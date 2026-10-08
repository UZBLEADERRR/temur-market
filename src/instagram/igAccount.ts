import crypto from 'node:crypto';
import { IgAccount } from '../database/models/instagram';
import { logger } from '../utils/logger';
import type { IgCredentials, InstagramClient } from './igClient';

const DAY = 24 * 3600_000;

export interface IgEnv {
  IG_ACCESS_TOKEN?: string;
  IG_APP_SECRET?: string;
  IG_VERIFY_TOKEN?: string;
  TELEGRAM_BOT_TOKEN: string;
}

/** Stable synthetic chat id for an Instagram user (negative, so it never collides with Telegram ids). */
export function igChatId(igUserId: string): number {
  const h = crypto.createHash('sha256').update(`ig:${igUserId}`).digest();
  return -(h.readUIntBE(0, 6) + 1);
}

export const IG_PREFIX = 'ig:';
export const isIgConnection = (connectionId: string | null | undefined) => Boolean(connectionId?.startsWith(IG_PREFIX));

/** Where the Instagram token / app secret live: the panel (database) first, then environment variables. */
export class IgAccountService {
  private cache?: { at: number; creds: IgCredentials | null; secret?: string };

  constructor(private readonly env: IgEnv) {}

  /** Verify token Meta sends when the webhook is set up. Shown in the panel. */
  verifyToken(): string {
    return this.env.IG_VERIFY_TOKEN || crypto.createHash('sha256').update(`ig-verify:${this.env.TELEGRAM_BOT_TOKEN}`).digest('hex').slice(0, 24);
  }

  invalidate(): void {
    this.cache = undefined;
  }

  private async load() {
    if (this.cache && Date.now() - this.cache.at < 10_000) return this.cache;
    const doc = await IgAccount.findById('main').lean();
    const token = doc?.accessToken || this.env.IG_ACCESS_TOKEN;
    this.cache = {
      at: Date.now(),
      creds: token ? { token, userId: doc?.userId ?? undefined } : null,
      secret: doc?.appSecret || this.env.IG_APP_SECRET,
    };
    return this.cache;
  }

  async credentials(): Promise<IgCredentials | null> {
    return (await this.load()).creds;
  }

  async appSecret(): Promise<string | undefined> {
    return (await this.load()).secret;
  }

  async accountId(): Promise<string | undefined> {
    return (await this.credentials())?.userId;
  }

  /** Checks the token against Instagram and stores the account (called from the panel or at startup). */
  async connect(client: InstagramClient, token: string, appSecret?: string): Promise<{ username?: string; userId: string }> {
    const me = await client.me(token);
    await IgAccount.updateOne(
      { _id: 'main' },
      {
        $set: {
          accessToken: token,
          userId: String(me.user_id),
          username: me.username,
          name: me.name,
          pictureUrl: me.profile_picture_url,
          tokenRefreshedAt: new Date(),
          tokenExpiresAt: new Date(Date.now() + 60 * DAY),
          lastError: null,
          ...(appSecret ? { appSecret } : {}),
        },
      },
      { upsert: true },
    );
    this.invalidate();
    return { username: me.username, userId: String(me.user_id) };
  }

  /** On startup: an env token that was never stored is checked once so the account id is known. */
  async bootstrap(client: InstagramClient): Promise<void> {
    const doc = await IgAccount.findById('main').lean();
    if (doc?.userId || !this.env.IG_ACCESS_TOKEN) return;
    try {
      const r = await this.connect(client, this.env.IG_ACCESS_TOKEN);
      logger.info({ username: r.username }, 'Instagram account connected from env');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Instagram token from env is not valid');
    }
  }

  /** Refreshes the long-lived token every few days (it expires after 60 days without a refresh). */
  async refreshIfNeeded(client: InstagramClient, now = new Date()): Promise<boolean> {
    const doc = await IgAccount.findById('main').lean();
    if (!doc?.accessToken) return false;
    if (doc.tokenRefreshedAt && now.getTime() - doc.tokenRefreshedAt.getTime() < 5 * DAY) return false;
    try {
      const r = await client.refreshToken(doc.accessToken);
      await IgAccount.updateOne(
        { _id: 'main' },
        { $set: { accessToken: r.access_token, tokenRefreshedAt: now, tokenExpiresAt: new Date(now.getTime() + r.expires_in * 1000), lastError: null } },
      );
      this.invalidate();
      logger.info('Instagram token refreshed');
      return true;
    } catch (err) {
      await IgAccount.updateOne({ _id: 'main' }, { $set: { lastError: (err as Error).message.slice(0, 300) } });
      logger.warn({ err: (err as Error).message }, 'Instagram token refresh failed');
      return false;
    }
  }
}
