import { clientLinkHtml } from '../leads/leadCard';
import { Lead } from '../database/models/Lead';
import { Reminder } from '../database/models/misc';
import { Message } from '../database/models/Message';
import type { TelegramGateway } from '../telegram/gateway';
import type { ConversationEngine } from '../conversations/engine';
import type { SettingsService } from '../services/settings';
import type { Lang } from '../utils/text';
import { HOUR, MINUTE } from '../utils/time';
import { logger } from '../utils/logger';

/** Telegram allows writing from the business account only within 24h of the client's last message. */
const WINDOW_MS = 23.5 * HOUR;

/**
 * Max 2 reminders, only while status = QUESTIONNAIRE and mode = AI, only when the last word was ours.
 * 1st: ~1h without an answer. 2nd: ~20h after the client's last message (close to the time they are usually active).
 */
export class ReminderService {
  constructor(
    private readonly engine: ConversationEngine,
    private readonly settings: SettingsService,
    private readonly gateway?: TelegramGateway,
  ) {}

  /**
   * The chat was handed to the coach (discount, card, «Temur bilan gaplashmoqchiman»…) and the client keeps writing
   * without an answer → remind the coach (every N minutes, at most 3 times) so nobody is left hanging.
   */
  async nudgeCoach(now = new Date()): Promise<number> {
    const every = (await this.settings.num('coach_nudge_minutes')) * MINUTE;
    if (every <= 0) return 0;
    const leads = await Lead.find({
      status: 'READY',
      readyReason: { $in: ['wants_coach', 'payment_request', 'sold', 'bot_question', 'completed'] },
      coachNudges: { $lt: 3 },
      lastClientMessageAt: { $ne: null, $lte: new Date(now.getTime() - every) },
    }).limit(50);
    let n = 0;
    for (const lead of leads) {
      if (lead.readyAt && lead.lastClientMessageAt! <= lead.readyAt) continue; // the client is not waiting
      const lastCoach = await Message.findOne({ leadId: lead._id, sender: 'temur' }).sort({ createdAt: -1 }).select('createdAt').lean();
      if (lastCoach && lastCoach.createdAt >= lead.lastClientMessageAt!) continue; // already answered
      if (lead.coachNudgedAt && now.getTime() - lead.coachNudgedAt.getTime() < every) continue;
      const waited = Math.round((now.getTime() - lead.lastClientMessageAt!.getTime()) / MINUTE);
      await this.gateway
        ?.notifyAdmins(
          `⏰ Mijoz ${waited} daqiqadan beri javobingizni kutyapti: ${clientLinkHtml(lead)}`,
        )
        .catch(() => undefined);
      await Lead.updateOne({ _id: lead._id }, { $set: { coachNudgedAt: now }, $inc: { coachNudges: 1 } });
      n++;
    }
    return n;
  }

  async tick(now = new Date()): Promise<number> {
    await this.nudgeCoach(now).catch(() => 0);
    // planned «o'ylab ko'raman» follow-ups first
    const due = await Lead.find({
      followUpAt: { $ne: null, $lte: now },
      mode: 'AI',
      status: 'SALES',
      $or: [{ aiPausedUntil: null }, { aiPausedUntil: { $lte: now } }],
    }).select('_id').limit(50).lean();
    let followUps = 0;
    for (const l of due) if (await this.engine.followUp(String(l._id))) followUps++;

    const r1 = (await this.settings.num('reminder1_delay_minutes')) * MINUTE;
    const r2 = (await this.settings.num('reminder2_delay_hours')) * HOUR;
    const candidates = await Lead.find({
      status: { $in: ['QUESTIONNAIRE', 'SALES'] },
      mode: 'AI',
      remindersSent: { $lt: 2 },
      pendingSince: null,
      followUpAt: null,
      $or: [{ aiPausedUntil: null }, { aiPausedUntil: { $lte: now } }],
      lastOutgoingAt: { $ne: null, $lte: new Date(now.getTime() - r1) },
      lastClientMessageAt: { $ne: null, $gte: new Date(now.getTime() - WINDOW_MS) },
    }).limit(100);

    let sent = 0;
    for (const lead of candidates) {
      const lastClient = lead.lastClientMessageAt!.getTime();
      const lastOut = lead.lastOutgoingAt!.getTime();
      if (lastOut < lastClient) continue; // we owe the answer, not the client
      const sinceClient = now.getTime() - lastClient;
      let number: 1 | 2 | undefined;
      if (lead.remindersSent === 0 && sinceClient < r2) number = 1;
      else if (sinceClient >= r2 && sinceClient < WINDOW_MS) number = 2;
      if (!number) continue;
      // idempotent per lead+number
      try {
        await Reminder.create({ leadId: lead._id, number });
      } catch {
        continue;
      }
      const key = lead.status === 'SALES' ? 'sales_reminder' : `reminder${number}`;
      const text = await this.settings.text(key, (lead.language as Lang) ?? 'uz');
      const delivered = await this.engine.sendToClient(lead, [text], { kind: 'reminder', at: now });
      await Reminder.updateOne({ leadId: lead._id, number }, { $set: { text, sentAt: now } });
      lead.remindersSent = number;
      await Lead.updateOne({ _id: lead._id }, { $set: { remindersSent: number } });
      logger.info({ leadId: String(lead._id), number, delivered }, 'Reminder sent');
      sent += delivered ? 1 : 0;
    }
    return sent + followUps;
  }
}
