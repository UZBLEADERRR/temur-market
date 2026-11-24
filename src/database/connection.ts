import pg from 'pg';
import { logger } from '../utils/logger';
import { getPool, setPool } from './odm';
import { SCHEMA_SQL } from './schema';

/**
 * Bitta Postgres pool. Hovuz ataylab kichik: bu bot kuniga o'n-yigirma
 * suhbatni olib boradi, parallel so'rov deyarli yo'q. Har ochiq ulanish
 * Postgres tomonda ham xotira egallaydi, Railway esa shunga pul oladi.
 */
export async function connectDatabase(uri: string): Promise<pg.Pool> {
  const pool = new pg.Pool({
    connectionString: uri,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Railway'ning ichki tarmog'i TLS'ni o'zi tekshirmaydi
    ssl: /\bsslmode=require\b/.test(uri) ? { rejectUnauthorized: false } : undefined,
  });

  // Ulanish uzilsa jarayon yiqilmasin — keyingi so'rov yangi ulanish oladi
  pool.on('error', (err) => logger.warn({ err: err.message }, 'Postgres ulanishi uzildi'));

  setPool(pool);
  const res = await pool.query('SELECT current_database() AS db');
  await pool.query(SCHEMA_SQL);
  logger.info({ db: res.rows[0].db }, 'PostgreSQL connected');
  return pool;
}

export async function disconnectDatabase(): Promise<void> {
  try {
    await getPool().end();
  } catch {
    // ulanmagan edi
  }
  setPool(undefined);
}

/**
 * Mongo'da processed_updates'ga TTL indeks qo'yilgan edi — eski qatorlarni
 * baza o'zi o'chirardi. Postgres'da TTL yo'q, shuning uchun fon ishi tozalaydi.
 */
export async function purgeOldUpdates(days = 14): Promise<number> {
  const res = await getPool().query(`DELETE FROM processed_updates WHERE "createdAt" < now() - $1::interval`, [`${days} days`]);
  return res.rowCount ?? 0;
}
