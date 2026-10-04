import mongoose from 'mongoose';
import { logger } from '../utils/logger';

/**
 * Cleans up data left by the (rolled back) sales version so this version runs safely:
 * - leads in the removed 'SALES' status → READY / MANUAL (they are in the coach's queue);
 * - imported 'sales' style examples (prices masked as [narx]) are disabled so the questionnaire never talks about prices.
 * Uses raw collections because the current schemas do not know these values.
 */
export async function runDataMigrations(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  const leads = await db.collection('leads').updateMany(
    { status: 'SALES' },
    { $set: { status: 'READY', mode: 'MANUAL', readyAt: new Date() }, $unset: { followUpAt: '' } },
  );
  const examples = await db.collection('style_examples').updateMany({ kind: 'sales', enabled: true }, { $set: { enabled: false } });
  if (leads.modifiedCount || examples.modifiedCount) {
    logger.info({ leads: leads.modifiedCount, salesExamples: examples.modifiedCount }, 'Data migrated after rollback');
  }
}
