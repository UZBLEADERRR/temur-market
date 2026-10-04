import ExcelJS from 'exceljs';
import { Lead } from '../database/models/Lead';
import { displayName, statusLabel } from '../leads/leadCard';
import { escapeHtml } from '../utils/text';
import { formatDateTime, startOfDayInTz } from '../utils/time';

/** READY leads waiting for TEMUR: urgent first, then oldest first. */
export async function getQueue(limit = 50) {
  return Lead.find({ status: 'READY' }).sort({ urgent: -1, readyAt: 1 }).limit(limit).lean();
}

export async function formatQueue(timeZone: string): Promise<string> {
  const leads = await getQueue();
  if (!leads.length) return "✅ Navbat bo'sh — javob kutayotgan mijoz yo'q.";
  const lines = leads.map((l, i) => {
    const who = `<a href="tg://user?id=${l.telegramId}">${escapeHtml(displayName(l))}</a>${l.username ? ' @' + escapeHtml(l.username) : ''}`;
    return `${i + 1}. ${l.urgent ? '🔴 ' : ''}${who} · ${escapeHtml(l.source ?? '—')} · TMI ${l.bmi ?? '—'} · ${formatDateTime(l.readyAt, timeZone)}`;
  });
  return `📋 <b>Navbat</b> (${leads.length})\n\n${lines.join('\n')}`;
}

export interface DailyStats {
  date: Date;
  newLeads: number;
  completed: number;
  answered: number;
  paid: number;
  rejected: number;
  urgent: number;
  waiting: number;
  bySource: Array<{ source: string; count: number }>;
}

export async function getDailyStats(timeZone: string, day = new Date()): Promise<DailyStats> {
  const from = startOfDayInTz(day, timeZone);
  const to = new Date(from.getTime() + 24 * 3600_000);
  const range = { $gte: from, $lt: to };
  const [newLeads, completed, answered, paid, rejected, urgent, waiting, bySource] = await Promise.all([
    Lead.countDocuments({ createdAt: range }),
    Lead.countDocuments({ readyAt: range }),
    Lead.countDocuments({ answeredAt: range }),
    Lead.countDocuments({ paidAt: range }),
    Lead.countDocuments({ rejectedAt: range }),
    Lead.countDocuments({ readyAt: range, urgent: true }),
    Lead.countDocuments({ status: 'READY' }),
    Lead.aggregate<{ _id: string; count: number }>([
      { $match: { createdAt: range } },
      { $group: { _id: '$source', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
  ]);
  return {
    date: from,
    newLeads,
    completed,
    answered,
    paid,
    rejected,
    urgent,
    waiting,
    bySource: bySource.map((s) => ({ source: s._id ?? 'unknown', count: s.count })),
  };
}

export function formatStats(s: DailyStats, timeZone: string): string {
  const day = new Intl.DateTimeFormat('ru-RU', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(s.date);
  const src = s.bySource.length ? '\n\n📍 Manbalar:\n' + s.bySource.map((x) => `• ${escapeHtml(x.source)}: ${x.count}`).join('\n') : '';
  return (
    `📊 <b>Statistika — ${day}</b>\n\n` +
    `Yangi leadlar: ${s.newLeads}\n` +
    `Anketa tugagan: ${s.completed}\n` +
    `Javob berilgan: ${s.answered}\n` +
    `To'lagan: ${s.paid}\n` +
    `Rad etgan: ${s.rejected}\n` +
    `Shoshilinch: ${s.urgent}\n` +
    `Hozir navbatda: ${s.waiting}` +
    src
  );
}

export const EXPORT_COLUMNS = [
  { header: 'Sana', key: 'date', width: 18 },
  { header: 'Ism', key: 'name', width: 20 },
  { header: 'Username', key: 'username', width: 18 },
  { header: 'Telegram ID', key: 'telegramId', width: 14 },
  { header: 'Manba', key: 'source', width: 14 },
  { header: 'Til', key: 'language', width: 6 },
  { header: "Bo'y", key: 'height', width: 8 },
  { header: 'Vazn', key: 'weight', width: 8 },
  { header: 'Yosh', key: 'age', width: 6 },
  { header: 'Tajriba', key: 'trainingExperience', width: 20 },
  { header: 'Maqsad', key: 'goal', width: 25 },
  { header: 'Maqsad vazn', key: 'targetWeight', width: 10 },
  { header: 'Kun/hafta', key: 'trainingDays', width: 10 },
  { header: 'Zal/uy', key: 'trainingLocation', width: 10 },
  { header: 'Oldingi urinish', key: 'previousAttempts', width: 30 },
  { header: "Sog'liq", key: 'healthProblems', width: 30 },
  { header: 'TMI', key: 'bmi', width: 6 },
  { header: 'Status', key: 'status', width: 14 },
  { header: 'Rejim', key: 'mode', width: 8 },
  { header: 'Shoshilinch', key: 'urgent', width: 10 },
  { header: 'Sabab', key: 'readyReason', width: 14 },
  { header: 'Tayyor', key: 'readyAt', width: 18 },
  { header: 'Javob berildi', key: 'answeredAt', width: 18 },
  { header: "To'ladi", key: 'paidAt', width: 18 },
  { header: 'Rad etdi', key: 'rejectedAt', width: 18 },
  { header: 'Oxirgi xabar', key: 'lastClientMessageAt', width: 18 },
] as const;

export async function exportRows(timeZone: string) {
  const leads = await Lead.find().sort({ createdAt: -1 }).lean();
  return leads.map((l) => {
    const a = l.answers ?? {};
    const dt = (d?: Date | null) => (d ? formatDateTime(d, timeZone) : '');
    return {
      date: dt(l.createdAt),
      name: displayName(l),
      username: l.username ? `@${l.username}` : '',
      telegramId: l.telegramId,
      source: l.source ?? '',
      language: l.language ?? '',
      height: a.height ?? '',
      weight: a.weight ?? '',
      age: a.age ?? '',
      trainingExperience: a.trainingExperience ?? '',
      goal: a.goal ?? '',
      targetWeight: a.targetWeight ?? '',
      trainingDays: a.trainingDays ?? '',
      trainingLocation: a.trainingLocation ?? '',
      previousAttempts: a.previousAttempts ?? '',
      healthProblems: a.healthProblems ?? '',
      bmi: l.bmi ?? '',
      status: statusLabel(l.status),
      mode: l.mode,
      urgent: l.urgent ? 'ha' : "yo'q",
      readyReason: l.readyReason ?? '',
      readyAt: dt(l.readyAt),
      answeredAt: dt(l.answeredAt),
      paidAt: dt(l.paidAt),
      rejectedAt: dt(l.rejectedAt),
      lastClientMessageAt: dt(l.lastClientMessageAt),
    };
  });
}

export async function exportXlsx(timeZone: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TEMUR.FIT bot';
  const ws = wb.addWorksheet('Leadlar');
  ws.columns = EXPORT_COLUMNS.map((c) => ({ ...c }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const row of await exportRows(timeZone)) ws.addRow(row);
  ws.autoFilter = { from: 'A1', to: { row: 1, column: EXPORT_COLUMNS.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function exportCsv(timeZone: string): Promise<Buffer> {
  const rows = await exportRows(timeZone);
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [EXPORT_COLUMNS.map((c) => esc(c.header)).join(',')];
  for (const r of rows) lines.push(EXPORT_COLUMNS.map((c) => esc((r as Record<string, unknown>)[c.key])).join(','));
  return Buffer.from('﻿' + lines.join('\r\n'), 'utf8'); // BOM so Excel opens UTF-8 correctly
}
