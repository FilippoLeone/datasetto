import webpush, { type PushSubscription as WebPushSubscription, type RequestOptions, type SendResult } from 'web-push';
import { newId } from '../core/ids.js';
import { RateLimiter } from '../core/rateLimit.js';
import type { DB } from '../db/index.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { PushSubscriptionView } from '../types.js';

export interface PushConfig {
  publicKey: string | null;
  privateKey: string | null;
  subject: string | null;
}

/** What the browser's `PushSubscription.toJSON()` gives us, plus the device's user agent. */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string | null;
}

/** The JSON the service worker receives (client/public/sw.js). Kept well under 2 KB. */
export interface PushNotification {
  title: string;
  body: string;
  /** Path the notification opens, e.g. `/app?channel=<id>`. */
  url: string;
  /** Collapses notifications of one conversation; `channel:<id>`. */
  tag: string;
  channelId: string | null;
}

export interface PushSendSummary {
  /** Why nothing was attempted, or null when deliveries were made. */
  skipped: 'disabled' | 'rate-limited' | 'no-subscriptions' | null;
  sent: number;
  failed: number;
  /** Subscriptions the push service reported gone (404/410) and that were deleted. */
  dropped: number;
}

/** Delivers one notification to one subscription; replaced by a fake in tests. */
export type PushTransport = (subscription: WebPushSubscription, payload: string, options: RequestOptions) => Promise<SendResult>;

export interface PushServiceOptions {
  transport?: PushTransport;
  /** Minimum gap between two notifications for one recipient about one conversation. */
  windowMs?: number;
}

/** Browsers of one account we keep; the oldest are dropped beyond this. */
export const MAX_SUBSCRIPTIONS_PER_ACCOUNT = 20;
/** Push services reject larger payloads (4 KB at most); 2 KB leaves room for everything we send. */
export const MAX_PAYLOAD_BYTES = 2048;
/** One notification per recipient per conversation within this window. */
export const NOTIFICATION_WINDOW_MS = 30_000;
const TITLE_MAX = 80;
const BODY_MAX = 180;
/** Notifications stay queued at the push service this long while the device is offline. */
const TTL_SECONDS = 60 * 60;
const KEY_PATTERN = /^[A-Za-z0-9_-]+=*$/;

interface SubscriptionRow {
  id: string;
  account_id: string;
  session_hash: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: number;
  last_used_at: number | null;
}

const rowToView = (row: SubscriptionRow): PushSubscriptionView => ({
  id: row.id,
  endpoint: row.endpoint,
  userAgent: row.user_agent,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

/** Collapse whitespace and cut to `max` characters with an ellipsis. */
export const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
};

/** Serialise a notification, shrinking the body until the JSON fits in MAX_PAYLOAD_BYTES. */
export const serializeNotification = (notification: PushNotification): string => {
  let body = clip(notification.body, BODY_MAX);
  const title = clip(notification.title, TITLE_MAX);
  for (;;) {
    const json = JSON.stringify({ ...notification, title, body });
    if (Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_BYTES || body.length === 0) return json;
    body = clip(body, Math.floor(body.length / 2));
  }
};

const statusOf = (error: unknown): number | null => {
  const status = (error as { statusCode?: unknown })?.statusCode;
  return typeof status === 'number' ? status : null;
};

/**
 * Web Push: subscriptions per account in SQLite and delivery through the `web-push`
 * package (VAPID). Disabled, and a no-op, without VAPID keys in the environment.
 */
export class PushService {
  private readonly stmts;
  private readonly transport: PushTransport;
  private readonly limiter: RateLimiter;
  private readonly enabled: boolean;

  constructor(
    db: DB,
    private readonly config: PushConfig,
    private readonly log: Logger,
    options: PushServiceOptions = {},
  ) {
    this.enabled = Boolean(config.publicKey && config.privateKey && config.subject);
    if (this.enabled) webpush.setVapidDetails(config.subject!, config.publicKey!, config.privateKey!);
    this.transport = options.transport ?? ((subscription, payload, sendOptions) => webpush.sendNotification(subscription, payload, sendOptions));
    this.limiter = new RateLimiter(1, options.windowMs ?? NOTIFICATION_WINDOW_MS);
    this.stmts = {
      upsert: db.prepare(`
        INSERT INTO push_subscriptions (id, account_id, session_hash, endpoint, p256dh, auth, user_agent, created_at, last_used_at)
        VALUES (@id, @account_id, @session_hash, @endpoint, @p256dh, @auth, @user_agent, @created_at, NULL)
        ON CONFLICT(endpoint) DO UPDATE SET
          account_id = excluded.account_id,
          session_hash = excluded.session_hash,
          p256dh = excluded.p256dh,
          auth = excluded.auth,
          user_agent = excluded.user_agent
      `),
      byEndpoint: db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?'),
      byAccount: db.prepare('SELECT * FROM push_subscriptions WHERE account_id = ? ORDER BY created_at ASC'),
      trim: db.prepare(`
        DELETE FROM push_subscriptions WHERE account_id = ? AND id NOT IN (
          SELECT id FROM push_subscriptions WHERE account_id = ? ORDER BY created_at DESC LIMIT ?
        )
      `),
      deleteOwn: db.prepare('DELETE FROM push_subscriptions WHERE account_id = ? AND endpoint = ?'),
      deleteById: db.prepare('DELETE FROM push_subscriptions WHERE id = ?'),
      deleteByAccount: db.prepare('DELETE FROM push_subscriptions WHERE account_id = ?'),
      // A subscription belongs to the login that made it; signed-out and expired logins take theirs along.
      purgeOrphans: db.prepare(`
        DELETE FROM push_subscriptions WHERE session_hash IS NOT NULL
          AND session_hash NOT IN (SELECT token_hash FROM sessions WHERE expires_at > ?)
      `),
      touch: db.prepare('UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?'),
      count: db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions'),
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** The VAPID public key browsers subscribe with; null when push is off. */
  publicKey(): string | null {
    return this.enabled ? this.config.publicKey : null;
  }

  subject(): string | null {
    return this.enabled ? this.config.subject : null;
  }

  count(): number {
    return Number((this.stmts.count.get() as { n: number }).n);
  }

  /**
   * Register (or refresh) a browser's subscription for an account. The endpoint is the
   * identity: the same browser signing in as someone else moves the subscription over.
   */
  subscribe(accountId: string, sessionHash: string | null, input: PushSubscriptionInput): PushSubscriptionView {
    const endpoint = this.validateEndpoint(input.endpoint);
    const p256dh = this.validateKey(input.keys?.p256dh, 'p256dh');
    const auth = this.validateKey(input.keys?.auth, 'auth');
    const now = Date.now();
    this.stmts.upsert.run({
      id: newId('push', 16),
      account_id: accountId,
      session_hash: sessionHash,
      endpoint,
      p256dh,
      auth,
      user_agent: input.userAgent ? input.userAgent.slice(0, 256) : null,
      created_at: now,
    });
    this.stmts.trim.run(accountId, accountId, MAX_SUBSCRIPTIONS_PER_ACCOUNT);
    const row = this.stmts.byEndpoint.get(endpoint) as SubscriptionRow | undefined;
    if (!row) throw new AppError('Subscription could not be stored', 'PUSH_SUBSCRIBE_FAILED', 500);
    return rowToView(row);
  }

  /** Remove one of the account's own subscriptions. */
  unsubscribe(accountId: string, endpoint: unknown): boolean {
    if (typeof endpoint !== 'string' || !endpoint) return false;
    return this.stmts.deleteOwn.run(accountId, endpoint.trim()).changes > 0;
  }

  list(accountId: string): PushSubscriptionView[] {
    return (this.stmts.byAccount.all(accountId) as SubscriptionRow[]).map(rowToView);
  }

  /** Drop every subscription of an account (account deleted). */
  removeAll(accountId: string): number {
    return this.stmts.deleteByAccount.run(accountId).changes;
  }

  /** Drop subscriptions whose login no longer exists. Cheap; runs before each send and hourly. */
  purgeOrphans(now = Date.now()): number {
    return this.stmts.purgeOrphans.run(now).changes;
  }

  /**
   * Send one notification to every device of an account, at most once per
   * `conversationKey` within the window. Gone subscriptions (404/410) are deleted.
   */
  async send(accountId: string, notification: PushNotification, conversationKey: string): Promise<PushSendSummary> {
    const summary: PushSendSummary = { skipped: null, sent: 0, failed: 0, dropped: 0 };
    if (!this.enabled) return { ...summary, skipped: 'disabled' };
    this.purgeOrphans();
    const rows = this.stmts.byAccount.all(accountId) as SubscriptionRow[];
    if (rows.length === 0) return { ...summary, skipped: 'no-subscriptions' };
    if (!this.limiter.hit(accountId + '|' + conversationKey).allowed) return { ...summary, skipped: 'rate-limited' };

    const payload = serializeNotification(notification);
    const outcomes = await Promise.all(rows.map((row) => this.deliver(row, payload)));
    for (const outcome of outcomes) summary[outcome] += 1;
    this.log.debug({ accountId, conversationKey, ...summary }, 'push notification');
    return summary;
  }

  private async deliver(row: SubscriptionRow, payload: string): Promise<'sent' | 'failed' | 'dropped'> {
    const subscription: WebPushSubscription = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
    try {
      await this.transport(subscription, payload, { TTL: TTL_SECONDS, urgency: 'high' });
      this.stmts.touch.run(Date.now(), row.id);
      return 'sent';
    } catch (error) {
      const status = statusOf(error);
      if (status === 404 || status === 410) {
        this.stmts.deleteById.run(row.id);
        this.log.info({ accountId: row.account_id, status }, 'push subscription gone, removed');
        return 'dropped';
      }
      this.log.warn({ err: error, accountId: row.account_id, status }, 'push delivery failed');
      return 'failed';
    }
  }

  private validateEndpoint(value: unknown): string {
    if (typeof value !== 'string' || value.length > 2048) throw new AppError('Invalid push endpoint', 'PUSH_INVALID', 400);
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new AppError('Invalid push endpoint', 'PUSH_INVALID', 400);
    }
    if (url.protocol !== 'https:') throw new AppError('Push endpoints must use https', 'PUSH_INVALID', 400);
    return url.toString();
  }

  private validateKey(value: unknown, name: string): string {
    if (typeof value !== 'string' || !value || value.length > 256 || !KEY_PATTERN.test(value)) {
      throw new AppError('Invalid push subscription key ' + name, 'PUSH_INVALID', 400);
    }
    return value;
  }
}
