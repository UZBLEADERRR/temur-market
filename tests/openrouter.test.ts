import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenRouterClient } from '../src/ai/openRouterClient';
import { LlmError } from '../src/ai/llmClient';
import { loadEnv } from '../src/config/env';

function server(handler: (body: any, headers: http.IncomingHttpHeaders) => { status?: number; json: unknown }) {
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const out = handler(JSON.parse(raw), req.headers);
        res.statusCode = out.status ?? 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(out.json));
      });
    });
    srv.listen(0, () => resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/v1`, close: () => srv.close() }));
  });
}

describe('OpenRouter client', () => {
  it('sends system + multimodal user content in OpenAI format and reads the answer', async () => {
    let seen: any;
    let auth = '';
    const s = await server((body, headers) => {
      seen = body;
      auth = String(headers.authorization);
      return { json: { model: 'google/gemini-3.8-flash', choices: [{ message: { content: '{"messages":["Salom"],"action":"ASK_NEXT"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } } };
    });
    const client = new OpenRouterClient({ apiKey: 'sk-or-test', model: 'google/gemini-3.8-flash', baseUrl: s.url, timeoutMs: 5000 });
    const res = await client.generate({
      system: 'SYS',
      json: true,
      parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'AAA' } }, { inlineData: { mimeType: 'audio/ogg', data: 'BBB' } }, { text: 'hello' }],
    });
    s.close();
    expect(auth).toBe('Bearer sk-or-test');
    expect(seen.model).toBe('google/gemini-3.8-flash');
    expect(seen.response_format).toEqual({ type: 'json_object' });
    expect(seen.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(seen.messages[1].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } },
      { type: 'input_audio', input_audio: { data: 'BBB', format: 'ogg' } },
      { type: 'text', text: 'hello' },
    ]);
    expect(res.text).toContain('ASK_NEXT');
    expect(res.promptTokens).toBe(10);
  });

  it('429 / 5xx are retryable errors, 400 is not', async () => {
    const s = await server(() => ({ status: 429, json: { error: { message: 'rate' } } }));
    const client = new OpenRouterClient({ apiKey: 'k', model: 'm', baseUrl: s.url, timeoutMs: 5000 });
    await expect(client.generate({ system: 's', parts: [{ text: 'x' }] })).rejects.toMatchObject({ retryable: true });
    s.close();
    const s2 = await server(() => ({ status: 400, json: { error: { message: 'bad' } } }));
    const c2 = new OpenRouterClient({ apiKey: 'k', model: 'm', baseUrl: s2.url, timeoutMs: 5000 });
    const err = await c2.generate({ system: 's', parts: [{ text: 'x' }] }).catch((e) => e);
    s2.close();
    expect(err).toBeInstanceOf(LlmError);
    expect(err.retryable).toBe(false);
  });

  it('env: OpenRouter is the default provider with gemini-3.8-flash and a separate database', () => {
    const e = loadEnv({ OPENROUTER_API_KEY: 'sk-or' } as NodeJS.ProcessEnv);
    expect(e.LLM_PROVIDER).toBe('openrouter');
    expect(e.LLM_MODEL).toBe('google/gemini-3.8-flash');
    expect(e.LLM_BASE_URL).toBe('https://openrouter.ai/api/v1');
    expect(e.LLM_API_KEY).toBe('sk-or');
    expect(e.MONGODB_URI).toContain('temur_bot2');
  });
});
