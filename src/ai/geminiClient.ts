import { LlmError, type LlmClient, type LlmRequest, type LlmResult } from './llmClient';

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  promptFeedback?: { blockReason?: string };
}

/** Google Gemini via the public REST API (generateContent). */
export class GeminiClient implements LlmClient {
  constructor(
    private readonly opts: { apiKey: string; model: string; baseUrl: string; timeoutMs: number },
  ) {}

  async generate(req: LlmRequest): Promise<LlmResult> {
    const model = req.model || this.opts.model;
    const url = `${this.opts.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: req.parts }],
      generationConfig: {
        temperature: req.temperature ?? 0.6,
        maxOutputTokens: req.maxOutputTokens ?? 2048,
        ...(req.json ? { responseMimeType: 'application/json' } : {}),
      },
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.opts.apiKey },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new LlmError(`LLM network error: ${(err as Error).name}`, true);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      const retryable = res.status === 429 || res.status >= 500;
      throw new LlmError(`LLM HTTP ${res.status}: ${detail}`, retryable, res.status);
    }
    const data = (await res.json()) as GeminiResponse;
    if (data.promptFeedback?.blockReason) {
      throw new LlmError(`LLM blocked: ${data.promptFeedback.blockReason}`, false);
    }
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
      .trim();
    if (!text) throw new LlmError(`LLM empty response (${cand?.finishReason ?? 'no candidate'})`, true);
    return {
      text,
      model,
      finishReason: cand?.finishReason,
      promptTokens: data.usageMetadata?.promptTokenCount,
      outputTokens: data.usageMetadata?.candidatesTokenCount,
    };
  }
}
