import crypto from 'node:crypto';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { Lead } from '../database/models/Lead';
import type { SentRef, TelegramGateway } from '../telegram/gateway';
import { sleep } from '../utils/time';
import { splitForInstagram, type InstagramClient } from './igClient';
import { isIgConnection } from './igAccount';

/** Numeric id for an Instagram message id (the Message model stores numbers). */
export function midToNumber(mid: string): number {
  return crypto.createHash('sha256').update(mid).digest().readUIntBE(0, 6);
}

/**
 * One gateway for the engine: Telegram chats go to Telegram, «ig:» chats go to Instagram Direct.
 * Admin notifications always go to the Telegram admin chat.
 */
export class ChannelGateway implements TelegramGateway {
  private readonly ownMids = new Map<string, number>();
  private readonly igUsers = new Map<number, string>();

  constructor(
    private readonly tg: TelegramGateway,
    private readonly ig: InstagramClient,
  ) {}

  /** Messages the bot itself sent (their echoes must not look like the coach writing). */
  rememberMid(mid: string): void {
    this.ownMids.set(mid, Date.now());
    if (this.ownMids.size > 5000) {
      const cutoff = Date.now() - 3600_000;
      for (const [k, t] of this.ownMids) if (t < cutoff) this.ownMids.delete(k);
    }
  }

  /** The echo may arrive before the send call returns — wait a little before deciding. */
  async isOwnMid(mid: string, waitMs = 6000): Promise<boolean> {
    const until = Date.now() + waitMs;
    for (;;) {
      if (this.ownMids.has(mid)) return true;
      if (Date.now() >= until) return false;
      await sleep(250);
    }
  }

  private async igUser(connectionId: string, chatId: number): Promise<string> {
    const known = this.igUsers.get(chatId);
    if (known) return known;
    const lead = await Lead.findOne({ businessConnectionId: connectionId, chatId }).select('igUserId').lean();
    if (!lead?.igUserId) throw new Error('Instagram user not found for chat');
    this.igUsers.set(chatId, lead.igUserId);
    return lead.igUserId;
  }

  async sendBusinessMessage(connectionId: string, chatId: number, text: string) {
    if (!isIgConnection(connectionId)) return this.tg.sendBusinessMessage(connectionId, chatId, text);
    const user = await this.igUser(connectionId, chatId);
    let last = '';
    for (const part of splitForInstagram(text)) {
      const r = await this.ig.sendText(user, part);
      this.rememberMid(r.messageId);
      last = r.messageId;
    }
    return { messageId: midToNumber(last) };
  }

  async sendTyping(connectionId: string, chatId: number, action?: 'typing' | 'record_voice') {
    if (!isIgConnection(connectionId)) return this.tg.sendTyping(connectionId, chatId, action);
    await this.ig.senderAction(await this.igUser(connectionId, chatId), 'typing_on');
  }

  async sendBusinessVoice(connectionId: string, chatId: number, fileId: string) {
    if (!isIgConnection(connectionId)) return this.tg.sendBusinessVoice(connectionId, chatId, fileId);
    throw new Error('Voice clips are not sent to Instagram');
  }

  sendAdminVoice(chatId: number, fileId: string, caption?: string) {
    return this.tg.sendAdminVoice(chatId, fileId, caption);
  }

  notifyAdmins(html: string, keyboard?: InlineKeyboardMarkup): Promise<SentRef[]> {
    return this.tg.notifyAdmins(html, keyboard);
  }

  editAdminMessage(ref: SentRef, html: string, keyboard?: InlineKeyboardMarkup) {
    return this.tg.editAdminMessage(ref, html, keyboard);
  }

  sendAdminDocument(chatId: number, data: Buffer, fileName: string, caption?: string) {
    return this.tg.sendAdminDocument(chatId, data, fileName, caption);
  }

  /** Instagram attachments are stored as their CDN URL instead of a Telegram file_id. */
  downloadFile(fileId: string): Promise<Buffer> {
    if (/^https?:\/\//.test(fileId)) return this.ig.download(fileId);
    return this.tg.downloadFile(fileId);
  }
}
