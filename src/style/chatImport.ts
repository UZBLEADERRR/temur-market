export interface RawChatMessage {
  sender: string;
  senderId?: string;
  text: string;
  date?: Date;
  media?: boolean;
}

export interface RawChat {
  /** Name of the other participant (client) when known. */
  peerName?: string;
  messages: RawChatMessage[];
}

const decode = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();

/** Parses a Telegram Desktop HTML export (messages.html, messages2.html …). */
export function parseTelegramHtml(html: string): RawChat {
  const header = html.match(/<div class="page_header">[\s\S]*?<div class="text bold">\s*([\s\S]*?)\s*<\/div>/);
  const peerName = header ? decode(header[1]) : undefined;
  const blocks = html.split('<div class="message ').slice(1);
  const messages: RawChatMessage[] = [];
  let lastSender = '';
  for (const b of blocks) {
    if (b.startsWith('service')) continue;
    const from = b.match(/<div class="from_name">\s*([\s\S]*?)\s*<\/div>/);
    if (from) lastSender = decode(from[1]).replace(/\s+via\s+@\S+$/, '');
    const isForwarded = /class="forwarded body"/.test(b);
    if (isForwarded) continue;
    const textMatch = b.match(/<div class="text">\s*([\s\S]*?)\s*<\/div>/);
    const date = b.match(/class="pull_right date details" title="(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})/);
    messages.push({
      sender: lastSender,
      text: textMatch ? decode(textMatch[1]) : '',
      media: /class="media_wrap/.test(b),
      date: date ? new Date(`${date[3]}-${date[2]}-${date[1]}T${date[4]}:${date[5]}:${date[6]}Z`) : undefined,
    });
  }
  return { peerName, messages };
}

type JsonText = string | Array<string | { text?: string }>;
interface JsonMessage {
  type?: string;
  from?: string;
  from_id?: string;
  text?: JsonText;
  date?: string;
  media_type?: string;
  photo?: string;
  forwarded_from?: string;
}
interface JsonChat {
  name?: string;
  type?: string;
  messages?: JsonMessage[];
}

const jsonText = (t: JsonText | undefined) =>
  typeof t === 'string' ? t : Array.isArray(t) ? t.map((p) => (typeof p === 'string' ? p : p.text ?? '')).join('') : '';

/** Parses Telegram Desktop JSON export: a single chat (result.json) or a full export with chats.list. */
export function parseTelegramJson(raw: string): RawChat[] {
  const data = JSON.parse(raw) as JsonChat & { chats?: { list?: JsonChat[] } };
  const chats: JsonChat[] = data.chats?.list ?? [data];
  return chats
    .filter((c) => !c.type || c.type === 'personal_chat')
    .map((c) => ({
      peerName: c.name,
      messages: (c.messages ?? [])
        .filter((m) => (m.type ?? 'message') === 'message' && !m.forwarded_from)
        .map((m) => ({
          sender: m.from ?? '',
          senderId: m.from_id,
          text: jsonText(m.text).trim(),
          media: Boolean(m.media_type || m.photo),
          date: m.date ? new Date(m.date) : undefined,
        })),
    }));
}

export function parseChatExport(fileName: string, content: string): RawChat[] {
  if (/\.json$/i.test(fileName) || content.trimStart().startsWith('{')) return parseTelegramJson(content);
  if (/\.html?$/i.test(fileName) || content.includes('<div class="message')) return [parseTelegramHtml(content)];
  return [parsePlainText(content)];
}

/** Plain text: lines like "Temur: ..." / "Mijoz: ...". */
export function parsePlainText(content: string): RawChat {
  const messages: RawChatMessage[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*([^:]{1,40}):\s*(.+)$/);
    if (m) messages.push({ sender: m[1].trim(), text: m[2].trim() });
    else if (messages.length && line.trim()) messages[messages.length - 1].text += `\n${line.trim()}`;
  }
  return { messages };
}

const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\d]/gu, '');

/** Decides which sender is the coach: explicit id, else "not the peer", else name match. */
export function identifyCoach(chat: RawChat, opts: { coachId?: number; coachName?: string }): string | undefined {
  const senders = Array.from(new Set(chat.messages.map((m) => m.sender).filter(Boolean)));
  if (opts.coachId) {
    const byId = chat.messages.find((m) => m.senderId === `user${opts.coachId}`);
    if (byId) return byId.sender;
  }
  if (chat.peerName) {
    const others = senders.filter((s) => fold(s) !== fold(chat.peerName!));
    if (others.length === 1) return others[0];
  }
  if (opts.coachName) {
    const name = fold(opts.coachName);
    const match = senders.find((s) => fold(s).includes(name));
    if (match) return match;
  }
  const lower = senders.find((s) => /^(temur|coach|murabbiy|mumin)/i.test(s.normalize('NFKC')));
  return lower;
}
