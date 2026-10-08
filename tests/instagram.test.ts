import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { Lead } from '../src/database/models/Lead';
import { Message } from '../src/database/models/Message';
import { IgComment, IgRule } from '../src/database/models/instagram';
import { ConversationEngine } from '../src/conversations/engine';
import { LeadService } from '../src/leads/leadService';
import { ReminderService } from '../src/reminders/reminderService';
import { SettingsService } from '../src/services/settings';
import { AiService } from '../src/ai/aiService';
import { loadEnv } from '../src/config/env';
import type { AppContext } from '../src/services/appContext';
import { createInstagram } from '../src/instagram';
import { igChatId } from '../src/instagram/igAccount';
import { registerInstagramWebhook, handleInstagramBody } from '../src/instagram/webhook';
import { splitForInstagram } from '../src/instagram/igClient';
import { createWebApp } from '../src/webapp/server';
import { createSession, verifySession } from '../src/webapp/session';
import { formatLeadCard } from '../src/leads/leadCard';
import { FakeGateway, FakeLlm, clientMsg, useDatabase } from './helpers';

useDatabase();

const ACCOUNT = '17841400000000001';
const SECRET = 'app-secret';

/** Fake graph.instagram.com: records every call and answers like the real API. */
function fakeInstagram() {
  const calls: Array<{ method: string; path: string; query: Record<string, string>; body: any }> = [];
  let n = 0;
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname.replace(/^\/v[\d.]+/, '');
    calls.push({ method: init?.method ?? 'GET', path, query: Object.fromEntries(url.searchParams), body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/me') return json({ user_id: ACCOUNT, username: 'temur.fit', name: 'Temur' });
    if (path.endsWith('/messages')) {
      if (body?.sender_action) return json({ recipient_id: body.recipient.id });
      return json({ recipient_id: body?.recipient?.id ?? 'x', message_id: `mid.out.${++n}` });
    }
    if (path.endsWith('/replies')) return json({ id: `reply.${++n}` });
    if (path.endsWith('/media')) return json({ data: [{ id: 'm1', caption: 'Ozish marafoni', media_type: 'IMAGE', media_url: 'https://cdn/x.jpg', permalink: 'https://instagram.com/p/x' }] });
    if (/^\/\d+$/.test(path)) return json({ name: 'Ali Valiyev', username: 'ali_v' });
    return json({});
  }) as typeof fetch;
  return { calls, fetchImpl, texts: () => calls.filter((c) => c.path.endsWith('/messages') && c.body?.message?.text).map((c) => c.body) };
}

async function buildIg() {
  const env = loadEnv({ ...process.env, NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: '123:TEST', TELEGRAM_ADMIN_ID: '1', LLM_API_KEY: 'x', IG_ACCESS_TOKEN: 'IGTOKEN', IG_APP_SECRET: SECRET });
  const settings = new SettingsService(0);
  const llm = new FakeLlm();
  const ai = new AiService(llm, settings, { retryDelaysMs: [1, 1] });
  const tg = new FakeGateway();
  const fake = fakeInstagram();
  const instagram = createInstagram(env, tg, settings, { fetch: fake.fetchImpl, commentDelayMs: 0 });
  const gateway = instagram.gateway;
  const leads = new LeadService({ gateway, timeZone: 'Asia/Tashkent', publicUrl: 'https://example.test' });
  const engine = new ConversationEngine({ gateway, ai, settings, leads }, { debounceMsOverride: 0, fastTyping: true });
  const reminders = new ReminderService(engine, settings, gateway);
  const app: AppContext = { env, settings, ai, engine, leads, reminders, gateway, instagram };
  await instagram.account.bootstrap(instagram.ig);
  const deps = { ...instagram, engine };
  return { env, settings, llm, tg, fake, instagram, engine, app, deps };
}

const dm = (from: string, text: string, mid = `mid.in.${Math.random()}`) => ({
  object: 'instagram',
  entry: [{ id: ACCOUNT, time: Date.now(), messaging: [{ sender: { id: from }, recipient: { id: ACCOUNT }, timestamp: Date.now(), message: { mid, text } }] }],
});
const comment = (id: string, from: string, text: string, username = 'ali_v', media = 'm1') => ({
  object: 'instagram',
  entry: [{ id: ACCOUNT, time: Date.now(), changes: [{ field: 'comments', value: { id, text, from: { id: from, username }, media: { id: media, media_product_type: 'FEED' } } }] }],
});
const settle = () => new Promise((r) => setTimeout(r, 30));

describe('Instagram Direct', () => {
  it('a Direct message gets the same human-like AI answer as Telegram, sent through the Instagram API', async () => {
    const { deps, fake } = await buildIg();
    await handleInstagramBody(dm('9001', 'Salom, kurs haqida'), deps);
    const lead = await Lead.findOne({ igUserId: '9001' });
    expect(lead?.channel).toBe('instagram');
    expect(lead?.chatId).toBe(igChatId('9001'));
    expect(lead?.businessConnectionId).toBe(`ig:${ACCOUNT}`);
    expect(lead?.username).toBe('ali_v');
    const out = fake.texts();
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((b) => b.recipient.id === '9001')).toBe(true);
    expect(out.map((b) => b.message.text).join(' ')).toMatch(/bo'y|Bo'y/i);
    // «yozyapti…» before the answer
    expect(fake.calls.some((c) => c.body?.sender_action === 'typing_on')).toBe(true);
  });

  it('the same message delivered twice is answered once', async () => {
    const { deps, fake } = await buildIg();
    const body = dm('9002', 'Salom, kurs haqida', 'mid.same');
    await handleInstagramBody(body, deps);
    const n = fake.texts().length;
    await handleInstagramBody(body, deps);
    expect(fake.texts().length).toBe(n);
  });

  it("the bot's own echo is ignored; TEMUR writing in the Instagram app pauses the AI", async () => {
    const { deps, fake, settings } = await buildIg();
    await settings.set({ coach_pause_minutes: 30 });
    await handleInstagramBody(dm('9003', 'Salom, kurs haqida'), deps);
    const ownMid = `mid.out.${fake.texts().length}`;
    const echo = (mid: string, text: string) => ({
      object: 'instagram',
      entry: [{ id: ACCOUNT, messaging: [{ sender: { id: ACCOUNT }, recipient: { id: '9003' }, message: { mid, text, is_echo: true } }] }],
    });
    await handleInstagramBody(echo(ownMid, 'bot text'), deps);
    expect(await Message.countDocuments({ sender: 'temur' })).toBe(0);
    deps.gateway.isOwnMid = async (mid: string) => mid === ownMid; // no 6s wait in tests
    await handleInstagramBody(echo('mid.manual', 'Salom, Temur'), deps);
    const lead = await Lead.findOne({ igUserId: '9003' });
    expect(await Message.countDocuments({ leadId: lead!._id, sender: 'temur' })).toBe(1);
    expect(lead?.aiPausedUntil?.getTime()).toBeGreaterThan(Date.now());
  });

  it('Instagram has its own mode: «faqat 5 savol» there, selling on Telegram', async () => {
    const { settings, engine } = await buildIg();
    await settings.set({ ig_sales_mode: false });
    expect(await (engine as any).salesOn({ channel: 'instagram' })).toBe(false);
    expect(await (engine as any).salesOn({ channel: 'telegram' })).toBe(true);
  });

  it('Instagram bot switched off → the message is stored, nothing is sent', async () => {
    const { deps, fake, settings } = await buildIg();
    await settings.set({ ig_enabled: false });
    await handleInstagramBody(dm('9004', 'Salom, kurs haqida'), deps);
    expect(fake.texts()).toHaveLength(0);
    expect(await Message.countDocuments({ sender: 'client', processed: false })).toBe(0);
  });

  it('long texts are split to the 1000-char Instagram limit; the lead card links the Instagram profile', async () => {
    const parts = splitForInstagram(('Juda uzun gap. '.repeat(100) + '\n').repeat(2));
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    const card = formatLeadCard({ channel: 'instagram', username: 'ali_v', name: 'Ali', telegramId: -5, igCommentText: '+' } as never, 'Asia/Tashkent');
    expect(card).toContain('https://instagram.com/ali_v');
    expect(card).not.toContain('tg://user');
  });
});

describe('Instagram comments (instead of ManyChat)', () => {
  it('comment → public reply + one Direct; the answer in Direct continues with the AI', async () => {
    const { deps, fake } = await buildIg();
    await handleInstagramBody(comment('c1', '9100', 'Kurs narxi qancha?'), deps);
    await settle();
    const reply = fake.calls.find((c) => c.path === '/c1/replies');
    expect(reply?.query.message).toBeTruthy();
    const priv = fake.calls.find((c) => c.body?.recipient?.comment_id === 'c1');
    expect(priv?.body.message.text).toMatch(/bo'y, ves, yosh/);
    const c = await IgComment.findOne({ commentId: 'c1' });
    expect(c?.status).toBe('done');
    expect(c?.dmSent).toBe(true);
    const lead = await Lead.findById(c!.leadId);
    expect(lead?.source).toBe('instagram_comment');
    expect(lead?.status).toBe('QUESTIONNAIRE');
    expect(lead?.lastAskedStep).toBe(1);
    // the person answers in Direct → the AI goes on with the questionnaire (no new greeting)
    await handleInstagramBody(dm('9100', "175 sm 80 kg 25 yosh, 1 yil zal"), deps);
    const after = await Lead.findById(lead!._id);
    expect(after?.answers?.height).toBe(175);
    const last = fake.texts().at(-1)!;
    expect(last.recipient.id).toBe('9100');
    expect(last.message.text).not.toMatch(/Assalomu alaykum/);
  });

  it('own replies, duplicates and non-matching keywords are not answered', async () => {
    const { deps, fake } = await buildIg();
    await IgRule.create({ name: 'Faqat +', keywords: '+, kurs', publicReplies: ['Yozdim'], dmText: 'Salom!' });
    await IgRule.deleteMany({ name: 'Barcha postlar' });
    await handleInstagramBody(comment('c2', ACCOUNT, 'Rahmat', 'temur.fit'), deps);
    await handleInstagramBody(comment('c3', '9200', 'Zo\'r post'), deps);
    await handleInstagramBody(comment('c4', '9201', '+'), deps);
    await handleInstagramBody(comment('c4', '9201', '+'), deps);
    await settle();
    expect(await IgComment.exists({ commentId: 'c2' })).toBeFalsy();
    expect((await IgComment.findOne({ commentId: 'c3' }))?.status).toBe('skipped');
    expect(fake.calls.filter((c) => c.body?.recipient?.comment_id === 'c4')).toHaveLength(1);
  });

  it('a rule for one post wins over «every post»; one Direct per person within the cooldown', async () => {
    const { deps, fake, instagram } = await buildIg();
    await instagram.comments.ensureDefaultRule();
    await IgRule.create({ name: 'Marafon', mediaId: 'm2', keywords: '', publicReplies: ['Marafon haqida yozdim'], dmText: 'Marafon: bo\'y, ves, yosh?' });
    await handleInstagramBody(comment('c5', '9300', 'qiziq', 'vali', 'm2'), deps);
    await handleInstagramBody(comment('c6', '9300', 'yana', 'vali', 'm2'), deps);
    await settle();
    expect(fake.calls.find((c) => c.path === '/c5/replies')?.query.message).toBe('Marafon haqida yozdim');
    expect(fake.calls.filter((c) => c.body?.recipient?.comment_id)).toHaveLength(1);
    expect((await IgComment.findOne({ commentId: 'c6' }))?.skipReason).toMatch(/allaqachon/);
  });
});

describe('Instagram webhook and panel', () => {
  async function server() {
    const ctx = await buildIg();
    const web = createWebApp(ctx.app, (e) => registerInstagramWebhook(e, ctx.deps));
    const srv = web.listen(0);
    const port = (srv.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const session = createSession(1, '123:TEST');
    const api = (path: string, opts: { method?: string; body?: unknown; session?: string } = {}) =>
      fetch(`${base}/api${path}`, {
        method: opts.method ?? 'GET',
        headers: { 'content-type': 'application/json', 'x-admin-session': opts.session ?? session },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    return { ...ctx, srv, base, api };
  }

  it('webhook: verify handshake, signature required', async () => {
    const { srv, base, instagram } = await server();
    const ok = await fetch(`${base}/instagram/webhook?hub.mode=subscribe&hub.verify_token=${instagram.account.verifyToken()}&hub.challenge=42`);
    expect(await ok.text()).toBe('42');
    expect((await fetch(`${base}/instagram/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`)).status).toBe(403);
    const body = JSON.stringify(dm('9400', 'Salom'));
    const bad = await fetch(`${base}/instagram/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' }, body });
    expect(bad.status).toBe(403);
    const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    const good = await fetch(`${base}/instagram/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body });
    expect(good.status).toBe(200);
    for (let i = 0; i < 50 && !(await Lead.exists({ igUserId: '9400' })); i++) await settle();
    expect(await Lead.exists({ igUserId: '9400' })).toBeTruthy();
    srv.close();
  });

  it('panel: login link works only for admins; Instagram chats are separate from the Telegram list', async () => {
    const { srv, api, engine, deps } = await server();
    expect(verifySession(createSession(1, '123:TEST', 30, Date.now() - 31 * 86400_000), '123:TEST')).toBeNull();
    expect((await api('/ig/status', { session: createSession(777, '123:TEST') })).status).toBe(401);
    expect((await api('/ig/status', { session: 'garbage.sig' })).status).toBe(401);

    await engine.handleClientMessage(clientMsg(70, 'Salom, kurs haqida'));
    await handleInstagramBody(dm('9500', 'Salom, kurs haqida'), deps);
    const tgList = (await (await api('/leads')).json()) as unknown[];
    expect(tgList).toHaveLength(1);
    const conv = (await (await api('/ig/conversations')).json()) as Array<{ id: string; username: string; last: { sender: string } }>;
    expect(conv).toHaveLength(1);
    expect(conv[0].username).toBe('ali_v');
    expect(conv[0].last.sender).toBe('ai');

    const st = (await (await api('/ig/status')).json()) as { connected: boolean; username: string; hasAppSecret: boolean };
    expect(st).toMatchObject({ connected: true, username: 'temur.fit', hasAppSecret: true });
    const ov = (await (await api('/ig/overview')).json()) as { today: { leads: number }; series: unknown[]; funnel: unknown[] };
    expect(ov.today.leads).toBe(1);
    expect(ov.series).toHaveLength(14);

    // the coach writes from the panel → goes to Instagram Direct
    const send = await api(`/leads/${conv[0].id}/message`, { method: 'POST', body: { text: 'Salom, bu Temur' } });
    expect(send.status).toBe(200);
    expect(deps.ig).toBeTruthy();
    srv.close();
  });

  it('panel: automation rules CRUD, comment list, manual reply', async () => {
    const { srv, api, deps, fake } = await server();
    const rules = (await (await api('/ig/rules')).json()) as Array<{ id: string; name: string }>;
    expect(rules[0].name).toBe('Barcha postlar');
    const created = (await (await api('/ig/rules', { method: 'POST', body: { name: 'Marafon', mediaId: 'm1', keywords: 'marafon', publicReplies: ['Yozdim', ' '], dmText: 'Salom' } })).json()) as { id: string };
    await api(`/ig/rules/${created.id}`, { method: 'PATCH', body: { enabled: false } });
    const r = await IgRule.findById(created.id).lean();
    expect(r).toMatchObject({ name: 'Marafon', mediaId: 'm1', enabled: false, publicReplies: ['Yozdim'] });
    expect((await (await api('/ig/media')).json()) as unknown[]).toHaveLength(1);

    await handleInstagramBody(comment('c9', '9600', 'Qancha turadi?'), deps);
    await settle();
    const list = (await (await api('/ig/comments')).json()) as Array<{ id: string; commentId: string; ruleName: string }>;
    expect(list[0]).toMatchObject({ commentId: 'c9', ruleName: 'Barcha postlar' });
    const res = await api(`/ig/comments/${list[0].id}/reply`, { method: 'POST', body: { text: 'Rahmat!' } });
    expect(res.status).toBe(200);
    expect(fake.calls.filter((c) => c.path === '/c9/replies').at(-1)?.query.message).toBe('Rahmat!');
    const again = await api(`/ig/comments/${list[0].id}/dm`, { method: 'POST', body: { text: 'yana' } });
    expect(again.status).toBe(400); // Instagram allows one private reply per comment
    await api(`/ig/rules/${created.id}`, { method: 'DELETE' });
    expect(await IgRule.exists({ _id: created.id })).toBeFalsy();
    srv.close();
  });
});
