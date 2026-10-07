import type { LeadData } from '../database/models/Lead';
import { escapeHtml, truncate } from '../utils/text';
import { formatDateTime } from '../utils/time';

const STATUS_LABEL: Record<string, string> = {
  NEW: 'Yangi',
  QUESTIONNAIRE: 'Anketa',
  SALES: 'Sotuvda (AI sotyapti)',
  READY: 'Tayyor (javob kutmoqda)',
  ANSWERED: 'Javob berildi',
  PAID: "To'ladi",
  REJECTED: 'Rad etdi',
};

const REASON_LABEL: Record<string, string> = {
  completed: '5 ta savol tugadi',
  wants_coach: "Murabbiy bilan gaplashmoqchi",
  bot_question: '«Botmisiz?» deb so\'radi',
  safety: "Xavfli holat (ochlik/qusish/o'ziga zarar)",
  low_target_bmi: 'Maqsad TMI juda past',
  manual_takeover: "Murabbiy o'zi yozdi",
  not_lead: "Kurs bo'yicha emas",
  flood: "Juda ko'p xabar (spam)",
  send_blocked: 'Telegram yuborishga ruxsat bermadi (pauza?)',
  sold: "💰 Sotildi — guruh linkini yuboring",
  refused: 'Kursdan voz kechdi',
  payment_request: "💳 Karta so'rayapti — to'lov ma'lumotini yuboring",
};

export const statusLabel = (s: string) => STATUS_LABEL[s] ?? s;

const v = (x: unknown, suffix = '') => (x === undefined || x === null || x === '' ? '—' : `${escapeHtml(String(x))}${suffix}`);

export function displayName(lead: Pick<LeadData, 'name' | 'firstName' | 'lastName'>): string {
  return lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'Nomaʼlum';
}

/** HTML lead card sent to the admin chat (Telegram parse_mode HTML). */
export function formatLeadCard(lead: LeadData & { _id?: unknown }, timeZone: string): string {
  const a = lead.answers ?? {};
  const head = lead.readyReason === 'payment_request'
    ? "💳 <b>KARTA SO'RAYAPTI — to'lov ma'lumotini o'zingiz yuboring</b>"
    : lead.urgent
    ? '🔴 <b>SHOSHILINCH LEAD</b>'
    : lead.readyReason === 'sold'
      ? "💰 <b>SOTILDI — to'lovni tekshirib, guruh linkini yuboring</b>"
      : lead.readyReason === 'payment_request'
        ? "💳 <b>KARTA SO'RAYAPTI — to'lov ma'lumotini o'zingiz yuboring</b>"
      : lead.readyReason === 'refused'
        ? '❌ <b>KURSDAN VOZ KECHDI</b>'
        : lead.status === 'SALES'
          ? '📋 <b>ANKETA TUGADI — AI kursni sotyapti</b>'
          : '🔥 <b>YANGI LEAD</b>';
  const userLink = `<a href="tg://user?id=${lead.telegramId}">${escapeHtml(displayName(lead))}</a>`;
  const lines = [
    head,
    '',
    `👤 Ism: ${userLink}`,
    `📱 Username: ${lead.username ? '@' + escapeHtml(lead.username) : '—'}`,
    `🆔 Telegram ID: <code>${lead.telegramId}</code>`,
    `📍 Manba: ${v(lead.source)}`,
    `🌐 Til: ${lead.language === 'ru' ? 'rus' : "o'zbek"}`,
    '',
    `📏 Bo'y: ${v(a.height, ' sm')}`,
    `⚖️ Vazn: ${v(a.weight, ' kg')}`,
    `🎂 Yosh: ${v(a.age)}`,
    `🏋️ Tajriba: ${v(a.trainingExperience)}`,
    '',
    `🌍 Davlat: ${v(a.country)}`,
    `🎯 Maqsad: ${v(a.goal)}${a.targetWeight ? ` (${a.targetWeight} kg)` : ''}`,
    `🏠 Trenirovka: ${a.trainingDays ?? '—'} kun / ${v(a.trainingLocation)}`,
    '',
    `📝 Oldingi urinish:\n${v(a.previousAttempts && truncate(a.previousAttempts, 400))}`,
    '',
    `❤️ Sog'liq:\n${v(a.healthProblems && truncate(a.healthProblems, 400))}`,
    a.motivation ? `\n🔥 Nega hozir:\n${v(truncate(a.motivation, 300))}` : '',
    '',
    `📊 TMI: ${v(lead.bmi)}${lead.targetBmi ? ` → maqsad TMI ${lead.targetBmi}` : ''}`,
    lead.readyReason ? `ℹ️ Sabab: ${escapeHtml(REASON_LABEL[lead.readyReason] ?? lead.readyReason)}` : '',
    `🕒 Yaratildi: ${formatDateTime(lead.createdAt as Date | undefined, timeZone)}`,
    `✅ Tayyor: ${formatDateTime(lead.readyAt as Date | undefined, timeZone)}`,
    `🚨 Shoshilinch: ${lead.urgent ? 'ha' : "yo'q"}`,
    '',
    `Status: <b>${statusLabel(lead.status)}</b> · Rejim: ${lead.mode}`,
  ];
  return lines.filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n');
}
