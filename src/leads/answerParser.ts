import type { LeadAnswers } from '../types/domain';
import { normalize } from '../utils/text';

export const RANGES = {
  height: [120, 230],
  weight: [30, 250],
  age: [10, 90],
  targetWeight: [30, 250],
  trainingDays: [0, 7],
} as const;

export function inRange(field: keyof typeof RANGES, v: unknown): v is number {
  const [min, max] = RANGES[field];
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

const num = (s: string) => Number(s.replace(',', '.'));

/**
 * Deterministic extraction of numeric questionnaire answers from free text.
 * Handles "180 bo'yim 90 kg 24 yosh", "175/82/22", "22 yoshman, 178 bo'y, 85 kg", "1.80 m", Russian units.
 * Free-text answers (goal, attempts, health) are extracted by the LLM.
 */
export function parseAnswers(raw: string, current: LeadAnswers = {}, opts: { bareNumbers?: boolean } = {}): LeadAnswers {
  const bareNumbers = opts.bareNumbers ?? true;
  const text = normalize(raw);
  const out: LeadAnswers = {};

  // Height in metres: 1.80 / 1,75 m
  const metres = text.match(/\b([12][.,]\d{2})\s*(m|м|metr|метр)?\b/);
  if (metres) {
    const h = Math.round(num(metres[1]) * 100);
    if (inRange('height', h)) out.height = h;
  }

  const unitPatterns: Array<[keyof LeadAnswers, RegExp]> = [
    ['height', /(\d{3})\s*(?:sm|cm|см|santimetr)\b/],
    ['height', /(?:bo'y\w*|boy\w*|рост\w*)\s*[:=-]?\s*(\d{3})/],
    ['height', /(\d{3})\s*(?:bo'y|boy|рост)/],
    ['weight', /(\d{2,3}(?:[.,]\d)?)\s*(?:kg|кг|kilo|кило)/],
    ['weight', /(?:ves\w*|vazn\w*|вес\w*)\s*[:=-]?\s*(\d{2,3}(?:[.,]\d)?)/],
    ['weight', /(\d{2,3}(?:[.,]\d)?)\s*(?:ves|vazn|вес)/],
    ['age', /(\d{1,2})\s*(?:yosh|ёш|лет|год|y\.o)/],
    ['age', /(?:yosh\w*|возраст\w*)\s*[:=-]?\s*(\d{1,2})\b/],
  ];
  for (const [field, re] of unitPatterns) {
    if (out[field] !== undefined) continue;
    const m = text.match(re);
    if (!m) continue;
    const v = num(m[1]);
    if (field === 'height' && inRange('height', v)) out.height = v;
    if (field === 'weight' && inRange('weight', v)) out.weight = v;
    if (field === 'age' && inRange('age', v)) out.age = v;
  }

  // Bare triple like 175/82/22 or "175 82 22" — order follows the first message: bo'y, ves, yosh.
  const missingBasics = [out.height ?? current.height, out.weight ?? current.weight, out.age ?? current.age].some(
    (v) => v === undefined,
  );
  if (missingBasics && bareNumbers) {
    const triple = text.match(/(?:^|[^\d.,])(\d{2,3})\s*[/\\|,\s-]\s*(\d{2,3}(?:[.,]\d)?)\s*[/\\|,\s-]\s*(\d{1,2})(?![\d.,]*\s*(?:kun|день|дня|раз))/);
    if (triple) {
      const [h, w, a] = [num(triple[1]), num(triple[2]), num(triple[3])];
      if (inRange('height', h) && inRange('weight', w) && inRange('age', a)) {
        out.height ??= h;
        out.weight ??= w;
        out.age ??= a;
      }
    }
  }

  // Remaining bare numbers: assign by plausible range to still-missing basics.
  const used = new Set([out.height, out.weight, out.age].filter((v) => v !== undefined));
  const bare = [...text.matchAll(/(?<![\d.,])(\d{2,3}(?:[.,]\d)?)(?![\d.,])/g)].map((m) => num(m[1])).filter((v) => !used.has(v));
  const need = {
    height: out.height === undefined && current.height === undefined,
    weight: out.weight === undefined && current.weight === undefined,
    age: out.age === undefined && current.age === undefined,
  };
  if (bareNumbers && (need.height || need.weight || need.age)) {
    // Uzbek order of the first message is bo'y, ves, yosh — so weight is filled before age.
    for (const v of bare) {
      if (need.height && v >= 140 && v <= 220 && Number.isInteger(v)) {
        out.height = v;
        need.height = false;
      } else if (need.weight && v >= 35 && v <= 200) {
        out.weight = v;
        need.weight = false;
      } else if (need.age && v >= 12 && v <= 80 && Number.isInteger(v)) {
        out.age = v;
        need.age = false;
      }
    }
  }

  // Training experience: "2 yildan beri", "1 yillik", "6 oy", "2 года", "tajriba yo'q"
  const exp = text.match(/(\d+(?:[.,]\d)?)\s*(yil\w*|oy\w*|год\w*|лет|месяц\w*)/);
  if (exp && /(zal|sport|trenirovka|shug'ullan|tajrib|boraman|qatnay|занима|трен|опыт|стаж|зал)/.test(text)) {
    out.trainingExperience = `${exp[1]} ${exp[2]}`;
  } else if (/(tajriba(m|si)?\s*(yo'q|yoq|yuq)|tajribasiz|опыта\s*нет|нет\s*опыта|без\s*опыта|не\s*занимал)/.test(text)) {
    out.trainingExperience = "yo'q";
  }

  // Training days and location
  const days = text.match(/(\d)\s*(?:-|–)?\s*(?:kun|marta|раз|дн|день)/);
  if (days && /(hafta|недел|trenirovka|zal|shug'ullan|трен|зал|дома|uyda)/.test(text)) {
    const d = Number(days[1]);
    if (inRange('trainingDays', d)) out.trainingDays = d;
  }
  if (/(^|[^\p{L}])(zal|sport ?zal|зал|фитнес|gym)/u.test(text)) out.trainingLocation = 'zal';
  else if (/(^|[^\p{L}])(uyda|uyimda|дома|домашн)/u.test(text)) out.trainingLocation = 'uy';

  return out;
}

/** Target weight from a goal answer: "85 gacha", "10 kg tashlash" (relative), "до 70". */
export function parseTargetWeight(raw: string, currentWeight?: number): number | undefined {
  const text = normalize(raw);
  const rel = text.match(/(\d{1,2}(?:[.,]\d)?)\s*(?:kg|кг|kilo|кило)?\s*(tashla|ozi|kamay|tushir|сброс|скинут|похуд|минус)/);
  if (rel && currentWeight) {
    const t = currentWeight - num(rel[1]);
    return inRange('targetWeight', t) ? t : undefined;
  }
  const relGain = text.match(/(\d{1,2}(?:[.,]\d)?)\s*(?:kg|кг|kilo)?\s*(qo'sh|olish|набра|прибав|плюс)/);
  if (relGain && currentWeight && num(relGain[1]) < 30) {
    const t = currentWeight + num(relGain[1]);
    return inRange('targetWeight', t) ? t : undefined;
  }
  const abs =
    text.match(/(\d{2,3}(?:[.,]\d)?)\s*(?:kg|кг|kilo)?\s*(?:gacha|ga\b|ga tush|ga chiq|bo'lsa|до|кг)/) ??
    text.match(/(?:до|maqsad\w*|цель\w*)\s*[:-]?\s*(\d{2,3}(?:[.,]\d)?)/);
  if (abs) {
    const t = num(abs[1]);
    return inRange('targetWeight', t) ? t : undefined;
  }
  return undefined;
}
