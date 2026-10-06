import { InlineKeyboard, type Bot, type Context } from 'grammy';
import { Lead } from '../database/models/Lead';
import { BusinessConnection, Campaign, StyleExample, VoiceClip } from '../database/models/misc';
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
import { guessClipCountry } from '../utils/country';

const CLIP_COUNTRY = { ALL: 'hammaga', KR: '🇰🇷 Koreya (won)', UZ: "🇺🇿 O'zbekiston (so'm)", OTHER: '🌍 boshqa chet el' } as const;

const HELP = `<b>TEMUR.FIT AI-yordamchi — admin</b>

/app — mini ilova (mijozlar jadvali, sozlamalar, ovozlar)
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
/faqat_anketa · /sotuv_rejimi — faqat 5 savol yoki anketa + sotuv

<b>Uslub</b>
Chat eksportini (.html / .json / .txt) shu yerga yuboring → anonim namunalar
Audio fayl yoki #uslub caption'li ovoz → uslub manbaiga qo'shiladi
/style — uslub profili · /style_rebuild — profilni qayta yaratish
/examples — namunalar soni · /examples_clear — hammasini o'chirish

<b>Ovozlar</b>
Botga ovozli xabar yuboring → saqlanadi, AI mos vaziyatda mijozga yuboradi (narx, guruh qanday ishlaydi…)
/voices — ro'yxat · caption'da #uslub — faqat uslub namunasi

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

  /** Mini app access: inline button + the bottom-left menu button (set again on every /start). */
  const sendAppButton = async (ctx: Context, withHelp: boolean) => {
    if (!app.env.publicUrl) {
      return reply(
        ctx,
        (withHelp ? HELP + '\n\n' : '') +
          "⚠️ <b>Mini ilova hali ulanmagan.</b> Railway → servis → <b>Settings → Networking → Generate Domain</b> ni bosing (yoki <code>PUBLIC_URL</code> ni kiriting), keyin botni qayta deploy qiling va /start bosing.",
      );
    }
    const url = `${app.env.publicUrl}/app/`;
    await bot.api
      .setChatMenuButton({ chat_id: ctx.chat!.id, menu_button: { type: 'web_app', text: 'Mijozlar', web_app: { url } } })
      .catch((err) => logger.warn({ err: (err as Error).message }, 'setChatMenuButton failed'));
    await reply(ctx, withHelp ? HELP : '📋 Mini ilova:', { reply_markup: new InlineKeyboard().webApp('📋 Mini ilovani ochish', url) });
  };
  admin.command(['start', 'help'], (ctx) => sendAppButton(ctx, true));
  admin.command('app', (ctx) => sendAppButton(ctx, false));

  /** Diagnostics: Business connection rights, AI switch, LLM health, recent problems. */
  admin.command('status', async (ctx) => {
    const lines: string[] = ['🩺 <b>Holat</b>'];
    lines.push(`Mini ilova: ${app.env.publicUrl ? `✅ ${escapeHtml(app.env.publicUrl)}/app/` : "❌ domen yo'q (Railway → Networking → Generate Domain)"}`);
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
    const priceList = await app.settings.get('price_list');
    const payment = await app.settings.get('payment_details');
    lines.push(`Sotuv: ${(await app.settings.bool('sales_mode')) ? '✅ yoqilgan' : "⛔️ o'chiq"} · narxlar: ${priceList.trim() ? '✅' : /\d/.test(await app.settings.get('course_info')) ? "⚠️ faqat «Kurs haqida» da" : '❌ kiritilmagan'} · to'lov ma'lumoti: ${payment.trim() ? '✅' : '❌ kiritilmagan'}`);
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
  // quick switch between «only the 5 questions» and «questions + selling»
  admin.command('faqat_anketa', async (ctx) => {
    await app.settings.set({ sales_mode: false });
    await reply(ctx, "📝 Rejim: <b>faqat 5 savol</b>. Anketa tugagach AI to'xtaydi, kartochka sizga keladi.\n/sotuv_rejimi — sotuvni qayta yoqish");
  });
  admin.command('sotuv_rejimi', async (ctx) => {
    await app.settings.set({ sales_mode: true });
    await reply(ctx, "💰 Rejim: <b>anketa + sotuv</b>. AI kursni to'lovgacha olib boradi.\n/faqat_anketa — faqat 5 savolga qaytish");
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
    const sales = await StyleExample.countDocuments({ kind: 'sales' });
    await reply(ctx, `📚 Namunalar: ${total} (uslub: ${total - sales}, sotuv: ${sales})\n\n${s}`);
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
      const salesCount = await StyleExample.countDocuments({ kind: 'sales' });
      await reply(
        ctx,
        `✅ Import: ${res.chats} chat, ${res.messages} xabar → ${res.examples} ta anonim namuna (jami ${total}, shundan sotuv namunalari: ${salesCount}).\nIsm, raqam, narx, sog'liq ma'lumotlari olib tashlandi.\n/style_rebuild — uslub profilini yangilash`,
      );
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Import failed');
      await reply(ctx, `❌ Import xatosi: ${escapeHtml((err as Error).message.slice(0, 200))}`);
    }
  });

  // ── voice library: a voice message sent to the bot is stored and later sent to clients by the AI ──
  const awaitingVoiceTitle = new Map<number, string>(); // adminId → clip id waiting for a short title
  admin.on('message:voice', async (ctx) => {
    const v = ctx.message.voice;
    const caption = (ctx.message.caption ?? '').trim();
    if (/#uslub/i.test(caption)) {
      // old behaviour on request: only a speaking-style sample
      const text = await app.ai.transcribe(await app.gateway.downloadFile(v.file_id), v.mime_type ?? 'audio/ogg').catch(() => '');
      if (text) await app.settings.set({ voice_style_notes: `${await app.settings.get('voice_style_notes')}\n\n${text}`.trim().slice(-20000) });
      return reply(ctx, text ? "✅ Uslub manbaiga qo'shildi." : "❌ Matnga aylantirib bo'lmadi.");
    }
    const existing = await VoiceClip.findOne({ fileUniqueId: v.file_unique_id });
    if (existing) return reply(ctx, `Bu ovoz allaqachon saqlangan: <b>${escapeHtml(existing.title || 'nomsiz')}</b>`);
    const clip = await VoiceClip.create({
      fileId: v.file_id,
      fileUniqueId: v.file_unique_id,
      mimeType: v.mime_type,
      duration: v.duration,
      title: caption.slice(0, 80),
    });
    await reply(ctx, '⏳ Saqlandi, matnga aylantiryapman...');
    const transcript = await app.ai.transcribe(await app.gateway.downloadFile(v.file_id), v.mime_type ?? 'audio/ogg').catch(() => '');
    clip.transcript = transcript.slice(0, 4000);
    clip.country = guessClipCountry(`${caption} ${transcript}`);
    await clip.save();
    const shortId = String(clip._id).slice(-6);
    if (!clip.title) awaitingVoiceTitle.set(ctx.from.id, String(clip._id));
    await reply(
      ctx,
      `🎙 Ovoz saqlandi (<code>${shortId}</code>, ${v.duration} s).\n` +
        (transcript ? `Matni: <i>${escapeHtml(truncate(transcript, 800))}</i>\n\n` : "Matnga aylantirib bo'lmadi — nomini aniq yozing.\n\n") +
        `Kimga: <b>${CLIP_COUNTRY[clip.country as keyof typeof CLIP_COUNTRY]}</b> (o'zgartirish: /voice_country ${shortId} KR|UZ|OTHER|ALL)\n` +
        (clip.title
          ? `Nomi: <b>${escapeHtml(clip.title)}</b>. AI uni mos vaziyatda mijozlarga yuboradi.`
          : "Bu ovoz nima haqida? Qisqa nom yozing (masalan: <i>narx</i>, <i>guruh qanday ishlaydi</i>, <i>taklif</i>). /skip — matnning o'zi yetadi."),
    );
  });

  admin.command('skip', async (ctx) => {
    awaitingVoiceTitle.delete(ctx.from!.id);
    await reply(ctx, 'Hop, nomsiz qoldi — AI ovoz matniga qarab tanlaydi.');
  });

  admin.command('voices', async (ctx) => {
    const list = await VoiceClip.find().sort({ createdAt: 1 }).lean();
    if (!list.length) return reply(ctx, "🎙 Ovozlar yo'q. Botga ovozli xabar yuboring — saqlanadi va AI mijozlarga mos vaziyatda yuboradi.");
    const lines = list.map(
      (c) =>
        `${c.enabled ? '🟢' : '⚪️'} <code>${String(c._id).slice(-6)}</code> <b>${escapeHtml(c.title || 'nomsiz')}</b> · ${CLIP_COUNTRY[(c.country ?? 'ALL') as keyof typeof CLIP_COUNTRY]} · ${c.duration ?? '?'} s · ${c.sentCount} marta yuborilgan\n<i>${escapeHtml(truncate(c.transcript || c.description || '', 120))}</i>`,
    );
    await reply(ctx, `🎙 <b>Ovozlar</b>\n\n${lines.join('\n\n')}\n\n/voice_title &lt;id&gt; &lt;nom&gt; · /voice_country &lt;id&gt; KR|UZ|OTHER|ALL · /voice_test &lt;id&gt; · /voice_off &lt;id&gt; · /voice_on &lt;id&gt; · /voice_del &lt;id&gt;`);
  });

  const findClip = async (arg?: string) => {
    const id = arg?.trim().split(/\s+/)[0];
    if (!id) return null;
    const all = await VoiceClip.find();
    return all.find((c) => String(c._id).endsWith(id)) ?? null;
  };
  admin.command('voice_country', async (ctx) => {
    const clip = await findClip(ctx.match);
    const code = (ctx.match ?? '').trim().split(/\s+/)[1]?.toUpperCase();
    if (!clip || !code || !(code in CLIP_COUNTRY)) return reply(ctx, 'Format: /voice_country &lt;id&gt; KR|UZ|OTHER|ALL');
    clip.country = code as keyof typeof CLIP_COUNTRY;
    await clip.save();
    await reply(ctx, `✅ ${escapeHtml(clip.title || 'ovoz')} → ${CLIP_COUNTRY[code as keyof typeof CLIP_COUNTRY]}`);
  });

  admin.command('voice_title', async (ctx) => {
    const clip = await findClip(ctx.match);
    if (!clip) return reply(ctx, 'Topilmadi. /voices');
    clip.title = (ctx.match ?? '').trim().split(/\s+/).slice(1).join(' ').slice(0, 80);
    await clip.save();
    await reply(ctx, `✅ Nomi: ${escapeHtml(clip.title)}`);
  });
  admin.command('voice_test', async (ctx) => {
    const clip = await findClip(ctx.match);
    if (!clip) return reply(ctx, 'Topilmadi. /voices');
    await app.gateway.sendAdminVoice(ctx.chat.id, clip.fileId, clip.title || undefined);
  });
  admin.command(['voice_off', 'voice_on'], async (ctx) => {
    const clip = await findClip(ctx.match);
    if (!clip) return reply(ctx, 'Topilmadi. /voices');
    clip.enabled = ctx.message?.text?.startsWith('/voice_on') ?? false;
    await clip.save();
    await reply(ctx, clip.enabled ? '🟢 Yoqildi' : "⚪️ O'chirildi (AI yubormaydi)");
  });
  admin.command('voice_del', async (ctx) => {
    const clip = await findClip(ctx.match);
    if (!clip) return reply(ctx, 'Topilmadi. /voices');
    await clip.deleteOne();
    await reply(ctx, "🗑 O'chirildi");
  });

  admin.on('message:audio', async (ctx) => {
    const v = ctx.message.audio;
    await reply(ctx, "ℹ️ Bu audio fayl. Mijozlarga yuboriladigan ovoz uchun Telegram'da mikrofon bilan <b>ovozli xabar</b> yozib yuboring. Bu fayl uslub manbaiga qo'shiladi.\n⏳ Transkripsiya...");
    try {
      const text = await app.ai.transcribe(await app.gateway.downloadFile(v.file_id), v.mime_type ?? 'audio/ogg');
      const prev = await app.settings.get('voice_style_notes');
      await app.settings.set({ voice_style_notes: `${prev}\n\n${text}`.trim().slice(-20000) });
      await reply(ctx, `✅ Uslub manbaiga qo'shildi:\n<i>${escapeHtml(truncate(text, 1500))}</i>`);
    } catch (err) {
      await reply(ctx, `❌ ${escapeHtml((err as Error).message.slice(0, 200))}`);
    }
  });

  admin.on('message:text', async (ctx, next) => {
    const clipId = awaitingVoiceTitle.get(ctx.from.id);
    if (clipId && !ctx.message.text.startsWith('/')) {
      awaitingVoiceTitle.delete(ctx.from.id);
      await VoiceClip.updateOne({ _id: clipId }, { $set: { title: ctx.message.text.trim().slice(0, 80) } });
      return reply(ctx, `✅ Nomi saqlandi: <b>${escapeHtml(ctx.message.text.trim().slice(0, 80))}</b>. AI uni mos vaziyatda yuboradi.`);
    }
    return next();
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
