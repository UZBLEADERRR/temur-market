import { webhookCallback } from 'grammy';
import { run, type RunnerHandle } from '@grammyjs/runner';
import { assertProductionEnv, env } from './config/env';
import { connectDatabase, disconnectDatabase } from './database/connection';
import { SettingsService } from './services/settings';
import { seedDefaultExamples } from './style/seedExamples';
import { createLlmClient } from './ai/createLlmClient';
import { AiService } from './ai/aiService';
import { createBot, ALLOWED_UPDATES } from './telegram/bot';
import { GrammyGateway } from './telegram/grammyGateway';
import { registerBusinessHandlers } from './telegram/businessHandlers';
import { registerAdminHandlers } from './admin/adminCommands';
import { ConversationEngine } from './conversations/engine';
import { LeadService } from './leads/leadService';
import { ReminderService } from './reminders/reminderService';
import { createWebApp } from './webapp/server';
import { createInstagram } from './instagram';
import { registerInstagramWebhook } from './instagram/webhook';
import type { AppContext } from './services/appContext';
import { logger } from './utils/logger';
import { MINUTE } from './utils/time';

async function main() {
  assertProductionEnv(env);
  await connectDatabase(env.MONGODB_URI);

  const settings = new SettingsService();
  await seedDefaultExamples();
  const migrated = await settings.migrateLegacyDefaults();
  if (migrated.length) logger.info({ keys: migrated }, 'Old default settings replaced with new defaults');
  const ai = new AiService(
    createLlmClient(env),
    settings,
    { maxConcurrency: env.LLM_MAX_CONCURRENCY },
  );
  const bot = createBot(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_API_ROOT);
  const tgGateway = new GrammyGateway(bot, env.adminIds, env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_API_ROOT);
  // Instagram Direct chats go through the same engine; Telegram chats are untouched
  const instagram = createInstagram(env, tgGateway, settings);
  const gateway = instagram.gateway;
  const leads = new LeadService({ gateway, timeZone: env.TZ_NAME, publicUrl: env.publicUrl });
  const engine = new ConversationEngine({ gateway, ai, settings, leads }, { timeZone: env.TZ_NAME });
  const reminders = new ReminderService(engine, settings, gateway);
  const app: AppContext = { env, settings, ai, engine, leads, reminders, gateway, instagram };

  registerBusinessHandlers(bot, app);
  registerAdminHandlers(bot, app);

  let runner: RunnerHandle | undefined;
  const useWebhook = env.BOT_MODE === 'webhook' && Boolean(env.publicUrl);
  const web = createWebApp(app, (e) => {
    registerInstagramWebhook(e, { ...instagram, engine });
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
        { command: 'app', description: 'Mini ilova' },
        { command: 'instagram', description: 'Instagram panel' },
        { command: 'status', description: 'Tizim holati' },
        { command: 'navbat', description: 'Javob kutayotgan mijozlar' },
        { command: 'stats', description: 'Kunlik statistika' },
        { command: 'export', description: 'Excel eksport' },
        { command: 'faqat_anketa', description: 'Rejim: faqat 5 savol' },
        { command: 'sotuv_rejimi', description: 'Rejim: anketa + sotuv' },
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

  await instagram.account.bootstrap(instagram.ig);
  await instagram.comments.ensureDefaultRule().catch(() => undefined);
  void instagram.comments.resumePending().catch(() => 0);

  // after a restart: messages that arrived while the bot was down / waiting are answered with the full stored context
  void engine.retryPending(0).catch((err) => logger.error({ err: (err as Error).message }, 'Startup retry failed'));

  // background jobs: reminders + retry of AI failures / unfinished processing after restarts
  const jobs = [
    setInterval(() => void reminders.tick().catch((err) => logger.error({ err: (err as Error).message }, 'Reminder tick failed')), MINUTE),
    setInterval(() => void instagram.account.refreshIfNeeded(instagram.ig).catch(() => false), 6 * 60 * MINUTE),
    setInterval(() => void engine.retryPending().catch((err) => logger.error({ err: (err as Error).message }, 'Retry tick failed')), 2 * MINUTE),
  ];

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    jobs.forEach(clearInterval);
    engine.stopAll();
    instagram.comments.stopAll();
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
