import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import bcrypt from 'bcryptjs';

import { generateId, validateUsername } from '../utils/helpers.js';
import { appConfig } from '../config/index.js';
import logger from '../utils/logger.js';

// Redis imports (dynamically loaded)
let RedisStore = null;
let redisInstance = null;

const ACCOUNT_FILE_VERSION = 1;
const REDIS_ACCOUNTS_NS = 'accounts';
const REDIS_SESSIONS_NS = 'sessions';
const REDIS_USERNAME_INDEX = 'username_index';

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
    this.sessionStorePath = options.sessionStorePath || appConfig.storage.sessionStorePath;
    this.sessionTtlMs = options.sessionTtlMs || appConfig.storage.accountSessionTtlMs;
    this.saltRounds = options.saltRounds || 10;

    this._pendingPersist = null;
    this._pendingSessionPersist = null;
    this._useRedis = false;
    this._redisInitialized = false;

    // Try to initialize Redis if REDIS_URL is set
    this._initRedis();
    
    // Load from disk as fallback/initial data
    this.loadFromDisk();
    this.loadSessionsFromDisk();
  }

  async _initRedis() {
    if (!appConfig.storage.redisUrl) {
      logger.info('[AccountManager] No REDIS_URL configured, using file storage');
      return;
    }

    try {
      // Dynamic import of Redis store
      const { getRedisStore } = await import('../storage/RedisStore.js');
      redisInstance = await getRedisStore();
      
      if (redisInstance && redisInstance.isConnected) {
        this._useRedis = true;
        this._redisInitialized = true;
        logger.info('[AccountManager] Connected to Redis for account storage');
        
        // Migrate existing file-based accounts to Redis
        await this._migrateToRedis();
      }
    } catch (error) {
      logger.warn(`[AccountManager] Redis not available, using file storage: ${error.message}`);
      this._useRedis = false;
    }
  }

  async _migrateToRedis() {
    if (!this._useRedis || !redisInstance) return;
    
    // Check if Redis already has accounts
    const existingIndex = await redisInstance.hgetall(REDIS_ACCOUNTS_NS, REDIS_USERNAME_INDEX);
    if (Object.keys(existingIndex).length > 0) {
      // Redis has data, load from Redis instead
      logger.info('[AccountManager] Loading accounts from Redis');
      await this._loadFromRedis();
      return;
    }

    // Migrate file accounts to Redis
    if (this.accounts.size > 0) {
      logger.info(`[AccountManager] Migrating ${this.accounts.size} accounts to Redis`);
      for (const account of this.accounts.values()) {
        await this._saveToRedis(account);
      }
      
      // Migrate active sessions to Redis
      if (this.sessions.size > 0) {
        logger.info(`[AccountManager] Migrating ${this.sessions.size} sessions to Redis`);
        for (const session of this.sessions.values()) {
          await this._saveSessionToRedis(session);
        }
      }

      logger.info('[AccountManager] Migration to Redis complete');
    }
  }

  async _loadFromRedis() {
    if (!this._useRedis || !redisInstance) return;

    try {
      const usernameIndex = await redisInstance.hgetall(REDIS_ACCOUNTS_NS, REDIS_USERNAME_INDEX);
      
      for (const accountId of Object.values(usernameIndex)) {
        const account = await redisInstance.get(REDIS_ACCOUNTS_NS, accountId);
        if (account) {
          this.accounts.set(account.id, account);

          // Load sessions for this account
          try {
            const tokens = await redisInstance.smembers(REDIS_SESSIONS_NS, `account:${account.id}`);
            if (tokens && Array.isArray(tokens)) {
              for (const token of tokens) {
                const session = await redisInstance.get(REDIS_SESSIONS_NS, token);
                if (session) {
                  // Verify session hasn't expired
                  if (!session.expiresAt || session.expiresAt > Date.now()) {
                    this.sessions.set(token, session);
                    if (!this.sessionsByAccount.has(account.id)) {
                      this.sessionsByAccount.set(account.id, new Set());
                    }
                    this.sessionsByAccount.get(account.id).add(token);
                  } else {
                    // Clean up expired session from Redis
                    await this._deleteSessionFromRedis(token, account.id);
                  }
                } else {
                   // Token exists in set but session object is gone (expired/deleted)
                   // Clean up set
                   await redisInstance.srem(REDIS_SESSIONS_NS, `account:${account.id}`, token);
                }
              }
            }
          } catch (err) {
            logger.warn(`[AccountManager] Failed to load sessions for account ${account.id}: ${err.message}`);
          }
        }
      }
      
      logger.info(`[AccountManager] Loaded ${this.accounts.size} account(s) and ${this.sessions.size} session(s) from Redis`);
    } catch (error) {
      logger.error(`[AccountManager] Failed to load from Redis: ${error.message}`);
    }
  }

  async _saveToRedis(account) {
    if (!this._useRedis || !redisInstance) return false;

    try {
      await redisInstance.set(REDIS_ACCOUNTS_NS, account.id, account);
      await redisInstance.hset(REDIS_ACCOUNTS_NS, REDIS_USERNAME_INDEX, account.username.toLowerCase(), account.id);
      return true;
    } catch (error) {
      logger.error(`[AccountManager] Failed to save to Redis: ${error.message}`);
      return false;
    }
  }

  async _deleteFromRedis(account) {
    if (!this._useRedis || !redisInstance) return false;

    try {
      await redisInstance.hdel(REDIS_ACCOUNTS_NS, REDIS_USERNAME_INDEX, account.username.toLowerCase());
      await redisInstance.delete(REDIS_ACCOUNTS_NS, account.id);
      return true;
    } catch (error) {
      logger.error(`[AccountManager] Failed to delete from Redis: ${error.message}`);
      return false;
    }
  }

  async _saveSessionToRedis(session) {
    if (!this._useRedis || !redisInstance) return false;

    try {
      const ttlSeconds = Math.floor(this.sessionTtlMs / 1000);
      await redisInstance.set(REDIS_SESSIONS_NS, session.token, session, ttlSeconds);
      await redisInstance.sadd(REDIS_SESSIONS_NS, `account:${session.accountId}`, session.token);
      return true;
    } catch (error) {
      logger.error(`[AccountManager] Failed to save session to Redis: ${error.message}`);
      return false;
    }
  }

  async _deleteSessionFromRedis(token, accountId) {
    if (!this._useRedis || !redisInstance) return false;

    try {
      await redisInstance.delete(REDIS_SESSIONS_NS, token);
      if (accountId) {
        await redisInstance.srem(REDIS_SESSIONS_NS, `account:${accountId}`, token);
      }
      return true;
    } catch (error) {
      logger.error(`[AccountManager] Failed to delete session from Redis: ${error.message}`);
      return false;
    }
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

  schedulePersist(account = null) {
    // If Redis is enabled and we have an account, save immediately to Redis
    if (this._useRedis && account) {
      this._saveToRedis(account).catch(err => {
        logger.error(`[AccountManager] Redis save failed: ${err.message}`);
      });
    }

    // Also persist to disk as backup
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

  loadSessionsFromDisk() {
    if (!this.sessionStorePath || !existsSync(this.sessionStorePath)) {
      return;
    }

    try {
      const raw = readFileSync(this.sessionStorePath, 'utf-8');
      if (!raw) return;

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sessions)) {
        logger.warn('[AccountManager] Invalid session store format');
        return;
      }

      const now = Date.now();
      let loadedCount = 0;
      let expiredCount = 0;

      parsed.sessions.forEach((session) => {
        if (!session || !session.token || !session.accountId || !session.expiresAt) {
          return;
        }

        if (session.expiresAt <= now) {
          expiredCount++;
          return;
        }

        // Verify account still exists
        if (!this.accounts.has(session.accountId)) {
          return;
        }

        this.sessions.set(session.token, session);
        
        if (!this.sessionsByAccount.has(session.accountId)) {
          this.sessionsByAccount.set(session.accountId, new Set());
        }
        this.sessionsByAccount.get(session.accountId).add(session.token);
        loadedCount++;
      });

      logger.info(`[AccountManager] Loaded ${loadedCount} session(s) (${expiredCount} expired pruned)`);
    } catch (error) {
      logger.error(`[AccountManager] Failed to load sessions: ${error.message}`);
    }
  }

  scheduleSessionPersist() {
    if (this._pendingSessionPersist) {
      clearTimeout(this._pendingSessionPersist);
    }

    this._pendingSessionPersist = setTimeout(() => {
      this.persistSessionsToDisk();
    }, 1000).unref?.();
  }

  persistSessionsToDisk() {
    this._pendingSessionPersist = null;

    try {
      if (!this.sessionStorePath) return;

      const payload = {
        version: 1,
        generatedAt: Date.now(),
        sessions: Array.from(this.sessions.values()),
      };

      const dir = dirname(this.sessionStorePath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(this.sessionStorePath, JSON.stringify(payload, null, 2));
    } catch (error) {
      logger.error(`[AccountManager] Failed to persist sessions: ${error.message}`);
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
    this.schedulePersist(account);

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

    // Also save to Redis if available
    this._saveSessionToRedis(session).catch(err => {
      logger.error(`[AccountManager] Failed to save session to Redis: ${err.message}`);
    });

    this.scheduleSessionPersist();

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

    // Also delete from Redis if available
    this._deleteSessionFromRedis(token, session.accountId).catch(err => {
      logger.error(`[AccountManager] Failed to delete session from Redis: ${err.message}`);
    });

    this.scheduleSessionPersist();

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
    this.schedulePersist(updatedAccount);

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
    this.schedulePersist(updatedAccount);

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
    this.schedulePersist(updatedAccount);

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
    this.schedulePersist(updatedAccount);

    logger.info('[AccountManager] Account enabled', { accountId });

    return this.sanitizeAccount(updatedAccount);
  }
}

const accountManager = new AccountManager();

export default accountManager;
