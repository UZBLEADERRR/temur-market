import { webhookCallback } from 'grammy';
import { run, type RunnerHandle } from '@grammyjs/runner';
import { assertProductionEnv, env } from './config/env';
import { connectDatabase, disconnectDatabase } from './database/connection';
import { SettingsService } from './services/settings';
import { GeminiClient } from './ai/geminiClient';
import { AiService } from './ai/aiService';
import { createBot, ALLOWED_UPDATES } from './telegram/bot';
import { GrammyGateway } from './telegram/grammyGateway';
import { registerBusinessHandlers } from './telegram/businessHandlers';
import { registerAdminHandlers } from './admin/adminCommands';
import { ConversationEngine } from './conversations/engine';
import { LeadService } from './leads/leadService';
import { ReminderService } from './reminders/reminderService';
import { createWebApp } from './webapp/server';
import type { AppContext } from './services/appContext';
import { logger } from './utils/logger';
import { MINUTE } from './utils/time';

async function main() {
  assertProductionEnv(env);
  await connectDatabase(env.MONGODB_URI);

  const settings = new SettingsService();
  const migrated = await settings.migrateLegacyDefaults();
  if (migrated.length) logger.info({ keys: migrated }, 'Old default settings replaced with new defaults');
  const ai = new AiService(
    new GeminiClient({ apiKey: env.LLM_API_KEY, model: env.LLM_MODEL, baseUrl: env.LLM_BASE_URL, timeoutMs: env.LLM_TIMEOUT_MS }),
    settings,
    { maxConcurrency: env.LLM_MAX_CONCURRENCY },
  );
  const bot = createBot(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_API_ROOT);
  const gateway = new GrammyGateway(bot, env.adminIds, env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_API_ROOT);
  const leads = new LeadService({ gateway, timeZone: env.TZ_NAME, publicUrl: env.publicUrl });
  const engine = new ConversationEngine({ gateway, ai, settings, leads });
  const reminders = new ReminderService(engine, settings);
  const app: AppContext = { env, settings, ai, engine, leads, reminders, gateway };

  registerBusinessHandlers(bot, app);
  registerAdminHandlers(bot, app);

  let runner: RunnerHandle | undefined;
  const useWebhook = env.BOT_MODE === 'webhook' && Boolean(env.publicUrl);
  const web = createWebApp(app, (e) => {
    if (useWebhook) {
      e.post('/telegram/webhook', webhookCallback(bot, 'express', { secretToken: env.WEBHOOK_SECRET }));
    }
  });
  const server = web.listen(env.PORT, () => logger.info({ port: env.PORT, publicUrl: env.publicUrl }, 'HTTP server listening'));

  await bot.init();
  logger.info({ bot: bot.botInfo.username }, 'Bot initialised');
  await bot.api
    .setMyCommands(
      [
        { command: 'status', description: 'Tizim holati' },
        { command: 'navbat', description: 'Javob kutayotgan mijozlar' },
        { command: 'stats', description: 'Kunlik statistika' },
        { command: 'export', description: 'Excel eksport' },
        { command: 'settings', description: 'Sozlamalar' },
        { command: 'prompt', description: 'System prompt' },
        { command: 'help', description: 'Yordam' },
      ],
      { scope: { type: 'all_private_chats' } },
    )
    .catch(() => undefined);
  if (env.publicUrl) {
    for (const id of env.adminIds) {
      await bot.api
        .setChatMenuButton({ chat_id: id, menu_button: { type: 'web_app', text: 'Mijozlar', web_app: { url: `${env.publicUrl}/app/` } } })
        .catch((err) => logger.warn({ err: (err as Error).message }, 'setChatMenuButton failed (admin must /start the bot first)'));
    }
  }

  if (useWebhook) {
    await bot.api.setWebhook(`${env.publicUrl}/telegram/webhook`, {
      allowed_updates: [...ALLOWED_UPDATES],
      secret_token: env.WEBHOOK_SECRET,
    });
    logger.info('Webhook mode');
  } else {
    await bot.api.deleteWebhook().catch(() => undefined);
    runner = run(bot, { runner: { fetch: { allowed_updates: [...ALLOWED_UPDATES] } }, sink: { concurrency: 50 } });
    logger.info('Long polling mode (concurrent runner)');
  }

  // background jobs: reminders + retry of AI failures / unfinished processing after restarts
  const jobs = [
    setInterval(() => void reminders.tick().catch((err) => logger.error({ err: (err as Error).message }, 'Reminder tick failed')), MINUTE),
    setInterval(() => void engine.retryPending().catch((err) => logger.error({ err: (err as Error).message }, 'Retry tick failed')), 2 * MINUTE),
  ];

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    jobs.forEach(clearInterval);
    engine.stopAll();
    if (runner?.isRunning()) await runner.stop().catch(() => undefined);
    server.close();
    await disconnectDatabase().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

// never let one bad request take the whole bot down
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, 'Uncaught exception');
});

main().catch((err) => {
  logger.fatal({ err: (err as Error).message }, 'Fatal startup error');
  process.exit(1);
});
