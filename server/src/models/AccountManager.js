import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import bcrypt from 'bcryptjs';

import { generateId, validateUsername } from '../utils/helpers.js';
import { appConfig } from '../config/index.js';
import logger from '../utils/logger.js';

const ACCOUNT_FILE_VERSION = 1;

function validatePassword(password) {
  const minLength = Math.max(appConfig.security?.passwordMinLength || 8, 8);
  if (typeof password !== 'string') {
    return { valid: false, error: 'Password is required' };
  }

  const trimmed = password.trim();

  if (trimmed.length < minLength) {
    return { valid: false, error: `Password must be at least ${minLength} characters long` };
  }

  if (trimmed.length > 128) {
    return { valid: false, error: 'Password must be 128 characters or less' };
  }

  return { valid: true, value: trimmed };
}

export class AccountManager {
  constructor(options = {}) {
    this.accounts = new Map();
    this.sessions = new Map();
    this.sessionsByAccount = new Map();

    this.storePath = options.storePath || appConfig.storage.accountStorePath;
    this.sessionTtlMs = options.sessionTtlMs || appConfig.storage.accountSessionTtlMs;
    this.saltRounds = options.saltRounds || 10;

    this._pendingPersist = null;

    this.loadFromDisk();
  }

  loadFromDisk() {
    if (!this.storePath || !existsSync(this.storePath)) {
      return;
    }

    try {
      const raw = readFileSync(this.storePath, 'utf-8');
      if (!raw) return;

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.accounts)) {
        logger.warn('[AccountManager] Invalid account store format');
        return;
      }

      parsed.accounts.forEach((acct) => {
        if (!acct || typeof acct !== 'object' || !acct.id || !acct.username || !acct.passwordHash) {
          return;
        }
        this.accounts.set(acct.id, {
          ...acct,
          roles: Array.isArray(acct.roles) && acct.roles.length ? Array.from(new Set(acct.roles)) : ['user'],
        });
      });

      logger.info(`[AccountManager] Loaded ${this.accounts.size} account(s)`);
    } catch (error) {
      logger.error(`[AccountManager] Failed to load accounts: ${error.message}`);
    }
  }

  schedulePersist() {
    if (this._pendingPersist) {
      clearTimeout(this._pendingPersist);
    }

    this._pendingPersist = setTimeout(() => {
      this.persistToDisk();
    }, 1000).unref?.();
  }

  persistToDisk() {
    this._pendingPersist = null;

    try {
      if (!this.storePath) return;

      const payload = {
        version: ACCOUNT_FILE_VERSION,
        generatedAt: Date.now(),
        accounts: Array.from(this.accounts.values()).map((acct) => ({ ...acct })),
      };

      const dir = dirname(this.storePath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(this.storePath, JSON.stringify(payload, null, 2));
    } catch (error) {
      logger.error(`[AccountManager] Failed to persist accounts: ${error.message}`);
    }
  }

  getAccountByUsername(username) {
    if (!username) return null;

    for (const account of this.accounts.values()) {
      if (account.username === username) {
        return account;
      }
    }

    return null;
  }

  getAccountById(accountId) {
    return this.accounts.get(accountId) || null;
  }

  listAccounts() {
    return Array.from(this.accounts.values());
  }

  _createAccountObject({ username, passwordHash, profile = {}, roles }) {
    const now = Date.now();
    const accountId = `acct-${generateId(20)}`;

    return {
      id: accountId,
      username,
      displayName: this._deriveDisplayName(profile.displayName, username),
      email: profile.email ? profile.email.toString().trim().slice(0, 254) : null,
      bio: profile.bio ? profile.bio.toString().trim().slice(0, 500) : null,
      avatarUrl: profile.avatarUrl ? profile.avatarUrl.toString().trim().slice(0, 2048) : null,
      roles: roles && roles.length ? roles : ['user'],
      status: 'active',
      passwordHash,
      createdAt: now,
      updatedAt: now,
      metadata: profile.metadata && typeof profile.metadata === 'object' ? profile.metadata : {},
    };
  }

  _deriveDisplayName(proposedDisplayName, identifier) {
    const candidate = typeof proposedDisplayName === 'string' ? proposedDisplayName.trim() : '';
    if (candidate.length > 0) {
      return candidate.slice(0, 50);
    }

    if (typeof identifier === 'string') {
      const trimmed = identifier.trim();
      if (trimmed.length > 0) {
        if (trimmed.includes('@')) {
          const [localPart] = trimmed.split('@');
          if (localPart && localPart.length > 0) {
            return localPart.slice(0, 50);
          }
        }
        return trimmed.slice(0, 50);
      }
    }

    return 'User';
  }

  async registerAccount({ username, password, profile = {} }) {
    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      throw new Error(usernameValidation.error);
    }

    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      throw new Error(passwordValidation.error);
    }

    const normalizedUsername = usernameValidation.value.toLowerCase();

    if (this.getAccountByUsername(normalizedUsername)) {
      throw new Error('Email already registered');
    }

    const passwordHash = bcrypt.hashSync(passwordValidation.value, this.saltRounds);

    const isFirstAccount = this.accounts.size === 0;
    const roles = isFirstAccount ? ['admin'] : ['user'];

    const account = this._createAccountObject({
      username: normalizedUsername,
      passwordHash,
      profile,
      roles,
    });

    this.accounts.set(account.id, account);
    this.schedulePersist();

    logger.info('[AccountManager] Account registered', { username: normalizedUsername, accountId: account.id, roles });

    return this.sanitizeAccount(account);
  }

  async authenticate(username, password) {
    if (!username || !password) {
      throw new Error('Email and password are required');
    }

    const normalizedUsername = username.trim().toLowerCase();
    const account = this.getAccountByUsername(normalizedUsername);

    if (!account || account.status !== 'active') {
      throw new Error('Invalid credentials');
    }

    const match = bcrypt.compareSync(password.trim(), account.passwordHash);
    if (!match) {
      throw new Error('Invalid credentials');
    }

    return this.sanitizeAccount(account);
  }

  sanitizeAccount(account) {
    if (!account) return null;

    const { passwordHash, ...safe } = account;
    return { ...safe };
  }

  createSession(accountId) {
    if (!accountId) {
      throw new Error('Account ID is required for session creation');
    }

    const account = this.getAccountById(accountId);
    if (!account) {
      throw new Error('Account not found');
    }

    const token = `sess-${generateId(30)}`;
    const now = Date.now();
    const session = {
      token,
      accountId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.sessionTtlMs,
    };

    this.sessions.set(token, session);

    if (!this.sessionsByAccount.has(accountId)) {
      this.sessionsByAccount.set(accountId, new Set());
    }

    this.sessionsByAccount.get(accountId).add(token);

    return session;
  }

  touchSession(token) {
    const session = this.sessions.get(token);
    if (!session) return null;

    const now = Date.now();
    if (session.expiresAt && session.expiresAt < now) {
      this.revokeSession(token);
      return null;
    }

    session.lastSeenAt = now;
    if (this.sessionTtlMs && this.sessionTtlMs > 0) {
      session.expiresAt = now + this.sessionTtlMs;
    }
    return session;
  }

  validateSession(token) {
    if (!token) return null;

    const session = this.touchSession(token);
    if (!session) return null;

    return this.sanitizeAccount(this.getAccountById(session.accountId));
  }

  revokeSession(token) {
    const session = this.sessions.get(token);
    if (!session) return false;

    this.sessions.delete(token);
    const set = this.sessionsByAccount.get(session.accountId);
    if (set) {
      set.delete(token);
      if (set.size === 0) {
        this.sessionsByAccount.delete(session.accountId);
      }
    }

    return true;
  }

  revokeAllSessions(accountId) {
    const tokens = this.sessionsByAccount.get(accountId);
    if (!tokens) return 0;

    let revoked = 0;
    tokens.forEach((token) => {
      if (this.revokeSession(token)) {
        revoked += 1;
      }
    });
    return revoked;
  }

  updateAccount(accountId, updates = {}) {
    const account = this.getAccountById(accountId);
    if (!account) {
      throw new Error('Account not found');
    }

    const sanitizedUpdates = {};

    if (updates.displayName) {
      sanitizedUpdates.displayName = updates.displayName.trim().slice(0, 50);
    }

    if (updates.email !== undefined) {
      sanitizedUpdates.email = updates.email ? updates.email.trim().slice(0, 254) : null;
    }

    if (updates.bio !== undefined) {
      sanitizedUpdates.bio = updates.bio ? updates.bio.trim().slice(0, 500) : null;
    }

    if (updates.avatarUrl !== undefined) {
      sanitizedUpdates.avatarUrl = updates.avatarUrl ? updates.avatarUrl.trim().slice(0, 2048) : null;
    }

    if (updates.metadata && typeof updates.metadata === 'object') {
      sanitizedUpdates.metadata = { ...account.metadata, ...updates.metadata };
    }

    if (updates.password) {
      const passwordValidation = validatePassword(updates.password);
      if (!passwordValidation.valid) {
        throw new Error(passwordValidation.error);
      }

      if (!updates.currentPassword) {
        throw new Error('Current password is required to change password');
      }

      const match = bcrypt.compareSync(updates.currentPassword.trim(), account.passwordHash);
      if (!match) {
        throw new Error('Current password is incorrect');
      }

      sanitizedUpdates.passwordHash = bcrypt.hashSync(passwordValidation.value, this.saltRounds);
      this.revokeAllSessions(accountId);
    }

    const updatedAccount = {
      ...account,
      ...sanitizedUpdates,
      updatedAt: Date.now(),
    };

    this.accounts.set(accountId, updatedAccount);
    this.schedulePersist();

    logger.info('[AccountManager] Account updated', { accountId });

    return this.sanitizeAccount(updatedAccount);
  }

  assignRoles(accountId, roles = []) {
    const account = this.getAccountById(accountId);
    if (!account) {
      throw new Error('Account not found');
    }

    const validRoles = Array.isArray(roles)
      ? Array.from(new Set(roles
          .filter((role) => typeof role === 'string' && role.trim())
          .map((r) => r.trim().toLowerCase())))
      : [];

    if (validRoles.length === 0) {
      throw new Error('At least one role must be specified');
    }

    const updatedAccount = {
      ...account,
      roles: validRoles,
      updatedAt: Date.now(),
    };

    this.accounts.set(accountId, updatedAccount);
    this.schedulePersist();

    logger.info('[AccountManager] Roles updated', { accountId, roles: validRoles });

    return this.sanitizeAccount(updatedAccount);
  }

  disableAccount(accountId, reason = null) {
    const account = this.getAccountById(accountId);
    if (!account) {
      throw new Error('Account not found');
    }

    const updatedAccount = {
      ...account,
      status: 'disabled',
      disabledAt: Date.now(),
      disabledReason: reason,
      updatedAt: Date.now(),
    };

    this.accounts.set(accountId, updatedAccount);
    this.revokeAllSessions(accountId);
    this.schedulePersist();

    logger.warn('[AccountManager] Account disabled', { accountId, reason });

    return this.sanitizeAccount(updatedAccount);
  }

  enableAccount(accountId) {
    const account = this.getAccountById(accountId);
    if (!account) {
      throw new Error('Account not found');
    }

    const updatedAccount = {
      ...account,
      status: 'active',
      disabledAt: null,
      disabledReason: null,
      updatedAt: Date.now(),
    };

    this.accounts.set(accountId, updatedAccount);
    this.schedulePersist();

    logger.info('[AccountManager] Account enabled', { accountId });

    return this.sanitizeAccount(updatedAccount);
  }
}

const accountManager = new AccountManager();

export default accountManager;
