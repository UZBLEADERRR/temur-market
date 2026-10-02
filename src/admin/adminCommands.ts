import { InlineKeyboard, type Bot, type Context } from 'grammy';
import { Lead } from '../database/models/Lead';
import { BusinessConnection, Campaign, StyleExample } from '../database/models/misc';
import type { AppContext } from '../services/appContext';
import { SETTINGS_BY_KEY, SETTINGS_SPEC } from '../services/settingsSpec';
import { formatLeadCard } from '../leads/leadCard';
import { leadKeyboard } from '../leads/leadService';
import { importChatExport } from '../style/importService';
import { rebuildStyleProfile } from '../style/styleProfile';
import { LEAD_STATUSES, type LeadStatus } from '../types/domain';
import { escapeHtml, truncate } from '../utils/text';
import { exportCsv, exportXlsx, formatQueue, formatStats, getDailyStats } from './adminQueries';
import { logger } from '../utils/logger';

const HELP = `<b>TEMUR.FIT AI-yordamchi — admin</b>

/status — tizim holati (Business ulanish, Gemini, xatolar)
/navbat — javob kutayotgan mijozlar (eng eskisi birinchi)
/stats — bugungi statistika (/stats 2026-10-01)
/export — Excel (XLSX) · /export_csv — CSV
/lead &lt;telegramId&gt; — lead kartochkasi
/ai_off &lt;telegramId&gt; · /ai_on &lt;telegramId&gt; — chatda AI ni o'chirish/yoqish
/always_on &lt;id&gt; · /always_off &lt;id&gt; — AI shu mijoz bilan doimiy yozishsin
/reset &lt;id&gt; — mijoz ma'lumotlarini tozalash (bot noldan boshlaydi)

<b>Sozlamalar</b> (hammasini mini ilovada ham o'zgartirish mumkin)
/settings — barcha kalitlar
/get &lt;kalit&gt; · /set &lt;kalit&gt; [qiymat] · /reset_setting &lt;kalit&gt;
/prompt — system promptni ko'rish va yangilash
/ai_global_off · /ai_global_on — AI ni butunlay o'chirish/yoqish

<b>Uslub</b>
Chat eksportini (.html / .json / .txt) shu yerga yuboring → anonim namunalar
Ovozli xabar yuboring → transkript uslub manbaiga qo'shiladi
/style — uslub profili · /style_rebuild — profilni qayta yaratish
/examples — namunalar soni · /examples_clear — hammasini o'chirish

<b>Manbalar</b>
/campaigns · /campaign_add &lt;kod&gt; &lt;manba&gt; · /campaign_del &lt;kod&gt;
Masalan: /campaign_add #v3 video_03`;

/** Admin commands in the bot's own private chat. Only TELEGRAM_ADMIN_ID / ADMIN_IDS may use them. */
export function registerAdminHandlers(bot: Bot, app: AppContext): void {
  const awaiting = new Map<number, string>(); // adminId → setting key waiting for a value
  const isAdmin = (ctx: Context) => Boolean(ctx.from && app.env.adminIds.includes(ctx.from.id));
  const tz = app.env.TZ_NAME;

  const admin = bot.chatType('private').filter(isAdmin);

  bot.chatType('private').filter((ctx) => !isAdmin(ctx) && Boolean(ctx.message)).use(async (ctx) => {
    await ctx.reply('Bu bot TEMUR.FIT ichki tizimi.');
  });

  const reply = (ctx: Context, html: string, extra: Record<string, unknown> = {}) =>
    ctx.reply(html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });

  admin.command(['start', 'help'], async (ctx) => {
    const kb = app.env.publicUrl ? new InlineKeyboard().webApp('📋 Mini ilova', `${app.env.publicUrl}/app/`) : undefined;
    await reply(ctx, HELP, kb ? { reply_markup: kb } : {});
  });

  /** Diagnostics: Business connection rights, AI switch, LLM health, recent problems. */
  admin.command('status', async (ctx) => {
    const lines: string[] = ['🩺 <b>Holat</b>'];
    lines.push(`AI umumiy: ${(await app.settings.bool('ai_enabled')) ? '✅ yoqilgan' : '⛔️ o\'chirilgan (/ai_global_on)'}`);
    const conns = await BusinessConnection.find().lean();
    if (!conns.length) lines.push("Business ulanish: ❌ yo'q — Telegram Business → Chatbots'da botni ulang");
    for (const c of conns) {
      try {
        const live = await bot.api.getBusinessConnection(c.connectionId);
        const r = (live.rights ?? {}) as { can_reply?: boolean; can_read_messages?: boolean };
        lines.push(`Business (${escapeHtml(live.user.first_name)}): ${live.is_enabled ? '✅ faol' : '⛔️ o\'chiq'} · javob ruxsati: ${r.can_reply === false ? '❌ yo\'q' : '✅ bor'}`);
      } catch (err) {
        lines.push(`Business ulanish: ❌ ${escapeHtml((err as Error).message.slice(0, 120))}`);
      }
    }
    try {
      const started = Date.now();
      await app.ai.freeText('Faqat OK deb javob ber.', 'ping');
      lines.push(`Gemini (${escapeHtml((await app.settings.get('llm_model')) || app.env.LLM_MODEL)}): ✅ ${Date.now() - started} ms`);
    } catch (err) {
      lines.push(`Gemini: ❌ <code>${escapeHtml((err as Error).message.slice(0, 200))}</code>`);
    }
    const blocked = await Lead.countDocuments({ readyReason: 'send_blocked' });
    const failing = await Lead.countDocuments({ aiFailures: { $gt: 0 } });
    lines.push(`Yuborib bo'lmagan chatlar: ${blocked} · AI xatosi bor chatlar: ${failing}`);
    await reply(ctx, lines.join('\n'));
  });

  admin.command('navbat', async (ctx) => reply(ctx, await formatQueue(tz)));

  admin.command('stats', async (ctx) => {
    const arg = ctx.match?.trim();
    const day = arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? new Date(`${arg}T12:00:00Z`) : new Date();
    await reply(ctx, formatStats(await getDailyStats(tz, day), tz));
  });

  admin.command('export', async (ctx) => {
    const buf = await exportXlsx(tz);
    await app.gateway.sendAdminDocument(ctx.chat.id, buf, `leads_${new Date().toISOString().slice(0, 10)}.xlsx`, '📤 Leadlar');
  });
  admin.command('export_csv', async (ctx) => {
    const buf = await exportCsv(tz);
    await app.gateway.sendAdminDocument(ctx.chat.id, buf, `leads_${new Date().toISOString().slice(0, 10)}.csv`, '📤 Leadlar (CSV)');
  });

  const findLead = async (arg?: string) => {
    const id = Number(arg?.trim().replace(/^@/, ''));
    if (Number.isFinite(id) && id > 0) return Lead.findOne({ telegramId: id }).sort({ updatedAt: -1 });
    if (arg?.trim()) return Lead.findOne({ username: arg.trim().replace(/^@/, '') }).sort({ updatedAt: -1 });
    return null;
  };

  admin.command('lead', async (ctx) => {
    const lead = await findLead(ctx.match);
    if (!lead) return reply(ctx, 'Topilmadi. /lead 123456789 yoki /lead @username');
    await reply(ctx, formatLeadCard(lead.toObject(), tz), { reply_markup: leadKeyboard(lead, app.env.publicUrl) });
  });

  admin.command('ai_off', async (ctx) => {
    const lead = await findLead(ctx.match);
    if (!lead) return reply(ctx, 'Topilmadi.');
    app.engine.cancel(String(lead._id));
    await app.leads.setMode(String(lead._id), 'MANUAL', ctx.from?.id);
    await reply(ctx, `🤖 AI o'chirildi: ${lead.telegramId}`);
  });
  admin.command('ai_on', async (ctx) => {
    const lead = await findLead(ctx.match);
    if (!lead) return reply(ctx, 'Topilmadi.');
    await app.leads.setMode(String(lead._id), 'AI', ctx.from?.id);
    await reply(ctx, `🤖 AI qayta yoqildi: ${lead.telegramId}. Mijoz keyingi xabar yozganda davom etadi.`);
  });
  admin.command(['always_on', 'always_off'], async (ctx) => {
    const lead = await findLead(ctx.match);
    if (!lead) return reply(ctx, 'Topilmadi.');
    const on = ctx.message?.text?.startsWith('/always_on') ?? false;
    lead.alwaysOn = on;
    if (on) lead.mode = 'AI';
    await lead.save();
    await reply(ctx, on ? `♾ AI ${lead.telegramId} bilan doimiy yozishadi.` : `Doimiy rejim o'chirildi: ${lead.telegramId}`);
  });
  admin.command('reset', async (ctx) => {
    const lead = await findLead(ctx.match);
    if (!lead) return reply(ctx, "Topilmadi. /reset 123456789 yoki /reset @username (sozlama uchun: /reset_setting kalit)");
    await app.engine.resetLead(String(lead._id));
    await reply(ctx, `🧹 Tozalandi: ${lead.telegramId}. Keyingi xabarida bot noldan boshlaydi.`);
  });
  admin.command('ai_global_off', async (ctx) => {
    await app.settings.set({ ai_enabled: false });
    await reply(ctx, "⛔️ AI barcha chatlarda to'xtatildi.");
  });
  admin.command('ai_global_on', async (ctx) => {
    await app.settings.set({ ai_enabled: true });
    await reply(ctx, '✅ AI yoqildi.');
  });

  // ── settings ──
  admin.command('settings', async (ctx) => {
    const values = await app.settings.all();
    let group = '';
    const lines: string[] = [];
    for (const def of SETTINGS_SPEC) {
      if (def.group !== group) {
        group = def.group;
        lines.push(`\n<b>${escapeHtml(group)}</b>`);
      }
      const v = String(values[def.key] ?? '');
      lines.push(`<code>${def.key}</code> — ${escapeHtml(truncate(v.replace(/\s+/g, ' '), 60))}`);
    }
    await reply(ctx, `⚙️ <b>Sozlamalar</b>\n/get kalit · /set kalit qiymat${lines.join('\n')}`);
  });

  admin.command('get', async (ctx) => {
    const key = ctx.match?.trim();
    const def = key ? SETTINGS_BY_KEY.get(key) : undefined;
    if (!def) return reply(ctx, "Noma'lum kalit. /settings");
    const v = String((await app.settings.all())[def.key] ?? '');
    if (v.length > 3500) {
      await app.gateway.sendAdminDocument(ctx.chat.id, Buffer.from(v, 'utf8'), `${def.key}.txt`, escapeHtml(def.label));
    } else {
      await reply(ctx, `<b>${escapeHtml(def.label)}</b>\n<pre>${escapeHtml(v)}</pre>`);
    }
  });

  admin.command('set', async (ctx) => {
    const [key, ...rest] = (ctx.match ?? '').trim().split(/\s+/);
    const def = key ? SETTINGS_BY_KEY.get(key) : undefined;
    if (!def) return reply(ctx, "Noma'lum kalit. /settings");
    const raw = (ctx.match ?? '').trim().slice(key.length).trim();
    if (rest.length && raw) {
      await app.settings.set({ [key]: raw });
      return reply(ctx, `✅ <code>${key}</code> yangilandi.`);
    }
    awaiting.set(ctx.from!.id, key);
    await reply(ctx, `✍️ <b>${escapeHtml(def.label)}</b> uchun yangi qiymatni yuboring (matn yoki .txt fayl). /cancel — bekor qilish.`);
  });

  admin.command('reset_setting', async (ctx) => {
    const key = ctx.match?.trim();
    if (!key || !SETTINGS_BY_KEY.has(key)) return reply(ctx, "Noma'lum kalit. /settings");
    await app.settings.reset(key);
    await reply(ctx, `↩️ <code>${key}</code> standart qiymatga qaytarildi.`);
  });

  admin.command('prompt', async (ctx) => {
    const v = await app.settings.get('system_prompt');
    await app.gateway.sendAdminDocument(ctx.chat.id, Buffer.from(v, 'utf8'), 'system_prompt.txt', 'Joriy system prompt');
    awaiting.set(ctx.from!.id, 'system_prompt');
    await reply(ctx, '✍️ Yangi promptni matn yoki .txt fayl qilib yuboring. /cancel — bekor qilish.');
  });

  admin.command('cancel', async (ctx) => {
    awaiting.delete(ctx.from!.id);
    await reply(ctx, 'Bekor qilindi.');
  });

  // ── style ──
  admin.command('style', async (ctx) => {
    const v = await app.settings.get('style_profile');
    await reply(ctx, `<b>Uslub profili</b>\n<pre>${escapeHtml(truncate(v, 3500))}</pre>\n/set style_profile — o'zgartirish`);
  });
  admin.command('style_rebuild', async (ctx) => {
    const count = await StyleExample.countDocuments({ enabled: true });
    if (!count) return reply(ctx, "Namunalar yo'q. Avval chat eksportini yuboring.");
    await reply(ctx, `⏳ ${count} ta namunadan profil yaratilmoqda...`);
    try {
      const { profile, stats } = await rebuildStyleProfile(app.ai, app.settings);
      await reply(ctx, `✅ Profil yangilandi (o'rtacha ${stats.avgWordsPerMessage} so'z/xabar).\n<pre>${escapeHtml(truncate(profile, 3000))}</pre>`);
    } catch (err) {
      await reply(ctx, `❌ Xatolik: ${escapeHtml((err as Error).message.slice(0, 200))}`);
    }
  });
  admin.command('examples', async (ctx) => {
    const total = await StyleExample.countDocuments();
    const sample = await StyleExample.aggregate<{ client: string; coach: string[] }>([{ $sample: { size: 3 } }]);
    const s = sample.map((e) => `Mijoz: ${escapeHtml(truncate(e.client, 120))}\nMurabbiy: ${escapeHtml(e.coach.join(' / '))}`).join('\n\n');
    await reply(ctx, `📚 Namunalar: ${total}\n\n${s}`);
  });
  admin.command('examples_clear', async (ctx) => {
    const r = await StyleExample.deleteMany({});
    await reply(ctx, `🗑 ${r.deletedCount} ta namuna o'chirildi.`);
  });

  // ── campaigns ──
  admin.command('campaigns', async (ctx) => {
    const list = await Campaign.find().sort({ source: 1 }).lean();
    const lines = list.map((c) => `<code>${escapeHtml(c.code)}</code> → ${escapeHtml(c.source)}`);
    await reply(
      ctx,
      `📍 <b>Manba kodlari</b>\n${lines.join('\n') || "yo'q"}\n\nChat link xabariga kodni qo'shing, masalan: «Salom! #v3». Kodsiz #video_03 kabi heshteg ham ishlaydi.`,
    );
  });
  admin.command('campaign_add', async (ctx) => {
    const [code, source, ...desc] = (ctx.match ?? '').trim().split(/\s+/);
    if (!code || !source) return reply(ctx, 'Format: /campaign_add &lt;kod&gt; &lt;manba&gt;');
    await Campaign.updateOne({ code }, { $set: { source, description: desc.join(' ') } }, { upsert: true });
    await reply(ctx, `✅ ${escapeHtml(code)} → ${escapeHtml(source)}`);
  });
  admin.command('campaign_del', async (ctx) => {
    const code = ctx.match?.trim();
    const r = await Campaign.deleteOne({ code });
    await reply(ctx, r.deletedCount ? "🗑 O'chirildi" : 'Topilmadi');
  });

  // ── lead card buttons ──
  bot.callbackQuery(/^st:(\w+):([a-f0-9]{24})$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: "Ruxsat yo'q" });
    const status = ctx.match[1] as LeadStatus;
    if (!LEAD_STATUSES.includes(status)) return ctx.answerCallbackQuery();
    const lead = await app.leads.setStatus(ctx.match[2], status, ctx.from.id);
    await ctx.answerCallbackQuery({ text: lead ? `Status: ${status}` : 'Topilmadi' });
  });

  // ── files, voice and awaited values ──
  admin.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    const name = doc.file_name ?? 'file';
    if ((doc.file_size ?? 0) > 20 * 1024 * 1024) return reply(ctx, 'Fayl juda katta (20MB dan kichik bo\'lsin).');
    const content = (await app.gateway.downloadFile(doc.file_id)).toString('utf8');
    const key = awaiting.get(ctx.from.id);
    if (key) {
      awaiting.delete(ctx.from.id);
      await app.settings.set({ [key]: content.trim() });
      return reply(ctx, `✅ <code>${key}</code> fayldan yangilandi (${content.length} belgi).`);
    }
    if (!/\.(html?|json|txt)$/i.test(name)) return reply(ctx, 'Faqat Telegram eksporti: .html, .json yoki .txt');
    try {
      const res = await importChatExport(name, content, {
        coachId: app.env.TEMUR_TELEGRAM_ID,
        coachName: await app.settings.get('coach_name'),
      });
      const total = await StyleExample.countDocuments();
      await reply(
        ctx,
        `✅ Import: ${res.chats} chat, ${res.messages} xabar → ${res.examples} ta anonim namuna (jami ${total}).\nIsm, raqam, narx, sog'liq ma'lumotlari olib tashlandi.\n/style_rebuild — uslub profilini yangilash`,
      );
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Import failed');
      await reply(ctx, `❌ Import xatosi: ${escapeHtml((err as Error).message.slice(0, 200))}`);
    }
  });

  admin.on(['message:voice', 'message:audio'], async (ctx) => {
    const v = ctx.message.voice ?? ctx.message.audio!;
    await reply(ctx, '⏳ Transkripsiya...');
    try {
      const text = await app.ai.transcribe(await app.gateway.downloadFile(v.file_id), v.mime_type ?? 'audio/ogg');
      const prev = await app.settings.get('voice_style_notes');
      await app.settings.set({ voice_style_notes: `${prev}\n\n${text}`.trim().slice(-20000) });
      await reply(ctx, `✅ Uslub manbaiga qo'shildi:\n<i>${escapeHtml(truncate(text, 1500))}</i>`);
    } catch (err) {
      await reply(ctx, `❌ ${escapeHtml((err as Error).message.slice(0, 200))}`);
    }
  });

  admin.on('message:text', async (ctx) => {
    const key = awaiting.get(ctx.from.id);
    if (!key) return reply(ctx, 'Buyruqlar: /help');
    awaiting.delete(ctx.from.id);
    try {
      await app.settings.set({ [key]: ctx.message.text });
      await reply(ctx, `✅ <code>${key}</code> yangilandi.`);
    } catch (err) {
      await reply(ctx, `❌ ${escapeHtml((err as Error).message)}`);
    }
  });
}
