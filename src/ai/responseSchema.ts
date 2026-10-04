import { z } from 'zod';

const optNum = z.preprocess((v) => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}, z.number().optional());

const optStr = z.preprocess(
  (v) => (v === null || v === undefined || String(v).trim() === '' ? undefined : String(v).trim().slice(0, 500)),
  z.string().optional(),
);

export const ExtractedSchema = z
  .object({
    height: optNum,
    weight: optNum,
    age: optNum,
    trainingExperience: optStr,
    goal: optStr,
    targetWeight: optNum,
    trainingDays: optNum,
    trainingLocation: optStr,
    previousAttempts: optStr,
    healthProblems: optStr,
  })
  .partial()
  .catch({});

export const AI_ACTIONS = ['ASK_NEXT', 'READY', 'URGENT_READY', 'NO_RESPONSE', 'PAUSE', 'NOT_LEAD', 'SOLD', 'REFUSED'] as const;

export const AiResponseSchema = z.preprocess(
  (raw) => {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const r = raw as Record<string, unknown>;
      if (!r.messages && typeof r.message === 'string') r.messages = [r.message];
      if (typeof r.messages === 'string') r.messages = [r.messages];
    }
    return raw;
  },
  z.object({
    messages: z.array(z.string().max(1000)).max(4).default([]),
    action: z.enum(AI_ACTIONS),
    reason: z
      .enum(['completed', 'wants_coach', 'bot_question', 'safety', 'low_target_bmi', 'paid', 'agreed', 'refused', 'other'])
      .nullish()
      .catch(null),
    language: z.enum(['uz', 'ru']).nullish().catch(null),
    answered_current: z.boolean().nullish().catch(null),
    question: z.coerce.number().int().min(1).max(5).nullish().catch(null),
    intent: z.enum(['course', 'other', 'unclear']).nullish().catch(null),
    sales_step: z.coerce.number().int().min(0).max(3).nullish().catch(null),
    extracted: ExtractedSchema.nullish(),
  }),
);

export type AiResponse = z.infer<typeof AiResponseSchema>;

export const TAYYOR_RE = /\[\s*TAYYOR\s*(?::\s*(ehtiyot))?\s*\]/gi;

/** Removes [TAYYOR] / [TAYYOR: ehtiyot] markers. Reports which one was present. */
export function stripMarkers(text: string): { text: string; ready: boolean; urgent: boolean } {
  let ready = false;
  let urgent = false;
  const cleaned = text.replace(TAYYOR_RE, (_m, e?: string) => {
    ready = true;
    if (e) urgent = true;
    return '';
  });
  return { text: cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), ready, urgent };
}

/** Parses model text (JSON possibly wrapped in ``` fences) and validates it. */
export function parseAiResponse(text: string): AiResponse {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('AI response is not JSON');
  const json = JSON.parse(trimmed.slice(start, end + 1));
  return AiResponseSchema.parse(json);
}
