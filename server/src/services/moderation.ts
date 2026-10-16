import type { DB } from '../db/index.js';
import type { BanRecord } from '../types.js';

interface BanRow {
  account_id: string;
  reason: string | null;
  banned_by: string | null;
  banned_at: number;
  expires_at: number | null;
}

const rowToRecord = (row: BanRow): BanRecord => ({
  accountId: row.account_id,
  reason: row.reason,
  bannedBy: row.banned_by,
  bannedAt: row.banned_at,
  expiresAt: row.expires_at,
});

export const VOICE_TIMEOUT_MIN_MS = 60 * 1000;
export const VOICE_TIMEOUT_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Bans are persistent (keyed by account). Voice timeouts are short-lived and
 * kept in memory, keyed by account so reconnecting does not clear them.
 */
export class ModerationService {
  private readonly stmts;
  private readonly voiceTimeouts = new Map<string, number>();

  constructor(db: DB) {
    this.stmts = {
      upsert: db.prepare(`
        INSERT INTO bans (account_id, reason, banned_by, banned_at, expires_at)
        VALUES (@account_id, @reason, @banned_by, @banned_at, @expires_at)
        ON CONFLICT(account_id) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by,
          banned_at = excluded.banned_at, expires_at = excluded.expires_at
      `),
      get: db.prepare('SELECT * FROM bans WHERE account_id = ?'),
      remove: db.prepare('DELETE FROM bans WHERE account_id = ?'),
      list: db.prepare('SELECT * FROM bans ORDER BY banned_at DESC'),
      purge: db.prepare('DELETE FROM bans WHERE expires_at IS NOT NULL AND expires_at <= ?'),
    };
  }

  ban(accountId: string, reason: string | null, bannedBy: string | null, durationMs: number | null = null): BanRecord {
    const now = Date.now();
    const record: BanRecord = {
      accountId,
      reason: reason ? reason.trim().slice(0, 500) : null,
      bannedBy: bannedBy ? bannedBy.slice(0, 100) : null,
      bannedAt: now,
      expiresAt: durationMs && durationMs > 0 ? now + durationMs : null,
    };
    this.stmts.upsert.run({
      account_id: record.accountId,
      reason: record.reason,
      banned_by: record.bannedBy,
      banned_at: record.bannedAt,
      expires_at: record.expiresAt,
    });
    return record;
  }

  unban(accountId: string): boolean {
    return this.stmts.remove.run(accountId).changes > 0;
  }

  getBan(accountId: string): BanRecord | null {
    const row = this.stmts.get.get(accountId) as BanRow | undefined;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      this.stmts.remove.run(accountId);
      return null;
    }
    return rowToRecord(row);
  }

  isBanned(accountId: string): boolean {
    return this.getBan(accountId) !== null;
  }

  listBans(): BanRecord[] {
    return (this.stmts.list.all() as BanRow[]).map(rowToRecord);
  }

  purgeExpired(now = Date.now()): number {
    for (const [accountId, until] of this.voiceTimeouts) {
      if (until <= now) this.voiceTimeouts.delete(accountId);
    }
    return this.stmts.purge.run(now).changes;
  }

  setVoiceTimeout(accountId: string, durationMs: number): number {
    const safe = Math.min(VOICE_TIMEOUT_MAX_MS, Math.max(VOICE_TIMEOUT_MIN_MS, durationMs));
    this.voiceTimeouts.set(accountId, Date.now() + safe);
    return safe;
  }

  clearVoiceTimeout(accountId: string): void {
    this.voiceTimeouts.delete(accountId);
  }

  /** Remaining voice timeout in ms, or 0 when none is active. */
  voiceTimeoutRemaining(accountId: string, now = Date.now()): number {
    const until = this.voiceTimeouts.get(accountId);
    if (!until) return 0;
    if (until <= now) {
      this.voiceTimeouts.delete(accountId);
      return 0;
    }
    return until - now;
  }
}
