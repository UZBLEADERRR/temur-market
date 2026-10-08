import express, { type NextFunction, type Request, type Response } from 'express';
import { Types } from 'mongoose';
import { Lead } from '../database/models/Lead';
import { Message } from '../database/models/Message';
import { IgAccount, IgComment, IgRule } from '../database/models/instagram';
import { displayName } from '../leads/leadCard';
import type { AppContext } from '../services/appContext';
import type { IgMedia } from '../instagram/igClient';
import { DEFAULT_RULE } from '../instagram/commentService';
import { logger } from '../utils/logger';

type AuthedRequest = Request & { adminId?: number };
const asyncH =
  (fn: (req: AuthedRequest, res: Response) => Promise<unknown>) => (req: AuthedRequest, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

const DAY = 24 * 3600_000;
const IG = { channel: 'instagram' as const };
const str = (v: unknown, max = 2000) => String(v ?? '').slice(0, max);
const errText = (err: unknown) => String((err as { description?: string }).description ?? (err as Error).message).slice(0, 300);

/** Local calendar day (YYYY-MM-DD) in the admin time zone. */
function dayKey(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** JSON API of the Instagram panel (/api/ig/*). Shares the admin auth of the mini app. */
export function instagramApi(app: AppContext): express.Router {
  const r = express.Router();
  const mod = () => {
    if (!app.instagram) throw Object.assign(new Error('Instagram moduli yoqilmagan'), { status: 503 });
    return app.instagram;
  };
  let mediaCache: { at: number; list: IgMedia[] } | undefined;

  r.get(
    '/status',
    asyncH(async (_req, res) => {
      const m = mod();
      const acc = await IgAccount.findById('main').lean();
      const creds = await m.account.credentials();
      res.json({
        connected: Boolean(creds?.token && acc?.userId),
        hasToken: Boolean(creds?.token),
        hasAppSecret: Boolean(await m.account.appSecret()),
        username: acc?.username,
        name: acc?.name,
        pictureUrl: acc?.pictureUrl,
        userId: acc?.userId,
        tokenExpiresAt: acc?.tokenExpiresAt,
        lastWebhookAt: acc?.lastWebhookAt,
        lastError: acc?.lastError,
        webhookUrl: app.env.publicUrl ? `${app.env.publicUrl}/instagram/webhook` : '/instagram/webhook',
        verifyToken: m.account.verifyToken(),
      });
    }),
  );

  r.post(
    '/connect',
    asyncH(async (req, res) => {
      const m = mod();
      const token = str(req.body?.token, 1000).trim();
      const appSecret = str(req.body?.appSecret, 200).trim();
      if (!token && appSecret) {
        await IgAccount.updateOne({ _id: 'main' }, { $set: { appSecret } }, { upsert: true });
        m.account.invalidate();
        return res.json({ ok: true });
      }
      if (!token) return res.status(400).json({ error: 'Access token kerak' });
      try {
        const r2 = await m.account.connect(m.ig, token, appSecret || undefined);
        mediaCache = undefined;
        res.json({ ok: true, username: r2.username });
      } catch (err) {
        res.status(400).json({ error: `Token ishlamadi: ${errText(err)}` });
      }
    }),
  );

  r.post(
    '/disconnect',
    asyncH(async (_req, res) => {
      await IgAccount.updateOne({ _id: 'main' }, { $unset: { accessToken: '', userId: '', username: '', name: '', pictureUrl: '', tokenExpiresAt: '' } });
      mod().account.invalidate();
      res.json({ ok: true });
    }),
  );

  r.get(
    '/overview',
    asyncH(async (_req, res) => {
      const tz = app.env.TZ_NAME;
      const now = Date.now();
      const since = new Date(now - 14 * DAY);
      const today = dayKey(new Date(), tz);
      const [comments, leads] = await Promise.all([
        IgComment.find({ createdAt: { $gte: since } }).select('createdAt dmSent status').lean(),
        Lead.find({ ...IG, createdAt: { $gte: new Date(now - 30 * DAY) } })
          .select('createdAt status readyReason source lastClientMessageAt questionnaireDoneAt soldAt paidAt igCommentId')
          .lean(),
      ]);
      const days: Array<{ day: string; comments: number; dms: number; leads: number }> = [];
      for (let i = 13; i >= 0; i--) days.push({ day: dayKey(new Date(now - i * DAY), tz), comments: 0, dms: 0, leads: 0 });
      const byDay = new Map(days.map((d) => [d.day, d]));
      for (const c of comments) {
        const d = byDay.get(dayKey(c.createdAt as Date, tz));
        if (!d) continue;
        d.comments++;
        if (c.dmSent) d.dms++;
      }
      for (const l of leads) {
        const d = byDay.get(dayKey(l.createdAt as Date, tz));
        if (d) d.leads++;
      }
      const fromComments = leads.filter((l) => l.igCommentId);
      const sold = (l: (typeof leads)[number]) => Boolean(l.soldAt || l.paidAt || l.status === 'PAID' || l.readyReason === 'sold');
      const qDone = (l: (typeof leads)[number]) => Boolean(l.questionnaireDoneAt) || ['SALES', 'PAID'].includes(l.status) || sold(l);
      const [waiting, inSales, active] = await Promise.all([
        Lead.countDocuments({ ...IG, status: 'READY' }),
        Lead.countDocuments({ ...IG, status: 'SALES' }),
        Lead.countDocuments({ ...IG, mode: 'AI', status: { $in: ['NEW', 'QUESTIONNAIRE', 'SALES'] } }),
      ]);
      const t = byDay.get(today)!;
      res.json({
        today: { comments: t.comments, dms: t.dms, leads: t.leads },
        waiting,
        inSales,
        active,
        sold30: leads.filter(sold).length,
        series: days,
        funnel: [
          { key: 'comments', label: 'Komment', value: comments.length },
          { key: 'dms', label: 'Direct yuborildi', value: comments.filter((c) => c.dmSent).length },
          { key: 'replied', label: 'Javob yozdi', value: fromComments.filter((l) => l.lastClientMessageAt).length },
          { key: 'questionnaire', label: 'Anketa tugadi', value: fromComments.filter(qDone).length },
          { key: 'sold', label: 'Sotildi', value: fromComments.filter(sold).length },
        ],
      });
    }),
  );

  r.get(
    '/conversations',
    asyncH(async (req, res) => {
      const q: Record<string, unknown> = { ...IG };
      const filter = str(req.query.filter, 20);
      if (filter === 'ai') Object.assign(q, { mode: 'AI', status: { $in: ['NEW', 'QUESTIONNAIRE', 'SALES'] } });
      else if (filter === 'waiting') q.status = 'READY';
      else if (filter === 'manual') q.mode = 'MANUAL';
      else if (filter === 'sales') q.status = 'SALES';
      else if (filter === 'sold') q.$or = [{ readyReason: 'sold' }, { status: 'PAID' }];
      const search = str(req.query.q, 80).trim();
      if (search) {
        const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        q.$and = [{ $or: [{ name: re }, { username: re }, { igCommentText: re }] }];
      }
      const leads = await Lead.find(q).sort({ updatedAt: -1 }).limit(200).lean();
      const last = await Message.aggregate<{ _id: Types.ObjectId; text: string; sender: string; kind: string; at: Date }>([
        { $match: { leadId: { $in: leads.map((l) => l._id) } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$leadId', text: { $first: '$text' }, sender: { $first: '$sender' }, kind: { $first: '$kind' }, at: { $first: '$createdAt' } } },
      ]);
      const lastBy = new Map(last.map((m) => [String(m._id), m]));
      const list = leads.map((l) => {
        const m = lastBy.get(String(l._id));
        return {
          id: String(l._id),
          name: displayName(l),
          username: l.username,
          status: l.status,
          mode: l.mode,
          urgent: l.urgent,
          readyReason: l.readyReason,
          source: l.source,
          country: l.answers?.country,
          paused: Boolean(l.aiPausedUntil && l.aiPausedUntil.getTime() > Date.now()),
          fromComment: Boolean(l.igCommentId),
          last: m ? { text: m.text, sender: m.sender, at: m.at } : null,
          unread: m?.sender === 'client',
          updatedAt: m?.at ?? l.updatedAt,
        };
      });
      list.sort((a, b) => new Date(b.updatedAt as Date).getTime() - new Date(a.updatedAt as Date).getTime());
      res.json(list);
    }),
  );

  r.get(
    '/comments',
    asyncH(async (req, res) => {
      const q: Record<string, unknown> = {};
      const status = str(req.query.status, 20);
      if (['pending', 'done', 'skipped', 'failed'].includes(status)) q.status = status;
      const list = await IgComment.find(q).sort({ createdAt: -1 }).limit(Math.min(200, Number(req.query.limit) || 100)).lean();
      const rules = new Map((await IgRule.find().select('name').lean()).map((x) => [String(x._id), x.name]));
      res.json(list.map((c) => ({ ...c, id: String(c._id), ruleName: c.ruleId ? rules.get(String(c.ruleId)) : undefined })));
    }),
  );

  const loadComment = async (id: string) => (Types.ObjectId.isValid(id) ? IgComment.findById(id) : null);

  r.post(
    '/comments/:id/reply',
    asyncH(async (req, res) => {
      const c = await loadComment(String(req.params.id));
      const text = str(req.body?.text, 2000).trim();
      if (!c || !text) return res.status(400).json({ error: 'Matn kerak' });
      try {
        const r2 = await mod().ig.replyToComment(c.commentId, text);
        c.publicReply = text;
        c.publicReplyId = r2.id;
        if (c.status !== 'done') c.status = 'done';
        await c.save();
        res.json({ ok: true });
      } catch (err) {
        res.status(502).json({ error: errText(err) });
      }
    }),
  );

  r.post(
    '/comments/:id/dm',
    asyncH(async (req, res) => {
      const c = await loadComment(String(req.params.id));
      const text = str(req.body?.text, 1000).trim();
      if (!c || !text) return res.status(400).json({ error: 'Matn kerak' });
      if (c.dmSent) return res.status(400).json({ error: 'Bu kommentga Direct allaqachon yuborilgan (Instagram faqat bittaga ruxsat beradi)' });
      try {
        const r2 = await mod().ig.privateReply(c.commentId, text);
        mod().gateway.rememberMid(r2.messageId);
        c.dmSent = true;
        c.dmText = text;
        if (c.status !== 'done') c.status = 'done';
        await c.save();
        res.json({ ok: true });
      } catch (err) {
        res.status(502).json({ error: errText(err) });
      }
    }),
  );

  r.post(
    '/comments/:id/hide',
    asyncH(async (req, res) => {
      const c = await loadComment(String(req.params.id));
      if (!c) return res.status(404).json({ error: 'not found' });
      const hide = req.body?.hide !== false;
      try {
        await mod().ig.hideComment(c.commentId, hide);
        c.hidden = hide;
        await c.save();
        res.json({ ok: true });
      } catch (err) {
        res.status(502).json({ error: errText(err) });
      }
    }),
  );

  /** Runs the automation again for a skipped / failed comment (e.g. after fixing a rule). */
  r.post(
    '/comments/:id/retry',
    asyncH(async (req, res) => {
      const c = await loadComment(String(req.params.id));
      if (!c) return res.status(404).json({ error: 'not found' });
      const rule = await mod().comments.findRule(c.mediaId ?? undefined, c.text);
      if (!rule) return res.status(400).json({ error: "Bu kommentga mos qoida yo'q" });
      await IgComment.updateOne({ _id: c._id }, { $set: { status: 'pending', ruleId: rule._id, error: null, skipReason: null } });
      await mod().comments.run(String(c._id));
      res.json({ ok: true, comment: await IgComment.findById(c._id).lean() });
    }),
  );

  // ── automation rules ──
  const ruleBody = (b: Record<string, unknown>) => {
    const $set: Record<string, unknown> = {};
    if (typeof b.name === 'string') $set.name = b.name.slice(0, 80);
    if (b.mediaId === null || typeof b.mediaId === 'string') $set.mediaId = b.mediaId || null;
    for (const k of ['mediaThumb', 'mediaCaption', 'mediaPermalink'] as const) if (typeof b[k] === 'string') $set[k] = (b[k] as string).slice(0, 1000);
    if (typeof b.keywords === 'string') $set.keywords = b.keywords.slice(0, 1000);
    if (Array.isArray(b.publicReplies)) $set.publicReplies = b.publicReplies.map((x) => String(x).trim().slice(0, 300)).filter(Boolean).slice(0, 20);
    if (typeof b.dmText === 'string') $set.dmText = b.dmText.slice(0, 1000);
    if (typeof b.enabled === 'boolean') $set.enabled = b.enabled;
    return $set;
  };

  r.get(
    '/rules',
    asyncH(async (_req, res) => {
      await mod().comments.ensureDefaultRule();
      const list = await IgRule.find().sort({ createdAt: 1 }).lean();
      res.json(list.map((x) => ({ ...x, id: String(x._id) })));
    }),
  );
  r.post(
    '/rules',
    asyncH(async (req, res) => {
      const rule = await IgRule.create({ ...DEFAULT_RULE, name: 'Yangi avtomat', ...ruleBody(req.body ?? {}) });
      res.json({ id: String(rule._id) });
    }),
  );
  r.patch(
    '/rules/:id',
    asyncH(async (req, res) => {
      if (!Types.ObjectId.isValid(String(req.params.id))) return res.status(404).json({ error: 'not found' });
      await IgRule.updateOne({ _id: req.params.id }, { $set: ruleBody(req.body ?? {}) });
      res.json({ ok: true });
    }),
  );
  r.delete(
    '/rules/:id',
    asyncH(async (req, res) => {
      if (!Types.ObjectId.isValid(String(req.params.id))) return res.status(404).json({ error: 'not found' });
      await IgRule.deleteOne({ _id: req.params.id });
      res.json({ ok: true });
    }),
  );

  r.get(
    '/media',
    asyncH(async (_req, res) => {
      if (mediaCache && Date.now() - mediaCache.at < 5 * 60_000) return res.json(mediaCache.list);
      try {
        const list = await mod().ig.listMedia(30);
        mediaCache = { at: Date.now(), list };
        res.json(list);
      } catch (err) {
        logger.warn({ err: errText(err) }, 'Instagram media list failed');
        res.status(502).json({ error: errText(err) });
      }
    }),
  );

  r.use((err: Error & { status?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (err.status === 503) return res.status(503).json({ error: err.message });
    next(err);
  });
  return r;
}
