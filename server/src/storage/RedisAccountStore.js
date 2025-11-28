/**
 * Redis Account Store
 * Persistent account storage using Redis
 * Wraps account operations to store in Redis
 */

import { getRedisStore } from './RedisStore.js';
import logger from '../utils/logger.js';

const NAMESPACE = 'accounts';
const SESSIONS_NAMESPACE = 'sessions';
const USERNAME_INDEX = 'username_index';

export class RedisAccountStore {
  constructor() {
    this.redis = null;
    this._initialized = false;
  }

  async init() {
    if (this._initialized) return;
    
    try {
      this.redis = await getRedisStore();
      this._initialized = true;
      logger.info('[RedisAccountStore] Initialized');
    } catch (error) {
      logger.error(`[RedisAccountStore] Failed to initialize: ${error.message}`);
      throw error;
    }
  }

  async ensureInitialized() {
    if (!this._initialized) {
      await this.init();
    }
  }

  // ========== Account Operations ==========

  async saveAccount(account) {
    await this.ensureInitialized();
    
    // Store the account by ID
    await this.redis.set(NAMESPACE, account.id, account);
    
    // Index by username for quick lookup
    await this.redis.hset(NAMESPACE, USERNAME_INDEX, account.username.toLowerCase(), account.id);
    
    logger.debug(`[RedisAccountStore] Saved account: ${account.username}`);
    return account;
  }

  async getAccountById(accountId) {
    await this.ensureInitialized();
    return await this.redis.get(NAMESPACE, accountId);
  }

  async getAccountByUsername(username) {
    await this.ensureInitialized();
    
    // Look up account ID from username index
    const accountId = await this.redis.hget(NAMESPACE, USERNAME_INDEX, username.toLowerCase());
    if (!accountId) return null;
    
    return await this.getAccountById(accountId);
  }

  async deleteAccount(accountId) {
    await this.ensureInitialized();
    
    const account = await this.getAccountById(accountId);
    if (account) {
      // Remove from username index
      await this.redis.hdel(NAMESPACE, USERNAME_INDEX, account.username.toLowerCase());
      // Remove account
      await this.redis.delete(NAMESPACE, accountId);
      logger.info(`[RedisAccountStore] Deleted account: ${account.username}`);
    }
    return true;
  }

  async listAccounts() {
    await this.ensureInitialized();
    
    // Get all account IDs from the username index
    const usernameIndex = await this.redis.hgetall(NAMESPACE, USERNAME_INDEX);
    const accounts = [];
    
    for (const accountId of Object.values(usernameIndex)) {
      const account = await this.getAccountById(accountId);
      if (account) {
        accounts.push(account);
      }
    }
    
    return accounts;
  }

  async accountExists(username) {
    await this.ensureInitialized();
    return await this.redis.exists(NAMESPACE, username.toLowerCase());
  }

  // ========== Session Operations ==========

  async saveSession(token, sessionData, ttlSeconds = 86400) {
    await this.ensureInitialized();
    
    await this.redis.set(SESSIONS_NAMESPACE, token, sessionData, ttlSeconds);
    
    // Also track sessions by account ID
    if (sessionData.accountId) {
      await this.redis.sadd(SESSIONS_NAMESPACE, `account:${sessionData.accountId}`, token);
    }
    
    return true;
  }

  async getSession(token) {
    await this.ensureInitialized();
    return await this.redis.get(SESSIONS_NAMESPACE, token);
  }

  async deleteSession(token) {
    await this.ensureInitialized();
    
    const session = await this.getSession(token);
    if (session && session.accountId) {
      await this.redis.srem(SESSIONS_NAMESPACE, `account:${session.accountId}`, token);
    }
    
    await this.redis.delete(SESSIONS_NAMESPACE, token);
    return true;
  }

  async deleteAccountSessions(accountId) {
    await this.ensureInitialized();
    
    const tokens = await this.redis.smembers(SESSIONS_NAMESPACE, `account:${accountId}`);
    for (const token of tokens) {
      await this.redis.delete(SESSIONS_NAMESPACE, token);
    }
    await this.redis.delete(SESSIONS_NAMESPACE, `account:${accountId}`);
    
    return true;
  }

  async sessionExists(token) {
    await this.ensureInitialized();
    return await this.redis.exists(SESSIONS_NAMESPACE, token);
  }
}

// Singleton instance
let instance = null;

export async function getRedisAccountStore() {
  if (!instance) {
    instance = new RedisAccountStore();
    await instance.init();
  }
  return instance;
}

export default RedisAccountStore;
