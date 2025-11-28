/**
 * Redis Message Store
 * Persistent message storage using Redis
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
  }

  async init() {
    if (this._initialized) return;
    
    try {
      this.redis = await getRedisStore();
      this._initialized = true;
      logger.info('[RedisMessageStore] Initialized');
    } catch (error) {
      logger.error(`[RedisMessageStore] Failed to initialize: ${error.message}`);
      throw error;
    }
  }

  async ensureInitialized() {
    if (!this._initialized) {
      await this.init();
    }
  }

  /**
   * Add a message to a channel
   */
  async addMessage(channelId, message) {
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
}
