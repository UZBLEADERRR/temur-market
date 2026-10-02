import { describe, expect, it } from 'vitest';
import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { Lead } from '../src/database/models/Lead';
import { Message } from '../src/database/models/Message';
import { registerBusinessHandlers } from '../src/telegram/businessHandlers';
import { buildApp, useDatabase } from './helpers';

useDatabase();

const OWNER = 999;

function makeBot() {
  const ctx = buildApp();
  const bot = new Bot('123:TEST', {
    botInfo: {
      id: 1, is_bot: true, first_name: 'Bot', username: 'temur_bot', can_join_groups: false, can_read_all_group_messages: false,
      supports_inline_queries: false, can_connect_to_business: true, has_main_web_app: false,
    } as never,
  });
  const apiCalls: string[] = [];
  bot.api.config.use(async (_prev, method) => {
    apiCalls.push(method);
    if (method === 'getBusinessConnection') {
      return { ok: true, result: { id: 'conn-1', user: { id: OWNER, is_bot: false, first_name: 'Temur' }, user_chat_id: OWNER, date: 0, is_enabled: true } } as never;
    }
    return { ok: true, result: true } as never;
  });
  registerBusinessHandlers(bot, ctx.app);
  return { ...ctx, bot, apiCalls };
}

let uid = 1;
function bm(chatId: number, fromId: number, messageId: number, text: string, extra: Record<string, unknown> = {}): Update {
  return {
    update_id: uid++,
    business_message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: 'Ali', username: 'ali' },
      from: { id: fromId, is_bot: false, first_name: fromId === OWNER ? 'Temur' : 'Ali' },
      business_connection_id: 'conn-1',
      text,
      ...extra,
    },
  } as Update;
}

describe('Telegram Business handlers', () => {
  it('16. duplicate Telegram message is processed only once', async () => {
    const { bot, gateway } = makeBot();
    const u = bm(100, 100, 1, 'Salom, kurs haqida');
    await bot.handleUpdate(u);
    await bot.handleUpdate({ ...u, update_id: uid++ }); // same message re-delivered
    expect(gateway.textsTo(100)).toHaveLength(1);
    expect(await Message.countDocuments({ telegramId: 100, sender: 'client' })).toBe(1);
  });

  it('client message → AI replies through the business connection (as TEMUR)', async () => {
    const { bot, gateway } = makeBot();
    await bot.handleUpdate(bm(101, 101, 1, 'Salom, kurs haqida'));
    expect(gateway.sent[0]).toMatchObject({ chatId: 101, connectionId: 'conn-1' });
  });

  it('message written by TEMUR in the chat → manual takeover, no AI reply afterwards', async () => {
    const { bot, gateway } = makeBot();
    await bot.handleUpdate(bm(102, 102, 1, 'Salom, kurs haqida'));
    await bot.handleUpdate(bm(102, OWNER, 2, 'Salom, men Temur'));
    await bot.handleUpdate(bm(102, 102, 3, '180 90 25'));
    expect(gateway.textsTo(102)).toHaveLength(1);
    const lead = await Lead.findOne({ chatId: 102 });
    expect(lead?.mode).toBe('MANUAL');
  });

  it("the bot's own messages echoed back (sender_business_bot) do not count as TEMUR takeover", async () => {
    const { bot } = makeBot();
    await bot.handleUpdate(bm(103, 103, 1, 'Salom, kurs haqida'));
    await bot.handleUpdate(bm(103, OWNER, 2, 'Assalomu alaykum!', { sender_business_bot: { id: 1, is_bot: true, first_name: 'Bot' } }));
    expect((await Lead.findOne({ chatId: 103 }))?.mode).toBe('AI');
  });
});
