import { logger } from '../utils/logger';
import { getPool } from './odm';

/**
 * Orqaga qaytarilgan "sotuv" versiyasidan qolgan ma'lumotlarni tozalaydi:
 * - o'chirilgan 'SALES' statusidagi leadlar → READY / MANUAL (ular murabbiy navbatida);
 * - import qilingan 'sales' uslub namunalari ([narx] bilan) o'chiriladi, anketa narx haqida gapirmasin.
 *
 * To'g'ridan-to'g'ri SQL: bu qiymatlar joriy modellarda yo'q.
 */
export async function runDataMigrations(): Promise<void> {
  const pool = getPool();
  // Mongo versiyasi bu yerda followUpAt'ni ham o'chirardi; yangi sxemada
  // bunday ustun yo'q, shuning uchun o'chiradigan narsa qolmadi.
  const leads = await pool.query(
    `UPDATE leads SET "status" = 'READY', "mode" = 'MANUAL', "readyAt" = now(), "updatedAt" = now() WHERE "status" = 'SALES'`,
  );
  const examples = await pool.query(
    `UPDATE style_examples SET "enabled" = FALSE, "updatedAt" = now() WHERE "kind" = 'sales' AND "enabled" = TRUE`,
  );
  if (leads.rowCount || examples.rowCount) {
    logger.info({ leads: leads.rowCount, salesExamples: examples.rowCount }, 'Data migrated after rollback');
  }
}
