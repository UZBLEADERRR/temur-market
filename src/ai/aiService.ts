import { LlmError, type LlmClient, type LlmPart } from './llmClient';
import { parseAiResponse, type AiResponse } from './responseSchema';
import type { SettingsService } from '../services/settings';
import { Semaphore } from '../utils/limiter';
import { sleep } from '../utils/time';
import { logger } from '../utils/logger';

export interface AiServiceOptions {
  maxConcurrency?: number;
  retryDelaysMs?: number[];
}

/** Wraps the LLM client with concurrency limiting, retries, and Zod validation. */
export class AiService {
  private readonly sem: Semaphore;
  private readonly delays: number[];

  constructor(
    private readonly client: LlmClient,
    private readonly settings: SettingsService,
    opts: AiServiceOptions = {},
  ) {
    this.sem = new Semaphore(opts.maxConcurrency ?? 4);
    this.delays = opts.retryDelaysMs ?? [1500, 4000];
  }

  private async modelConfig() {
    const model = (await this.settings.get('llm_model')).trim() || undefined;
    const temperature = await this.settings.num('llm_temperature');
    return { model, temperature };
  }

  /** Structured reply for the questionnaire. Throws after all retries fail. */
  async reply(system: string, userText: string, meta: Record<string, unknown> = {}): Promise<AiResponse> {
    const cfg = await this.modelConfig();
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.delays.length; attempt++) {
      const started = Date.now();
      try {
        const res = await this.sem.run(() =>
          this.client.generate({ system, parts: [{ text: userText }], json: true, ...cfg }),
        );
        const parsed = parseAiResponse(res.text);
        logger.info(
          { ...meta, attempt, model: res.model, ms: Date.now() - started, promptTokens: res.promptTokens, outputTokens: res.outputTokens, action: parsed.action },
          'AI response',
        );
        return parsed;
      } catch (err) {
        lastErr = err;
        const retryable = !(err instanceof LlmError) || err.retryable;
        logger.warn({ ...meta, attempt, err: (err as Error).message, retryable }, 'AI request failed');
        if (!retryable || attempt === this.delays.length) break;
        await sleep(this.delays[attempt]);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('AI failed');
  }

  async freeText(system: string, prompt: string, parts: LlmPart[] = []): Promise<string> {
    const cfg = await this.modelConfig();
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.delays.length; attempt++) {
      try {
        const res = await this.sem.run(() =>
          this.client.generate({ system, parts: [...parts, { text: prompt }], temperature: 0.3, model: cfg.model, maxOutputTokens: 4096 }),
        );
        return res.text;
      } catch (err) {
        lastErr = err;
        if (err instanceof LlmError && !err.retryable) break;
        if (attempt < this.delays.length) await sleep(this.delays[attempt]);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('AI failed');
  }

  /** Speech-to-text for client voice notes and coach voice samples. */
  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    return this.freeText(
      "Sen transkripsiya qiluvchisan. Audioni so'zma-so'z yoz (o'zbek yoki rus tilida, qanday aytilgan bo'lsa). Faqat matnni qaytar.",
      'Transkripsiya:',
      [{ inlineData: { mimeType, data: audio.toString('base64') } }],
    );
  }
}
