import { Router, type Request } from 'express';
import type { AppContext } from '../../context.js';
import { RateLimiter } from '../../core/rateLimit.js';
import { sanitizeAccount } from '../../services/accounts.js';

const COOKIE = 'datasetto_hls';

const bearerToken = (req: Request): string | null => {
  const header = req.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
};

const cookieValue = (req: Request, name: string): string | null => {
  const header = req.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
};

/** Channel name from an HLS path such as /hls/<channel>/index.m3u8. */
export const channelFromHlsPath = (uri: string): string | null => {
  const match = uri.split('?')[0].match(/^\/hls\/([^/]+)\//);
  return match ? decodeURIComponent(match[1]) : null;
};

/**
 * HLS access control.
 * - `POST /api/stream/:channelName/ticket` hands a signed-in viewer a short-lived ticket
 *   (also set as a cookie scoped to that stream's path) when the stream has room left.
 * - `GET /internal/hls/auth` is Caddy's forward_auth target: every playlist and
 *   segment request must carry a valid ticket in the `X-Hls-Ticket` header or the cookie.
 */
export const hlsRouter = (ctx: AppContext): Router => {
  const router = Router();
  const ticketLimiter = new RateLimiter(60, 60_000);
  const overBudget = () => ctx.usage.monthEgressBytes() >= ctx.config.streaming.monthlyEgressBytes;

  router.post('/api/stream/:channelName/ticket', (req, res) => {
    if (!ticketLimiter.hit(req.ip ?? 'unknown').allowed) {
      res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
      return;
    }
    const session = ctx.sessions.resume(bearerToken(req));
    const record = session ? ctx.accounts.getById(session.accountId) : null;
    if (!session || !record || record.status !== 'active' || ctx.moderation.getBan(record.id)) {
      res.status(401).json({ error: 'Sign in to watch', code: 'NOT_AUTHENTICATED' });
      return;
    }
    const account = sanitizeAccount(record);
    const channel = ctx.channels.getByName(String(req.params.channelName ?? ''));
    if (!channel || channel.type !== 'stream') {
      res.status(404).json({ error: 'Channel not found', code: 'NOT_FOUND' });
      return;
    }
    const subject = { accountId: account.id, roles: account.roles, isSuperuser: account.roles.includes('superuser') };
    if (!ctx.channels.canAccess(channel, subject, 'view')) {
      res.status(403).json({ error: 'No access to this channel', code: 'FORBIDDEN' });
      return;
    }
    if (overBudget()) {
      res.status(403).json({ error: 'Streaming is paused until next month: the traffic budget is used up.', code: 'EGRESS_BUDGET_EXCEEDED' });
      return;
    }
    // The viewer is usually already counted (it joined the channel over the socket).
    if (ctx.presence.channelMemberCount(channel.id) > ctx.config.streaming.maxViewers) {
      res.status(429).json({ error: 'This stream is full right now', code: 'STREAM_FULL', maxViewers: ctx.config.streaming.maxViewers });
      return;
    }

    const issued = ctx.hlsTickets.issue(channel.name, account.id);
    const secure = req.secure || req.get('x-forwarded-proto') === 'https';
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${encodeURIComponent(issued.ticket)}; Path=/hls/${encodeURIComponent(channel.name)}/; Max-Age=${Math.floor(ctx.hlsTickets.ttlMs / 1000)}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ticket: issued.ticket, expiresAt: issued.expiresAt, ttlSeconds: Math.floor(ctx.hlsTickets.ttlMs / 1000) });
  });

  router.get('/internal/hls/auth', (req, res) => {
    const uri = req.get('x-forwarded-uri') ?? req.originalUrl;
    const channelName = channelFromHlsPath(uri);
    if (!channelName) {
      res.status(404).end();
      return;
    }
    if (overBudget()) {
      res.status(403).json({ code: 'EGRESS_BUDGET_EXCEEDED' });
      return;
    }
    const ticket = req.get('x-hls-ticket') ?? cookieValue(req, COOKIE);
    const claims = ctx.hlsTickets.verify(ticket, channelName);
    if (!claims) {
      res.status(401).json({ code: 'HLS_TICKET_INVALID' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).end();
  });

  return router;
};
