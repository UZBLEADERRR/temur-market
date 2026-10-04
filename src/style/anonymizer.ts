import { normalize } from '../utils/text';

/** Health terms (stems). Matched only at the start of a word so "qanday" never becomes "qand". */
const HEALTH_STEMS = [
  'grija', 'gryja', 'diabet', 'gipertoni', 'astma', 'operatsiya', 'skolioz', 'artrit', 'gormon', 'garmon',
  'qalqonsimon', 'homilador', 'грыж', 'диабет', 'давлени', 'гормон', 'щитовид', 'операци', 'сколиоз', 'беремен', 'астм',
];
/** Short health words that must match as whole words. */
const HEALTH_WORDS = ['qand', 'qandli', 'bosim', 'bosimim', 'yurak', 'jigar', 'buyrak', 'сахар', 'сердце', 'печень', 'почки'];

const HEALTH_RE = new RegExp(
  `(?<![\\p{L}])(?:(?:${HEALTH_STEMS.join('|')})\\p{L}*|(?:${HEALTH_WORDS.join('|')})(?![\\p{L}]))`,
  'giu',
);

export interface AnonymizeOptions {
  /** Names of chat participants to remove (client display names, etc.). */
  names?: string[];
  /** Replace all digits (used for client side so weights/ages never leak into examples). */
  maskNumbers?: boolean;
}

/** Removes personal data from historical chat text. Conservative: masks more rather than less. */
export function anonymize(text: string, opts: AnonymizeOptions = {}): string {
  let t = text.normalize('NFKC');
  t = t.replace(/https?:\/\/\S+|t\.me\/\S+|www\.\S+/gi, '[link]');
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]');
  t = t.replace(/@[A-Za-z0-9_]{3,}/g, '[username]');
  t = t.replace(/\b(?:\d[ -]?){16}\b/g, '[karta]');
  t = t.replace(/(?:\+?998|\+?7|\b8)[\s-]?\(?\d{2,3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/g, '[telefon]');
  t = t.replace(/\b\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/g, '[telefon]');
  t = t.replace(
    /\d[\d\s.,]*\s*(?:so'm|som|сум|sum|ming|тыс|mln|млн|million|миллион|\$|usd|dollar|долл|won|вон)/gi,
    '[narx]',
  );
  for (const name of opts.names ?? []) {
    for (const part of name.normalize('NFKC').split(/\s+/).filter((p) => p.length >= 3)) {
      t = t.replace(new RegExp(`(?<![\\p{L}])${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'giu'), '[ism]');
    }
  }
  t = t.replace(HEALTH_RE, "[sog'liq]");
  if (opts.maskNumbers) t = t.replace(/\d+(?:[.,]\d+)?/g, 'N');
  return t.trim();
}

/** Coach replies that must never be used as style examples (prices, cards, diet plans, client-specific promises). */
export function isUnsafeCoachReply(text: string): boolean {
  const n = normalize(text);
  if (/\[(narx|karta|telefon|link|email)\]/.test(text)) return true;
  if (/\d/.test(n)) return true; // numbers = prices, diet grams, promised days for a specific client
  if (/(narx|tarif|chegirma|to'lov|karta|цена|стоимост|скидк|оплат)/.test(n)) return true;
  if (text.length > 350) return true;
  if (!/\p{L}/u.test(text)) return true; // "." or emoji-only replies carry no style
  return false;
}
