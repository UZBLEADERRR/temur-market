import { describe, expect, it } from 'vitest';
import { Lead } from '../src/database/models/Lead';
import { Reminder } from '../src/database/models/misc';
import { buildApp, clientMsg, useDatabase } from './helpers';

useDatabase();
const H = 3600_000;

async function startedLead(chatId: number) {
  const ctx = buildApp();
  await ctx.engine.handleClientMessage(clientMsg(chatId, 'Salom'));
  const t0 = new Date('2026-10-01T10:00:00Z');
  await Lead.updateOne({ chatId }, { $set: { lastClientMessageAt: t0, lastOutgoingAt: new Date(t0.getTime() + 5000) } });
  return { ...ctx, t0 };
}

describe('reminders', () => {
  it('19. first reminder after ~1 hour without an answer', async () => {
    const { reminders, gateway, t0 } = await startedLead(50);
    expect(await reminders.tick(new Date(t0.getTime() + 30 * 60_000))).toBe(0);
    expect(await reminders.tick(new Date(t0.getTime() + 61 * 60_000))).toBe(1);
    expect(gateway.textsTo(50).at(-1)).toBe('Javobingizni kutyapman');
    // not twice
    expect(await reminders.tick(new Date(t0.getTime() + 2 * H))).toBe(0);
    expect((await Lead.findOne({ chatId: 50 }))?.remindersSent).toBe(1);
  });

  it('20. second reminder ~20h after the client last wrote, inside the 24h window; max 2', async () => {
    const { reminders, gateway, t0 } = await startedLead(51);
    await reminders.tick(new Date(t0.getTime() + 61 * 60_000));
    expect(await reminders.tick(new Date(t0.getTime() + 19 * H))).toBe(0);
    expect(await reminders.tick(new Date(t0.getTime() + 20 * H + 60_000))).toBe(1);
    expect(gateway.textsTo(51).at(-1)).toContain('Savollarga javob berib yuborsangiz');
    expect(await reminders.tick(new Date(t0.getTime() + 23 * H))).toBe(0);
    expect(await Reminder.countDocuments()).toBe(2);
  });

  it('no reminder outside the 24h window', async () => {
    const { reminders, t0 } = await startedLead(52);
    expect(await reminders.tick(new Date(t0.getTime() + 25 * H))).toBe(0);
  });

  it('no reminder when the client wrote last (we owe the answer)', async () => {
    const b = await startedLead(53);
    await Lead.updateOne({ chatId: 53 }, { $set: { lastClientMessageAt: new Date(b.t0.getTime() + 10_000) } });
    expect(await b.reminders.tick(new Date(b.t0.getTime() + 2 * H))).toBe(0);
  });

  it('no reminder when the chat is MANUAL', async () => {
    const c = await startedLead(54);
    await Lead.updateOne({ chatId: 54 }, { $set: { mode: 'MANUAL' } });
    expect(await c.reminders.tick(new Date(c.t0.getTime() + 2 * H))).toBe(0);
  });

  it('reminder texts and delays are admin-editable; Russian client gets Russian reminder', async () => {
    const ctx = buildApp();
    await ctx.settings.set({ reminder1_delay_minutes: 30, reminder1_ru: 'Жду ответа 🙂' });
    await ctx.engine.handleClientMessage(clientMsg(55, 'Здравствуйте'));
    const t0 = new Date('2026-10-01T10:00:00Z');
    await Lead.updateOne({ chatId: 55 }, { $set: { lastClientMessageAt: t0, lastOutgoingAt: t0 } });
    expect(await ctx.reminders.tick(new Date(t0.getTime() + 31 * 60_000))).toBe(1);
    expect(ctx.gateway.textsTo(55).at(-1)).toBe('Жду ответа 🙂');
  });
});

describe('sales reminders', () => {
  it('in the sales stage the sales reminder text is used', async () => {
    const ctx = buildApp();
    await ctx.engine.handleClientMessage(clientMsg(56, 'Salom, kurs haqida'));
    const t0 = new Date('2026-10-01T10:00:00Z');
    await Lead.updateOne({ chatId: 56 }, { $set: { status: 'SALES', lastClientMessageAt: t0, lastOutgoingAt: t0 } });
    expect(await ctx.reminders.tick(new Date(t0.getTime() + 61 * 60_000))).toBe(1);
    expect(ctx.gateway.textsTo(56).at(-1)).toBe("Qaror qildingizmi? Savollaringiz bo'lsa bemalol yozing");
  });
});
