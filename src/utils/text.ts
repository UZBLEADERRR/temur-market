export type Lang = 'uz' | 'ru';

/** Normalizes apostrophes and case so keyword matching works for o'/o‘/oʻ variants. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’`ʻʼ´]/g, "'")
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

const UZ_CYRILLIC = /[ўқғҳЎҚҒҲ]/;

/** Detects Russian vs Uzbek. Uzbek written in Cyrillic is treated as Uzbek. Returns undefined when unsure. */
export function detectLanguage(text: string): Lang | undefined {
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length < 2) return undefined;
  const cyr = (letters.match(/[Ѐ-ӿ]/g) ?? []).length;
  const ratio = cyr / letters.length;
  if (ratio > 0.5) {
    if (UZ_CYRILLIC.test(text)) return 'uz';
    const words = new Set(normalize(text).split(/[^\p{L}]+/u));
    if (['салом', 'рахмат', 'яхши', 'канча', 'менга', 'сизга', 'йук', 'йўқ', 'бўй', 'ёш'].some((w) => words.has(w))) return 'uz';
    return 'ru';
  }
  if (ratio < 0.2) return 'uz';
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
