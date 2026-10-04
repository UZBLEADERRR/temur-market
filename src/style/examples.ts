import { StyleExample } from '../database/models/misc';
import { detectLanguage, normalize, type Lang } from '../utils/text';
import { anonymize, isUnsafeCoachReply } from './anonymizer';
import { identifyCoach, type RawChat } from './chatImport';

export interface ExamplePair {
  client: string;
  coach: string[];
  language: Lang;
}

export function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      normalize(text)
        .replace(/[^\p{L}\s']/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3)
        .map((w) => w.slice(0, 5)),
    ),
  );
}

/** Turns a chat into anonymized (client → coach) pairs. Only coach replies and the message they answered remain. */
export function buildPairs(chat: RawChat, opts: { coachId?: number; coachName?: string }): ExamplePair[] {
  const coach = identifyCoach(chat, opts);
  if (!coach) return [];
  const names = Array.from(new Set(chat.messages.map((m) => m.sender).filter((s) => s && s !== coach)));
  if (chat.peerName) names.push(chat.peerName);

  const pairs: ExamplePair[] = [];
  let clientRun: string[] = [];
  let coachRun: string[] = [];
  const flush = () => {
    const clientText = clientRun.join('\n').trim();
    const coachTexts = coachRun.map((t) => t.trim()).filter(Boolean).slice(0, 3);
    if (clientText && coachTexts.length) {
      const cleanCoach = coachTexts.map((t) => anonymize(t, { names }));
      if (!cleanCoach.some(isUnsafeCoachReply)) {
        const cleanClient = anonymize(clientText, { names, maskNumbers: true }).slice(0, 300);
        pairs.push({
          client: cleanClient,
          coach: cleanCoach,
          language: detectLanguage(cleanCoach.join(' ')) ?? detectLanguage(cleanClient) ?? 'uz',
        });
      }
    }
    clientRun = [];
    coachRun = [];
  };

  for (const m of chat.messages) {
    if (!m.text) continue;
    if (m.sender === coach) {
      if (clientRun.length) coachRun.push(m.text);
    } else {
      if (coachRun.length) flush();
      clientRun.push(m.text);
    }
  }
  flush();

  // de-duplicate identical pairs
  const seen = new Set<string>();
  return pairs.filter((p) => {
    const k = normalize(p.client + '|' + p.coach.join('|'));
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function saveExamples(pairs: ExamplePair[], source = 'import'): Promise<number> {
  if (!pairs.length) return 0;
  const docs = pairs.map((p) => ({ ...p, tokens: tokenize(p.client + ' ' + p.coach.join(' ')), source }));
  await StyleExample.insertMany(docs);
  return docs.length;
}

export interface RetrievedExample {
  client: string;
  coach: string[];
}

/**
 * Picks relevant examples for the current turn: token overlap with the client's message and the
 * next question, same language first, then fills the rest with varied examples so the style stays rich.
 */
export async function retrieveExamples(query: string, lang: Lang, limit: number, seed = 0): Promise<RetrievedExample[]> {
  const all = await StyleExample.find({ enabled: true }).select('client coach language tokens').lean();
  if (!all.length || limit <= 0) return [];
  const q = new Set(tokenize(query));
  const scored = all.map((e, i) => {
    const overlap = (e.tokens ?? []).filter((t) => q.has(t)).length;
    const langBonus = e.language === lang ? 2 : 0;
    const jitter = ((i * 9301 + seed * 49297) % 233280) / 233280; // deterministic per lead
    return { e, score: overlap * 3 + langBonus + jitter };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ e }) => ({ client: e.client, coach: e.coach }));
}

export function formatExamples(examples: RetrievedExample[], coachName: string): string {
  return examples.map((e) => `Mijoz: ${e.client}\n${coachName}: ${e.coach.join('\n' + coachName + ': ')}`).join('\n\n');
}
