/**
 * Redis Message Store
 * Persistent message storage using Redis
 * 
 * NOTE: This store maintains an in-memory cache for synchronous access,
 * while persisting to Redis asynchronously.
 */

import { getRedisStore } from './RedisStore.js';
import logger from '../utils/logger.js';
import { appConfig } from '../config/index.js';

const NAMESPACE = 'messages';

export default class RedisMessageStore {
  constructor(options = {}) {
    this.redis = null;
    this.maxHistoryPerChannel = options.maxHistoryPerChannel || appConfig.messages.maxHistoryPerChannel || 100;
    this._initialized = false;
    // In-memory cache for synchronous access (required by MessageManager)
    this._cache = new Map();
    this._loadPromise = null;
  }

  async init() {
    if (this._initialized) return;
    
    try {
      this.redis = await getRedisStore();
      this._initialized = true;
      logger.info('[RedisMessageStore] Initialized');
      
      // Start loading existing messages into cache
      this._loadPromise = this._loadAllFromRedis();
    } catch (error) {
      logger.error(`[RedisMessageStore] Failed to initialize: ${error.message}`);
      throw error;
    }
  }

  async _loadAllFromRedis() {
    try {
      const channelIds = await this.redis.scan(NAMESPACE);
      for (const channelId of channelIds) {
        const messages = await this.redis.lrange(NAMESPACE, channelId, 0, -1);
        this._cache.set(channelId, messages || []);
      }
      logger.info(`[RedisMessageStore] Loaded ${channelIds.length} channels from Redis`);
    } catch (error) {
      logger.error(`[RedisMessageStore] Failed to load from Redis: ${error.message}`);
    }
  }

  async ensureInitialized() {
    if (!this._initialized) {
      await this.init();
    }
  }

  /**
   * Synchronous getHistory for MessageManager compatibility
   * Returns the cached history array (mutable)
   */
  getHistory(channelId) {
    if (!this._cache.has(channelId)) {
      this._cache.set(channelId, []);
    }
    return this._cache.get(channelId);
  }

  /**
   * Touch/update - persist to Redis asynchronously
   */
  touch(channelId) {
    // Persist the current cache to Redis asynchronously
    this._persistToRedis(channelId).catch(err => {
      logger.error(`[RedisMessageStore] Failed to persist: ${err.message}`);
    });
  }

  async _persistToRedis(channelId) {
    await this.ensureInitialized();
    
    const messages = this._cache.get(channelId) || [];
    
    try {
      // Clear and re-add all messages
      await this.redis.delete(NAMESPACE, channelId);
      for (const msg of messages) {
        await this.redis.rpush(NAMESPACE, channelId, msg);
      }
    } catch (error) {
      logger.error(`[RedisMessageStore] _persistToRedis error: ${error.message}`);
    }
  }

  /**
   * Add a message to a channel (async version)
   * Also updates the in-memory cache
   */
  async addMessage(channelId, message) {
    // Update cache immediately (sync)
    if (!this._cache.has(channelId)) {
      this._cache.set(channelId, []);
    }
    const cache = this._cache.get(channelId);
    cache.push(message);
    
    // Trim cache if needed
    if (cache.length > this.maxHistoryPerChannel) {
      cache.splice(0, cache.length - this.maxHistoryPerChannel);
    }
    
    await this.ensureInitialized();
    
    try {
      // Push message to the right (end) of the list
      await this.redis.rpush(NAMESPACE, channelId, message);
      
      // Trim to keep only the latest maxHistoryPerChannel messages
      const len = await this.redis.llen(NAMESPACE, channelId);
      if (len > this.maxHistoryPerChannel) {
        await this.redis.ltrim(NAMESPACE, channelId, -this.maxHistoryPerChannel, -1);
      }
      
      return true;
    } catch (error) {
      logger.error(`[RedisMessageStore] addMessage error: ${error.message}`);
      return false;
    }
  }

  /**
   * Get messages for a channel
   */
  async getMessages(channelId, limit = null) {
    await this.ensureInitialized();
    
    try {
      const effectiveLimit = limit || this.maxHistoryPerChannel;
      // Get the last N messages
      const messages = await this.redis.lrange(NAMESPACE, channelId, -effectiveLimit, -1);
      return messages;
    } catch (error) {
      logger.error(`[RedisMessageStore] getMessages error: ${error.message}`);
      return [];
    }
  }

  /**
   * Delete a specific message by ID
   */
  async deleteMessage(channelId, messageId) {
    await this.ensureInitialized();
    
    try {
      // Get all messages, filter out the one to delete, then replace
      const messages = await this.getMessages(channelId);
      const filtered = messages.filter(m => m.id !== messageId);
      
      if (filtered.length !== messages.length) {
        // Clear and re-add
        await this.redis.delete(NAMESPACE, channelId);
        for (const msg of filtered) {
          await this.redis.rpush(NAMESPACE, channelId, msg);
        }
        return true;
      }
      
      return false;
    } catch (error) {
      logger.error(`[RedisMessageStore] deleteMessage error: ${error.message}`);
      return false;
    }
  }

  /**
   * Clear all messages for a channel
   */
  async clearChannel(channelId) {
    // Clear cache
    this._cache.delete(channelId);
    
    await this.ensureInitialized();
    
    try {
      await this.redis.delete(NAMESPACE, channelId);
      return true;
    } catch (error) {
      logger.error(`[RedisMessageStore] clearChannel error: ${error.message}`);
      return false;
    }
  }

  /**
   * Synchronous delete channel (for MessageManager compatibility)
   */
  deleteChannel(channelId) {
    this._cache.delete(channelId);
    // Also clear from Redis async
    this.clearChannel(channelId).catch(err => {
      logger.error(`[RedisMessageStore] deleteChannel async error: ${err.message}`);
    });
  }

  /**
   * Get message count for a channel
   */
  async getMessageCount(channelId) {
    await this.ensureInitialized();
    
    try {
      return await this.redis.llen(NAMESPACE, channelId);
    } catch (error) {
      logger.error(`[RedisMessageStore] getMessageCount error: ${error.message}`);
      return 0;
    }
  }

  /**
   * Get all channel IDs that have messages
   */
  async getAllChannelIds() {
    await this.ensureInitialized();
    
    try {
      return await this.redis.scan(NAMESPACE);
    } catch (error) {
      logger.error(`[RedisMessageStore] getAllChannelIds error: ${error.message}`);
      return [];
    }
  }

  /**
   * Set full history for a channel (for MessageManager compatibility)
   */
  setHistory(channelId, messages) {
    this._cache.set(channelId, messages);
    // Persist to Redis async
    this._persistToRedis(channelId).catch(err => {
      logger.error(`[RedisMessageStore] setHistory persist error: ${err.message}`);
    });
  }

  /**
   * Enumerate channel IDs that have history (for MessageManager compatibility)
   */
  listChannels() {
    return Array.from(this._cache.keys());
  }

  /**
   * Total messages across all channels (for MessageManager compatibility)
   */
  countAllMessages() {
    let total = 0;
    for (const history of this._cache.values()) {
      total += history.length;
    }
    return total;
  }

  /**
   * Clear all messages (for MessageManager compatibility)
   */
  clearAll() {
    this._cache.clear();
    // Also clear from Redis async
    this._clearAllFromRedis().catch(err => {
      logger.error(`[RedisMessageStore] clearAll async error: ${err.message}`);
    });
  }

  async _clearAllFromRedis() {
    await this.ensureInitialized();
    
    try {
      const channelIds = await this.redis.scan(NAMESPACE);
      for (const channelId of channelIds) {
        await this.redis.delete(NAMESPACE, channelId);
      }
      logger.info(`[RedisMessageStore] Cleared all channels from Redis`);
    } catch (error) {
      logger.error(`[RedisMessageStore] _clearAllFromRedis error: ${error.message}`);
    }
  }
}
