/**
 * Uzbek Latin → Uzbek Cyrillic, for clients who write in Cyrillic: fixed texts (first message, questions,
 * country question…) are stored in Latin and converted before sending.
 */
const MULTI: Array<[RegExp, string]> = [
  [/o['‘’`ʻ]/g, 'ў'],
  [/O['‘’`ʻ]/g, 'Ў'],
  [/g['‘’`ʻ]/g, 'ғ'],
  [/G['‘’`ʻ]/g, 'Ғ'],
  [/sh/g, 'ш'],
  [/Sh/g, 'Ш'],
  [/SH/g, 'Ш'],
  [/ch/g, 'ч'],
  [/Ch/g, 'Ч'],
  [/CH/g, 'Ч'],
  [/yo/g, 'ё'],
  [/Yo/g, 'Ё'],
  [/yu/g, 'ю'],
  [/Yu/g, 'Ю'],
  [/ya/g, 'я'],
  [/Ya/g, 'Я'],
  [/(^|[\s.,!?«"(-])ye/g, '$1е'],
  [/(^|[\s.,!?«"(-])Ye/g, '$1Е'],
  [/(^|[\s.,!?«"(-])e/g, '$1э'],
  [/(^|[\s.,!?«"(-])E/g, '$1Э'],
];

const SINGLE: Record<string, string> = {
  a: 'а', b: 'б', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'ҳ', i: 'и', j: 'ж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п',
  q: 'қ', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', x: 'х', y: 'й', z: 'з', c: 'с', w: 'в',
};

export function uzLatinToCyrillic(text: string): string {
  // links and codes (KRW, UZS, URLs, @username) stay as they are
  const parts = text.split(/(https?:\/\/\S+|t\.me\/\S+|@\w+|\b[A-Z]{2,}\b)/);
  return parts.map((p, i) => (i % 2 === 1 ? p : convert(p))).join('');
}

function convert(text: string): string {
  let t = text;
  for (const [re, rep] of MULTI) t = t.replace(re, rep);
  t = t.replace(/[A-Za-z]/g, (ch) => {
    const lower = SINGLE[ch.toLowerCase()];
    if (!lower) return ch;
    return ch === ch.toLowerCase() ? lower : lower.toUpperCase();
  });
  // a leftover apostrophe inside a word is the Uzbek «ъ» (ma'lumot → маълумот, san'at → санъат)
  return t.replace(/([а-яёўқғҳ])['‘’`ʻ](?=[а-яёўқғҳ])/gi, '$1ъ');
}

/** Safe to convert: Latin prose without links, long numbers (cards/accounts) or e-mails. */
export function isConvertibleLatin(text: string): boolean {
  if (/\d{6,}|\d[\d\s-]{9,}\d/.test(text.replace(/,\d{3}/g, ''))) return false; // card / account numbers
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (!letters) return false;
  const latin = (letters.match(/[A-Za-z]/g) ?? []).length;
  return latin / letters.length > 0.8;
}
