import { normalize } from './text';

export type CountryCode = 'KR' | 'UZ' | 'OTHER';

const KR = /(koreya|koreа|korea|koreada|koreyada|janubiy koreya|seul|seoul|pusan|busan|incheon|suwon|ansan|корея|корее|сеул)/;
const UZ = /(o'zbekiston|ozbekiston|uzbekiston|uzbekistan|\buzb\b|uzbda|o'zbda|toshkent|tashkent|samarqand|buxoro|andijon|farg'ona|namangan|узбекистан|ташкент)/;
const OTHER = /(rossiya|moskva|russia|россия|москв|turkiya|turkey|istanbul|amerika|usa|aqsh|germaniya|yaponiya|japan|qozog'iston|kazakhstan|dubay|dubai|chet el|boshqa davlat|xorij)/;

/** Detects where the client lives from free text («Koreyadaman», «Toshkentda», «Москва»). */
export function detectCountry(text: string): CountryCode | undefined {
  const n = normalize(text);
  if (KR.test(n)) return 'KR';
  if (UZ.test(n)) return 'UZ';
  if (OTHER.test(n)) return 'OTHER';
  return undefined;
}

export const COUNTRY_LABEL: Record<CountryCode, string> = { KR: 'Koreya', UZ: "O'zbekiston", OTHER: 'boshqa chet el' };

/** Which currency belongs to which country — used to catch «so'm» sent to a client in Korea and vice versa. */
const WON = /\d[\d\s,.]*\s*(ming\s*)?(won|вон|krw|₩)|₩\s*\d/i;
const SOM = /\d[\d\s,.]*\s*(ming\s*|mln\s*|million\s*)?(so'm|som|sum|сум|uzs)\b/i;

export function mentionsWrongCurrency(text: string, country: CountryCode): boolean {
  const n = normalize(text);
  if (country === 'KR') return SOM.test(n) && !WON.test(n);
  if (country === 'UZ') return WON.test(n) && !SOM.test(n);
  return false;
}

export function mentionsPrice(text: string): boolean {
  const n = normalize(text);
  return WON.test(n) || SOM.test(n);
}

/** The price line for a country from the admin's price list («Koreyadagilar uchun: 150,000 KRW»). */
export function priceLineFor(country: CountryCode, priceList: string): string {
  const lines = priceList.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pick = (re: RegExp) => lines.find((l) => re.test(normalize(l)));
  if (country === 'KR') return pick(/korey|korea|krw|won|вон/) ?? '';
  if (country === 'UZ') return pick(/o'zbekiston|ozbekiston|uzbekiston|узбекистан/) ?? pick(/so'm|uzs|сум/) ?? '';
  return pick(/chet el|boshqa|xorij|зарубеж/) ?? '';
}

/** Voice clip country from its title/caption/transcript: «narx koreya», «150 ming won» → KR. */
export function guessClipCountry(text: string): CountryCode | 'ALL' {
  const n = normalize(text);
  const kr = KR.test(n) || /(won|вон|krw)/.test(n);
  const uz = UZ.test(n) || /(so'm|сум|uzs)/.test(n);
  if (kr && !uz) return 'KR';
  if (uz && !kr) return 'UZ';
  if (!kr && !uz && /(chet el|boshqa davlat|xorij)/.test(n)) return 'OTHER';
  return 'ALL';
}
