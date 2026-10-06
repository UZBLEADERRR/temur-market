import type { Bot, Context } from 'grammy';
import type { Message as TgMessage } from 'grammy/types';
import { BusinessConnection } from '../database/models/misc';
import type { AppContext } from '../services/appContext';
import type { IncomingClientMessage } from '../conversations/engine';
import { firstTime } from './idempotency';
import { logger } from '../utils/logger';

function kindOf(m: TgMessage): IncomingClientMessage['kind'] {
  if (m.text) return 'text';
  if (m.voice || m.audio || m.video_note) return 'voice';
  if (m.photo) return 'photo';
  if (m.video || m.animation) return 'video';
  if (m.sticker) return 'sticker';
  return 'other';
}

async function ownerOf(bot: Bot, connectionId: string): Promise<number | undefined> {
  const known = await BusinessConnection.findOne({ connectionId }).lean();
  if (known) return known.userId;
  try {
    const c = await bot.api.getBusinessConnection(connectionId);
    await BusinessConnection.updateOne(
      { connectionId },
      { $set: { userId: c.user.id, userChatId: c.user_chat_id, isEnabled: c.is_enabled, canReply: c.rights?.can_reply ?? true } },
      { upsert: true },
    );
    return c.user.id;
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'getBusinessConnection failed');
    return undefined;
  }
}

/** Telegram Business: messages in the coach's private chats arrive as business_message updates. */
export function registerBusinessHandlers(bot: Bot, app: AppContext): void {
  bot.on('business_connection', async (ctx: Context) => {
    const c = ctx.businessConnection!;
    const canReply = c.rights?.can_reply ?? true;
    await BusinessConnection.updateOne(
      { connectionId: c.id },
      { $set: { userId: c.user.id, userChatId: c.user_chat_id, isEnabled: c.is_enabled, canReply } },
      { upsert: true },
    );
    logger.info({ owner: c.user.id, enabled: c.is_enabled, canReply }, 'Business connection updated');
    await app.gateway
      .notifyAdmins(
        c.is_enabled
          ? `🔗 Telegram Business ulandi: ${c.user.first_name}${canReply ? '' : "\n⚠️ Botga xabar yozish ruxsati berilmagan (Chatbots → ruxsatlar)."}`
          : "⛔️ Telegram Business aloqasi o'chirildi. AI hech kimga yoza olmaydi.",
      )
      .catch(() => undefined);
  });

  bot.on('business_message', async (ctx: Context) => {
    const m = ctx.businessMessage!;
    const connectionId = m.business_connection_id!;
    if (m.chat.type !== 'private') return;
    if (!(await firstTime(`bm:${connectionId}:${m.chat.id}:${m.message_id}`))) {
      logger.info({ chatId: m.chat.id }, 'Duplicate business message ignored');
      return;
    }
    const owner = await ownerOf(bot, connectionId);
    const text = m.text ?? m.caption ?? '';
    const chat = { id: m.chat.id, username: m.chat.username, first_name: m.chat.first_name, last_name: m.chat.last_name };

    if (m.from?.id === owner || (owner === undefined && m.from?.id !== m.chat.id)) {
      // sent from the business account: either by us (sender_business_bot) or by TEMUR himself
      if (m.sender_business_bot) return;
      await app.engine.handleCoachMessage({ connectionId, chat, messageId: m.message_id, text, kind: kindOf(m) });
      return;
    }

    const voice = m.voice ?? m.audio;
    // pick a mid-size photo (enough for the model, small to download)
    const photo = m.photo?.length ? ([...m.photo].reverse().find((p) => (p.file_size ?? 0) <= 1_500_000) ?? m.photo[0]) : undefined;
    await app.engine.handleClientMessage({
      connectionId,
      chat,
      messageId: m.message_id,
      text,
      kind: kindOf(m),
      voice: voice ? { fileId: voice.file_id, mimeType: voice.mime_type } : undefined,
      photo: photo ? { fileId: photo.file_id } : undefined,
      replyTo: m.reply_to_message
        ? {
            text: (m.reply_to_message.text ?? m.reply_to_message.caption ?? (m.reply_to_message.voice ? '[ovozli xabar]' : '')).slice(0, 500),
            fromCoach: m.reply_to_message.from?.id !== m.chat.id,
          }
        : undefined,
      date: new Date(m.date * 1000),
    });
  });

  bot.on('edited_business_message', () => undefined);
  bot.on('deleted_business_messages', () => undefined);
}
