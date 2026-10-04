import { describe, expect, it } from 'vitest';
import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { Lead } from '../src/database/models/Lead';
import { registerBusinessHandlers } from '../src/telegram/businessHandlers';
import { buildApp, useDatabase } from './helpers';

useDatabase();
const OWNER = 999;
let uid = 1;
const bm = (chatId: number, fromId: number, id: number, text: string): Update =>
  ({
    update_id: uid++,
    business_message: {
      message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private', first_name: 'S' },
      from: { id: fromId, is_bot: false, first_name: 'x' }, business_connection_id: 'conn-1', text,
    },
  }) as Update;

describe('reset flow through Telegram handlers', () => {
  it('after coach takeover + reset, "Salom" gets an answer', async () => {
    const ctx = buildApp();
    await ctx.settings.set({ coach_message_stops_ai: true });
    const bot = new Bot('123:TEST', { botInfo: { id: 1, is_bot: true, first_name: 'B', username: 'b' } as never });
    bot.api.config.use(async (_p, method) =>
      method === 'getBusinessConnection'
        ? ({ ok: true, result: { id: 'conn-1', user: { id: OWNER, is_bot: false, first_name: 'T' }, user_chat_id: OWNER, date: 0, is_enabled: true } } as never)
        : ({ ok: true, result: true } as never),
    );
    registerBusinessHandlers(bot, ctx.app);
    await bot.handleUpdate(bm(300, 300, 1, 'Salom'));
    await bot.handleUpdate(bm(300, OWNER, 2, 'Narxi: ...'));
    expect((await Lead.findOne({ chatId: 300 }))?.mode).toBe('MANUAL');
    await ctx.engine.resetLead(String((await Lead.findOne({ chatId: 300 }))!._id));
    await bot.handleUpdate(bm(300, 300, 3, 'Salom'));
    await bot.handleUpdate(bm(300, 300, 4, 'Hi'));
    expect(ctx.gateway.textsTo(300).length).toBeGreaterThan(1);
  });

  it('a blocked send (bot paused in chat) is reported to the admin instead of failing silently', async () => {
    const ctx = buildApp();
    ctx.gateway.failSend = Object.assign(new Error('Forbidden'), { error_code: 403, description: 'Forbidden: bot was paused' });
    const { clientMsg } = await import('./helpers');
    await ctx.engine.handleClientMessage(clientMsg(301, 'Salom'));
    expect(ctx.gateway.admin.at(-1)?.html).toContain('Mijozga xabar yuborilmadi');
    expect(ctx.gateway.admin.at(-1)?.html).toContain('bot was paused');
    expect((await Lead.findOne({ chatId: 301 }))?.readyReason).toBe('send_blocked');
  });
});
