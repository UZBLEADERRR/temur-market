import { StyleExample, StyleProfile } from '../database/models/misc';
import type { AiService } from '../ai/aiService';
import type { SettingsService } from '../services/settings';
import { normalize } from '../utils/text';

export interface StyleStats {
  examples: number;
  coachMessages: number;
  avgWordsPerMessage: number;
  avgMessagesPerTurn: number;
  emojiPerMessage: number;
  questionMarkRate: number;
  endsWithPeriodRate: number;
  topPhrases: string[];
}

const EMOJI = /\p{Extended_Pictographic}/gu;

export function computeStyleStats(examples: Array<{ coach: string[] }>): StyleStats {
  const msgs = examples.flatMap((e) => e.coach);
  const words = msgs.map((m) => m.split(/\s+/).filter(Boolean).length);
  const counts = new Map<string, number>();
  for (const m of msgs) {
    const n = normalize(m).replace(/[^\p{L}\s']/gu, '').trim();
    if (!n) continue;
    const w = n.split(' ');
    const phrases = [n.split(' ').length <= 4 ? n : '', ...w.slice(0, 3).map((_, i) => w.slice(i, i + 2).join(' '))];
    for (const p of phrases) if (p && p.length > 2) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const topPhrases = [...counts.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([p]) => p);
  const avg = (arr: number[]) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : 0);
  return {
    examples: examples.length,
    coachMessages: msgs.length,
    avgWordsPerMessage: avg(words),
    avgMessagesPerTurn: avg(examples.map((e) => e.coach.length)),
    emojiPerMessage: avg(msgs.map((m) => (m.match(EMOJI) ?? []).length)),
    questionMarkRate: avg(msgs.map((m) => (m.includes('?') ? 1 : 0))),
    endsWithPeriodRate: avg(msgs.map((m) => (/\.$/.test(m.trim()) ? 1 : 0))),
    topPhrases,
  };
}

/**
 * Builds the reusable style profile: statistics from the examples + an LLM summary
 * (secondary source: voice transcripts). Saves it and puts it into the editable `style_profile` setting.
 */
export async function rebuildStyleProfile(ai: AiService, settings: SettingsService): Promise<{ profile: string; stats: StyleStats }> {
  const examples = await StyleExample.find({ enabled: true }).select('client coach').lean();
  const stats = computeStyleStats(examples);
  const coachName = await settings.get('coach_name');
  const voice = await settings.get('voice_style_notes');
  const sample = examples.slice(0, 120).map((e) => `Mijoz: ${e.client}\n${coachName}: ${e.coach.join(' / ')}`).join('\n\n');

  const system =
    "Sen yozish uslubini tahlil qiluvchi mutaxassissan. Faqat uslubni tasvirla, mijozlarning shaxsiy ma'lumotlarini, narxlarni va va'dalarni yozma. Javob o'zbek tilida, oddiy matn.";
  const prompt = `${coachName}ning Telegram yozishmalaridan anonim namunalar va statistika berilgan.
Quyidagi bo'limlar bilan qisqa USLUB PROFILI yoz (har biri 1-2 qator):
language_style, sentence_length, tone, greeting_style, punctuation, emoji_frequency, question_style, transitions, common_phrases (10-20 ta, vergul bilan), russian_style, spoken_style.

STATISTIKA: ${JSON.stringify(stats)}

${voice ? `OVOZLI XABARLAR TRANSKRIPTI (ikkilamchi manba, faqat uslub uchun):\n${voice.slice(0, 4000)}\n\n` : ''}NAMUNALAR:\n${sample}`;

  const profile = await ai.freeText(system, prompt);
  await StyleProfile.updateMany({}, { $set: { active: false } });
  await StyleProfile.create({ profile: { text: profile }, stats, exampleCount: examples.length, active: true });
  await settings.set({ style_profile: profile });
  return { profile, stats };
}
