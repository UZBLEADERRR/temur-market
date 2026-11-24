import { describe, expect, it } from 'vitest';
import { runDataMigrations } from '../src/database/migrations';
import { Lead } from '../src/database/models/Lead';
import { StyleExample } from '../src/database/models/misc';
import { useDatabase } from './helpers';

useDatabase();

describe('rollback data migration', () => {
  it('moves SALES leads to READY/MANUAL and disables sales examples', async () => {
    await Lead.create({ businessConnectionId: 'c', chatId: 1, telegramId: 1, status: 'SALES', mode: 'AI' });
    await StyleExample.insertMany([
      { client: 'Qimmat', coach: ['[narx]dan tushadi'], kind: 'sales', enabled: true },
      { client: 'Salom', coach: ['Va alaykum'], kind: 'style', enabled: true },
    ]);

    await runDataMigrations();

    const lead = await Lead.findOne({ chatId: 1 }).lean();
    expect(lead?.status).toBe('READY');
    expect(lead?.mode).toBe('MANUAL');
    expect(await StyleExample.countDocuments({ enabled: true })).toBe(1);
  });
});
