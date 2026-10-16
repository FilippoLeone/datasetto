import { randomToken, sha256 } from '../core/ids.js';
import type { DB } from '../db/index.js';
import type { SessionRecord } from '../types.js';

const TOKEN_PREFIX = 'sess-';
/** Avoid a write on every reconnect: only refresh the sliding window this often. */
const TOUCH_INTERVAL_MS = 60_000;

export interface IssuedSession {
  token: string;
  tokenHash: string;
  accountId: string;
  createdAt: number;
  expiresAt: number;
}

export interface SessionMeta {
  userAgent?: string | null;
  ip?: string | null;
}

interface SessionRow {
  token_hash: string;
  account_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  user_agent: string | null;
  ip: string | null;
}

const rowToRecord = (row: SessionRow): SessionRecord => ({
  tokenHash: row.token_hash,
  accountId: row.account_id,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  expiresAt: row.expires_at,
  userAgent: row.user_agent,
  ip: row.ip,
});

export class SessionService {
  private readonly stmts;

  constructor(
    db: DB,
    private readonly ttlMs: number,
  ) {
    this.stmts = {
      insert: db.prepare(`
        INSERT INTO sessions (token_hash, account_id, created_at, last_seen_at, expires_at, user_agent, ip)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      byHash: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
      touch: db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?'),
      deleteByHash: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
      deleteByAccount: db.prepare('DELETE FROM sessions WHERE account_id = ?'),
      deleteByAccountExcept: db.prepare('DELETE FROM sessions WHERE account_id = ? AND token_hash <> ?'),
      deleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
      countByAccount: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?'),
    };
  }

  static hashToken(token: string): string {
    return sha256(token);
  }

  create(accountId: string, meta: SessionMeta = {}): IssuedSession {
    const token = TOKEN_PREFIX + randomToken(32);
    const tokenHash = SessionService.hashToken(token);
    const now = Date.now();
    const expiresAt = now + this.ttlMs;
    this.stmts.insert.run(
      tokenHash,
      accountId,
      now,
      now,
      expiresAt,
      meta.userAgent ? meta.userAgent.slice(0, 256) : null,
      meta.ip ? meta.ip.slice(0, 64) : null,
    );
    return { token, tokenHash, accountId, createdAt: now, expiresAt };
  }

  /**
   * Validate a token, extend its expiry (sliding window) and return the record.
   * Returns null for unknown or expired tokens; expired rows are removed.
   */
  resume(token: unknown): SessionRecord | null {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX) || token.length > 256) return null;
    const tokenHash = SessionService.hashToken(token);
    const row = this.stmts.byHash.get(tokenHash) as SessionRow | undefined;
    if (!row) return null;

    const now = Date.now();
    if (row.expires_at <= now) {
      this.stmts.deleteByHash.run(tokenHash);
      return null;
    }

    const record = rowToRecord(row);
    if (now - record.lastSeenAt >= TOUCH_INTERVAL_MS) {
      record.lastSeenAt = now;
      record.expiresAt = now + this.ttlMs;
      this.stmts.touch.run(record.lastSeenAt, record.expiresAt, tokenHash);
    }
    return record;
  }

  revoke(token: unknown): boolean {
    if (typeof token !== 'string') return false;
    return this.stmts.deleteByHash.run(SessionService.hashToken(token)).changes > 0;
  }

  revokeAll(accountId: string, exceptTokenHash: string | null = null): number {
    if (exceptTokenHash) {
      return this.stmts.deleteByAccountExcept.run(accountId, exceptTokenHash).changes;
    }
    return this.stmts.deleteByAccount.run(accountId).changes;
  }

  purgeExpired(now = Date.now()): number {
    return this.stmts.deleteExpired.run(now).changes;
  }

  countForAccount(accountId: string): number {
    return Number((this.stmts.countByAccount.get(accountId) as { n: number }).n);
  }
}
