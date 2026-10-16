import { Router, type Request } from 'express';
import type { AppContext } from '../../context.js';
import { extractStreamChannelName, extractStreamKeyToken } from '../../core/ids.js';
import { RateLimiter } from '../../core/rateLimit.js';

const pick = (...values: unknown[]): string => {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = pick(...value);
      if (nested) return nested;
      continue;
    }
    if (typeof value === 'string' && value.trim() && value.trim() !== 'undefined') return value.trim();
  }
  return '';
};

/** Fields nginx-rtmp posts (form encoded) on `on_publish` / `on_publish_done`. */
const parseCallback = (req: Request) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const query = (req.query ?? {}) as Record<string, unknown>;
  const name = pick(body.name, query.name, body.channel, query.channel);
  const tcUrl = pick(body.tcurl, query.tcurl, body.tcUrl, query.tcUrl);

  let token = extractStreamKeyToken(pick(body.key, body.streamKey, query.key, query.streamKey));
  if (!token) token = extractStreamKeyToken(name);
  if (!token && tcUrl.includes('?')) token = extractStreamKeyToken(tcUrl.slice(tcUrl.indexOf('?')));

  return {
    name,
    channelName: extractStreamChannelName(name),
    token,
    clientId: pick(body.clientid, body.clientId, query.clientid) || null,
    ip: pick(body.addr, query.addr, body.ip, query.ip) || req.ip || null,
  };
};

export const streamRouter = (ctx: AppContext): Router => {
  const router = Router();
  const publishLimiter = new RateLimiter(20, 60_000);

  router.get('/api/stream/:channelName/status', (req, res) => {
    const channel = ctx.channels.getByName(String(req.params.channelName ?? ''));
    // Private stream channels are not acknowledged on this unauthenticated endpoint.
    if (!channel || channel.type !== 'stream' || channel.visibility === 'private') {
      res.status(404).json({ error: 'Channel not found', code: 'NOT_FOUND', isLive: false });
      return;
    }
    const live = ctx.presence.getStream(channel.id);
    res.json({
      channelName: channel.name,
      isLive: Boolean(live),
      startedAt: live?.startedAt ?? null,
      viewerCount: ctx.presence.channelMemberCount(channel.id),
      timestamp: Date.now(),
    });
  });

  /**
   * nginx-rtmp `on_publish`. Only reachable from inside the Docker network
   * (Caddy never proxies /internal). OBS publishes to `live/<channel>?key=<token>`:
   * nginx keeps `<channel>` as the stream name (so HLS lives at /hls/<channel>/)
   * and forwards `key` here. The stream name must match the channel the key
   * belongs to, otherwise the key could be used to publish under another name.
   */
  router.post('/internal/stream/publish', (req, res) => {
    const input = parseCallback(req);
    const limiterKey = (input.ip ?? 'unknown') + ':' + input.token.slice(-6);
    if (!publishLimiter.hit(limiterKey).allowed) {
      ctx.log.warn({ ip: input.ip }, 'stream publish rate limited');
      res.status(429).json({ allowed: false, code: 'RATE_LIMITED' });
      return;
    }

    const budget = ctx.config.streaming.monthlyEgressBytes;
    if (budget > 0 && ctx.usage.monthEgressBytes() >= budget) {
      ctx.log.warn({ ip: input.ip, name: input.name || null }, 'stream publish rejected: monthly egress budget used up');
      res.status(403).json({ allowed: false, code: 'EGRESS_BUDGET_EXCEEDED' });
      return;
    }

    const channel = ctx.channels.getByStreamKey(input.token);
    if (!channel || channel.type !== 'stream') {
      ctx.log.warn({ ip: input.ip, name: input.name || null }, 'stream publish rejected: invalid key');
      res.status(403).json({ allowed: false, code: 'STREAM_KEY_INVALID' });
      return;
    }
    if (input.name.toLowerCase() !== channel.name.toLowerCase()) {
      ctx.log.warn({ ip: input.ip, name: input.name, expected: channel.name }, 'stream publish rejected: stream name must equal the channel name');
      res.status(403).json({ allowed: false, code: 'STREAM_NAME_MISMATCH', expected: channel.name });
      return;
    }

    try {
      const stream = ctx.presence.startStream(channel.id, {
        accountId: null,
        displayName: channel.name,
        clientId: input.clientId,
        sourceIp: input.ip,
      });
      ctx.broadcast.channels();
      ctx.log.info({ channel: channel.name, clientId: input.clientId, ip: input.ip }, 'stream started');
      res.status(200).json({ allowed: true, channel: channel.name, startedAt: stream.startedAt });
    } catch (error) {
      ctx.log.warn({ channel: channel.name }, 'stream publish rejected: already live');
      res.status(409).json({ allowed: false, code: 'STREAM_ALREADY_LIVE' });
    }
  });

  /** nginx-rtmp `on_publish_done`. Idempotent; always answers 200. */
  router.post('/internal/stream/done', (req, res) => {
    const input = parseCallback(req);
    const channel = ctx.channels.getByStreamKey(input.token) ?? ctx.channels.getByName(input.channelName);
    if (!channel || channel.type !== 'stream') {
      res.json({ released: false, reason: 'unknown channel' });
      return;
    }
    const live = ctx.presence.getStream(channel.id);
    if (!live) {
      res.json({ released: false, reason: 'not live' });
      return;
    }
    if (live.clientId && input.clientId && live.clientId !== input.clientId) {
      res.json({ released: false, reason: 'client mismatch' });
      return;
    }
    ctx.presence.endStream(channel.id);
    ctx.broadcast.channels();
    ctx.log.info({ channel: channel.name, clientId: input.clientId }, 'stream ended');
    res.json({ released: true });
  });

  return router;
};
