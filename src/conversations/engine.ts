import { Types } from 'mongoose';
import { Lead, type LeadDoc } from '../database/models/Lead';
import { Message } from '../database/models/Message';
import { AdminEvent } from '../database/models/misc';
import type { AiService } from '../ai/aiService';
import { buildSystem, buildUserText } from '../ai/promptBuilder';
import { stripMarkers, type AiResponse } from '../ai/responseSchema';
import { parseAnswers, parseTargetWeight, inRange } from '../leads/answerParser';
import { bmiBand, calcBmi } from '../leads/bmi';
import { missingFields, missingHint, nextStep, questionText } from '../leads/questionnaire';
import type { LeadService } from '../leads/leadService';
import { displayName } from '../leads/leadCard';
import { detectSource } from '../leads/sourceDetector';
import type { SettingsService } from '../services/settings';
import { retrieveExamples } from '../style/examples';
import { isChatClosedError, type TelegramGateway } from '../telegram/gateway';
import type { LeadAnswers, LeadStatus, QuestionStep, ReadyReason } from '../types/domain';
import { containsAny, detectLanguage, escapeHtml, normalize, splitKeywords, type Lang } from '../utils/text';
import { KeyedMutex } from '../utils/limiter';
import { sleep } from '../utils/time';
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
  date?: Date;
}

export interface EngineOptions {
  /** Overrides the debounce setting (tests use 0 and call flush()). */
  debounceMsOverride?: number;
  /** Disables typing delays (tests). */
  fastTyping?: boolean;
  now?: () => Date;
}

const ACTIVE_STATUSES: LeadStatus[] = ['NEW', 'QUESTIONNAIRE'];

export function isAiActive(lead: { mode?: string | null; status?: string | null }): boolean {
  return lead.mode === 'AI' && ACTIVE_STATUSES.includes(lead.status as LeadStatus);
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

    if (msg.kind === 'voice' && msg.voice && isAiActive(lead)) {
      text = await this.transcribeVoice(msg.voice.fileId, msg.voice.mimeType).catch((err) => {
        logger.warn({ err: (err as Error).message }, 'Voice transcription failed');
        return '';
      });
      text = text ? `[ovozli xabar] ${text}` : '[ovozli xabar, matni aniqlanmadi]';
    } else if (!text && msg.kind !== 'text') {
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
    });
    lead.lastClientMessageAt = now;
    if (active) lead.pendingSince ??= now;
    await lead.save();
    logger.info({ leadId: String(lead._id), kind: msg.kind, active }, 'Incoming client message');

    if (active) await this.scheduleAsync(String(lead._id));
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

  private async scheduleAsync(leadId: string): Promise<void> {
    const ms = this.opts.debounceMsOverride ?? (await this.deps.settings.num('debounce_seconds')) * 1000;
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
    const pendingIds = pending.map((m) => m._id);
    const newText = pending.map((m) => m.text).filter(Boolean).join('\n');
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

    // 2) Deterministic extraction (numbers) before the LLM sees the message
    const answers: LeadAnswers = plainAnswers(lead);
    const stepBefore = nextStep(answers, (lead.skippedSteps ?? []) as number[]);
    mergeAnswers(answers, parseAnswers(newText, answers, { bareNumbers: stepBefore === 1 }));
    if (stepBefore === 2 || answers.goal === undefined) {
      const target = parseTargetWeight(newText, answers.weight);
      if (target && stepBefore >= 2 && answers.targetWeight === undefined) answers.targetWeight = target;
    }

    // 3) First contact: send the fixed first message unless the client already gave Q1 data
    if (lead.status === 'NEW') {
      lead.status = 'QUESTIONNAIRE';
      const gaveBasics = answers.height !== undefined || answers.weight !== undefined || answers.age !== undefined;
      if (!gaveBasics) {
        lead.answers = answers as never;
        lead.currentQuestion = 1;
        lead.lastAskedStep = 1;
        lead.askCount = 1;
        await markProcessed();
        await lead.save();
        await this.sendToClient(lead, [await this.deps.settings.text('first_message', lang)]);
        return;
      }
    }

    // 4) LLM turn
    const bmiPre = calcBmi(answers.weight, answers.height);
    const step = nextStep(answers, (lead.skippedSteps ?? []) as number[]);
    let ai: AiResponse;
    try {
      ai = await this.askAi(lead, answers, step, bmiPre, lang, pending.map((m) => m.text), (lead.lastAskedStep ?? stepBefore) as QuestionStep);
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
    if (after === 6) {
      return this.finishReady(lead, 'completed', false, await this.deps.settings.text('ready_message', outLang));
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

    // ASK_NEXT — make sure the asked question is the one the backend expects
    const canonical = await questionText(after, outLang, lead.bmi ?? undefined, this.deps.settings);
    const bandChanged =
      after === 2 &&
      bmiBand(bmiPre, await this.deps.settings.num('bmi_high'), await this.deps.settings.num('bmi_low')) !==
        bmiBand(lead.bmi ?? undefined, await this.deps.settings.num('bmi_high'), await this.deps.settings.num('bmi_low'));
    let out = messages;
    const askedOther = ai.question !== null && ai.question !== undefined && ai.question !== after;
    const askedNothing = !out.some((m) => m.includes('?'));
    if (after !== 1 && (askedOther || bandChanged || askedNothing || out.length === 0)) {
      // keep the model's short side answer (no question in it), then ask the canonical question
      const side = out.filter((m) => !m.includes('?') && !/^(tushunarli|понятно|hop|ok)[.!]?$/i.test(m.trim()));
      out = [...side.slice(0, 1), canonical];
    } else if (after === 1 && out.length === 0) {
      out = [`${missingHint(answers, 1)}?`];
    }
    lead.askCount = lead.lastAskedStep === after ? (lead.askCount ?? 0) + 1 : 1;
    lead.lastAskedStep = after;
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
      remaining.push({ step: i, text: await questionText(i as QuestionStep, lang, bmi, s) });
    }
    const queryForExamples = `${newMessages.join(' ')} ${remaining[0]?.text ?? ''}`;
    const examples = await retrieveExamples(queryForExamples, lang, await s.num('examples_per_request'), lead.telegramId % 1000);
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
      summary: lead.summary,
      history,
      newMessages,
    };
    return this.deps.ai.reply(buildSystem(input), buildUserText(input), { leadId: String(lead._id), step });
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
  private async finishReady(lead: LeadDoc, reason: ReadyReason, urgent: boolean, text: string): Promise<void> {
    lead.status = 'READY';
    lead.readyReason = reason;
    lead.urgent = urgent || lead.urgent;
    lead.readyAt = this.now();
    lead.pendingSince = undefined;
    await lead.save();
    // the final message is the only one allowed after the decision; mode flips right after it
    await this.sendToClient(lead, [text], { final: true });
    lead.mode = 'MANUAL';
    await lead.save();
    this.cancel(String(lead._id));
    await AdminEvent.create({ type: urgent ? 'tayyor_ehtiyot' : 'tayyor', leadId: lead._id, data: { reason } });
    logger.info({ leadId: String(lead._id), reason, urgent }, urgent ? '[TAYYOR: ehtiyot]' : '[TAYYOR]');
    await this.deps.leads.sendCard(lead);
  }

  // ───────────────────────────── sending ─────────────────────────────

  /** Sends messages "like a human": typing indicator, delay proportional to length, stop if the coach took over. */
  async sendToClient(lead: LeadDoc, texts: string[], opts: { final?: boolean; kind?: string; at?: Date } = {}): Promise<number> {
    let sent = 0;
    for (const raw of texts) {
      const text = stripMarkers(raw).text;
      if (!text) continue;
      const fresh = await Lead.findById(lead._id).select('mode status').lean();
      if (!fresh || fresh.mode !== 'AI' || (!opts.final && !['NEW', 'QUESTIONNAIRE'].includes(fresh.status))) {
        logger.info({ leadId: String(lead._id) }, 'Send skipped: chat is no longer in AI mode');
        break;
      }
      try {
        await this.typing(lead, text);
        const again = await Lead.findById(lead._id).select('mode').lean();
        if (again?.mode !== 'AI') break;
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
        if (isChatClosedError(err)) {
          // bot paused in this chat / connection gone / 24h window closed → AI stops for this chat
          await Lead.updateOne({ _id: lead._id }, { $set: { mode: 'MANUAL' } });
          lead.mode = 'MANUAL';
          await AdminEvent.create({ type: 'send_blocked', leadId: lead._id, data: { err: (err as Error).message } });
        }
        break;
      }
    }
    return sent;
  }

  private async typing(lead: LeadDoc, text: string): Promise<void> {
    await this.deps.gateway.sendTyping(lead.businessConnectionId, lead.chatId).catch(() => undefined);
    if (this.opts.fastTyping) return;
    const perChar = await this.deps.settings.num('typing_ms_per_char');
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
