import 'dotenv/config';
import { z } from 'zod';

const csvIds = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0),
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  /** Optional custom Bot API server (local Bot API server or tests). */
  TELEGRAM_API_ROOT: z.string().optional(),
  TELEGRAM_ADMIN_ID: csvIds,
  ADMIN_IDS: csvIds,
  TEMUR_TELEGRAM_ID: z.coerce.number().optional(),
  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/temur_bot2'),
  /** openrouter (default for bot2) or gemini (Google API directly). */
  LLM_PROVIDER: z.enum(['openrouter', 'gemini']).default('openrouter'),
  LLM_API_KEY: z.string().default(''),
  OPENROUTER_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_BASE_URL: z.string().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().default(30000),
  LLM_MAX_CONCURRENCY: z.coerce.number().default(8),
  PORT: z.coerce.number().default(3000),
  PUBLIC_URL: z.string().optional(),
  RAILWAY_PUBLIC_DOMAIN: z.string().optional(),
  BOT_MODE: z.enum(['polling', 'webhook']).default('polling'),
  WEBHOOK_SECRET: z.string().optional(),
  ADMIN_WEB_TOKEN: z.string().optional(),
  TZ_NAME: z.string().default('Asia/Tashkent'),
  LOG_LEVEL: z.string().default('info'),
});

export type Env = Omit<z.infer<typeof EnvSchema>, 'LLM_MODEL' | 'LLM_BASE_URL'> & {
  LLM_MODEL: string;
  LLM_BASE_URL: string;
  adminIds: number[];
  publicUrl?: string;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.parse(source);
  const adminIds = Array.from(
    new Set([
      ...parsed.TELEGRAM_ADMIN_ID,
      ...parsed.ADMIN_IDS,
      ...(parsed.TEMUR_TELEGRAM_ID ? [parsed.TEMUR_TELEGRAM_ID] : []),
    ]),
  );
  const publicUrl =
    parsed.PUBLIC_URL?.replace(/\/$/, '') ||
    (parsed.RAILWAY_PUBLIC_DOMAIN ? `https://${parsed.RAILWAY_PUBLIC_DOMAIN}` : undefined);
  const openrouter = parsed.LLM_PROVIDER === 'openrouter';
  return {
    ...parsed,
    LLM_API_KEY: parsed.OPENROUTER_API_KEY || parsed.LLM_API_KEY,
    LLM_MODEL: parsed.LLM_MODEL || (openrouter ? 'google/gemini-3.8-flash' : 'gemini-3.8-flash'),
    LLM_BASE_URL: parsed.LLM_BASE_URL || (openrouter ? 'https://openrouter.ai/api/v1' : 'https://generativelanguage.googleapis.com/v1beta'),
    adminIds,
    publicUrl,
  };
}

export const env = loadEnv();

export function assertProductionEnv(e: Env): void {
  const missing: string[] = [];
  if (!e.TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (!e.LLM_API_KEY) missing.push(e.LLM_PROVIDER === 'openrouter' ? 'OPENROUTER_API_KEY' : 'LLM_API_KEY');
  if (e.adminIds.length === 0) missing.push('TELEGRAM_ADMIN_ID');
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}
