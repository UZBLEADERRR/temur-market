import crypto from 'node:crypto';
import type express from 'express';
import { Lead } from '../database/models/Lead';
import { IgAccount } from '../database/models/instagram';
import type { ConversationEngine, IncomingClientMessage } from '../conversations/engine';
import { firstTime } from '../telegram/idempotency';
import { logger } from '../utils/logger';
import type { ChannelGateway } from './channelGateway';
import { midToNumber } from './channelGateway';
import type { CommentService, IgCommentEvent } from './commentService';
import { IG_PREFIX, igChatId, type IgAccountService } from './igAccount';
import type { InstagramClient } from './igClient';

interface IgAttachment {
  type?: string;
  payload?: { url?: string; title?: string };
}

export interface IgMessagingEvent {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: {
    mid: string;
    text?: string;
    attachments?: IgAttachment[];
    is_echo?: boolean;
    is_deleted?: boolean;
    is_unsupported?: boolean;
    reply_to?: { mid?: string; story?: { url?: string; id?: string } };
  };
}

interface IgWebhookBody {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    messaging?: IgMessagingEvent[];
    changes?: Array<{ field?: string; value?: unknown }>;
  }>;
}

export interface IgDeps {
  ig: InstagramClient;
  gateway: ChannelGateway;
  account: IgAccountService;
  comments: CommentService;
  engine: ConversationEngine;
}

export function verifySignature(raw: Buffer | undefined, header: string | undefined, secret: string): boolean {
  if (!raw || !header?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header.slice(7));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function kindOf(m: NonNullable<IgMessagingEvent['message']>): IncomingClientMessage['kind'] {
  const t = m.attachments?.[0]?.type;
  if (m.text && !t) return 'text';
  if (t === 'audio') return 'voice';
  if (t === 'image') return 'photo';
  if (t === 'video' || t === 'ig_reel' || t === 'reel') return 'video';
  if (t === 'animated_image_share' || t === 'sticker') return 'sticker';
  return m.text ? 'text' : 'other';
}

/** What a shared post / story mention means for the AI (it cannot open them). */
function attachmentNote(m: NonNullable<IgMessagingEvent['message']>): string {
  const t = m.attachments?.[0]?.type;
  if (t === 'share' || t === 'ig_reel' || t === 'reel') return '[mijoz post/reels ulashdi]';
  if (t === 'story_mention') return '[mijoz storysida sizni belgiladi]';
  return '';
}

/** Instagram webhooks: Direct messages go to the same AI engine as Telegram, comments to the automation. */
export function registerInstagramWebhook(web: express.Express, deps: IgDeps): void {
  web.get('/instagram/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = String(req.query['hub.verify_token'] ?? '');
    if (mode === 'subscribe' && token === deps.account.verifyToken()) {
      res.status(200).send(String(req.query['hub.challenge'] ?? ''));
      return;
    }
    res.status(403).send('forbidden');
  });

  web.post('/instagram/webhook', async (req, res) => {
    const secret = await deps.account.appSecret();
    const raw = (req as express.Request & { rawBody?: Buffer }).rawBody;
    if (!secret) {
      logger.warn('Instagram webhook rejected: App Secret is not set (panel → Sozlamalar)');
      res.status(403).send('app secret not configured');
      return;
    }
    if (!verifySignature(raw, req.header('x-hub-signature-256'), secret)) {
      logger.warn('Instagram webhook rejected: bad signature');
      res.status(403).send('bad signature');
      return;
    }
    res.status(200).send('EVENT_RECEIVED');
    try {
      await handleInstagramBody(req.body as IgWebhookBody, deps);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Instagram webhook processing failed');
    }
  });
}

export async function handleInstagramBody(body: IgWebhookBody, deps: IgDeps): Promise<void> {
  if (body?.object !== 'instagram') return;
  await IgAccount.updateOne({ _id: 'main' }, { $set: { lastWebhookAt: new Date() } }, { upsert: true });
  for (const entry of body.entry ?? []) {
    for (const ev of entry.messaging ?? []) await handleMessaging(ev, entry.id, deps);
    for (const ch of entry.changes ?? []) {
      if (ch.field === 'comments' || ch.field === 'live_comments') await deps.comments.handle(ch.value as IgCommentEvent);
      // «Test» button in the Meta dashboard sends messages in this form
      else if (ch.field === 'messages') await handleMessaging(ch.value as IgMessagingEvent, entry.id, deps);
    }
  }
}

async function handleMessaging(ev: IgMessagingEvent, entryId: string | undefined, deps: IgDeps): Promise<void> {
  const m = ev.message;
  if (!m?.mid || m.is_deleted || m.is_unsupported) return;
  const accountId = (await deps.account.accountId()) ?? entryId;
  const connectionId = `${IG_PREFIX}${accountId ?? 'me'}`;

  if (m.is_echo) {
    // sent from the business account: by the bot (ignore) or by TEMUR in the Instagram app (coach takes over)
    const clientId = ev.recipient?.id;
    if (!clientId || (await deps.gateway.isOwnMid(m.mid))) return;
    if (!(await firstTime(`igm:${m.mid}`))) return;
    const chatId = igChatId(clientId);
    if (!(await Lead.exists({ businessConnectionId: connectionId, chatId }))) return; // a chat the bot never saw
    await deps.engine.handleCoachMessage({
      connectionId,
      chat: { id: chatId, igUserId: clientId },
      messageId: midToNumber(m.mid),
      text: m.text ?? (m.attachments?.length ? '[media]' : ''),
      kind: m.attachments?.length ? 'other' : 'text',
    });
    return;
  }

  const clientId = ev.sender?.id;
  if (!clientId || clientId === accountId) return;
  if (!(await firstTime(`igm:${m.mid}`))) return;
  const chatId = igChatId(clientId);
  const known = await Lead.findOne({ businessConnectionId: connectionId, chatId }).select('username firstName').lean();
  let profile: { name?: string; username?: string } = {};
  if (!known?.username) profile = await deps.ig.getProfile(clientId).catch(() => ({}));

  const kind = kindOf(m);
  const att = m.attachments?.[0];
  const note = attachmentNote(m);
  let text = [m.text ?? '', note].filter(Boolean).join('\n');
  if (m.reply_to?.story) text = `${text}\n(storyga javob)`.trim();
  await deps.engine.handleClientMessage({
    connectionId,
    chat: { id: chatId, igUserId: clientId, username: profile.username, first_name: profile.name },
    messageId: midToNumber(m.mid),
    text,
    kind,
    voice: kind === 'voice' && att?.payload?.url ? { fileId: att.payload.url, mimeType: 'audio/mp4' } : undefined,
    photo: kind === 'photo' && att?.payload?.url ? { fileId: att.payload.url } : undefined,
    date: ev.timestamp ? new Date(ev.timestamp) : undefined,
  });
}
