import { describe, expect, it } from 'vitest';
import { Lead } from '../src/database/models/Lead';
import { buildApp, clientMsg, useDatabase } from './helpers';

useDatabase();

describe('load', () => {
  it('150 clients writing at the same time are all answered, nothing crashes', async () => {
    const { engine, gateway } = buildApp();
    const ids = Array.from({ length: 150 }, (_, i) => 5000 + i);
    await Promise.all(ids.map((id) => engine.handleClientMessage(clientMsg(id, 'Salom, kurs haqida'))));
    await Promise.all(ids.map((id) => engine.handleClientMessage(clientMsg(id, "180 bo'y 90 kg 25 yosh, 1 yil zal"))));
    expect(await Lead.countDocuments()).toBe(150);
    for (const id of ids) expect(gateway.textsTo(id)).toHaveLength(2);
  }, 60_000);
});
