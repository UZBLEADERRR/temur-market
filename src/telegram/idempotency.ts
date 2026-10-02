import { ProcessedUpdate } from '../database/models/misc';

/** Returns true the first time a key is seen, false for duplicates (Telegram retries, restarts). */
export async function firstTime(key: string): Promise<boolean> {
  try {
    await ProcessedUpdate.create({ key });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}
