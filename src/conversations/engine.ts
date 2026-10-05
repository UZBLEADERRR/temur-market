import { Types } from 'mongoose';
import { Lead, type LeadDoc } from '../database/models/Lead';
import { Message } from '../database/models/Message';
import { AdminEvent, Reminder } from '../database/models/misc';
import type { AiService } from '../ai/aiService';
import { buildSystem, buildUserText } from '../ai/promptBuilder';
import { stripMarkers, type AiResponse } from '../ai/responseSchema';
import { parseAnswers, parseTargetWeight, inRange } from '../leads/answerParser';
import { bmiBand, calcBmi } from '../leads/bmi';
import { missingFields, missingHint, nextStep, pickAck, questionText, stripLeadingAck } from '../leads/questionnaire';
import type { LeadService } from '../leads/leadService';
import { displayName } from '../leads/leadCard';
import { detectSource } from '../leads/sourceDetector';
import type { SettingsService } from '../services/settings';
import { retrieveExamples } from '../style/examples';
import { isChatClosedError, type TelegramGateway } from '../telegram/gateway';
import type { LeadAnswers, LeadStatus, QuestionStep, ReadyReason } from '../types/domain';
import { containsAny, detectLanguage, escapeHtml, fillTemplate, isGreetingOnly, normalize, splitKeywords, type Lang } from '../utils/text';
import { KeyedMutex } from '../utils/limiter';
import { formatLocal, HOUR, parseLocal, sleep, zonedParts } from '../utils/time';
import { logger } from '../utils/logger';

export interface ClientInfo {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface IncomingClientMessage {
  connectionId: string;
  chat: ClientInfo;
  messageId: number;
  text: string;
  kind: 'text' | 'voice' | 'photo' | 'video' | 'sticker' | 'other';
  voice?: { fileId: string; mimeType?: string };
  photo?: { fileId: string };
  date?: Date;
}

export interface EngineOptions {
  /** Overrides the debounce setting (tests use 0 and call flush()). */
  debounceMsOverride?: number;
  /** Disables typing delays (tests). */
  fastTyping?: boolean;
  now?: () => Date;
  /** Client-facing time zone (follow-up times, quiet hours). */
  timeZone?: string;
}

const ACTIVE_STATUSES: LeadStatus[] = ['NEW', 'QUESTIONNAIRE', 'SALES'];

export function isAiActive(lead: { mode?: string | null; status?: string | null; alwaysOn?: boolean | null }): boolean {
  return lead.mode === 'AI' && (ACTIVE_STATUSES.includes(lead.status as LeadStatus) || Boolean(lead.alwaysOn));
}

/**
 * The questionnaire state machine. Receives client / coach messages from Telegram Business,
 * decides (backend rules + LLM) what to answer, and hands the chat to the coach on [TAYYOR].
 */
export class ConversationEngine {
  private readonly mutex = new KeyedMutex();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly deps: {
      gateway: TelegramGateway;
      ai: AiService;
      settings: SettingsService;
      leads: LeadService;
    },
    private readonly opts: EngineOptions = {},
  ) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  // ───────────────────────────── incoming ─────────────────────────────

  async handleClientMessage(msg: IncomingClientMessage): Promise<LeadDoc> {
    let lead = await Lead.findOne({ businessConnectionId: msg.connectionId, chatId: msg.chat.id });
    const now = msg.date ?? this.now();
    let text = msg.text ?? '';

    if (!lead) {
      const detected = await detectSource(text);
      lead = await Lead.create({
        businessConnectionId: msg.connectionId,
        chatId: msg.chat.id,
        telegramId: msg.chat.id,
        username: msg.chat.username,
        firstName: msg.chat.first_name,
        lastName: msg.chat.last_name,
        name: [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || undefined,
        language: detectLanguage(detected.cleanedText) ?? 'uz',
        source: detected.source,
        sourceRaw: text.slice(0, 200),
        status: 'NEW',
        mode: (await this.deps.settings.bool('ai_enabled')) ? 'AI' : 'MANUAL',
      });
      text = detected.cleanedText;
      logger.info({ leadId: String(lead._id), source: detected.source }, 'New lead created');
    } else {
      // keep profile fresh
      lead.username = msg.chat.username ?? lead.username;
      lead.firstName = msg.chat.first_name ?? lead.firstName;
      lead.lastName = msg.chat.last_name ?? lead.lastName;
    }

    if (!text && msg.kind !== 'text' && msg.kind !== 'voice') {
      text = `[${msg.kind === 'photo' ? 'rasm' : msg.kind === 'video' ? 'video' : msg.kind === 'sticker' ? 'stiker' : 'fayl'}]`;
    }

    const active = isAiActive(lead);
    await Message.create({
      leadId: lead._id,
      telegramMessageId: msg.messageId,
      telegramId: msg.chat.id,
      direction: 'incoming',
      sender: 'client',
      kind: msg.kind,
      text,
      processed: !active,
      // voice is transcribed when the batch is processed, so the Telegram update loop is never blocked
      meta:
        msg.kind === 'voice' && msg.voice
          ? { voiceFileId: msg.voice.fileId, mimeType: msg.voice.mimeType }
          : msg.photo
            ? { photoFileId: msg.photo.fileId }
            : undefined,
    });
    const isFirst = !lead.lastClientMessageAt;
    lead.lastClientMessageAt = now;
    // the client is back — a planned «o'ylab ko'raman» reminder is no longer needed
    if (lead.followUpAt) lead.followUpAt = undefined;
    if (active) lead.pendingSince ??= now;
    await lead.save();
    logger.info({ leadId: String(lead._id), kind: msg.kind, active }, 'Incoming client message');

    if (active) await this.scheduleAsync(String(lead._id), { first: isFirst, voice: msg.kind === 'voice' });
    return lead;
  }

  /** TEMUR wrote in the chat himself → AI is off for this chat for good (until re-enabled by admin). */
  async handleCoachMessage(input: { connectionId: string; chat: ClientInfo; messageId: number; text: string; kind: string }): Promise<void> {
    let lead = await Lead.findOne({ businessConnectionId: input.connectionId, chatId: input.chat.id });
    if (!lead) {
      lead = await Lead.create({
        businessConnectionId: input.connectionId,
        chatId: input.chat.id,
        telegramId: input.chat.id,
        username: input.chat.username,
        firstName: input.chat.first_name,
        lastName: input.chat.last_name,
        name: [input.chat.first_name, input.chat.last_name].filter(Boolean).join(' ') || undefined,
        status: 'ANSWERED',
        mode: 'MANUAL',
        readyReason: 'manual_takeover',
        answeredAt: this.now(),
      });
    }
    await Message.create({
      leadId: lead._id,
      telegramMessageId: input.messageId,
      telegramId: input.chat.id,
      direction: 'outgoing',
      sender: 'temur',
      kind: input.kind,
      text: input.text,
    });
    await this.takeover(lead, 'coach_message');
  }

  /** Marks a chat as handled by the coach (manual message from Telegram or from the mini app). */
  async takeover(lead: LeadDoc, why: string): Promise<void> {
    const stops = !lead.alwaysOn && (await this.deps.settings.bool('coach_message_stops_ai'));
    if (!stops) {
      // the coach answered himself: what the client wrote so far is covered by his message;
      // the AI keeps going and takes the coach's words into account on the next client message
      this.cancel(String(lead._id));
      await Message.updateMany({ leadId: lead._id, processed: false }, { $set: { processed: true } });
      lead.pendingSince = undefined;
      lead.lastOutgoingAt = this.now();
      if (lead.status === 'READY') {
        lead.status = 'ANSWERED';
        lead.answeredAt ??= this.now();
      }
      await lead.save();
      await AdminEvent.create({ type: 'coach_message', leadId: lead._id, data: { why } });
      await this.deps.leads.refreshCards(lead);
      return;
    }
    this.cancel(String(lead._id));
    const wasAi = lead.mode === 'AI';
    lead.mode = 'MANUAL';
    lead.pendingSince = undefined;
    if (['NEW', 'QUESTIONNAIRE', 'READY'].includes(lead.status)) {
      if (lead.status !== 'READY') lead.readyReason ??= 'manual_takeover';
      lead.status = 'ANSWERED';
      lead.answeredAt ??= this.now();
    }
    lead.lastOutgoingAt = this.now();
    await lead.save();
    await Message.updateMany({ leadId: lead._id, processed: false }, { $set: { processed: true } });
    if (wasAi) {
      await AdminEvent.create({ type: 'manual_takeover', leadId: lead._id, data: { why } });
      logger.info({ leadId: String(lead._id), why }, 'Manual takeover — AI disabled for chat');
    }
    await this.deps.leads.refreshCards(lead);
  }

  // ───────────────────────────── scheduling ─────────────────────────────

  /**
   * Waits until the client stops writing: every new message restarts the timer
   * (Telegram does not tell bots that a client is typing, so a quiet period is used instead).
   */
  private async scheduleAsync(leadId: string, hint: { first?: boolean; voice?: boolean } = {}): Promise<void> {
    const s = this.deps.settings;
    const base = await s.num(hint.first ? 'debounce_first_seconds' : 'debounce_seconds');
    const extra = hint.voice ? await s.num('debounce_voice_extra_seconds') : 0;
    const ms = this.opts.debounceMsOverride ?? (base + extra) * 1000;
    this.cancel(leadId);
    if (ms <= 0) {
      await this.process(leadId).catch((err) => logger.error({ err: (err as Error).message, leadId }, 'Process failed'));
      return;
    }
    const t = setTimeout(() => {
      this.timers.delete(leadId);
      void this.process(leadId).catch((err) => logger.error({ err: (err as Error).message, leadId }, 'Process failed'));
    }, ms);
    this.timers.set(leadId, t);
  }

  cancel(leadId: string): void {
    const t = this.timers.get(leadId);
    if (t) clearTimeout(t);
    this.timers.delete(leadId);
  }

  stopAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Processes all unprocessed client messages of one lead (serialized per lead). */
  process(leadId: string): Promise<void> {
    return this.mutex.run(leadId, () => this.processLocked(leadId));
  }

  // ───────────────────────────── core ─────────────────────────────

  private async processLocked(leadId: string): Promise<void> {
    const lead = await Lead.findById(leadId);
    if (!lead || !isAiActive(lead)) return;
    if (!(await this.deps.settings.bool('ai_enabled'))) return;

    const pending = await Message.find({ leadId: lead._id, sender: 'client', processed: false }).sort({ createdAt: 1 });
    if (!pending.length) {
      lead.pendingSince = undefined;
      await lead.save();
      return;
    }
    // spam / flood protection: too many messages in a short time → AI steps back, the coach decides
    const floodLimit = await this.deps.settings.num('flood_limit');
    const recentCount = await Message.countDocuments({
      leadId: lead._id,
      sender: 'client',
      createdAt: { $gte: new Date(this.now().getTime() - 5 * 60_000) },
    });
    if (floodLimit > 0 && recentCount > floodLimit) {
      await Message.updateMany({ leadId: lead._id, processed: false }, { $set: { processed: true } });
      lead.mode = 'MANUAL';
      lead.readyReason = 'flood';
      lead.pendingSince = undefined;
      await lead.save();
      await AdminEvent.create({ type: 'flood', leadId: lead._id, data: { recentCount } });
      await this.deps.gateway
        .notifyAdmins(`⚠️ Juda ko'p xabar (${recentCount} ta / 5 daqiqa) — AI shu chatda to'xtadi: <a href="tg://user?id=${lead.telegramId}">${escapeHtml(displayName(lead))}</a>`)
        .catch(() => undefined);
      return;
    }
    // only the latest messages of a big batch matter (spam, 20 photos in a row…)
    if (pending.length > 15) {
      await Message.updateMany({ _id: { $in: pending.slice(0, pending.length - 15).map((m) => m._id) } }, { $set: { processed: true } });
      pending.splice(0, pending.length - 15);
    }
    for (const m of pending) {
      const meta = m.meta as { voiceFileId?: string; mimeType?: string } | undefined;
      if (m.kind === 'voice' && !m.text && meta?.voiceFileId) {
        const t = await this.transcribeVoice(meta.voiceFileId, meta.mimeType).catch((err) => {
          logger.warn({ err: (err as Error).message }, 'Voice transcription failed');
          return '';
        });
        m.text = t ? `[ovozli xabar] ${t}` : '[ovozli xabar, matni aniqlanmadi]';
        await Message.updateOne({ _id: m._id }, { $set: { text: m.text } });
      }
    }
    const pendingIds = pending.map((m) => m._id);
    const newText = pending.map((m) => m.text).filter(Boolean).join('\n').slice(0, 3000);
    const photoIds = pending
      .map((m) => (m.meta as { photoFileId?: string } | undefined)?.photoFileId)
      .filter((x): x is string => Boolean(x));
    // stickers / emoji only and nothing to look at → nothing to answer
    const meaningful = pending.some((m) => m.kind === 'photo' || /\p{L}|\d/u.test(m.text.replace(/^\[(stiker|fayl|video)\]$/, '')));
    if (!meaningful) {
      await Message.updateMany({ _id: { $in: pendingIds } }, { $set: { processed: true } });
      lead.pendingSince = undefined;
      await lead.save();
      return;
    }
    const lang: Lang = detectLanguage(newText) ?? (lead.language as Lang) ?? 'uz';
    lead.language = lang;

    const markProcessed = async () => {
      await Message.updateMany({ _id: { $in: pendingIds } }, { $set: { processed: true } });
      lead.pendingSince = undefined;
    };

    // 1) Hard rules that never wait for the LLM
    const safety = containsAny(newText, splitKeywords(await this.deps.settings.get('safety_keywords')));
    if (safety) {
      await markProcessed();
      return this.finishReady(lead, 'safety', true, await this.deps.settings.text('ready_message', lang));
    }
    const botQ = containsAny(newText, splitKeywords(await this.deps.settings.get('bot_question_keywords')));
    if (botQ) {
      await markProcessed();
      return this.finishReady(lead, 'bot_question', false, await this.deps.settings.text('bot_answer', lang));
    }
    const coachName = await this.deps.settings.get('coach_name');
    const coachKeywords = splitKeywords(await this.deps.settings.get('coach_request_keywords'));
    if (coachName && normalize(coachName) !== 'temur') {
      coachKeywords.push(...['bilan gaplash', "ning o'zi kerak"].map((k) => normalize(`${coachName} ${k}`)));
    }
    if (containsAny(newText, coachKeywords)) {
      await markProcessed();
      return this.finishReady(lead, 'wants_coach', false, await this.deps.settings.text('ready_message', lang));
    }

    if (lead.status === 'SALES') {
      return this.salesTurn(lead, pending.map((m) => m.text), photoIds, lang, markProcessed);
    }

    // 2) Deterministic extraction (numbers) before the LLM sees the message
    const answers: LeadAnswers = plainAnswers(lead);
    const stepBefore = nextStep(answers, (lead.skippedSteps ?? []) as number[]);
    mergeAnswers(answers, parseAnswers(newText, answers, { bareNumbers: stepBefore === 1 }));
    if (stepBefore === 2 || answers.goal === undefined) {
      const target = parseTargetWeight(newText, answers.weight);
      if (target && stepBefore >= 2 && answers.targetWeight === undefined) answers.targetWeight = target;
    }

    // 3) First contact: is the client writing about the course at all?
    const gaveBasics = answers.height !== undefined || answers.weight !== undefined || answers.age !== undefined;
    const courseSignal =
      (lead.source && lead.source !== 'unknown') ||
      gaveBasics ||
      Boolean(containsAny(newText, splitKeywords(await this.deps.settings.get('course_keywords'))));
    if (lead.status === 'NEW') {
      lead.status = 'QUESTIONNAIRE';
      const askIntent = await this.deps.settings.bool('ask_intent');
      if (courseSignal || !askIntent) {
        lead.intent = 'course';
        if (!gaveBasics && isGreetingOnly(newText) && !photoIds.length) {
          lead.answers = answers as never;
          lead.currentQuestion = 1;
          lead.lastAskedStep = 1;
          lead.askCount = 1;
          await markProcessed();
          await lead.save();
          await this.sendToClient(lead, [await this.deps.settings.text('first_message', lang)]);
          return;
        }
        // the client already wrote something meaningful → the model answers it and moves to question 1
        if (!gaveBasics) lead.lastAskedStep = 0;
      } else if (isGreetingOnly(newText) && !photoIds.length) {
        // only "Salom" — ask what it is about
        lead.intent = 'asked';
        lead.lastAskedStep = 0;
        lead.askCount = 1;
        await markProcessed();
        await lead.save();
        await this.sendToClient(lead, [await this.deps.settings.text('intent_question', lang)]);
        return;
      } else {
        // a real message without obvious keywords → the model decides whether it is about the course
        lead.intent = 'asked';
        lead.lastAskedStep = 0;
        lead.askCount = 0;
      }
    }
    if (lead.intent === 'asked' && courseSignal) lead.intent = 'course';

    // 4) LLM turn
    if (lead.alwaysOn && !ACTIVE_STATUSES.includes(lead.status as LeadStatus)) {
      return this.coachModeTurn(lead, pending.map((m) => m.text), photoIds, lang, markProcessed);
    }
    const bmiPre = calcBmi(answers.weight, answers.height);
    const step = nextStep(answers, (lead.skippedSteps ?? []) as number[]);
    let ai: AiResponse;
    try {
      ai = await this.askAi(lead, answers, step, bmiPre, lang, pending.map((m) => m.text), (lead.lastAskedStep ?? stepBefore) as QuestionStep, photoIds);
    } catch (err) {
      await this.onAiFailure(lead, err as Error);
      return;
    }
    lead.aiFailures = 0;

    // markers inside text are honoured as well (the PDF's [TAYYOR] protocol)
    let markerReady = false;
    let markerUrgent = false;
    const messages = ai.messages
      .map((m) => {
        const s = stripMarkers(m);
        markerReady ||= s.ready;
        markerUrgent ||= s.urgent;
        return s.text;
      })
      .filter(Boolean);

    if (ai.language) lead.language = ai.language;
    const outLang = (lead.language as Lang) ?? lang;

    if (lead.intent === 'asked' && ai.action !== 'URGENT_READY' && ai.action !== 'READY' && !markerReady) {
      if (ai.action === 'NOT_LEAD' || ai.intent === 'other') {
        await markProcessed();
        return this.stopNotLead(lead, newText);
      }
      if (ai.intent === 'course') {
        lead.intent = 'course';
      } else {
        // still unclear: one clarifying question, then hand the chat to the coach
        await markProcessed();
        if ((lead.askCount ?? 0) >= 2) return this.stopNotLead(lead, newText);
        if ((lead.askCount ?? 0) === 0 && !messages.length) messages.push(await this.deps.settings.text('intent_question', outLang));
        lead.askCount = (lead.askCount ?? 0) + 1;
        await lead.save();
        await this.sendToClient(lead, messages.length ? messages.slice(0, 2) : [await this.deps.settings.text('intent_question', outLang)]);
        return;
      }
    }

    mergeAnswers(answers, sanitizeExtracted(ai.extracted ?? {}));
    // the client answered the current question but the model did not structure it → keep raw text
    // answered_current refers to the question we asked last (not the one after this message)
    const raw = newText.slice(0, 500);
    const asked = (lead.lastAskedStep ?? stepBefore) as QuestionStep;
    if (ai.answered_current) {
      if (asked === 2 && !answers.goal) answers.goal = raw;
      if (asked === 4 && !answers.previousAttempts) answers.previousAttempts = raw;
      if (asked === 5 && !answers.healthProblems) answers.healthProblems = raw;
      if (asked === 1 && !answers.trainingExperience && missingFields(answers, 1).join() === 'trainingExperience') {
        answers.trainingExperience = raw;
      }
      if (asked === 3 && !answers.trainingLocation && answers.trainingDays !== undefined) answers.trainingLocation = raw;
    }
    // loop guard: the same question was already asked twice and the client replied again → move on
    const skipped = new Set<number>((lead.skippedSteps ?? []) as number[]);
    if (asked !== 6 && lead.lastAskedStep === asked && (lead.askCount ?? 0) >= 2 && nextStep(answers, [...skipped]) === asked) {
      skipped.add(asked);
      for (const f of missingFields(answers, asked as 1 | 2 | 3 | 4 | 5)) {
        if (['trainingExperience', 'goal', 'trainingLocation', 'previousAttempts', 'healthProblems'].includes(f)) {
          (answers as Record<string, unknown>)[f] = `(aniq emas) ${raw}`.slice(0, 500);
        }
      }
      lead.skippedSteps = [...skipped] as never;
    }
    if (!answers.goal && answers.targetWeight !== undefined && step >= 2) answers.goal = `${answers.targetWeight} kg`;

    lead.answers = answers as never;
    lead.bmi = calcBmi(answers.weight, answers.height);
    lead.targetBmi = calcBmi(answers.targetWeight, answers.height);
    await markProcessed();

    // 5) Decide
    const minTarget = await this.deps.settings.num('min_target_bmi');
    if (lead.targetBmi !== undefined && lead.targetBmi !== null && lead.targetBmi < minTarget) {
      return this.finishReady(lead, 'low_target_bmi', true, await this.deps.settings.text('ready_message', outLang));
    }
    if (ai.action === 'URGENT_READY' || markerUrgent) {
      return this.finishReady(lead, (ai.reason as ReadyReason) === 'low_target_bmi' ? 'low_target_bmi' : 'safety', true, await this.deps.settings.text('ready_message', outLang));
    }
    if (ai.action === 'READY' || markerReady) {
      if (ai.reason === 'bot_question') {
        return this.finishReady(lead, 'bot_question', false, await this.deps.settings.text('bot_answer', outLang));
      }
      if (ai.reason === 'wants_coach') {
        return this.finishReady(lead, 'wants_coach', false, await this.deps.settings.text('ready_message', outLang));
      }
      if (asked === 5 && !answers.healthProblems) answers.healthProblems = newText.slice(0, 500);
      lead.answers = answers as never;
    }

    const after = nextStep(answers, [...skipped]);
    lead.currentQuestion = after;
    if (after === 6 && (await this.deps.settings.bool('sales_mode'))) {
      // questionnaire done → the coach gets the card, the AI moves on to selling the course
      lead.status = 'SALES';
      lead.readyReason = 'completed';
      lead.questionnaireDoneAt = this.now();
      await lead.save();
      await AdminEvent.create({ type: 'questionnaire_done', leadId: lead._id });
      logger.info({ leadId: String(lead._id) }, 'Questionnaire complete — sales stage');
      await this.deps.leads.sendCard(lead);
      const priceKnown = /\d/.test((await this.deps.settings.get('price_list')) + (await this.deps.settings.get('course_info')));
      if (!priceKnown) {
        await this.deps.gateway
          .notifyAdmins("⚠️ Kurs narxi kiritilmagan — AI narxni ayta olmaydi. Mini ilova → «Murabbiy haqida» → «Narxlar va tariflar» va «To'lov ma'lumoti» ni to'ldiring.")
          .catch(() => undefined);
      }
      return this.salesTurn(lead, pending.map((m) => m.text), photoIds, outLang, async () => undefined);
    }
    if (after === 6) {
      const closing =
        (await this.deps.settings.bool('ai_closing_message')) && messages.length && !messages.some((m) => m.includes('?'))
          ? messages.slice(0, 2)
          : [await this.deps.settings.text('ready_message', outLang)];
      return this.finishReady(lead, 'completed', false, closing);
    }

    if (ai.action === 'NO_RESPONSE') {
      await lead.save();
      return;
    }
    if (ai.action === 'PAUSE') {
      await lead.save();
      await this.sendToClient(lead, messages.slice(0, 1));
      return;
    }

    // ASK_NEXT — trust the model's wording; correct it only when it asks the wrong question
    const recentAi = await this.recentAiTexts(lead, 4);
    // the very first bot message keeps the greeting of the fixed first message
    const canonical =
      after === 1 && recentAi.length === 0
        ? await this.deps.settings.text('first_message', outLang)
        : stripLeadingAck(await questionText(after, outLang, lead.bmi ?? undefined, this.deps.settings));
    const bandChanged =
      after === 2 &&
      ai.question === 2 &&
      bmiBand(bmiPre, await this.deps.settings.num('bmi_high'), await this.deps.settings.num('bmi_low')) !==
        bmiBand(lead.bmi ?? undefined, await this.deps.settings.num('bmi_high'), await this.deps.settings.num('bmi_low'));
    const askedWrong = ai.question !== null && ai.question !== undefined && ai.question !== after;
    const alreadyAsked = lead.lastAskedStep === after;
    let out = messages;
    // the model says which question it asked; people often drop the "?" so the text alone is not enough
    const modelAsked = ai.question === after || out.some(looksLikeQuestion);
    if (askedWrong || bandChanged || (!alreadyAsked && !modelAsked)) {
      // keep the model's side answer, then ask the expected question with a fresh acknowledgement
      const side = out.filter((m) => !looksLikeQuestion(m) && !isBareAck(m));
      const greeted = side.some(isGreeting);
      // never greet twice: after the model's own greeting use question 1 without «Assalomu alaykum»
      const question = greeted && after === 1 ? await this.deps.settings.text('q1', outLang) : canonical;
      const ack = side.length || recentAi.length === 0 ? '' : pickAck(await this.deps.settings.text('ack_words', outLang), recentAi, (lead.askCount ?? 0) + after + recentAi.length);
      out = [...side.slice(0, 2), ack ? `${ack}. ${question}` : question];
    }
    // never send the exact same text twice in a row
    const seen = new Set(recentAi.map((m) => normalize(m)));
    out = out.filter((m) => !seen.has(normalize(m)));
    if (!out.length) {
      await lead.save();
      return;
    }
    const asksNow = modelAsked || out.some(looksLikeQuestion);
    if (asksNow) {
      lead.askCount = lead.lastAskedStep === after ? (lead.askCount ?? 0) + 1 : 1;
      lead.lastAskedStep = after;
    }
    await lead.save();
    await this.sendToClient(lead, out.slice(0, 3));
    void this.maybeSummarize(lead).catch(() => undefined);
  }

  private async askAi(
    lead: LeadDoc,
    answers: LeadAnswers,
    step: QuestionStep,
    bmi: number | undefined,
    lang: Lang,
    newMessages: string[],
    askedStep: QuestionStep,
    photoIds: string[] = [],
    coachMode = false,
    salesMode = false,
    salesDirective = '',
  ): Promise<AiResponse> {
    const s = this.deps.settings;
    const historyLimit = await s.num('history_messages');
    const historyDocs = await Message.find({ leadId: lead._id, processed: true })
      .sort({ createdAt: -1 })
      .limit(historyLimit)
      .select('sender text')
      .lean();
    const history = historyDocs.reverse().map((m) => ({ sender: m.sender, text: m.text }));
    const remaining: Array<{ step: number; text: string }> = [];
    for (let i = step; i <= 5; i++) {
      if (missingFields(answers, i as 1 | 2 | 3 | 4 | 5).length === 0) continue;
      const firstContact = i === 1 && !(await Message.exists({ leadId: lead._id, sender: 'ai' }));
      remaining.push({ step: i, text: firstContact ? await s.text('first_message', lang) : await questionText(i as QuestionStep, lang, bmi, s) });
    }
    const queryForExamples = `${newMessages.join(' ')} ${remaining[0]?.text ?? ''}`;
    const examples = await retrieveExamples(queryForExamples, lang, await s.num('examples_per_request'), lead.telegramId % 1000, { sales: salesMode });
    const input = {
      systemPrompt: await s.get('system_prompt'),
      coachName: await s.get('coach_name'),
      coachInfo: await s.get('coach_info'),
      styleProfile: await s.get('style_profile'),
      examples,
      lang,
      source: lead.source,
      answers,
      bmi,
      step,
      askedStep,
      remainingQuestions: remaining,
      missing: missingHint(answers, step),
      botAnswer: await s.text('bot_answer', lang),
      priceReply: await s.text('price_reply', lang),
      courseInfo: await s.get('course_info'),
      results: await s.get('coach_results'),
      ackWords: await s.text('ack_words', lang),
      intentPending: lead.intent === 'asked',
      coachMode,
      salesMode,
      salesPrompt: salesMode ? fillTemplate(await s.get('sales_prompt'), { coach_name: await s.get('coach_name') }) : undefined,
      salesDirective,
      nowLocal: formatLocal(this.now(), this.tz()),
      clientName: lead.firstName ?? undefined,
      soldContext: lead.readyReason === 'sold',
      priceList: salesMode ? await s.get('price_list') : undefined,
      paymentDetails: salesMode ? await s.get('payment_details') : undefined,
      allowAdvice: await s.bool('allow_advice'),
      photos: photoIds.length,
      lastAiMessages: (await this.recentAiTexts(lead, 3)).reverse(),
      summary: lead.summary,
      history,
      newMessages,
    };
    const images = await this.loadImages(photoIds);
    return this.deps.ai.reply(buildSystem(input), buildUserText(input), { leadId: String(lead._id), step }, images);
  }

  private async onAiFailure(lead: LeadDoc, err: Error): Promise<void> {
    lead.aiFailures = (lead.aiFailures ?? 0) + 1;
    await lead.save();
    logger.error({ leadId: String(lead._id), failures: lead.aiFailures, err: err.message }, 'AI failed — nothing sent to client');
    if (lead.aiFailures >= 2 && !lead.aiFailureNotifiedAt) {
      lead.aiFailureNotifiedAt = this.now();
      await lead.save();
      await this.deps.gateway
        .notifyAdmins(
          `⚠️ AI javob bera olmayapti (${lead.aiFailures} marta).\nMijoz: <a href="tg://user?id=${lead.telegramId}">${escapeHtml(displayName(lead))}</a>${lead.username ? ' @' + escapeHtml(lead.username) : ''}\nBot qayta urinadi. Shoshilinch bo'lsa o'zingiz yozing.`,
        )
        .catch(() => undefined);
    }
  }

  /** [TAYYOR] / [TAYYOR: ehtiyot]: send final text, switch to MANUAL/READY, card to the coach. */
  private async finishReady(lead: LeadDoc, reason: ReadyReason, urgent: boolean, text: string | string[]): Promise<void> {
    lead.status = 'READY';
    lead.readyReason = reason;
    lead.urgent = urgent || lead.urgent;
    lead.readyAt = this.now();
    if (reason === 'sold') lead.soldAt = this.now();
    lead.pendingSince = undefined;
    await lead.save();
    // the final message is the only one allowed after the decision; mode flips right after it
    await this.sendToClient(lead, Array.isArray(text) ? text : [text], { final: true });
    lead.mode = lead.alwaysOn && !urgent ? 'AI' : 'MANUAL';
    await lead.save();
    this.cancel(String(lead._id));
    await AdminEvent.create({ type: urgent ? 'tayyor_ehtiyot' : 'tayyor', leadId: lead._id, data: { reason } });
    logger.info({ leadId: String(lead._id), reason, urgent }, urgent ? '[TAYYOR: ehtiyot]' : '[TAYYOR]');
    await this.deps.leads.sendCard(lead);
  }

  /** Not a course lead: the AI stays silent and the chat goes to the coach without a lead card. */
  private async stopNotLead(lead: LeadDoc, text: string): Promise<void> {
    lead.intent = 'other';
    lead.mode = 'MANUAL';
    lead.readyReason = 'not_lead';
    lead.pendingSince = undefined;
    await lead.save();
    this.cancel(String(lead._id));
    await AdminEvent.create({ type: 'not_lead', leadId: lead._id });
    logger.info({ leadId: String(lead._id) }, 'Not a course lead — AI stopped');
    await this.deps.gateway
      .notifyAdmins(
        `💬 Kurs bo'yicha emas (AI to'xtadi): <a href="tg://user?id=${lead.telegramId}">${escapeHtml(displayName(lead))}</a>${lead.username ? ' @' + escapeHtml(lead.username) : ''}\n<i>${escapeHtml(text.slice(0, 300))}</i>`,
      )
      .catch(() => undefined);
  }

  /** Sales stage: the AI presents the course, handles objections and closes; then the coach sends the group link. */
  private async salesTurn(lead: LeadDoc, newMessages: string[], photoIds: string[], lang: Lang, markProcessed: () => Promise<void>): Promise<void> {
    const s = this.deps.settings;
    const step = lead.salesStep ?? 0;
    const turns = lead.salesTurns ?? 0;
    const directive = await this.salesDirective(step, turns);
    let ai: AiResponse;
    try {
      ai = await this.askAi(lead, plainAnswers(lead), 6, lead.bmi ?? undefined, lang, newMessages, 6, photoIds, false, true, directive);
    } catch (err) {
      await this.onAiFailure(lead, err as Error);
      return;
    }
    lead.aiFailures = 0;
    await markProcessed();
    if (ai.language) lead.language = ai.language;
    const outLang = (lead.language as Lang) ?? lang;
    const recent = new Set((await this.recentAiTexts(lead, 4)).map(normalize));
    let markerUrgent = false;
    const out = ai.messages
      .map((m) => {
        const x = stripMarkers(m);
        markerUrgent ||= x.urgent;
        return x.text;
      })
      .filter((m) => m && !recent.has(normalize(m)));

    if (ai.action === 'URGENT_READY' || markerUrgent) return this.finishReady(lead, 'safety', true, await s.text('ready_message', outLang));
    if (ai.action === 'READY' && ai.reason === 'bot_question') return this.finishReady(lead, 'bot_question', false, await s.text('bot_answer', outLang));
    if (ai.action === 'READY') return this.finishReady(lead, 'wants_coach', false, out.length ? out.slice(0, 2) : [await s.text('ready_message', outLang)]);
    if (ai.action === 'SOLD') {
      // optionally the AI stays as the coach's assistant after the sale (the coach still sends the group link)
      if (await s.bool('ai_after_sale')) lead.alwaysOn = true;
      lead.followUpAt = undefined;
      return this.finishReady(lead, 'sold', false, out.length ? out.slice(0, 2) : [await s.text('ready_message', outLang)]);
    }
    if (ai.action === 'REFUSED') return this.finishReady(lead, 'refused', false, out.slice(0, 2));
    if (ai.action === 'NO_RESPONSE' || !out.length) {
      await lead.save();
      return;
    }
    // the payment details are sent exactly as the admin wrote them (never retyped by the model)
    const payment = (await s.get('payment_details')).trim() || paymentFromInfo(`${await s.get('price_list')}\n${await s.get('course_info')}`);
    const reachedPayment = (ai.sales_step ?? 0) >= 3;
    if (reachedPayment && payment && step < 3 && !containsPayment(out.join('\n'), payment)) out.push(payment);
    if (ai.follow_up_at) await this.planFollowUp(lead, ai.follow_up_at, ai.follow_up_note ?? '');
    lead.salesStep = Math.max(step, Math.min(3, ai.sales_step ?? step));
    lead.salesTurns = turns + 1;
    await lead.save();
    await this.sendToClient(lead, out.slice(0, 4));
    void this.maybeSummarize(lead).catch(() => undefined);
  }

  private tz(): string {
    return this.opts.timeZone ?? 'Asia/Tashkent';
  }

  /**
   * «Ertaga o'ylab ko'raman» → remember to write again. Kept inside Telegram's 24h window after the client's
   * last message and outside night hours (22:00–09:00 client time).
   */
  private async planFollowUp(lead: LeadDoc, when: string, note: string): Promise<void> {
    if ((lead.followUpsSent ?? 0) >= (await this.deps.settings.num('max_follow_ups'))) return;
    const now = this.now();
    let at = parseLocal(when, this.tz()) ?? new Date(now.getTime() + 20 * HOUR);
    const local = zonedParts(at, this.tz());
    if (local.hour >= 22) at = new Date(at.getTime() + (24 - local.hour + 10) * HOUR - local.minute * 60_000);
    else if (local.hour < 9) at = new Date(at.getTime() + (10 - local.hour) * HOUR - local.minute * 60_000);
    const windowEnd = (lead.lastClientMessageAt ?? now).getTime() + 23 * HOUR;
    if (at.getTime() > windowEnd) at = new Date(windowEnd);
    if (at.getTime() < now.getTime() + 30 * 60_000) at = new Date(now.getTime() + 30 * 60_000);
    lead.followUpAt = at;
    lead.followUpNote = note.slice(0, 300);
    logger.info({ leadId: String(lead._id), at: at.toISOString() }, 'Follow-up planned');
  }

  /** Sends the planned follow-up: a short, context-aware nudge written by the model. */
  followUp(leadId: string): Promise<boolean> {
    return this.mutex.run(leadId, async () => {
      const lead = await Lead.findById(leadId);
      if (!lead || !isAiActive(lead) || !lead.followUpAt || lead.status !== 'SALES') return false;
      const lang = (lead.language as Lang) ?? 'uz';
      const directive = `ESLATMA VAQTI: mijoz o'ylab ko'rishini aytgan edi${lead.followUpNote ? ` (${lead.followUpNote})` : ''}. Yangi xabar yo'q — sen o'zing yozyapsan. Salom bilan, samimiy va qisqa eslat, qaror haqida yengil so'ra yoki yordam taklif qil. Bosim yo'q, narxni takrorlama (so'ramasa).`;
      let ai: AiResponse;
      try {
        ai = await this.askAi(lead, plainAnswers(lead), 6, lead.bmi ?? undefined, lang, [], 6, [], false, true, directive);
      } catch (err) {
        await this.onAiFailure(lead, err as Error);
        return false;
      }
      lead.followUpAt = undefined;
      lead.followUpsSent = (lead.followUpsSent ?? 0) + 1;
      await lead.save();
      const out = ai.messages.map((m) => stripMarkers(m).text).filter(Boolean).slice(0, 2);
      const sent = out.length ? await this.sendToClient(lead, out, { kind: 'follow_up' }) : 0;
      logger.info({ leadId, sent }, 'Follow-up sent');
      return sent > 0;
    });
  }

  /** Tells the model where the sale is and what the next concrete step must be, so it always moves towards payment. */
  private async salesDirective(step: number, turns: number): Promise<string> {
    const max = await this.deps.settings.num('max_sales_turns');
    if (step >= 3) {
      return "To'lov ma'lumoti allaqachon berilgan. Mijoz «to'ladim» desa yoki chek/skrinshot yuborsa → action=SOLD, reason=paid. Savoli bo'lsa qisqa javob ber va chekni yuborishini eslat. To'lov ma'lumotini mijoz so'ramasa qayta yuborma.";
    }
    if (turns >= max) {
      return "Suhbat cho'zildi. Endi to'g'ridan-to'g'ri yopish: mijoz rozi bo'lsa yoki ikkilanmasa — to'lov ma'lumotini ber (sales_step=3) va chek so'ra; aks holda bitta aniq savol: «To'lov ma'lumotini yuboraymi?»";
    }
    if (step === 0) {
      return "Anketadan sotuvga tabiiy o'tish: avval mijozning o'z so'zlari bilan uning holatini qisqa qaytar (maqsadi, oldin nima xalaqit bergani) — u tushunilganini his qilsin. Keyin unga qanday yordam berishingni 1–2 gapda ayt va mos formatni narxi bilan oddiy gapda ayt (ro'yxat emas). Oxirida bitta yengil savol: «Sizga shu format to'g'ri keladimi?» yoki «Boshlaymizmi?». 2–3 ta qisqa xabar, reklama ohangi yo'q.";
    }
    return "Mijoz rozi bo'lsa yoki qanday to'lashni so'rasa — DARHOL to'lov ma'lumotini ber (sales_step=3) va chek yuborishini so'ra. E'tiroz bo'lsa — 1–2 gap bilan javob (natijadan misol), keyin yana yopish savoli. Har javob aniq harakatga chaqiruv bilan tugasin, umumiy gap bilan cho'zma.";
  }

  /** After the questionnaire, for "always on" clients: free conversation as the coach's assistant. */
  private async coachModeTurn(lead: LeadDoc, newMessages: string[], photoIds: string[], lang: Lang, markProcessed: () => Promise<void>): Promise<void> {
    let ai: AiResponse;
    try {
      ai = await this.askAi(lead, plainAnswers(lead), 6, lead.bmi ?? undefined, lang, newMessages, 6, photoIds, true);
    } catch (err) {
      await this.onAiFailure(lead, err as Error);
      return;
    }
    await markProcessed();
    if (ai.action === 'URGENT_READY') {
      lead.alwaysOn = false;
      return this.finishReady(lead, 'safety', true, await this.deps.settings.text('ready_message', lang));
    }
    await lead.save();
    const recent = new Set((await this.recentAiTexts(lead, 4)).map(normalize));
    const out = ai.messages.map((m) => stripMarkers(m).text).filter((m) => m && !recent.has(normalize(m)));
    if (ai.action !== 'NO_RESPONSE' && out.length) await this.sendToClient(lead, out.slice(0, 3), { final: true });
  }

  /** Downloads up to N client photos for the model to look at (body photos, food, screenshots). */
  private async loadImages(photoIds: string[]): Promise<Array<{ mimeType: string; data: string }>> {
    const max = await this.deps.settings.num('max_images_per_turn');
    const out: Array<{ mimeType: string; data: string }> = [];
    for (const id of photoIds.slice(-Math.max(0, max))) {
      try {
        const buf = await this.deps.gateway.downloadFile(id);
        if (buf.length > 0 && buf.length < 5 * 1024 * 1024) out.push({ mimeType: 'image/jpeg', data: buf.toString('base64') });
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Photo download failed');
      }
    }
    return out;
  }

  private async recentAiTexts(lead: LeadDoc, n: number): Promise<string[]> {
    const docs = await Message.find({ leadId: lead._id, sender: 'ai' }).sort({ createdAt: -1 }).limit(n).select('text').lean();
    return docs.map((d) => d.text);
  }

  // ───────────────────────────── sending ─────────────────────────────

  /** Sends messages "like a human": typing indicator, delay proportional to length, stop if the coach took over. */
  async sendToClient(lead: LeadDoc, texts: string[], opts: { final?: boolean; kind?: string; at?: Date } = {}): Promise<number> {
    let sent = 0;
    for (const raw of texts) {
      const text = stripMarkers(raw).text;
      if (!text) continue;
      const fresh = await Lead.findById(lead._id).select('mode status').lean();
      if (!fresh || fresh.mode !== 'AI' || (!opts.final && !ACTIVE_STATUSES.includes(fresh.status as LeadStatus))) {
        logger.info({ leadId: String(lead._id) }, 'Send skipped: chat is no longer in AI mode');
        break;
      }
      try {
        await this.typing(lead, text);
        const again = await Lead.findById(lead._id).select('mode').lean();
        if (again?.mode !== 'AI') break;
        if (!opts.final && (await Message.exists({ leadId: lead._id, sender: 'client', processed: false }))) {
          // the client is still writing — stop here, the next batch is answered together
          logger.info({ leadId: String(lead._id) }, 'Send interrupted by a new client message');
          break;
        }
        const res = await this.deps.gateway.sendBusinessMessage(lead.businessConnectionId, lead.chatId, text);
        await Message.create({
          leadId: lead._id,
          telegramMessageId: res.messageId,
          telegramId: lead.chatId,
          direction: 'outgoing',
          sender: 'ai',
          kind: opts.kind ?? 'text',
          text,
        });
        lead.lastOutgoingAt = opts.at ?? this.now();
        await Lead.updateOne({ _id: lead._id }, { $set: { lastOutgoingAt: lead.lastOutgoingAt } });
        sent++;
        logger.info({ leadId: String(lead._id), kind: opts.kind ?? 'text', len: text.length }, 'Outgoing AI message');
      } catch (err) {
        logger.error({ leadId: String(lead._id), err: (err as Error).message }, 'Failed to send business message');
        const reason = String((err as { description?: string }).description ?? (err as Error).message).slice(0, 200);
        if (isChatClosedError(err)) {
          // bot paused in this chat / connection gone / 24h window closed → AI stops for this chat
          await Lead.updateOne({ _id: lead._id }, { $set: { mode: 'MANUAL', readyReason: 'send_blocked' } });
          lead.mode = 'MANUAL';
          await AdminEvent.create({ type: 'send_blocked', leadId: lead._id, data: { err: reason } });
        }
        // never fail silently: the coach must know the client got no answer
        await this.deps.gateway
          .notifyAdmins(
            `⚠️ Mijozga xabar yuborilmadi: <a href="tg://user?id=${lead.telegramId}">${escapeHtml(displayName(lead))}</a>\n` +
              `Telegram javobi: <code>${escapeHtml(reason)}</code>\n` +
              (isChatClosedError(err)
                ? "Sabab odatda: bot shu chatda <b>pauzada</b> yoki Telegram Business → Chatbots'da <b>javob berish ruxsati</b> o'chiq. Pauzani olib tashlang, so'ng mini ilovada «🧹 Tozalash» yoki «AI ni qayta yoqish» ni bosing."
                : 'Bot keyinroq qayta urinadi.'),
          )
          .catch(() => undefined);
        break;
      }
    }
    return sent;
  }

  private async typing(lead: LeadDoc, text: string): Promise<void> {
    if (!this.opts.fastTyping) {
      // a person reads the message first, then starts typing
      await sleep(700 + Math.random() * 1500);
    }
    await this.deps.gateway.sendTyping(lead.businessConnectionId, lead.chatId).catch(() => undefined);
    if (this.opts.fastTyping) return;
    const perChar = (await this.deps.settings.num('typing_ms_per_char')) * (0.75 + Math.random() * 0.5);
    const max = await this.deps.settings.num('typing_max_ms');
    const ms = Math.min(max, 800 + text.length * perChar);
    // Telegram shows "typing" for ~5s; refresh for long delays
    let left = ms;
    while (left > 0) {
      const chunk = Math.min(left, 4500);
      await sleep(chunk);
      left -= chunk;
      if (left > 0) await this.deps.gateway.sendTyping(lead.businessConnectionId, lead.chatId).catch(() => undefined);
    }
  }

  private async transcribeVoice(fileId: string, mimeType = 'audio/ogg'): Promise<string> {
    const buf = await this.deps.gateway.downloadFile(fileId);
    if (buf.length > 15 * 1024 * 1024) return '';
    return (await this.deps.ai.transcribe(buf, mimeType)).trim();
  }

  /** Keeps a rolling summary so the LLM only needs the last N messages. */
  private async maybeSummarize(lead: LeadDoc): Promise<void> {
    const limit = await this.deps.settings.num('history_messages');
    const total = await Message.countDocuments({ leadId: lead._id });
    if (total <= limit + 10 || total - (lead.summaryMessageCount ?? 0) < 10) return;
    const older = await Message.find({ leadId: lead._id }).sort({ createdAt: 1 }).limit(total - limit).select('sender text').lean();
    const transcript = older.map((m) => `${m.sender === 'client' ? 'Mijoz' : 'Murabbiy'}: ${m.text}`).join('\n');
    const summary = await this.deps.ai.freeText(
      "Suhbatni 3-5 qatorda qisqa xulosa qil: mijoz nima dedi, nima so'radi, kayfiyati. Faqat faktlar.",
      transcript.slice(0, 8000),
    );
    await Lead.updateOne({ _id: lead._id }, { $set: { summary: summary.slice(0, 1500), summaryMessageCount: total } });
  }

  /** Admin "clear data": the client starts from zero as if they wrote for the first time. */
  async resetLead(leadId: string): Promise<boolean> {
    this.cancel(leadId);
    const lead = await Lead.findById(leadId);
    if (!lead) return false;
    await Message.deleteMany({ leadId: lead._id });
    await Reminder.deleteMany({ leadId: lead._id });
    await Lead.updateOne(
      { _id: lead._id },
      {
        $set: { answers: {}, status: 'NEW', mode: 'AI', urgent: false, remindersSent: 0, aiFailures: 0, askCount: 0, skippedSteps: [], currentQuestion: 1, adminCardMessageIds: [], salesStep: 0, salesTurns: 0, followUpsSent: 0 },
        $unset: {
          intent: '', bmi: '', targetBmi: '', readyReason: '', summary: '', summaryMessageCount: '', lastAskedStep: '', pendingSince: '',
          lastClientMessageAt: '', lastOutgoingAt: '', readyAt: '', answeredAt: '', paidAt: '', rejectedAt: '', aiFailureNotifiedAt: '', questionnaireDoneAt: '', soldAt: '', followUpAt: '', followUpNote: '',
        },
      },
    );
    await AdminEvent.create({ type: 'lead_reset', leadId: lead._id });
    logger.info({ leadId }, 'Lead data cleared by admin');
    return true;
  }

  /** Leads whose processing failed (AI down) or was interrupted by a restart. */
  async retryPending(olderThanMs = 2 * 60_000): Promise<number> {
    const cutoff = new Date(this.now().getTime() - olderThanMs);
    const leads = await Lead.find({
      mode: 'AI',
      status: { $in: ACTIVE_STATUSES },
      pendingSince: { $lte: cutoff },
      aiFailures: { $lt: 6 },
    })
      .select('_id')
      .limit(20)
      .lean();
    for (const l of leads) {
      if (!this.timers.has(String(l._id))) await this.process(String(l._id));
    }
    return leads.length;
  }
}

/** Lead answers as a plain object without nulls / mongoose wrappers. */
export function plainAnswers(lead: { answers?: unknown }): LeadAnswers {
  const a = lead.answers as { toObject?: () => Record<string, unknown> } | Record<string, unknown> | undefined;
  const obj = (a && typeof (a as { toObject?: unknown }).toObject === 'function' ? (a as { toObject: () => Record<string, unknown> }).toObject() : (a ?? {})) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)) as LeadAnswers;
}

/** Card / payment lines found inside the course info (used when «To'lov ma'lumoti» is empty). */
export function paymentFromInfo(info: string): string {
  const lines = info.split(/\r?\n/);
  const idx = lines.findIndex((l) => /(?:\d[ -]?){16}/.test(l));
  if (idx < 0) return '';
  // the card line plus an adjacent owner / instruction line when it looks related
  const around = [lines[idx - 1], lines[idx], lines[idx + 1]].filter(
    (l, i) => l !== undefined && (i === 1 || /karta|card|карта|nomi|ism|ega|to'lov|оплат|chek|чек/i.test(l)),
  );
  return around.map((l) => l.trim()).filter(Boolean).join('\n');
}

/** True when the message already contains the payment details (card number or the first line). */
function containsPayment(text: string, payment: string): boolean {
  const digits = payment.replace(/\s+/g, '').match(/\d{8,}/)?.[0];
  if (digits) return text.replace(/\s+/g, '').includes(digits);
  return normalize(text).includes(normalize(payment.split('\n')[0]).slice(0, 40));
}

/** A question even without "?" — Uzbek/Russian question particles at the end ("tajriba bormi", "nechida"). */
export function looksLikeQuestion(text: string): boolean {
  const t = normalize(text).replace(/[.!…\s]+$/u, '');
  if (t.includes('?')) return true;
  return /(mi|mu|bormi|yo'qmi|qancha|nechta|nechi|nechida|qanaqa|qanday|qayerda|qachon|nima|nimaga|ли|сколько|какой|какая|когда|где|почему|зачем)$/u.test(t);
}

const isGreeting = (m: string) => /^(assalomu alaykum|assalom|salom|va alaykum|здравствуйте|привет|добрый)/i.test(normalize(m));

const isBareAck = (m: string) => /^(tushunarli|tushundim|aha|zo'r|yaxshi|hop|ok|понятно|ясно|хорошо|ага)[.!]?$/i.test(m.trim());

function mergeAnswers(target: LeadAnswers, src: LeadAnswers): void {
  for (const [k, v] of Object.entries(src) as Array<[keyof LeadAnswers, unknown]>) {
    if (v === undefined || v === null || v === '') continue;
    if (k === 'targetWeight') {
      (target as Record<string, unknown>)[k] = v;
      continue;
    }
    if (target[k] === undefined || target[k] === null || target[k] === '') (target as Record<string, unknown>)[k] = v;
  }
}

/** Never trust the model's numbers blindly. */
function sanitizeExtracted(x: LeadAnswers): LeadAnswers {
  const out: LeadAnswers = { ...x };
  if (out.height !== undefined && out.height < 3) out.height = Math.round(out.height * 100);
  if (out.height !== undefined && !inRange('height', out.height)) delete out.height;
  if (out.weight !== undefined && !inRange('weight', out.weight)) delete out.weight;
  if (out.age !== undefined && !inRange('age', out.age)) delete out.age;
  if (out.targetWeight !== undefined && !inRange('targetWeight', out.targetWeight)) delete out.targetWeight;
  if (out.trainingDays !== undefined && !inRange('trainingDays', out.trainingDays)) delete out.trainingDays;
  if (out.trainingLocation) {
    const n = normalize(out.trainingLocation);
    out.trainingLocation = /zal|зал|gym|фитнес/.test(n) ? 'zal' : /uy|дом|home/.test(n) ? 'uy' : out.trainingLocation;
  }
  return out;
}

export const _internals = { mergeAnswers, sanitizeExtracted };
export { Types };
