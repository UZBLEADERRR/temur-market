import { Lead } from '../database/models/Lead';
import { Reminder } from '../database/models/misc';
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
  ) {}

  async tick(now = new Date()): Promise<number> {
    const r1 = (await this.settings.num('reminder1_delay_minutes')) * MINUTE;
    const r2 = (await this.settings.num('reminder2_delay_hours')) * HOUR;
    const candidates = await Lead.find({
      status: 'QUESTIONNAIRE',
      mode: 'AI',
      remindersSent: { $lt: 2 },
      pendingSince: null,
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
      const text = await this.settings.text(`reminder${number}`, (lead.language as Lang) ?? 'uz');
      const delivered = await this.engine.sendToClient(lead, [text], { kind: 'reminder', at: now });
      await Reminder.updateOne({ leadId: lead._id, number }, { $set: { text, sentAt: now } });
      lead.remindersSent = number;
      await Lead.updateOne({ _id: lead._id }, { $set: { remindersSent: number } });
      logger.info({ leadId: String(lead._id), number, delivered }, 'Reminder sent');
      sent += delivered ? 1 : 0;
    }
    return sent;
  }
}
