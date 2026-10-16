import { timingSafeEqual } from 'node:crypto';
import { generateStreamKeyToken, newId } from '../core/ids.js';
import type { DB } from '../db/index.js';
import { AppError, notFound } from '../errors.js';
import type { InviteTokenRecord } from '../types.js';

export const INVITE_TOKEN_PREFIX = 'inv-';
export const MAX_INVITE_TOKENS = 500;
export const MAX_INVITE_USES = 1000;

export interface CreateInviteInput {
  createdBy: string | null;
  note?: string | null;
  /** 1 for a single-use link; up to {@link MAX_INVITE_USES}. */
  maxUses?: number;
  expiresAt?: number | null;
}

interface InviteRow {
  id: string;
  token: string;
  note: string | null;
  max_uses: number;
  uses: number;
  created_by: string | null;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

const rowToRecord = (row: InviteRow): InviteTokenRecord => ({
  id: row.id,
  token: row.token,
  note: row.note,
  maxUses: row.max_uses,
  uses: row.uses,
  createdBy: row.created_by,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
});

const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
};

/** Why a token cannot be redeemed right now; null when it can. */
export const inviteStatus = (invite: InviteTokenRecord, now = Date.now()): 'active' | 'revoked' | 'expired' | 'exhausted' => {
  if (invite.revokedAt !== null) return 'revoked';
  if (invite.expiresAt !== null && invite.expiresAt <= now) return 'expired';
  if (invite.uses >= invite.maxUses) return 'exhausted';
  return 'active';
};

export const looksLikeInviteToken = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(INVITE_TOKEN_PREFIX) && value.length <= 64;

/**
 * Invite tokens: admin-made registration links that work next to (or instead
 * of) the single env invite code. Tokens are stored as issued so an admin can
 * copy the link again later; they can be revoked at any time.
 */
export class InviteService {
  private readonly stmts;

  constructor(db: DB) {
    this.stmts = {
      insert: db.prepare(`
        INSERT INTO invite_tokens (id, token, note, max_uses, uses, created_by, created_at, expires_at, revoked_at)
        VALUES (@id, @token, @note, @max_uses, 0, @created_by, @created_at, @expires_at, NULL)
      `),
      byId: db.prepare('SELECT * FROM invite_tokens WHERE id = ?'),
      byToken: db.prepare('SELECT * FROM invite_tokens WHERE token = ?'),
      list: db.prepare('SELECT * FROM invite_tokens ORDER BY created_at DESC'),
      count: db.prepare('SELECT COUNT(*) AS n FROM invite_tokens'),
      use: db.prepare('UPDATE invite_tokens SET uses = uses + 1 WHERE id = ? AND revoked_at IS NULL AND uses < max_uses'),
      revoke: db.prepare('UPDATE invite_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
      remove: db.prepare('DELETE FROM invite_tokens WHERE id = ?'),
      redeemedBy: db.prepare('SELECT id, username, display_name, created_at FROM accounts WHERE invite_token_id = ? ORDER BY created_at ASC'),
    };
  }

  create(input: CreateInviteInput, now = Date.now()): InviteTokenRecord {
    if (this.count() >= MAX_INVITE_TOKENS) {
      throw new AppError('Too many invite tokens; delete old ones first', 'INVITE_LIMIT', 409);
    }
    const maxUses = Math.min(MAX_INVITE_USES, Math.max(1, Math.floor(input.maxUses ?? 1)));
    const expiresAt = typeof input.expiresAt === 'number' && input.expiresAt > now ? Math.floor(input.expiresAt) : null;
    const record: InviteTokenRecord = {
      id: newId('invite', 12),
      token: INVITE_TOKEN_PREFIX + generateStreamKeyToken(20),
      note: input.note ? input.note.trim().slice(0, 200) || null : null,
      maxUses,
      uses: 0,
      createdBy: input.createdBy,
      createdAt: now,
      expiresAt,
      revokedAt: null,
    };
    this.stmts.insert.run({
      id: record.id,
      token: record.token,
      note: record.note,
      max_uses: record.maxUses,
      created_by: record.createdBy,
      created_at: record.createdAt,
      expires_at: record.expiresAt,
    });
    return record;
  }

  count(): number {
    return Number((this.stmts.count.get() as { n: number }).n);
  }

  get(id: string): InviteTokenRecord | null {
    const row = this.stmts.byId.get(id) as InviteRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  require(id: string): InviteTokenRecord {
    const invite = this.get(id);
    if (!invite) throw notFound('Invite');
    return invite;
  }

  getByToken(token: unknown): InviteTokenRecord | null {
    if (!looksLikeInviteToken(token)) return null;
    const row = this.stmts.byToken.get(token) as InviteRow | undefined;
    // The unique index already matched exactly; the constant-time compare keeps the habit.
    return row && safeEqual(row.token, token) ? rowToRecord(row) : null;
  }

  list(): InviteTokenRecord[] {
    return (this.stmts.list.all() as InviteRow[]).map(rowToRecord);
  }

  /** Accounts that registered with this token. */
  redeemedBy(id: string): Array<{ accountId: string; username: string; displayName: string; createdAt: number }> {
    return (this.stmts.redeemedBy.all(id) as Array<{ id: string; username: string; display_name: string; created_at: number }>).map((row) => ({
      accountId: row.id,
      username: row.username,
      displayName: row.display_name,
      createdAt: row.created_at,
    }));
  }

  /**
   * Consume one use of a token. Returns the token when it was valid; null
   * otherwise (unknown, revoked, expired or used up). Call inside the
   * transaction that creates the account so the use and the account land together.
   */
  redeem(token: unknown, now = Date.now()): InviteTokenRecord | null {
    const invite = this.getByToken(token);
    if (!invite || inviteStatus(invite, now) !== 'active') return null;
    if (this.stmts.use.run(invite.id).changes === 0) return null;
    return { ...invite, uses: invite.uses + 1 };
  }

  revoke(id: string, now = Date.now()): InviteTokenRecord {
    this.require(id);
    this.stmts.revoke.run(now, id);
    return this.require(id);
  }

  delete(id: string): boolean {
    return this.stmts.remove.run(id).changes > 0;
  }
}
