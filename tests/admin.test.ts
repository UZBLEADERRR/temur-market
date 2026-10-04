import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { AddressInfo } from 'node:net';
import { Lead } from '../src/database/models/Lead';
import { exportCsv, exportXlsx, formatQueue, formatStats, getDailyStats, getQueue } from '../src/admin/adminQueries';
import { createWebApp } from '../src/webapp/server';
import { signInitData } from '../src/webapp/auth';
import { buildApp, clientMsg, useDatabase } from './helpers';

useDatabase();
const TZ = 'Asia/Tashkent';

async function seed() {
  const now = new Date();
  const base = { businessConnectionId: 'c', mode: 'MANUAL', source: 'video_01' };
  await Lead.create([
    { ...base, chatId: 1, telegramId: 1, name: 'Old', status: 'READY', readyAt: new Date(now.getTime() - 3 * 3600_000), answers: { height: 180, weight: 90 }, bmi: 27.8 },
    { ...base, chatId: 2, telegramId: 2, name: 'New', status: 'READY', readyAt: new Date(now.getTime() - 1 * 3600_000) },
    { ...base, chatId: 3, telegramId: 3, name: 'Urgent', status: 'READY', urgent: true, readyAt: now },
    { ...base, chatId: 4, telegramId: 4, name: 'Paid', status: 'PAID', readyAt: now, answeredAt: now, paidAt: now, source: 'video_02' },
    { ...base, chatId: 5, telegramId: 5, name: 'Rej', status: 'REJECTED', readyAt: now, answeredAt: now, rejectedAt: now },
    { ...base, chatId: 6, telegramId: 6, name: 'Ans', status: 'ANSWERED', answeredAt: now },
    { ...base, chatId: 7, telegramId: 7, name: 'Q', status: 'QUESTIONNAIRE', mode: 'AI' },
  ]);
}

describe('admin', () => {
  it('23. /navbat — READY only, urgent first, then oldest first', async () => {
    await seed();
    const q = await getQueue();
    expect(q.map((l) => l.name)).toEqual(['Urgent', 'Old', 'New']);
    const html = await formatQueue(TZ);
    expect(html).toContain('Navbat');
    expect(html.indexOf('Urgent')).toBeLessThan(html.indexOf('Old'));
    expect(html).toContain('🔴');
  });

  it('24. /stats — daily numbers', async () => {
    await seed();
    const s = await getDailyStats(TZ);
    expect(s.newLeads).toBe(7);
    expect(s.paid).toBe(1);
    expect(s.rejected).toBe(1);
    expect(s.answered).toBe(3);
    expect(s.waiting).toBe(3);
    const text = formatStats(s, TZ);
    expect(text).toContain('Yangi leadlar: 7');
    expect(text).toContain("To'lagan: 1");
    expect(text).toContain('Rad etgan: 1');
    expect(text).toContain('video_02: 1');
  });

  it('25. /export — XLSX and CSV with answers, TMI, status, urgent, timestamps', async () => {
    await seed();
    const xlsx = await exportXlsx(TZ);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Leadlar')!;
    expect(ws.rowCount).toBe(8);
    const header = (ws.getRow(1).values as string[]).filter(Boolean);
    expect(header).toEqual(expect.arrayContaining(['Sana', 'Ism', 'Username', 'Manba', "Bo'y", 'Vazn', 'TMI', 'Status', 'Shoshilinch', 'Tayyor']));
    const csv = (await exportCsv(TZ)).toString('utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"Urgent"');
    expect(csv).toContain('"27.8"');
  });

  it('lead status buttons: ANSWERED → PAID / REJECTED with timestamps, card is refreshed', async () => {
    const { engine, leads, gateway } = buildApp();
    await engine.handleClientMessage(clientMsg(60, 'Salom, kurs haqida'));
    await engine.handleClientMessage(clientMsg(60, 'Temur bilan gaplashmoqchiman'));
    const lead = await Lead.findOne({ chatId: 60 });
    await leads.setStatus(String(lead!._id), 'ANSWERED', 1);
    const paid = await leads.setStatus(String(lead!._id), 'PAID', 1);
    expect(paid?.status).toBe('PAID');
    expect(paid?.paidAt).toBeTruthy();
    expect(paid?.answeredAt).toBeTruthy();
    expect(gateway.edits.length).toBeGreaterThan(0);
  });
});

describe('mini app API', () => {
  async function server() {
    const ctx = buildApp();
    const web = createWebApp(ctx.app);
    const srv = web.listen(0);
    const port = (srv.address() as AddressInfo).port;
    const init = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 1, first_name: 'Temur' }) }, '123:TEST');
    const call = (path: string, opts: { method?: string; body?: unknown; initData?: string } = {}) =>
      fetch(`http://127.0.0.1:${port}/api${path}`, {
        method: opts.method ?? 'GET',
        headers: { 'content-type': 'application/json', 'x-telegram-init-data': opts.initData ?? init },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    return { ...ctx, srv, call };
  }

  it('rejects requests without valid Telegram initData or from non-admins', async () => {
    const { srv, call } = await server();
    expect((await call('/leads', { initData: 'bad' })).status).toBe(401);
    const stranger = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 777 }) }, '123:TEST');
    expect((await call('/leads', { initData: stranger })).status).toBe(401);
    srv.close();
  });

  it('lists leads, opens one, writes to the client as the coach (AI keeps going), edits settings', async () => {
    const { srv, call, engine, gateway } = await server();
    await engine.handleClientMessage(clientMsg(61, 'Salom, kurs haqida'));
    const list = (await (await call('/leads?status=QUESTIONNAIRE')).json()) as Array<{ id: string; name: string }>;
    expect(list).toHaveLength(1);
    const detail = (await (await call(`/leads/${list[0].id}`)).json()) as { lead: { businessConnectionId?: string }; messages: unknown[] };
    expect(detail.messages.length).toBe(2);
    expect(detail.lead.businessConnectionId).toBeUndefined(); // never exposed

    const res = await call(`/leads/${list[0].id}/message`, { method: 'POST', body: { text: 'Salom, bu Temur' } });
    expect(res.status).toBe(200);
    expect(gateway.textsTo(61).at(-1)).toBe('Salom, bu Temur');
    const lead = await Lead.findById(list[0].id);
    // by default the AI continues and takes the coach's message into account
    expect(lead?.mode).toBe('AI');
    expect(lead?.status).toBe('QUESTIONNAIRE');

    const put = await call('/settings', { method: 'PUT', body: { values: { coach_info: 'Yangi info', reminder1_delay_minutes: '45' } } });
    expect(put.status).toBe(200);
    const s = (await (await call('/settings')).json()) as { values: Record<string, unknown> };
    expect(s.values.coach_info).toBe('Yangi info');
    expect(s.values.reminder1_delay_minutes).toBe(45);
    srv.close();
  });
});
