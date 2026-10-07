import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { SettingsService } from '../src/services/settings';
import { AiService } from '../src/ai/aiService';
import type { LlmClient, LlmRequest, LlmResult } from '../src/ai/llmClient';
import { LlmError } from '../src/ai/llmClient';
import { ConversationEngine, type IncomingClientMessage } from '../src/conversations/engine';
import { LeadService } from '../src/leads/leadService';
import { ReminderService } from '../src/reminders/reminderService';
import type { SentRef, TelegramGateway } from '../src/telegram/gateway';
import type { AppContext } from '../src/services/appContext';
import { loadEnv } from '../src/config/env';

export const TEST_URI = process.env.TEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/temur_fit_test';

export function useDatabase() {
  beforeAll(async () => {
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 5000 });
    await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  });
  beforeEach(async () => {
    const cols = await mongoose.connection.db!.collections();
    await Promise.all(cols.map((c) => c.deleteMany({})));
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });
}

export class FakeGateway implements TelegramGateway {
  sent: Array<{ chatId: number; text: string; connectionId: string }> = [];
  typing = 0;
  admin: Array<{ html: string; keyboard?: InlineKeyboardMarkup }> = [];
  edits: Array<{ ref: SentRef; html: string }> = [];
  documents: Array<{ chatId: number; fileName: string; size: number }> = [];
  failSend?: Error;
  private nextId = 1000;

  async sendBusinessMessage(connectionId: string, chatId: number, text: string) {
    if (this.failSend) throw this.failSend;
    this.sent.push({ chatId, text, connectionId });
    return { messageId: this.nextId++ };
  }
  async sendTyping() {
    this.typing++;
  }
  voices: Array<{ chatId: number; fileId: string }> = [];
  async sendBusinessVoice(_c: string, chatId: number, fileId: string) {
    if (this.failSend) throw this.failSend;
    this.voices.push({ chatId, fileId });
    return { messageId: this.nextId++ };
  }
  async sendAdminVoice() {}
  async notifyAdmins(html: string, keyboard?: InlineKeyboardMarkup) {
    this.admin.push({ html, keyboard });
    return [{ chatId: 1, messageId: this.nextId++ }];
  }
  async editAdminMessage(ref: SentRef, html: string) {
    this.edits.push({ ref, html });
  }
  async sendAdminDocument(chatId: number, data: Buffer, fileName: string) {
    this.documents.push({ chatId, fileName, size: data.length });
  }
  async downloadFile(): Promise<Buffer> {
    return Buffer.from('audio');
  }
  textsTo(chatId: number) {
    return this.sent.filter((s) => s.chatId === chatId).map((s) => s.text);
  }
}

export type FakeReply = Record<string, unknown> | ((req: LlmRequest) => Record<string, unknown>) | Error;

/**
 * Scriptable LLM. Without a scripted reply it behaves like a well-behaved model:
 * acknowledges, asks the first remaining question and reports answered_current = true.
 */
export class FakeLlm implements LlmClient {
  queue: FakeReply[] = [];
  calls: LlmRequest[] = [];
  transcript = 'transkript matni';

  push(...r: FakeReply[]) {
    this.queue.push(...r);
  }

  async generate(req: LlmRequest): Promise<LlmResult> {
    this.calls.push(req);
    if (!req.json) return { text: req.parts.some((p) => p.inlineData) ? this.transcript : 'xulosa', model: 'fake' };
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    const obj = typeof next === 'function' ? next(req) : next ?? defaultReply(req);
    return { text: JSON.stringify(obj), model: 'fake' };
  }
}

export function lastUserText(req: LlmRequest): string {
  return req.parts.map((p) => p.text ?? '').join('\n');
}

export function defaultReply(req: LlmRequest): Record<string, unknown> {
  const text = lastUserText(req);
  const m = text.match(/QOLGAN SAVOLLAR \(tartib bilan\):\n(\d)\. «([^»]+)»/);
  const ru = /Mijoz tili: rus/.test(text);
  return {
    messages: m ? [m[2]] : [],
    action: 'ASK_NEXT',
    reason: null,
    language: ru ? 'ru' : 'uz',
    answered_current: true,
    question: m ? Number(m[1]) : null,
    extracted: {},
  };
}

export function buildApp(opts: { now?: () => Date } = {}) {
  const env = loadEnv({ ...process.env, NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: '123:TEST', TELEGRAM_ADMIN_ID: '1', LLM_API_KEY: 'x' });
  const settings = new SettingsService(0);
  const llm = new FakeLlm();
  const ai = new AiService(llm, settings, { retryDelaysMs: [1, 1] });
  const gateway = new FakeGateway();
  const leads = new LeadService({ gateway, timeZone: 'Asia/Tashkent', publicUrl: 'https://example.test' });
  const engine = new ConversationEngine({ gateway, ai, settings, leads }, { debounceMsOverride: 0, fastTyping: true, now: opts.now });
  const reminders = new ReminderService(engine, settings, gateway);
  const app: AppContext = { env, settings, ai, engine, leads, reminders, gateway };
  return { app, settings, llm, ai, gateway, leads, engine, reminders };
}

let msgId = 1;
export function clientMsg(chatId: number, text: string, extra: Partial<IncomingClientMessage> = {}): IncomingClientMessage {
  return {
    connectionId: 'conn-1',
    chat: { id: chatId, first_name: 'Ali', username: `user${chatId}` },
    messageId: msgId++,
    text,
    kind: 'text',
    ...extra,
  };
}

export { LlmError };
