import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { Lead } from '../database/models/Lead';
import { Message } from '../database/models/Message';
import { AdminEvent, Campaign, StyleExample, VoiceClip } from '../database/models/misc';
import type { AppContext } from '../services/appContext';
import { SETTINGS_SPEC } from '../services/settingsSpec';
import { exportXlsx, getDailyStats, getQueue } from '../admin/adminQueries';
import { displayName } from '../leads/leadCard';
import { rebuildStyleProfile } from '../style/styleProfile';
import { tokenize } from '../style/examples';
import { LEAD_STATUSES, type LeadStatus } from '../types/domain';
import { escapeHtml, detectLanguage } from '../utils/text';
import { validateInitData } from './auth';
import { verifySession } from './session';
import { instagramApi } from './igApi';
import { logger } from '../utils/logger';

type AuthedRequest = Request & { adminId?: number };

const asyncH =
  (fn: (req: AuthedRequest, res: Response) => Promise<unknown>) => (req: AuthedRequest, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

/** Express app: health check, Telegram Mini App (static) and its admin JSON API. */
export function createWebApp(app: AppContext, extra?: (e: express.Express) => void): express.Express {
  const web = express();
  web.disable('x-powered-by');
  // the raw body is kept for webhook signatures (Instagram X-Hub-Signature-256)
  web.use(
    express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  web.get('/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  extra?.(web);

  web.use('/app', express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: 0 }));
  web.use('/ig', express.static(path.join(__dirname, 'public', 'ig'), { index: 'index.html', maxAge: 0 }));

  const auth = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const token = req.header('x-admin-token');
    if (app.env.ADMIN_WEB_TOKEN && token && safeEqual(token, app.env.ADMIN_WEB_TOKEN)) {
      req.adminId = app.env.adminIds[0];
      return next();
    }
    // signed login link from the bot (Instagram panel in a normal browser)
    const session = req.header('x-admin-session');
    const sessionAdmin = session ? verifySession(session, app.env.TELEGRAM_BOT_TOKEN) : null;
    if (sessionAdmin && app.env.adminIds.includes(sessionAdmin)) {
      req.adminId = sessionAdmin;
      return next();
    }
    const user = validateInitData(req.header('x-telegram-init-data') ?? '', app.env.TELEGRAM_BOT_TOKEN);
    if (!user || !app.env.adminIds.includes(user.id)) return res.status(401).json({ error: 'unauthorized' });
    req.adminId = user.id;
    next();
  };

  const api = express.Router();
  api.use(auth);

  api.get('/me', (req: AuthedRequest, res) => {
    res.json({ adminId: req.adminId, publicUrl: app.env.publicUrl, instagram: Boolean(app.instagram) });
  });

  api.get(
    '/leads',
    asyncH(async (req, res) => {
      // the Telegram mini app shows Telegram chats; Instagram chats live in the Instagram panel
      const channel = String(req.query.channel ?? 'telegram');
      const q: Record<string, unknown> = channel === 'all' ? {} : channel === 'instagram' ? { channel: 'instagram' } : { channel: { $ne: 'instagram' } };
      const status = String(req.query.status ?? '');
      if (status === 'QUEUE') q.status = 'READY';
      else if (LEAD_STATUSES.includes(status as LeadStatus)) q.status = status;
      const search = String(req.query.q ?? '').trim();
      if (search) {
        const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const n = Number(search);
        q.$or = [{ name: re }, { username: re }, { source: re }, ...(Number.isFinite(n) ? [{ telegramId: n }] : [])];
      }
      const sort: Record<string, 1 | -1> = status === 'QUEUE' || status === 'READY' ? { urgent: -1, readyAt: 1 } : { updatedAt: -1 };
      const leads = await Lead.find(q).sort(sort).limit(300).lean();
      res.json(
        leads.map((l) => ({
          id: String(l._id),
          name: displayName(l),
          username: l.username,
          telegramId: l.telegramId,
          channel: l.channel ?? 'telegram',
          source: l.source,
          status: l.status,
          mode: l.mode,
          urgent: l.urgent,
          alwaysOn: l.alwaysOn,
          bmi: l.bmi,
          answers: l.answers,
          readyAt: l.readyAt,
          createdAt: l.createdAt,
          lastClientMessageAt: l.lastClientMessageAt,
        })),
      );
    }),
  );

  api.get(
    '/leads/:id',
    asyncH(async (req, res) => {
      if (!Types.ObjectId.isValid(String(req.params.id))) return res.status(404).json({ error: 'not found' });
      const lead = await Lead.findById(req.params.id).lean();
      if (!lead) return res.status(404).json({ error: 'not found' });
      const messages = await Message.find({ leadId: lead._id }).sort({ createdAt: 1 }).limit(500).select('sender text kind createdAt').lean();
      res.json({ lead: { ...lead, id: String(lead._id), displayName: displayName(lead), businessConnectionId: undefined }, messages });
    }),
  );

  api.post(
    '/leads/:id/status',
    asyncH(async (req, res) => {
      const status = String(req.body?.status) as LeadStatus;
      if (!LEAD_STATUSES.includes(status)) return res.status(400).json({ error: 'bad status' });
      const lead = await app.leads.setStatus(String(req.params.id), status, req.adminId);
      res.json({ ok: Boolean(lead) });
    }),
  );

  api.post(
    '/leads/:id/mode',
    asyncH(async (req, res) => {
      const mode = req.body?.mode === 'AI' ? 'AI' : 'MANUAL';
      if (mode === 'MANUAL') app.engine.cancel(String(req.params.id));
      const lead = await app.leads.setMode(String(req.params.id), mode, req.adminId);
      res.json({ ok: Boolean(lead) });
    }),
  );

  /** "Ma'lumotlarni tozalash": answers and chat history are deleted, the client starts from zero. */
  api.post(
    '/leads/:id/reset',
    asyncH(async (req, res) => {
      res.json({ ok: await app.engine.resetLead(String(req.params.id)) });
    }),
  );

  /** AI always on for this client (does not stop after the questionnaire or the coach's messages). */
  api.post(
    '/leads/:id/always-on',
    asyncH(async (req, res) => {
      const on = Boolean(req.body?.on);
      const lead = await Lead.findById(req.params.id);
      if (!lead) return res.status(404).json({ error: 'not found' });
      lead.alwaysOn = on;
      if (on) lead.mode = 'AI';
      await lead.save();
      await AdminEvent.create({ type: on ? 'always_on' : 'always_off', leadId: lead._id, actorId: req.adminId });
      res.json({ ok: true });
    }),
  );

  api.delete(
    '/leads/:id',
    asyncH(async (req, res) => {
      app.engine.cancel(String(req.params.id));
      await Message.deleteMany({ leadId: req.params.id });
      await Lead.deleteOne({ _id: req.params.id });
      await AdminEvent.create({ type: 'lead_deleted', actorId: req.adminId, data: { leadId: req.params.id } });
      res.json({ ok: true });
    }),
  );

  api.post(
    '/leads/:id/notes',
    asyncH(async (req, res) => {
      await Lead.updateOne({ _id: req.params.id }, { $set: { notes: String(req.body?.notes ?? '').slice(0, 5000) } });
      res.json({ ok: true });
    }),
  );

  /** The coach writes to the client from the mini app — sent from TEMUR's account via the business connection. */
  api.post(
    '/leads/:id/message',
    asyncH(async (req, res) => {
      const text = String(req.body?.text ?? '').trim();
      if (!text) return res.status(400).json({ error: 'empty' });
      const lead = await Lead.findById(req.params.id);
      if (!lead) return res.status(404).json({ error: 'not found' });
      try {
        const sent = await app.gateway.sendBusinessMessage(lead.businessConnectionId, lead.chatId, text.slice(0, lead.channel === 'instagram' ? 3000 : 4000));
        await Message.create({
          leadId: lead._id,
          telegramMessageId: sent.messageId,
          telegramId: lead.chatId,
          direction: 'outgoing',
          sender: 'temur',
          text,
          meta: { via: 'miniapp', adminId: req.adminId },
        });
        await app.engine.takeover(lead, 'miniapp_message');
        res.json({ ok: true });
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Mini app send failed');
        res.status(502).json({
          error:
            lead.channel === 'instagram'
              ? "Yuborib bo'lmadi: mijoz oxirgi marta yozganiga 24 soatdan oshgan bo'lishi mumkin. Instagram ilovasida o'zingiz yozing."
              : "Yuborib bo'lmadi (24 soatlik oyna yopilgan yoki bot pauzada). Telegram'da o'zingiz yozing.",
        });
      }
    }),
  );

  /** For clients without @username: the bot sends the admin a tappable mention that opens the chat. */
  api.post(
    '/leads/:id/open',
    asyncH(async (req, res) => {
      const lead = await Lead.findById(req.params.id).lean();
      if (!lead || !req.adminId) return res.status(404).json({ error: 'not found' });
      await app.gateway.notifyAdmins(
        `💬 Chatni ochish: <a href="tg://user?id=${lead.telegramId}">${escapeHtml(displayName(lead))}</a>${lead.username ? ' @' + escapeHtml(lead.username) : ''}\n🆔 <code>${lead.telegramId}</code>`,
      );
      res.json({ ok: true });
    }),
  );

  api.get(
    '/stats',
    asyncH(async (req, res) => {
      const day = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? new Date(`${req.query.date}T12:00:00Z`) : new Date();
      const [stats, totals, queue] = await Promise.all([
        getDailyStats(app.env.TZ_NAME, day),
        Lead.aggregate<{ _id: string; count: number }>([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
        getQueue(5),
      ]);
      res.json({ stats, totals: Object.fromEntries(totals.map((t) => [t._id, t.count])), queueSize: queue.length });
    }),
  );

  api.get(
    '/settings',
    asyncH(async (_req, res) => {
      res.json({ spec: SETTINGS_SPEC, values: await app.settings.all() });
    }),
  );
  api.put(
    '/settings',
    asyncH(async (req, res) => {
      try {
        const values = await app.settings.set(req.body?.values ?? {});
        await AdminEvent.create({ type: 'settings_update', actorId: req.adminId, data: { keys: Object.keys(req.body?.values ?? {}) } });
        res.json({ ok: true, values });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }),
  );
  api.post(
    '/settings/reset',
    asyncH(async (req, res) => {
      await app.settings.reset(String(req.body?.key));
      res.json({ ok: true, values: await app.settings.all() });
    }),
  );

  api.get(
    '/examples',
    asyncH(async (_req, res) => {
      const list = await StyleExample.find().sort({ createdAt: -1 }).limit(500).select('client coach language enabled source').lean();
      res.json(list.map((e) => ({ ...e, id: String(e._id) })));
    }),
  );
  api.post(
    '/examples',
    asyncH(async (req, res) => {
      const client = String(req.body?.client ?? '').trim();
      const coach = (Array.isArray(req.body?.coach) ? req.body.coach : String(req.body?.coach ?? '').split('\n'))
        .map((s: unknown) => String(s).trim())
        .filter(Boolean);
      if (!client || !coach.length) return res.status(400).json({ error: 'client va coach kerak' });
      const e = await StyleExample.create({
        client,
        coach,
        language: detectLanguage(coach.join(' ')) ?? 'uz',
        tokens: tokenize(client + ' ' + coach.join(' ')),
        source: 'manual',
      });
      res.json({ id: String(e._id) });
    }),
  );
  api.patch(
    '/examples/:id',
    asyncH(async (req, res) => {
      await StyleExample.updateOne({ _id: req.params.id }, { $set: { enabled: Boolean(req.body?.enabled) } });
      res.json({ ok: true });
    }),
  );
  api.delete(
    '/examples/:id',
    asyncH(async (req, res) => {
      await StyleExample.deleteOne({ _id: req.params.id });
      res.json({ ok: true });
    }),
  );
  api.post(
    '/style/rebuild',
    asyncH(async (_req, res) => {
      try {
        const r = await rebuildStyleProfile(app.ai, app.settings);
        res.json({ ok: true, profile: r.profile, stats: r.stats });
      } catch (err) {
        res.status(502).json({ error: (err as Error).message.slice(0, 200) });
      }
    }),
  );

  // ── voice library ──
  api.get(
    '/voices',
    asyncH(async (_req, res) => {
      const list = await VoiceClip.find().sort({ createdAt: 1 }).lean();
      res.json(list.map((c) => ({ ...c, id: String(c._id), shortId: String(c._id).slice(-6), fileId: undefined, fileUniqueId: undefined })));
    }),
  );
  api.patch(
    '/voices/:id',
    asyncH(async (req, res) => {
      const $set: Record<string, unknown> = {};
      if (typeof req.body?.title === 'string') $set.title = req.body.title.slice(0, 80);
      if (typeof req.body?.description === 'string') $set.description = req.body.description.slice(0, 1000);
      if (typeof req.body?.enabled === 'boolean') $set.enabled = req.body.enabled;
      if (['ALL', 'KR', 'UZ', 'OTHER'].includes(req.body?.country)) $set.country = req.body.country;
      await VoiceClip.updateOne({ _id: req.params.id }, { $set });
      res.json({ ok: true });
    }),
  );
  api.delete(
    '/voices/:id',
    asyncH(async (req, res) => {
      await VoiceClip.deleteOne({ _id: req.params.id });
      res.json({ ok: true });
    }),
  );
  /** Plays a clip inside the mini app (streams the Telegram file). */
  api.get(
    '/voices/:id/audio',
    asyncH(async (req, res) => {
      const clip = await VoiceClip.findById(req.params.id).lean();
      if (!clip) return res.status(404).end();
      const buf = await app.gateway.downloadFile(clip.fileId);
      res.setHeader('content-type', clip.mimeType || 'audio/ogg');
      res.setHeader('cache-control', 'private, max-age=3600');
      res.end(buf);
    }),
  );
  /** Sends the clip to the admin's chat with the bot (reliable playback on every phone). */
  api.post(
    '/voices/:id/test',
    asyncH(async (req, res) => {
      const clip = await VoiceClip.findById(req.params.id).lean();
      if (!clip || !req.adminId) return res.status(404).json({ error: 'not found' });
      await app.gateway.sendAdminVoice(req.adminId, clip.fileId, clip.title || undefined);
      res.json({ ok: true });
    }),
  );

  api.get(
    '/campaigns',
    asyncH(async (_req, res) => {
      const list = await Campaign.find().sort({ source: 1 }).lean();
      const counts = await Lead.aggregate<{ _id: string; count: number }>([{ $group: { _id: '$source', count: { $sum: 1 } } }]);
      res.json({ campaigns: list.map((c) => ({ ...c, id: String(c._id) })), leadsBySource: counts });
    }),
  );
  api.post(
    '/campaigns',
    asyncH(async (req, res) => {
      const code = String(req.body?.code ?? '').trim();
      const source = String(req.body?.source ?? '').trim();
      if (!code || !source) return res.status(400).json({ error: 'kod va manba kerak' });
      await Campaign.updateOne({ code }, { $set: { source, description: String(req.body?.description ?? '') } }, { upsert: true });
      res.json({ ok: true });
    }),
  );
  api.delete(
    '/campaigns/:id',
    asyncH(async (req, res) => {
      await Campaign.deleteOne({ _id: req.params.id });
      res.json({ ok: true });
    }),
  );

  api.post(
    '/export',
    asyncH(async (req, res) => {
      const buf = await exportXlsx(app.env.TZ_NAME);
      await app.gateway.sendAdminDocument(req.adminId!, buf, `leads_${new Date().toISOString().slice(0, 10)}.xlsx`, '📤 Leadlar');
      res.json({ ok: true });
    }),
  );

  api.use('/ig', instagramApi(app));
  web.use('/api', api);

  web.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: err.message }, 'HTTP error');
    res.status(500).json({ error: 'internal' });
  });
  return web;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
