import type { InlineKeyboardMarkup } from 'grammy/types';

export interface SentRef {
  chatId: number;
  messageId: number;
}

/** Everything the core needs from Telegram. The grammY implementation lives in grammyGateway.ts; tests use a fake. */
export interface TelegramGateway {
  sendBusinessMessage(connectionId: string, chatId: number, text: string): Promise<{ messageId: number }>;
  sendTyping(connectionId: string, chatId: number): Promise<void>;
  notifyAdmins(html: string, keyboard?: InlineKeyboardMarkup): Promise<SentRef[]>;
  editAdminMessage(ref: SentRef, html: string, keyboard?: InlineKeyboardMarkup): Promise<void>;
  sendAdminDocument(chatId: number, data: Buffer, fileName: string, caption?: string): Promise<void>;
  downloadFile(fileId: string): Promise<Buffer>;
}

/** Telegram errors that mean "the bot may not write into this chat anymore" (paused, disconnected, 24h window). */
export function isChatClosedError(err: unknown): boolean {
  const msg = String((err as { description?: string; message?: string })?.description ?? (err as Error)?.message ?? '');
  const code = (err as { error_code?: number })?.error_code;
  return (
    code === 403 ||
    /BUSINESS_PEER|BOT_BUSINESS|business connection|PEER_ID_INVALID|chat not found|bot was blocked|USER_IS_BLOCKED|not enough rights|BUSINESS_CONNECTION/i.test(msg)
  );
}
