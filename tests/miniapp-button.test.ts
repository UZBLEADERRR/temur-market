import { describe, expect, it } from 'vitest';
import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { registerAdminHandlers } from '../src/admin/adminCommands';
import { buildApp, useDatabase } from './helpers';

useDatabase();
let uid = 1;
const cmd = (text: string): Update =>
  ({
    update_id: uid++,
    message: {
      message_id: uid, date: Math.floor(Date.now() / 1000), chat: { id: 1, type: 'private', first_name: 'T' }, from: { id: 1, is_bot: false, first_name: 'T' },
      text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }],
    },
  }) as Update;

function setup(publicUrl?: string) {
  const ctx = buildApp();
  ctx.app.env.publicUrl = publicUrl;
  const calls: Array<{ method: string; payload: any }> = [];
  const bot = new Bot('123:TEST', { botInfo: { id: 9, is_bot: true, first_name: 'B', username: 'b' } as never });
  bot.api.config.use(async (_p, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: method === 'sendMessage' ? { message_id: 1, date: 0, chat: { id: 1, type: 'private' } } : true } as never;
  });
  registerAdminHandlers(bot, ctx.app);
  return { bot, calls };
}

describe('mini app button for the admin', () => {
  it('/start sets the menu button and sends an "open mini app" button', async () => {
    const { bot, calls } = setup('https://bot2.up.railway.app');
    await bot.handleUpdate(cmd('/start'));
    const menu = calls.find((c) => c.method === 'setChatMenuButton');
    expect(menu?.payload.menu_button.web_app.url).toBe('https://bot2.up.railway.app/app/');
    const msg = calls.find((c) => c.method === 'sendMessage');
    expect(msg?.payload.reply_markup.inline_keyboard[0][0].web_app.url).toBe('https://bot2.up.railway.app/app/');
  });

  it('without a public domain the admin is told exactly what to do', async () => {
    const { bot, calls } = setup(undefined);
    await bot.handleUpdate(cmd('/app'));
    const msg = calls.find((c) => c.method === 'sendMessage');
    expect(msg?.payload.text).toContain('Generate Domain');
    expect(calls.some((c) => c.method === 'setChatMenuButton')).toBe(false);
  });
});
