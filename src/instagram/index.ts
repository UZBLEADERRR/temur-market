import type { Env } from '../config/env';
import type { SettingsService } from '../services/settings';
import type { TelegramGateway } from '../telegram/gateway';
import { ChannelGateway } from './channelGateway';
import { CommentService } from './commentService';
import { IgAccountService } from './igAccount';
import { InstagramClient } from './igClient';

export interface InstagramModule {
  ig: InstagramClient;
  account: IgAccountService;
  gateway: ChannelGateway;
  comments: CommentService;
}

/** Instagram pieces that do not need the engine; the webhook is registered once the engine exists. */
export function createInstagram(
  env: Pick<Env, 'IG_ACCESS_TOKEN' | 'IG_APP_SECRET' | 'IG_VERIFY_TOKEN' | 'IG_API_VERSION' | 'IG_GRAPH_BASE' | 'TELEGRAM_BOT_TOKEN'>,
  tg: TelegramGateway,
  settings: SettingsService,
  opts: { fetch?: typeof fetch; commentDelayMs?: number } = {},
): InstagramModule {
  const account = new IgAccountService(env);
  const ig = new InstagramClient(() => account.credentials(), { version: env.IG_API_VERSION, base: env.IG_GRAPH_BASE, fetch: opts.fetch });
  const gateway = new ChannelGateway(tg, ig);
  const comments = new CommentService({ ig, gateway, account, settings }, { delayOverrideMs: opts.commentDelayMs });
  return { ig, account, gateway, comments };
}
