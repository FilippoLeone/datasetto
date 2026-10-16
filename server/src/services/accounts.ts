import { timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { AppConfig } from '../config.js';
import { newId } from '../core/ids.js';
import { normalizeRoles } from '../core/roles.js';
import { displayNameSchema, emailSchema, optionalTextSchema, optionalUrlSchema, passwordSchema } from '../core/validation.js';
import { parseJson, type DB } from '../db/index.js';
import { AppError, notFound } from '../errors.js';
import type { AccountRecord, PublicAccount, RoleName } from '../types.js';
import { looksLikeInviteToken, type InviteService } from './invites.js';

const BCRYPT_ROUNDS = 10;
// Valid bcrypt hash of a random string; used to equalise timing for unknown accounts.
const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8W8V6Rq8kO5Rn4cJz7k9KZkC3Yq1mS';

interface AccountRow {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  bio: string | null;
  avatar_url: string | null;
  roles: string;
  status: string;
  password_hash: string;
  metadata: string;
  created_at: number;
  updated_at: number;
  disabled_at: number | null;
  disabled_reason: string | null;
  invite_token_id: string | null;
  must_change_password: number;
  last_seen_at: number | null;
  deleted_at: number | null;
}

export interface RegisterInput {
  username: string;
  password: string;
  displayName?: string | null;
  inviteCode?: string | null;
}

export interface ProfileUpdate {
  displayName?: string;
  email?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  metadata?: Record<string, unknown>;
}

const rowToRecord = (row: AccountRow): AccountRecord => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  email: row.email,
  bio: row.bio,
  avatarUrl: row.avatar_url,
  roles: normalizeRoles(parseJson<string[]>(row.roles, ['user'])),
  status: row.status === 'disabled' ? 'disabled' : row.status === 'deleted' ? 'deleted' : 'active',
  passwordHash: row.password_hash,
  metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  disabledAt: row.disabled_at,
  disabledReason: row.disabled_reason,
  inviteTokenId: row.invite_token_id ?? null,
  mustChangePassword: Boolean(row.must_change_password),
  lastSeenAt: row.last_seen_at ?? null,
  deletedAt: row.deleted_at ?? null,
});

/** Username a deleted account keeps so the real one becomes free again. */
export const tombstoneUsername = (id: string): string => 'deleted-' + id + '@deleted.invalid';

const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

export const sanitizeAccount = (account: AccountRecord): PublicAccount => {
  const { passwordHash: _passwordHash, ...safe } = account;
  return { ...safe, roles: [...safe.roles], metadata: { ...safe.metadata } };
};

const inviteUsable = (invite: { revokedAt: number | null; expiresAt: number | null; uses: number; maxUses: number }, now = Date.now()): boolean =>
  invite.revokedAt === null && (invite.expiresAt === null || invite.expiresAt > now) && invite.uses < invite.maxUses;

const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

const deriveDisplayName = (proposed: string | null | undefined, username: string): string => {
  const candidate = typeof proposed === 'string' ? proposed.trim() : '';
  if (candidate) return candidate.slice(0, 50);
  const local = username.includes('@') ? username.split('@')[0] : username;
  return (local || 'User').slice(0, 50);
};

export class AccountService {
  private readonly stmts;

  constructor(
    private readonly db: DB,
    private readonly config: AppConfig,
    private readonly invites: InviteService | null = null,
  ) {
    this.stmts = {
      count: db.prepare('SELECT COUNT(*) AS n FROM accounts'),
      byId: db.prepare('SELECT * FROM accounts WHERE id = ?'),
      byUsername: db.prepare('SELECT * FROM accounts WHERE username = ?'),
      list: db.prepare('SELECT * FROM accounts ORDER BY created_at ASC'),
      insert: db.prepare(`
        INSERT INTO accounts (id, username, display_name, email, bio, avatar_url, roles, status, password_hash, metadata, created_at, updated_at, invite_token_id)
        VALUES (@id, @username, @display_name, @email, @bio, @avatar_url, @roles, 'active', @password_hash, @metadata, @created_at, @updated_at, @invite_token_id)
      `),
      updateProfile: db.prepare(`
        UPDATE accounts SET display_name = @display_name, email = @email, bio = @bio, avatar_url = @avatar_url,
          metadata = @metadata, updated_at = @updated_at WHERE id = @id
      `),
      updatePassword: db.prepare('UPDATE accounts SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?'),
      resetPassword: db.prepare('UPDATE accounts SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?'),
      touchSeen: db.prepare('UPDATE accounts SET last_seen_at = ? WHERE id = ?'),
      softDelete: db.prepare(`
        UPDATE accounts SET status = 'deleted', deleted_at = @now, username = @username, display_name = 'Deleted user', email = NULL,
          bio = NULL, avatar_url = NULL, roles = '["user"]', metadata = @metadata, must_change_password = 0, updated_at = @now WHERE id = @id
      `),
      updateRoles: db.prepare('UPDATE accounts SET roles = ?, updated_at = ? WHERE id = ?'),
      setStatus: db.prepare(`
        UPDATE accounts SET status = @status, disabled_at = @disabled_at, disabled_reason = @disabled_reason,
          updated_at = @updated_at WHERE id = @id
      `),
    };
  }

  count(): number {
    return Number((this.stmts.count.get() as { n: number }).n);
  }

  getById(id: string): AccountRecord | null {
    const row = this.stmts.byId.get(id) as AccountRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  getByUsername(username: string): AccountRecord | null {
    const row = this.stmts.byUsername.get(username.trim().toLowerCase()) as AccountRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  requireById(id: string): AccountRecord {
    const account = this.getById(id);
    if (!account) throw notFound('Account');
    return account;
  }

  list(): AccountRecord[] {
    return (this.stmts.list.all() as AccountRow[]).map(rowToRecord);
  }

  listPublic(): PublicAccount[] {
    return this.list().map(sanitizeAccount);
  }

  /** Roles the server grants automatically on top of what is stored. */
  private bootstrapRoles(username: string, roles: RoleName[], isFirstAccount: boolean): RoleName[] {
    const result = new Set<RoleName>(roles);
    if (isFirstAccount) {
      result.delete('user');
      result.add('admin');
    }
    if (this.config.registration.adminEmails.includes(username)) result.add('superuser');
    return normalizeRoles(Array.from(result));
  }

  /**
   * Decide whether a registration may proceed and with which invite token.
   * Returns the token to redeem (null for the env code or open registration).
   */
  private checkInvite(input: RegisterInput): string | null {
    const { mode, inviteCode } = this.config.registration;
    const provided = typeof input.inviteCode === 'string' ? input.inviteCode.trim() : '';
    if (mode === 'closed') {
      throw new AppError('Registration is closed on this server', 'REGISTRATION_CLOSED', 403);
    }
    const envCodeMatches = Boolean(inviteCode && provided && safeEqual(provided, inviteCode));
    if (envCodeMatches) return null;
    const token = this.invites && looksLikeInviteToken(provided) ? this.invites.getByToken(provided) : null;
    const tokenValid = token !== null && inviteUsable(token);
    if (mode === 'invite') {
      if (!tokenValid) throw new AppError('Invalid invite code', 'INVITE_CODE_INVALID', 403);
      return provided;
    }
    // Open registration: a valid token is recorded, anything else is ignored.
    return tokenValid ? provided : null;
  }

  private readonly lastSeenWritten = new Map<string, number>();

  /** Record activity, writing at most once a minute per account. */
  touchLastSeen(id: string, now = Date.now()): void {
    const previous = this.lastSeenWritten.get(id);
    if (previous !== undefined && now - previous < LAST_SEEN_WRITE_INTERVAL_MS) return;
    this.lastSeenWritten.set(id, now);
    this.stmts.touchSeen.run(now, id);
  }

  async register(input: RegisterInput): Promise<PublicAccount> {
    const inviteToken = this.checkInvite(input);

    const username = emailSchema.parse(input.username);
    const password = passwordSchema(this.config.security.passwordMinLength).parse(input.password);
    const displayName = deriveDisplayName(input.displayName, username);

    if (this.getByUsername(username)) {
      throw new AppError('An account with this email already exists', 'ACCOUNT_EXISTS', 409);
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const now = Date.now();
    const roles = this.bootstrapRoles(username, ['user'], this.count() === 0);

    const record: AccountRecord = {
      id: newId('acct', 20),
      username,
      displayName,
      email: null,
      bio: null,
      avatarUrl: null,
      roles,
      status: 'active',
      passwordHash,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      disabledAt: null,
      disabledReason: null,
      inviteTokenId: null,
      mustChangePassword: false,
      lastSeenAt: null,
      deletedAt: null,
    };

    // The token use and the account land in one transaction: a token is never
    // spent without an account, and an account never points at an unspent token.
    this.db.transaction(() => {
      if (inviteToken && this.invites) {
        const redeemed = this.invites.redeem(inviteToken, now);
        if (!redeemed) throw new AppError('Invalid invite code', 'INVITE_CODE_INVALID', 403);
        record.inviteTokenId = redeemed.id;
      }
      this.stmts.insert.run({
        id: record.id,
        username: record.username,
        display_name: record.displayName,
        email: record.email,
        bio: record.bio,
        avatar_url: record.avatarUrl,
        roles: JSON.stringify(record.roles),
        password_hash: record.passwordHash,
        metadata: JSON.stringify(record.metadata),
        created_at: now,
        updated_at: now,
        invite_token_id: record.inviteTokenId,
      });
    })();

    return sanitizeAccount(record);
  }

  /** Verify credentials. Errors are deliberately generic. */
  async authenticate(username: unknown, password: unknown): Promise<PublicAccount> {
    const invalid = () => new AppError('Invalid email or password', 'INVALID_CREDENTIALS', 401);
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      throw invalid();
    }

    const account = this.getByUsername(username);
    if (!account || account.status === 'deleted') {
      await bcrypt.compare(password, DUMMY_HASH);
      throw invalid();
    }
    if (account.status !== 'active') {
      throw new AppError(account.disabledReason || 'This account has been disabled', 'ACCOUNT_DISABLED', 403);
    }

    const match = await bcrypt.compare(password, account.passwordHash);
    if (!match) throw invalid();

    const roles = this.bootstrapRoles(account.username, account.roles, false);
    if (roles.length !== account.roles.length || roles.some((role) => !account.roles.includes(role))) {
      return this.assignRoles(account.id, roles);
    }
    return sanitizeAccount(account);
  }

  updateProfile(id: string, updates: ProfileUpdate): PublicAccount {
    const account = this.requireById(id);
    const next: AccountRecord = { ...account, updatedAt: Date.now() };

    if (updates.displayName !== undefined) {
      next.displayName = displayNameSchema.parse(updates.displayName);
    }
    if (updates.email !== undefined) {
      next.email = updates.email ? emailSchema.parse(updates.email) : null;
    }
    if (updates.bio !== undefined) {
      next.bio = optionalTextSchema(500).parse(updates.bio);
    }
    if (updates.avatarUrl !== undefined) {
      next.avatarUrl = optionalUrlSchema.parse(updates.avatarUrl);
    }
    if (updates.metadata && typeof updates.metadata === 'object') {
      next.metadata = { ...account.metadata, ...updates.metadata };
      if (JSON.stringify(next.metadata).length > 8000) {
        throw new AppError('Profile metadata is too large', 'METADATA_TOO_LARGE', 400);
      }
    }

    this.stmts.updateProfile.run({
      id,
      display_name: next.displayName,
      email: next.email,
      bio: next.bio,
      avatar_url: next.avatarUrl,
      metadata: JSON.stringify(next.metadata),
      updated_at: next.updatedAt,
    });

    return sanitizeAccount(next);
  }

  async changePassword(id: string, currentPassword: unknown, newPassword: unknown): Promise<void> {
    const account = this.requireById(id);
    if (typeof currentPassword !== 'string' || !currentPassword) {
      throw new AppError('Current password is required to change password', 'PASSWORD_REQUIRED', 400);
    }
    const next = passwordSchema(this.config.security.passwordMinLength).parse(newPassword);
    const match = await bcrypt.compare(currentPassword, account.passwordHash);
    if (!match) {
      throw new AppError('Current password is incorrect', 'PASSWORD_INCORRECT', 403);
    }
    const hash = await bcrypt.hash(next, BCRYPT_ROUNDS);
    this.stmts.updatePassword.run(hash, Date.now(), id);
  }

  /** Admin: set a temporary password; the user must pick a new one on the next sign-in. */
  async resetPassword(id: string, temporaryPassword: unknown): Promise<PublicAccount> {
    const account = this.requireById(id);
    if (account.status === 'deleted') throw new AppError('This account was deleted', 'ACCOUNT_DELETED', 410);
    const next = passwordSchema(this.config.security.passwordMinLength).parse(temporaryPassword);
    const hash = await bcrypt.hash(next, BCRYPT_ROUNDS);
    const now = Date.now();
    this.stmts.resetPassword.run(hash, now, id);
    return sanitizeAccount({ ...account, passwordHash: hash, mustChangePassword: true, updatedAt: now });
  }

  /**
   * Soft delete: the row stays (messages keep their author id) but the account
   * can no longer sign in, its profile is blanked and its email becomes free.
   */
  softDelete(id: string): PublicAccount {
    const account = this.requireById(id);
    if (account.status === 'deleted') return sanitizeAccount(account);
    const now = Date.now();
    const username = tombstoneUsername(id);
    const metadata = { deletedUsername: account.username, deletedDisplayName: account.displayName };
    this.stmts.softDelete.run({ id, now, username, metadata: JSON.stringify(metadata) });
    return sanitizeAccount({
      ...account,
      status: 'deleted',
      deletedAt: now,
      username,
      displayName: 'Deleted user',
      email: null,
      bio: null,
      avatarUrl: null,
      roles: ['user'],
      metadata,
      mustChangePassword: false,
      updatedAt: now,
    });
  }

  assignRoles(id: string, roles: unknown): PublicAccount {
    const account = this.requireById(id);
    const normalized = normalizeRoles(roles);
    const now = Date.now();
    this.stmts.updateRoles.run(JSON.stringify(normalized), now, id);
    return sanitizeAccount({ ...account, roles: normalized, updatedAt: now });
  }

  disable(id: string, reason: string | null = null): PublicAccount {
    const account = this.requireById(id);
    const now = Date.now();
    const safeReason = reason ? reason.toString().trim().slice(0, 500) : null;
    this.stmts.setStatus.run({ id, status: 'disabled', disabled_at: now, disabled_reason: safeReason, updated_at: now });
    return sanitizeAccount({ ...account, status: 'disabled', disabledAt: now, disabledReason: safeReason, updatedAt: now });
  }

  enable(id: string): PublicAccount {
    const account = this.requireById(id);
    const now = Date.now();
    this.stmts.setStatus.run({ id, status: 'active', disabled_at: null, disabled_reason: null, updated_at: now });
    return sanitizeAccount({ ...account, status: 'active', disabledAt: null, disabledReason: null, updatedAt: now });
  }

  /** Active accounts holding admin or superuser, excluding `exceptId`. */
  countActiveAdmins(exceptId: string | null = null): number {
    return this.list().filter(
      (acct) =>
        acct.id !== exceptId &&
        acct.status === 'active' &&
        (acct.roles.includes('admin') || acct.roles.includes('superuser')),
    ).length;
  }
}
