import type { InlineKeyboardMarkup } from 'grammy/types';
import { Lead, type LeadDoc } from '../database/models/Lead';
import { AdminEvent } from '../database/models/misc';
import type { TelegramGateway } from '../telegram/gateway';
import type { LeadStatus } from '../types/domain';
import { logger } from '../utils/logger';
import { formatLeadCard } from './leadCard';

export interface LeadServiceDeps {
  gateway: TelegramGateway;
  timeZone: string;
  publicUrl?: string;
}

export function leadKeyboard(lead: LeadDoc, publicUrl?: string): InlineKeyboardMarkup {
  const id = String(lead._id);
  const rows: InlineKeyboardMarkup['inline_keyboard'] = [
    [
      { text: '✅ Javob berildi', callback_data: `st:ANSWERED:${id}` },
      { text: "💰 To'ladi", callback_data: `st:PAID:${id}` },
      { text: '❌ Rad etdi', callback_data: `st:REJECTED:${id}` },
    ],
  ];
  const second: InlineKeyboardMarkup['inline_keyboard'][number] = [];
  if (lead.username) second.push({ text: '💬 Chatni ochish', url: `https://t.me/${lead.username}` });
  if (publicUrl) second.push({ text: '📋 Ilovada ochish', web_app: { url: `${publicUrl}/app/#lead=${id}` } });
  if (second.length) rows.push(second);
  return { inline_keyboard: rows };
}

/** Lead status changes, admin cards and audit events. */
export class LeadService {
  constructor(private readonly deps: LeadServiceDeps) {}

  async sendCard(lead: LeadDoc): Promise<void> {
    const html = formatLeadCard(lead.toObject(), this.deps.timeZone);
    try {
      const refs = await this.deps.gateway.notifyAdmins(html, leadKeyboard(lead, this.deps.publicUrl));
      lead.adminCardMessageIds = refs as never;
      await lead.save();
    } catch (err) {
      logger.error({ err: (err as Error).message, leadId: String(lead._id) }, 'Failed to send lead card');
    }
  }

  async refreshCards(lead: LeadDoc): Promise<void> {
    const html = formatLeadCard(lead.toObject(), this.deps.timeZone);
    for (const ref of lead.adminCardMessageIds ?? []) {
      if (!ref.chatId || !ref.messageId) continue;
      await this.deps.gateway
        .editAdminMessage({ chatId: ref.chatId, messageId: ref.messageId }, html, leadKeyboard(lead, this.deps.publicUrl))
        .catch(() => undefined);
    }
  }

  async setStatus(leadId: string, status: LeadStatus, actorId?: number): Promise<LeadDoc | null> {
    const lead = await Lead.findById(leadId);
    if (!lead) return null;
    const prev = lead.status;
    lead.status = status;
    const now = new Date();
    if (status === 'ANSWERED') lead.answeredAt ??= now;
    if (status === 'PAID') lead.paidAt = now;
    if (status === 'REJECTED') lead.rejectedAt = now;
    if (status !== 'NEW' && status !== 'QUESTIONNAIRE') lead.mode = 'MANUAL';
    await lead.save();
    await AdminEvent.create({ type: 'status_change', leadId: lead._id, actorId, data: { from: prev, to: status } });
    logger.info({ leadId, from: prev, to: status }, 'Lead status changed');
    await this.refreshCards(lead);
    return lead;
  }

  /** Re-enabling AI is an explicit admin action; it resumes the questionnaire. */
  async setMode(leadId: string, mode: 'AI' | 'MANUAL', actorId?: number): Promise<LeadDoc | null> {
    const lead = await Lead.findById(leadId);
    if (!lead) return null;
    lead.mode = mode;
    if (mode === 'AI') {
      lead.status = 'QUESTIONNAIRE';
      lead.urgent = false;
      lead.readyReason = undefined;
      lead.readyAt = undefined;
    }
    await lead.save();
    await AdminEvent.create({ type: mode === 'AI' ? 'ai_enabled' : 'ai_disabled', leadId: lead._id, actorId });
    logger.info({ leadId, mode }, 'Lead mode changed by admin');
    return lead;
  }
}
