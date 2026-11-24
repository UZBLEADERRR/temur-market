import { ProcessedUpdate } from '../database/models/misc';

/** Unique cheklov buzilgani — Postgres kodi (Mongo'da 11000 edi). */
const UNIQUE_VIOLATION = '23505';

/** Returns true the first time a key is seen, false for duplicates (Telegram retries, restarts). */
export async function firstTime(key: string): Promise<boolean> {
  try {
    await ProcessedUpdate.create({ key });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) return false;
    throw err;
  }
}
