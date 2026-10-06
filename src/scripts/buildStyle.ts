/** CLI: rebuild the TEMUR style profile from imported examples (same as /style_rebuild). */
import { env } from '../config/env';
import { connectDatabase, disconnectDatabase } from '../database/connection';
import { SettingsService } from '../services/settings';
import { AiService } from '../ai/aiService';
import { createLlmClient } from '../ai/createLlmClient';
import { rebuildStyleProfile } from '../style/styleProfile';

async function main() {
  await connectDatabase(env.MONGODB_URI);
  const settings = new SettingsService();
  const ai = new AiService(
    createLlmClient(env),
    settings,
  );
  const { profile, stats } = await rebuildStyleProfile(ai, settings);
  console.log(JSON.stringify(stats, null, 2));
  console.log(profile);
  await disconnectDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
