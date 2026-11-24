import pg from 'pg';
import { logger } from '../utils/logger';
import { getPool, setPool } from './odm';
import { SCHEMA_SQL } from './schema';

/**
 * Bitta Postgres pool. Hovuz ataylab kichik: bu bot kuniga o'n-yigirma
 * suhbatni olib boradi, parallel so'rov deyarli yo'q. Har ochiq ulanish
 * Postgres tomonda ham xotira egallaydi, Railway esa shunga pul oladi.
 */
/** Railway konteyner ichida ishlayotganimizni bildiradi. */
function onRailway(): boolean {
  return Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID || process.env.RAILWAY_PROJECT_ID);
}

const LOCAL_HOST = /@(127\.0\.0\.1|localhost)[:/]/;

/**
 * Lokal baza va Railway'ning ichki tarmog'i TLS'siz ishlaydi; tashqi baza
 * (Neon, Supabase, Railway'ning ommaviy proxy manzili) esa TLS talab qiladi.
 * `sslmode=disable` yozilgan bo'lsa, aytilganidek qoldiramiz.
 */
export function needsSsl(uri: string): boolean {
  if (/\bsslmode=(disable|allow)\b/.test(uri)) return false;
  if (/\bsslmode=/.test(uri)) return true;
  if (LOCAL_HOST.test(uri)) return false;
  // Railway ichki manzili: postgres.railway.internal
  return !/@[^@/]*\.internal[:/]/.test(uri);
}

export async function connectDatabase(uri: string): Promise<pg.Pool> {
  // Railway'da DATABASE_URL qo'yilmagan bo'lsa, standart qiymat localhost'ga
  // qaraydi — u yerda hech narsa yo'q va konteyner tinmay qayta ishga tushadi.
  // Buni "ulanmadi" degan tushunarsiz xato o'rniga aniq aytamiz.
  if (onRailway() && LOCAL_HOST.test(uri)) {
    throw new Error(
      [
        "DATABASE_URL qo'yilmagan — baza manzili localhost'ga qarab turibdi.",
        '',
        'Railway → loyiha → + New → Database → Postgres,',
        "keyin bot servisi → Variables → DATABASE_URL = ${{Postgres.DATABASE_URL}}",
        '',
        "Tashqi baza (Neon, Supabase) bo'lsa, uning connection string'ini qo'ying.",
      ].join('\n'),
    );
  }

  const pool = new pg.Pool({
    connectionString: uri,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: needsSsl(uri) ? { rejectUnauthorized: false } : undefined,
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
