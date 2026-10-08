/**
 * Instagram API with Instagram Login (graph.instagram.com).
 * Messaging (Direct), comment replies, private replies, profile lookups and token refresh.
 */
export class IgApiError extends Error {
  readonly code?: number;
  readonly subcode?: number;
  readonly status: number;
  /** Same shape as Telegram errors, so the engine treats a closed 24h window like a paused chat. */
  readonly error_code?: number;
  readonly description: string;

  constructor(status: number, body: { error?: { message?: string; code?: number; error_subcode?: number } } | undefined) {
    const msg = body?.error?.message ?? `HTTP ${status}`;
    super(msg);
    this.status = status;
    this.code = body?.error?.code;
    this.subcode = body?.error?.error_subcode;
    this.description = `Instagram: ${msg}`;
    if (isWindowClosed(this.code, this.subcode)) this.error_code = 403;
  }
}

/** Outside the 24h window / user unavailable / blocked messaging. */
function isWindowClosed(code?: number, subcode?: number): boolean {
  return code === 10 || code === 551 || subcode === 2018278 || subcode === 2534022 || subcode === 2018108;
}

export interface IgProfile {
  name?: string;
  username?: string;
  profile_pic?: string;
}

export interface IgMe {
  user_id: string;
  username?: string;
  name?: string;
  profile_picture_url?: string;
}

export interface IgMedia {
  id: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
}

export interface IgCredentials {
  token: string;
  userId?: string;
}

type FetchLike = typeof fetch;

/** One Instagram message holds up to 1000 characters. */
export const IG_TEXT_LIMIT = 1000;

export function splitForInstagram(text: string, limit = IG_TEXT_LIMIT): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export class InstagramClient {
  constructor(
    private readonly credentials: () => Promise<IgCredentials | null>,
    private readonly opts: { version?: string; base?: string; fetch?: FetchLike } = {},
  ) {}

  private get base(): string {
    return `${this.opts.base ?? 'https://graph.instagram.com'}/${this.opts.version ?? 'v23.0'}`;
  }

  private get fetch(): FetchLike {
    return this.opts.fetch ?? fetch;
  }

  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: { query?: Record<string, string>; body?: unknown; token?: string } = {}): Promise<T> {
    const token = params.token ?? (await this.credentials())?.token;
    if (!token) throw new IgApiError(401, { error: { message: 'Instagram ulanmagan (access token yo\'q)' } });
    const url = new URL(path.startsWith('http') ? path : `${this.base}/${path.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(params.query ?? {})) url.searchParams.set(k, v);
    const res = await this.fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(params.body ? { 'content-type': 'application/json' } : {}) },
      body: params.body ? JSON.stringify(params.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = undefined;
    }
    if (!res.ok || (json as { error?: unknown })?.error) throw new IgApiError(res.status, json as never);
    return json as T;
  }

  private async accountPath(): Promise<string> {
    return (await this.credentials())?.userId || 'me';
  }

  async sendText(igUserId: string, text: string): Promise<{ messageId: string }> {
    const r = await this.call<{ message_id: string }>('POST', `${await this.accountPath()}/messages`, {
      body: { recipient: { id: igUserId }, message: { text } },
    });
    return { messageId: r.message_id };
  }

  async sendAudio(igUserId: string, url: string): Promise<{ messageId: string }> {
    const r = await this.call<{ message_id: string }>('POST', `${await this.accountPath()}/messages`, {
      body: { recipient: { id: igUserId }, message: { attachment: { type: 'audio', payload: { url } } } },
    });
    return { messageId: r.message_id };
  }

  async senderAction(igUserId: string, action: 'typing_on' | 'typing_off' | 'mark_seen'): Promise<void> {
    await this.call('POST', `${await this.accountPath()}/messages`, { body: { recipient: { id: igUserId }, sender_action: action } });
  }

  /** One Direct message to the author of a comment (allowed once per comment, within 7 days). */
  async privateReply(commentId: string, text: string): Promise<{ messageId: string; recipientId?: string }> {
    const r = await this.call<{ message_id: string; recipient_id?: string }>('POST', `${await this.accountPath()}/messages`, {
      body: { recipient: { comment_id: commentId }, message: { text } },
    });
    return { messageId: r.message_id, recipientId: r.recipient_id };
  }

  /** Public reply under the comment. */
  async replyToComment(commentId: string, message: string): Promise<{ id: string }> {
    return this.call<{ id: string }>('POST', `${commentId}/replies`, { query: { message } });
  }

  async hideComment(commentId: string, hide = true): Promise<void> {
    await this.call('POST', commentId, { query: { hide: String(hide) } });
  }

  async getProfile(igUserId: string): Promise<IgProfile> {
    return this.call<IgProfile>('GET', igUserId, { query: { fields: 'name,username,profile_pic' } });
  }

  async me(token?: string): Promise<IgMe> {
    return this.call<IgMe>('GET', 'me', { token, query: { fields: 'user_id,username,name,profile_picture_url' } });
  }

  async listMedia(limit = 24): Promise<IgMedia[]> {
    const r = await this.call<{ data: IgMedia[] }>('GET', `${await this.accountPath()}/media`, {
      query: { fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp', limit: String(limit) },
    });
    return r.data ?? [];
  }

  async getMedia(id: string): Promise<IgMedia> {
    return this.call<IgMedia>('GET', id, { query: { fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp' } });
  }

  /** Long-lived tokens live 60 days; refreshing gives another 60. */
  async refreshToken(token: string): Promise<{ access_token: string; expires_in: number }> {
    const base = this.opts.base ?? 'https://graph.instagram.com';
    return this.call('GET', `${base}/refresh_access_token`, { token, query: { grant_type: 'ig_refresh_token', access_token: token } });
  }

  /** Attachments (photos, voice) are public CDN links. */
  async download(url: string): Promise<Buffer> {
    const res = await this.fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Instagram media download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
