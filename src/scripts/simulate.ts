/**
 * Manual test scenarios against the REAL LLM (needs LLM_API_KEY) without Telegram:
 *   npm run simulate            → runs all scenarios A–O
 *   npm run simulate -- F       → only scenario F
 * Messages are printed instead of being sent. Uses MONGODB_URI (use a separate test database!).
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { connectDatabase } from '../database/connection';
import { SettingsService } from '../services/settings';
import { AiService } from '../ai/aiService';
import { createLlmClient } from '../ai/createLlmClient';
import { LlmError, type LlmClient } from '../ai/llmClient';
import { ConversationEngine } from '../conversations/engine';
import { LeadService } from '../leads/leadService';
import { Lead } from '../database/models/Lead';
import { Campaign } from '../database/models/misc';
import type { TelegramGateway } from '../telegram/gateway';

const SCENARIOS: Record<string, { title: string; msgs: string[]; failAi?: boolean }> = {
  A: { title: "Oddiy o'zbek mijoz", msgs: ['Salom', "180 bo'yim 95 kg 27 yosh, 1 yil zalga borganman", '85 kg', '4 kun, zalda', "Ha, ishdan vaqt bo'lmadi", "yo'q"] },
  B: { title: 'Rus mijoz', msgs: ['Здравствуйте', 'Рост 170, вес 85, 32 года, опыта нет', 'Хочу 70', '3 раза дома', 'Пробовала диеты, срывалась', 'Колени болят'] },
  C: { title: 'Hammasi bitta xabarda', msgs: ["Salom. 178 sm, 92 kg, 30 yosh, 3 yil tajriba. Maqsad 80 kg. Haftasiga 5 kun zal. Oldin o'zim qildim, ovqatni ushlay olmadim. Sog'ligim joyida"] },
  D: { title: 'Qisman javob', msgs: ['Salom', "175 bo'y", '80 kg, 25 yosh', "tajribam yo'q"] },
  E: { title: "Narx so'raydi", msgs: ['Salom', 'Narxi qancha?', '180 90 25 1 yil', 'Kurs necha oy?'] },
  F: { title: '«Botmisiz?»', msgs: ['Salom', 'Siz botmisiz o\'zi?'] },
  G: { title: 'Temur kerak', msgs: ['Temurning o\'zi bilan gaplashmoqchiman'] },
  H: { title: "Sog'liq muammosi", msgs: ['Salom', '170 75 40 tajriba yo\'q', 'ozish', '3 kun uyda', "yo'q", 'Grija bor, bel og\'riydi'] },
  I: { title: 'Ochlik', msgs: ['Salom', 'Men 3 kundan beri hech narsa yemayapman, tezroq ozish uchun'] },
  J: { title: 'Juda past maqsad vazn', msgs: ['Salom', '170 60 20 tajriba yo\'q', '48 kg bo\'lmoqchiman'] },
  K: { title: 'Javob bermay qoldi', msgs: ['Salom'] },
  M: { title: 'video_01 dan', msgs: ['Salom! #v1'] },
  N: { title: 'video_02 dan', msgs: ['Salom! 2-videodan keldim'] },
  O: { title: 'AI vaqtincha ishlamayapti', msgs: ['Salom', '180 90 25 1 yil'], failAi: true },
};

class PrintGateway implements TelegramGateway {
  async sendBusinessMessage(_c: string, _chat: number, text: string) {
    console.log(`   🟦 Temur(AI): ${text}`);
    return { messageId: Math.floor(Math.random() * 1e6) };
  }
  async sendTyping() {}
  async sendBusinessVoice(_c: string, _chat: number, fileId: string) {
    console.log(`   🎙 Temur(AI) ovoz: ${fileId.slice(0, 12)}…`);
    return { messageId: Math.floor(Math.random() * 1e6) };
  }
  async sendAdminVoice() {}
  async notifyAdmins(html: string) {
    console.log(`   📮 ADMIN: ${html.replace(/<[^>]+>/g, '').split('\n').slice(0, 3).join(' | ')}`);
    return [];
  }
  async editAdminMessage() {}
  async sendAdminDocument() {}
  async downloadFile(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
}

async function main() {
  await connectDatabase(env.MONGODB_URI);
  const only = process.argv[2]?.toUpperCase();
  const settings = new SettingsService();
  const real = createLlmClient(env);
  let failing = false;
  const client: LlmClient = { generate: (r) => (failing ? Promise.reject(new LlmError('simulated outage', true)) : real.generate(r)) };
  const ai = new AiService(client, settings, { retryDelaysMs: [500, 1000] });
  const gateway = new PrintGateway();
  const leads = new LeadService({ gateway, timeZone: env.TZ_NAME });
  const engine = new ConversationEngine({ gateway, ai, settings, leads }, { debounceMsOverride: 0, fastTyping: true });
  await Campaign.updateOne({ code: '#v1' }, { $set: { source: 'video_01' } }, { upsert: true });

  let chatId = 900_000 + Math.floor(Math.random() * 1000) * 100;
  for (const [key, sc] of Object.entries(SCENARIOS)) {
    if (only && key !== only) continue;
    chatId++;
    failing = Boolean(sc.failAi);
    console.log(`\n=== ${key}. ${sc.title} ===`);
    for (const text of sc.msgs) {
      console.log(`   ⬜️ Mijoz: ${text}`);
      await engine.handleClientMessage({ connectionId: 'sim', chat: { id: chatId, first_name: 'Test' }, messageId: Date.now(), text, kind: 'text' });
    }
    const lead = await Lead.findOne({ chatId }).lean();
    console.log(`   → status=${lead?.status} mode=${lead?.mode} urgent=${lead?.urgent} source=${lead?.source} TMI=${lead?.bmi ?? '-'} answers=${JSON.stringify(lead?.answers)}`);
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
