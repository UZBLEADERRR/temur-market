export type Lang = 'uz' | 'ru';

/** Normalizes apostrophes and case so keyword matching works for o'/o‘/oʻ variants. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’`ʻʼ´]/g, "'")
    .replace(/ё/g, 'е')
    // Turkish-keyboard spellings of Uzbek Latin: ğ → g', ş → sh, ç → ch, ö → o'
    .replace(/ğ/g, "g'")
    .replace(/ş/g, 'sh')
    .replace(/ç/g, 'ch')
    .replace(/ö/g, "o'")
    .replace(/ü/g, 'u')
    .replace(/ı/g, 'i')
    .replace(/\s+/g, ' ')
    .trim();
}

const UZ_CYRILLIC = /[ўқғҳЎҚҒҲ]/;

/** Common Uzbek words written in Cyrillic (after normalize: ё→е). */
const UZ_CYR_WORDS = new Set([
  'салом', 'ассалому', 'ассалом', 'алайкум', 'алейкум', 'рахмат', 'раҳмат', 'яхши', 'яхшимисиз', 'канча', 'қанча', 'нарх', 'нархи',
  'нархини', 'керак', 'кере', 'менга', 'сизга', 'мен', 'сиз', 'бор', 'бормиз', 'бормисиз', 'йук', 'йуқ', 'йўқ', 'ха', 'ҳа', 'хоп',
  'ҳоп', 'озиш', 'озмокчиман', 'озмоқчиман', 'семириш', 'бўй', 'буй', 'вазн', 'еш', 'ешим', 'ака', 'опа', 'ука', 'укам', 'курсингиз',
  'курсга', 'курсни', 'кейин', 'хозир', 'ҳозир', 'нима', 'нега', 'качон', 'қачон', 'канака', 'қанақа', 'тушунарли', 'майли', 'зор',
  'зўр', 'бўлади', 'булади', 'бўлдими', 'кандай', 'қандай', 'узбекистон', 'ўзбекистон', 'корея', 'кореяда', 'тошкент', 'тошкентда',
  'маълумот', 'малумот', 'ёрдам', 'тренировка', 'зал', 'залда', 'уйда', 'саволим', 'савол', 'ёзинг', 'ёзаман',
].map((w) => w.replace(/ё/g, 'е')));

/** Unmistakably Russian words. */
const RU_WORDS = new Set([
  'здравствуйте', 'здравствуй', 'привет', 'добрый', 'хочу', 'хотела', 'хотел', 'сколько', 'стоит', 'можно', 'как', 'что', 'это',
  'мне', 'меня', 'я', 'вы', 'вас', 'пожалуйста', 'спасибо', 'да', 'нет', 'буду', 'есть', 'нужно', 'надо', 'когда', 'где', 'почему',
  'похудеть', 'подскажите', 'расскажите', 'интересно', 'цена', 'записаться', 'тоже', 'очень', 'уже', 'еще', 'или', 'если', 'только',
  'занимаюсь', 'вес', 'рост', 'лет', 'года', 'интересует', 'интересно', 'узнать', 'подробнее', 'хотелось',
]);

/** Uzbek suffixes on Cyrillic words (агглютинация) vs typical Russian endings. */
const UZ_SUFFIX = /(лар|ларни|ларга|лардан|ни|га|ка|да|дан|ман|миз|сиз|мисиз|ми|чи|моқчи|мокчи|япман|япти|ган|гандим|ди|дим|сам|са)$/;
const RU_SUFFIX = /(ться|тся|ость|ого|его|ому|ему|ый|ий|ая|ое|ые|ешь|ете|ишь|ите|ую|юю)$/;

/**
 * Detects Russian vs Uzbek (Latin or Cyrillic script). Uzbek written in Cyrillic («Курсингиз нархи канча?»)
 * is Uzbek, not Russian. A short ambiguous Cyrillic word («Курс») returns undefined so the previous language
 * (default Uzbek) is kept. Returns undefined when unsure.
 */
export function detectLanguage(text: string): Lang | undefined {
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length < 2) return undefined;
  const cyr = (letters.match(/[\u0400-\u04FF]/g) ?? []).length;
  const ratio = cyr / letters.length;
  if (ratio < 0.2) return 'uz';
  if (ratio <= 0.5) return undefined;
  if (UZ_CYRILLIC.test(text)) return 'uz';
  const words = normalize(text)
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
  let uz = 0;
  let ru = 0;
  for (const w of words) {
    if (UZ_CYR_WORDS.has(w)) uz += 2;
    else if (RU_WORDS.has(w)) ru += 2;
    else if (w.length > 3 && UZ_SUFFIX.test(w)) uz += 1;
    else if (w.length > 3 && RU_SUFFIX.test(w)) ru += 1;
  }
  if (uz > ru) return 'uz';
  if (ru > uz) return 'ru';
  return undefined;
}

/** Which alphabet the client uses (for Uzbek: reply in the same script). */
export function detectScript(text: string): 'cyrl' | 'latn' | undefined {
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length < 2) return undefined;
  const cyr = (letters.match(/[\u0400-\u04FF]/g) ?? []).length / letters.length;
  if (cyr > 0.6) return 'cyrl';
  if (cyr < 0.2) return 'latn';
  return undefined;
}

export function splitKeywords(value: string): string[] {
  return value
    .split(/[\n,;]+/)
    .map((s) => normalize(s))
    .filter(Boolean);
}

export function containsAny(text: string, keywords: string[]): string | undefined {
  const n = normalize(text);
  return keywords.find((k) => k && n.includes(k));
}

export function fillTemplate(tpl: string, vars: Record<string, string | number | undefined>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => String(vars[k] ?? ''));
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

const GREETING_WORDS = new Set([
  'salom', 'assalomu', 'assalom', 'alaykum', 'aleykum', 'alekum', 'aka', 'opa', 'uka', 'yaxshimisiz', 'qalaysiz', 'qalesiz',
  'xayrli', 'hayrli', 'kun', 'tong', 'kech', 'kechqurun', 'ertalab', 'ok', 'hi', 'hello', 'hey', 'привет', 'здравствуйте',
  'здравствуй', 'добрый', 'день', 'вечер', 'утро', 'салом', 'ассалому', 'алайкум', 'brat', 'бро', 'bro', 'sizga', 'savol', 'bor', 'edi',
]);

/** True for messages that are only a greeting ("Salom", "Assalomu alaykum aka", "Привет"), i.e. no purpose yet. */
export function isGreetingOnly(text: string): boolean {
  const words = normalize(text)
    .replace(/[^\p{L}\s']/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/'/g, ''))
    .filter(Boolean);
  if (!words.length) return true;
  return words.every((w) => GREETING_WORDS.has(w) || GREETING_WORDS.has(w.replace(/'/g, '')));
}
