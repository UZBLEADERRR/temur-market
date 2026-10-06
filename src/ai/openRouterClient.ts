import { LlmError, type LlmClient, type LlmRequest, type LlmResult } from './llmClient';

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } };

interface OpenRouterResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: number };
}

const AUDIO_FORMAT: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
};

/** OpenRouter (OpenAI-compatible chat completions) — used with google/gemini-3.8-flash. */
export class OpenRouterClient implements LlmClient {
  constructor(
    private readonly opts: { apiKey: string; model: string; baseUrl: string; timeoutMs: number; appUrl?: string; appName?: string },
  ) {}

  async generate(req: LlmRequest): Promise<LlmResult> {
    const model = req.model || this.opts.model;
    const content: ContentPart[] = req.parts.map((p) => {
      if (p.inlineData?.mimeType.startsWith('image/')) {
        return { type: 'image_url', image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } };
      }
      if (p.inlineData?.mimeType.startsWith('audio/')) {
        const format = AUDIO_FORMAT[p.inlineData.mimeType.split(';')[0]] ?? 'ogg';
        return { type: 'input_audio', input_audio: { data: p.inlineData.data, format } };
      }
      return { type: 'text', text: p.text ?? '' };
    });
    const body = {
      model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content },
      ],
      temperature: req.temperature ?? 0.6,
      max_tokens: req.maxOutputTokens ?? 2048,
      ...(req.json ? { response_format: { type: 'json_object' } } : {}),
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.apiKey}`,
          ...(this.opts.appUrl ? { 'HTTP-Referer': this.opts.appUrl } : {}),
          'X-Title': this.opts.appName ?? 'TEMUR.FIT bot',
        },
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
      throw new LlmError(`LLM HTTP ${res.status}: ${detail}`, res.status === 429 || res.status >= 500 || res.status === 408, res.status);
    }
    const data = (await res.json()) as OpenRouterResponse;
    if (data.error) throw new LlmError(`LLM error: ${data.error.message ?? 'unknown'}`, true, data.error.code);
    const choice = data.choices?.[0];
    const text = (choice?.message?.content ?? '').trim();
    if (!text) throw new LlmError(`LLM empty response (${choice?.finish_reason ?? 'no choice'})`, true);
    return {
      text,
      model: data.model ?? model,
      finishReason: choice?.finish_reason,
      promptTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
    };
  }
}
