import { InputFile, type Bot } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import type { SentRef, TelegramGateway } from './gateway';
import { logger } from '../utils/logger';

export class GrammyGateway implements TelegramGateway {
  constructor(
    private readonly bot: Bot,
    private readonly adminIds: number[],
    private readonly token: string,
    private readonly apiRoot = 'https://api.telegram.org',
  ) {}

  async sendBusinessMessage(connectionId: string, chatId: number, text: string) {
    const m = await this.bot.api.sendMessage(chatId, text, { business_connection_id: connectionId });
    return { messageId: m.message_id };
  }

  async sendTyping(connectionId: string, chatId: number) {
    await this.bot.api.sendChatAction(chatId, 'typing', { business_connection_id: connectionId });
  }

  async notifyAdmins(html: string, keyboard?: InlineKeyboardMarkup): Promise<SentRef[]> {
    const refs: SentRef[] = [];
    for (const id of this.adminIds) {
      try {
        const m = await this.bot.api.sendMessage(id, html, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard,
        });
        refs.push({ chatId: id, messageId: m.message_id });
      } catch (err) {
        logger.error({ adminId: id, err: (err as Error).message }, 'Admin notify failed (has the admin pressed /start?)');
      }
    }
    return refs;
  }

  async editAdminMessage(ref: SentRef, html: string, keyboard?: InlineKeyboardMarkup) {
    await this.bot.api.editMessageText(ref.chatId, ref.messageId, html, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard,
    });
  }

  async sendAdminDocument(chatId: number, data: Buffer, fileName: string, caption?: string) {
    await this.bot.api.sendDocument(chatId, new InputFile(data, fileName), caption ? { caption, parse_mode: 'HTML' } : {});
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) throw new Error('File path missing');
    const res = await fetch(`${this.apiRoot}/file/bot${this.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`File download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
