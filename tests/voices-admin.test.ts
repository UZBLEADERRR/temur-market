import { describe, expect, it } from 'vitest';
import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { VoiceClip } from '../src/database/models/misc';
import { registerAdminHandlers } from '../src/admin/adminCommands';
import { buildApp, useDatabase } from './helpers';

useDatabase();
let uid = 1;
const ADMIN = 1;
const upd = (message: Record<string, unknown>): Update =>
  ({
    update_id: uid++,
    message: { message_id: uid, date: Math.floor(Date.now() / 1000), chat: { id: ADMIN, type: 'private', first_name: 'T' }, from: { id: ADMIN, is_bot: false, first_name: 'T' }, ...message },
  }) as Update;

describe('admin voice library', () => {
  it('a voice sent to the bot is stored, transcribed and named by the next text', async () => {
    const ctx = buildApp();
    ctx.llm.transcript = "50 kunlik yopiq guruhda har kuni nazorat bo'ladi";
    const replies: string[] = [];
    const bot = new Bot('123:TEST', { botInfo: { id: 9, is_bot: true, first_name: 'B', username: 'b' } as never });
    bot.api.config.use(async (_p, method, payload) => {
      if (method === 'sendMessage') replies.push(String((payload as { text: string }).text));
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: ADMIN, type: 'private' } } } as never;
    });
    registerAdminHandlers(bot, ctx.app);
    await bot.handleUpdate(upd({ voice: { file_id: 'F1', file_unique_id: 'U1', duration: 42, mime_type: 'audio/ogg' } }));
    let clip = await VoiceClip.findOne({ fileUniqueId: 'U1' });
    expect(clip?.transcript).toContain('yopiq guruh');
    expect(replies.at(-1)).toContain('nima haqida');
    await bot.handleUpdate(upd({ text: 'guruh qanday ishlaydi' }));
    clip = await VoiceClip.findOne({ fileUniqueId: 'U1' });
    expect(clip?.title).toBe('guruh qanday ishlaydi');
    // duplicates are not stored twice
    await bot.handleUpdate(upd({ voice: { file_id: 'F1b', file_unique_id: 'U1', duration: 42 } }));
    expect(await VoiceClip.countDocuments()).toBe(1);
    // caption = title right away
    await bot.handleUpdate(upd({ voice: { file_id: 'F2', file_unique_id: 'U2', duration: 20 }, caption: 'narx' }));
    expect((await VoiceClip.findOne({ fileUniqueId: 'U2' }))?.title).toBe('narx');
  });
});
