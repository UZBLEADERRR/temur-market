/**
 * CLI: import TEMUR's Telegram exports as anonymized style examples.
 *   npm run import:chats -- path/to/messages.html [path/to/result.json ...]
 * Same as sending the file to the bot's admin chat.
 */
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';
import { connectDatabase, disconnectDatabase } from '../database/connection';
import { SettingsService } from '../services/settings';
import { importChatExport } from '../style/importService';

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error('Usage: npm run import:chats -- <export.html|result.json> ...');
  await connectDatabase(env.MONGODB_URI);
  const coachName = await new SettingsService().get('coach_name');
  for (const f of files) {
    const res = await importChatExport(path.basename(f), fs.readFileSync(f, 'utf8'), { coachId: env.TEMUR_TELEGRAM_ID, coachName });
    console.log(`${f}: ${res.chats} chat, ${res.messages} messages → ${res.examples} anonymized examples`);
  }
  await disconnectDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
