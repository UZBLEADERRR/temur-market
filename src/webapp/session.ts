import crypto from 'node:crypto';

/**
 * Login link for the Instagram panel in a normal browser (outside Telegram):
 * the bot sends the admin a signed link, valid for 30 days.
 */
function key(botToken: string): Buffer {
  return crypto.createHmac('sha256', 'panel-session').update(botToken).digest();
}

export function createSession(adminId: number, botToken: string, days = 30, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ a: adminId, e: Math.floor(now / 1000) + days * 86400 })).toString('base64url');
  const sig = crypto.createHmac('sha256', key(botToken)).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySession(token: string, botToken: string, now = Date.now()): number | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !botToken) return null;
  const expected = crypto.createHmac('sha256', key(botToken)).update(payload).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { a: adminId, e } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { a: number; e: number };
    if (!adminId || !e || e * 1000 < now) return null;
    return adminId;
  } catch {
    return null;
  }
}
