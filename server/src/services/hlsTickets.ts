import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** What a valid viewer ticket says. */
export interface HlsTicket {
  channelName: string;
  accountId: string;
  expiresAt: number;
}

/**
 * Short-lived, signed viewer tickets for HLS playback. Caddy asks the app
 * (`/internal/hls/auth`) before serving any playlist or segment, so a leaked
 * stream URL alone is worthless and every byte served belongs to a signed-in
 * viewer. Tickets are bound to one channel and expire after a few minutes;
 * the player renews them while it plays.
 */
export class HlsTicketService {
  private readonly secret: Buffer;

  constructor(
    secret: string | null,
    readonly ttlMs = 10 * 60_000,
  ) {
    // Without a configured secret every restart invalidates outstanding tickets,
    // which only costs viewers one transparent renewal.
    this.secret = secret ? Buffer.from(secret, 'utf8') : randomBytes(32);
  }

  issue(channelName: string, accountId: string, now = Date.now()): { ticket: string; expiresAt: number } {
    const expiresAt = now + this.ttlMs;
    const body = Buffer.from(JSON.stringify({ e: expiresAt, c: channelName.toLowerCase(), a: accountId }), 'utf8').toString('base64url');
    return { ticket: body + '.' + this.sign(body), expiresAt };
  }

  /** Returns the ticket claims when `ticket` is genuine, unexpired and issued for `channelName`. */
  verify(ticket: unknown, channelName: string, now = Date.now()): HlsTicket | null {
    if (typeof ticket !== 'string' || ticket.length > 512) return null;
    const dot = ticket.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = ticket.slice(0, dot);
    const signature = ticket.slice(dot + 1);
    const expected = this.sign(body);
    if (signature.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'))) return null;

    let claims: { e?: unknown; c?: unknown; a?: unknown };
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as typeof claims;
    } catch {
      return null;
    }
    if (typeof claims.e !== 'number' || typeof claims.c !== 'string' || typeof claims.a !== 'string') return null;
    if (claims.e <= now) return null;
    if (claims.c !== channelName.toLowerCase()) return null;
    return { channelName: claims.c, accountId: claims.a, expiresAt: claims.e };
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}
