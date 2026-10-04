import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { runDataMigrations } from '../src/database/migrations';
import { useDatabase } from './helpers';

useDatabase();

describe('rollback data migration', () => {
  it('moves SALES leads to READY/MANUAL and disables sales examples', async () => {
    const db = mongoose.connection.db!;
    await db.collection('leads').insertOne({ businessConnectionId: 'c', chatId: 1, telegramId: 1, status: 'SALES', mode: 'AI' });
    await db.collection('style_examples').insertMany([
      { client: 'Qimmat', coach: ['[narx]dan tushadi'], kind: 'sales', enabled: true },
      { client: 'Salom', coach: ['Va alaykum'], kind: 'style', enabled: true },
    ]);
    await runDataMigrations();
    const lead = await db.collection('leads').findOne({ chatId: 1 });
    expect(lead?.status).toBe('READY');
    expect(lead?.mode).toBe('MANUAL');
    expect(await db.collection('style_examples').countDocuments({ enabled: true })).toBe(1);
  });
});
