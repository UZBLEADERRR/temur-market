import type { Env } from '../config/env';
import { GeminiClient } from './geminiClient';
import type { LlmClient } from './llmClient';
import { OpenRouterClient } from './openRouterClient';

export function createLlmClient(env: Env): LlmClient {
  if (env.LLM_PROVIDER === 'gemini') {
    return new GeminiClient({ apiKey: env.LLM_API_KEY, model: env.LLM_MODEL, baseUrl: env.LLM_BASE_URL, timeoutMs: env.LLM_TIMEOUT_MS });
  }
  return new OpenRouterClient({
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    baseUrl: env.LLM_BASE_URL,
    timeoutMs: env.LLM_TIMEOUT_MS,
    appUrl: env.publicUrl,
    appName: 'TEMUR.FIT bot2',
  });
}
