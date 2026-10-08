import { Lead } from '../database/models/Lead';
import { Message } from '../database/models/Message';
import { AdminEvent } from '../database/models/misc';
import { IgComment, IgRule } from '../database/models/instagram';
import type { SettingsService } from '../services/settings';
import { containsAny, detectLanguage, splitKeywords } from '../utils/text';
import { logger } from '../utils/logger';
import { KeyedMutex } from '../utils/limiter';
import type { ChannelGateway } from './channelGateway';
import { midToNumber } from './channelGateway';
import { IG_PREFIX, igChatId, type IgAccountService } from './igAccount';
import type { InstagramClient } from './igClient';

export interface IgCommentEvent {
  id: string;
  text?: string;
  parent_id?: string;
  from?: { id: string; username?: string };
  media?: { id: string; media_product_type?: string };
}

export const DEFAULT_RULE = {
  name: 'Barcha postlar',
  keywords: '',
  publicReplies: ['Direktga yozdim 👍', 'Direktni tekshiring 🙌', 'Yozdim, direktga qarang', 'Direktda javob berdim'],
  dmText: "Assalomu alaykum! Kommentingizni ko'rdim 🙂 Kurs haqida shu yerda batafsil aytib beraman. Oldin o'zingiz haqingizda qisqacha yozing: bo'y, ves, yosh?",
};

/** «Bo'y, ves, yosh» in the opener = the first questionnaire question is already asked. */
const ASKS_FIRST_QUESTION = /bo['ʻ’`]?y|\bves\b|vazn|yosh|рост|вес|возраст/i;

const pick = <T>(list: T[]): T | undefined => list[Math.floor(Math.random() * list.length)];

export function fillVars(text: string, vars: { username?: string; name?: string }): string {
  return text
    .replace(/\{username\}/g, vars.username ? `@${vars.username}` : '')
    .replace(/\{name\}/g, vars.name ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Instagram comment automation (instead of ManyChat): a short public reply under the comment
 * and one Direct message; when the person answers, the AI continues the conversation.
 */
export class CommentService {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly perUser = new KeyedMutex();

  constructor(
    private readonly deps: {
      ig: InstagramClient;
      gateway: ChannelGateway;
      account: IgAccountService;
      settings: SettingsService;
    },
    private readonly opts: { delayOverrideMs?: number } = {},
  ) {}

  /** The panel always shows at least one rule; a fresh install starts with «every post». */
  async ensureDefaultRule(): Promise<void> {
    if (!(await IgRule.exists({}))) await IgRule.create(DEFAULT_RULE);
  }

  async findRule(mediaId: string | undefined, text: string) {
    await this.ensureDefaultRule();
    const rules = await IgRule.find({ enabled: true }).sort({ createdAt: 1 }).lean();
    // a rule made for this exact post wins over the «every post» rule
    const ordered = [...rules.filter((r) => r.mediaId && r.mediaId === mediaId), ...rules.filter((r) => !r.mediaId)];
    return ordered.find((r) => {
      const words = splitKeywords(r.keywords ?? '');
      return !words.length || Boolean(containsAny(text, words));
    });
  }

  /** Webhook entry point. Returns false for comments the bot ignores (own replies, duplicates). */
  async handle(ev: IgCommentEvent): Promise<boolean> {
    const accountId = await this.deps.account.accountId();
    if (!ev.id || !ev.from?.id) return false;
    if (accountId && ev.from.id === accountId) return false; // our own reply
    if (await IgComment.exists({ commentId: ev.id })) return false;
    const text = (ev.text ?? '').trim();
    const doc = await IgComment.create({
      commentId: ev.id,
      parentId: ev.parent_id,
      mediaId: ev.media?.id,
      mediaProductType: ev.media?.media_product_type,
      fromId: ev.from.id,
      fromUsername: ev.from.username,
      text,
    }).catch((err) => {
      if ((err as { code?: number }).code === 11000) return null;
      throw err;
    });
    if (!doc) return false;

    const skip = async (reason: string) => {
      await IgComment.updateOne({ _id: doc._id }, { $set: { status: 'skipped', skipReason: reason } });
      return true;
    };
    if (!(await this.deps.settings.bool('ig_comment_enabled'))) return skip('Avtomatik javob o\'chiq');
    if (ev.media?.media_product_type === 'AD' && !text) return skip("Bo'sh komment");
    const rule = await this.findRule(ev.media?.id, text);
    if (!rule) return skip("Kalit so'z mos kelmadi");

    const base = this.opts.delayOverrideMs ?? (await this.deps.settings.num('ig_comment_delay_seconds')) * 1000;
    const delay = this.opts.delayOverrideMs ?? Math.round(base * (0.6 + Math.random() * 0.8));
    await IgComment.updateOne({ _id: doc._id }, { $set: { ruleId: rule._id, dueAt: new Date(Date.now() + delay) } });
    await IgRule.updateOne({ _id: rule._id }, { $inc: { triggered: 1 } });
    await this.schedule(String(doc._id), delay);
    return true;
  }

  private async schedule(id: string, delay: number): Promise<void> {
    if (delay <= 0) {
      await this.run(id).catch((err) => logger.error({ err: (err as Error).message }, 'Instagram comment run failed'));
      return;
    }
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.run(id).catch((err) => logger.error({ err: (err as Error).message }, 'Instagram comment run failed'));
      }, delay),
    );
  }

  /** After a restart: comments that were waiting for their reply are finished. */
  async resumePending(): Promise<number> {
    const list = await IgComment.find({ status: 'pending', ruleId: { $ne: null }, createdAt: { $gte: new Date(Date.now() - 6 * 24 * 3600_000) } })
      .select('_id dueAt')
      .lean();
    for (const c of list) if (!this.timers.has(String(c._id))) await this.schedule(String(c._id), Math.max(0, (c.dueAt?.getTime() ?? 0) - Date.now()));
    return list.length;
  }

  stopAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Public reply + one Direct message (private reply) + a lead the AI continues with. */
  async run(id: string): Promise<void> {
    const from = await IgComment.findById(id).select('fromId').lean();
    // one person's comments are handled one after another (so two quick comments never give two Directs)
    await this.perUser.run(from?.fromId ?? id, () => this.runLocked(id));
  }

  private async runLocked(id: string): Promise<void> {
    const c = await IgComment.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { status: 'done' } }, { new: true });
    if (!c) return;
    const rule = c.ruleId ? await IgRule.findById(c.ruleId).lean() : null;
    if (!rule) {
      await IgComment.updateOne({ _id: c._id }, { $set: { status: 'skipped', skipReason: "Qoida o'chirilgan" } });
      return;
    }
    const vars = { username: c.fromUsername ?? undefined };
    const errors: string[] = [];

    const replyText = pick((rule.publicReplies ?? []).map((r) => r.trim()).filter(Boolean));
    if (replyText) {
      try {
        const text = fillVars(replyText, vars);
        const r = await this.deps.ig.replyToComment(c.commentId, text);
        c.publicReply = text;
        c.publicReplyId = r.id;
      } catch (err) {
        errors.push(`Javob: ${(err as Error).message}`);
      }
    }

    const dmTemplate = (rule.dmText ?? '').trim();
    if (dmTemplate && c.fromId) {
      const cooldownH = await this.deps.settings.num('ig_comment_dm_cooldown_hours');
      const accountId = await this.deps.account.accountId();
      const connectionId = `${IG_PREFIX}${accountId ?? 'me'}`;
      const chatId = igChatId(c.fromId);
      const existing = await Lead.findOne({ businessConnectionId: connectionId, chatId });
      const recentDm = await IgComment.exists({
        _id: { $ne: c._id },
        fromId: c.fromId,
        dmSent: true,
        createdAt: { $gte: new Date(Date.now() - cooldownH * 3600_000) },
      });
      const talking = existing?.lastClientMessageAt && Date.now() - existing.lastClientMessageAt.getTime() < 7 * 24 * 3600_000;
      if (recentDm || talking) {
        c.skipReason = 'Direct yuborilmadi: bu odam bilan allaqachon yozishilyapti';
        if (existing) c.leadId = existing._id;
      } else {
        try {
          const dm = fillVars(dmTemplate, vars);
          const r = await this.deps.ig.privateReply(c.commentId, dm);
          this.deps.gateway.rememberMid(r.messageId);
          c.dmText = dm;
          c.dmSent = true;
          const lead = await this.startLead({ connectionId, chatId, comment: c, dm, messageId: r.messageId, existing });
          c.leadId = lead._id;
          await IgRule.updateOne({ _id: rule._id }, { $inc: { dmsSent: 1 } });
        } catch (err) {
          errors.push(`Direct: ${(err as Error).message}`);
        }
      }
    }

    if (errors.length) {
      c.error = errors.join(' · ').slice(0, 500);
      if (!c.publicReplyId && !c.dmSent) c.status = 'failed';
      logger.warn({ commentId: c.commentId, err: c.error }, 'Instagram comment automation failed');
    }
    await c.save();
  }

  /** The person who commented becomes a lead; their answer in Direct is handled by the AI like any chat. */
  private async startLead(p: {
    connectionId: string;
    chatId: number;
    comment: { fromId?: string | null; fromUsername?: string | null; text: string; commentId: string; mediaId?: string | null };
    dm: string;
    messageId: string;
    existing: InstanceType<typeof Lead> | null;
  }) {
    const ai = await this.deps.settings.bool('ai_enabled');
    const lead =
      p.existing ??
      (await Lead.create({
        businessConnectionId: p.connectionId,
        chatId: p.chatId,
        telegramId: p.chatId,
        channel: 'instagram',
        igUserId: p.comment.fromId,
        username: p.comment.fromUsername,
        name: p.comment.fromUsername,
        language: detectLanguage(p.comment.text) ?? 'uz',
        source: 'instagram_comment',
        sourceRaw: p.comment.text.slice(0, 200),
        status: 'NEW',
        mode: ai ? 'AI' : 'MANUAL',
      }));
    const asksFirst = ASKS_FIRST_QUESTION.test(p.dm);
    await Lead.updateOne(
      { _id: lead._id },
      {
        $set: {
          igCommentId: p.comment.commentId,
          igMediaId: p.comment.mediaId,
          igCommentText: p.comment.text.slice(0, 500),
          ...(lead.status === 'NEW'
            ? { status: 'QUESTIONNAIRE', intent: 'course', lastAskedStep: asksFirst ? 1 : 0, askCount: asksFirst ? 1 : 0, currentQuestion: 1 }
            : {}),
          lastOutgoingAt: new Date(),
        },
      },
    );
    // the AI sees the comment and the opener as the start of the conversation
    await Message.create({
      leadId: lead._id,
      telegramId: p.chatId,
      direction: 'incoming',
      sender: 'client',
      kind: 'comment',
      text: `[Instagram postga komment] ${p.comment.text}`.trim(),
      processed: true,
    });
    await Message.create({
      leadId: lead._id,
      telegramMessageId: midToNumber(p.messageId),
      telegramId: p.chatId,
      direction: 'outgoing',
      sender: 'ai',
      kind: 'text',
      text: p.dm,
      meta: { igMid: p.messageId, via: 'comment' },
    });
    await AdminEvent.create({ type: 'ig_comment_dm', leadId: lead._id, data: { commentId: p.comment.commentId } });
    logger.info({ leadId: String(lead._id) }, 'Instagram comment → Direct sent');
    return lead;
  }
}
