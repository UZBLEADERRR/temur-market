import { Bot } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { sequentialize } from '@grammyjs/runner';
import { logger } from '../utils/logger';

export const ALLOWED_UPDATES = [
  'message',
  'callback_query',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
] as const;

/** grammY bot with Telegram rate limiting (throttler) and automatic 429/5xx retries. */
export function createBot(token: string): Bot {
  const bot = new Bot(token);
  bot.api.config.use(apiThrottler());
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
  // updates of different chats run in parallel (runner), updates of one chat stay in order
  bot.use(sequentialize((ctx) => String(ctx.chat?.id ?? ctx.from?.id ?? 'global')));
  bot.catch((err) => {
    logger.error({ err: err.error instanceof Error ? err.error.message : String(err.error), update: err.ctx?.update?.update_id }, 'Bot handler error');
  });
  return bot;
}
