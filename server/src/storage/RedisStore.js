/**
 * Redis Store
 * Persistent storage adapter using Redis
 * Provides key-value storage for accounts, messages, and other data
 */

import { createClient } from 'redis';
import logger from '../utils/logger.js';

export class RedisStore {
  constructor(options = {}) {
    this.url = options.url || process.env.REDIS_URL || 'redis://localhost:6379';
    this.prefix = options.prefix || 'datasetto:';
    this.client = null;
    this.isConnected = false;
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 10;
  }

  async connect() {
    if (this.isConnected && this.client) {
      return this.client;
    }

    try {
      this.client = createClient({
        url: this.url,
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > this._maxReconnectAttempts) {
              logger.error('[RedisStore] Max reconnection attempts reached');
              return new Error('Max reconnection attempts reached');
            }
            // Exponential backoff: 100ms, 200ms, 400ms, ... up to 30s
            return Math.min(retries * 100, 30000);
          },
        },
      });

      this.client.on('error', (err) => {
        logger.error(`[RedisStore] Connection error: ${err.message}`);
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        logger.info('[RedisStore] Connected to Redis');
        this.isConnected = true;
        this._reconnectAttempts = 0;
      });

      this.client.on('reconnecting', () => {
        this._reconnectAttempts++;
        logger.warn(`[RedisStore] Reconnecting... (attempt ${this._reconnectAttempts})`);
      });

      await this.client.connect();
      return this.client;
    } catch (error) {
      logger.error(`[RedisStore] Failed to connect: ${error.message}`);
      throw error;
    }
  }

  async disconnect() {
    if (this.client && this.isConnected) {
      await this.client.quit();
      this.isConnected = false;
      this.client = null;
    }
  }

  _key(namespace, key) {
    return `${this.prefix}${namespace}:${key}`;
  }

  // ========== Generic Key-Value Operations ==========

  async get(namespace, key) {
    if (!this.isConnected) return null;
    try {
      const value = await this.client.get(this._key(namespace, key));
      return value ? JSON.parse(value) : null;
    } catch (error) {
      logger.error(`[RedisStore] get error: ${error.message}`);
      return null;
    }
  }

  async set(namespace, key, value, ttlSeconds = null) {
    if (!this.isConnected) return false;
    try {
      const serialized = JSON.stringify(value);
      if (ttlSeconds) {
        await this.client.setEx(this._key(namespace, key), ttlSeconds, serialized);
      } else {
        await this.client.set(this._key(namespace, key), serialized);
      }
      return true;
    } catch (error) {
      logger.error(`[RedisStore] set error: ${error.message}`);
      return false;
    }
  }

  async delete(namespace, key) {
    if (!this.isConnected) return false;
    try {
      await this.client.del(this._key(namespace, key));
      return true;
    } catch (error) {
      logger.error(`[RedisStore] delete error: ${error.message}`);
      return false;
    }
  }

  async exists(namespace, key) {
    if (!this.isConnected) return false;
    try {
      return (await this.client.exists(this._key(namespace, key))) === 1;
    } catch (error) {
      logger.error(`[RedisStore] exists error: ${error.message}`);
      return false;
    }
  }

  // ========== Hash Operations (for storing objects) ==========

  async hget(namespace, key, field) {
    if (!this.isConnected) return null;
    try {
      const value = await this.client.hGet(this._key(namespace, key), field);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      logger.error(`[RedisStore] hget error: ${error.message}`);
      return null;
    }
  }

  async hset(namespace, key, field, value) {
    if (!this.isConnected) return false;
    try {
      await this.client.hSet(this._key(namespace, key), field, JSON.stringify(value));
      return true;
    } catch (error) {
      logger.error(`[RedisStore] hset error: ${error.message}`);
      return false;
    }
  }

  async hgetall(namespace, key) {
    if (!this.isConnected) return {};
    try {
      const data = await this.client.hGetAll(this._key(namespace, key));
      const result = {};
      for (const [field, value] of Object.entries(data)) {
        try {
          result[field] = JSON.parse(value);
        } catch {
          result[field] = value;
        }
      }
      return result;
    } catch (error) {
      logger.error(`[RedisStore] hgetall error: ${error.message}`);
      return {};
    }
  }

  async hdel(namespace, key, field) {
    if (!this.isConnected) return false;
    try {
      await this.client.hDel(this._key(namespace, key), field);
      return true;
    } catch (error) {
      logger.error(`[RedisStore] hdel error: ${error.message}`);
      return false;
    }
  }

  // ========== List Operations (for messages, logs) ==========

  async lpush(namespace, key, value) {
    if (!this.isConnected) return false;
    try {
      await this.client.lPush(this._key(namespace, key), JSON.stringify(value));
      return true;
    } catch (error) {
      logger.error(`[RedisStore] lpush error: ${error.message}`);
      return false;
    }
  }

  async rpush(namespace, key, value) {
    if (!this.isConnected) return false;
    try {
      await this.client.rPush(this._key(namespace, key), JSON.stringify(value));
      return true;
    } catch (error) {
      logger.error(`[RedisStore] rpush error: ${error.message}`);
      return false;
    }
  }

  async lrange(namespace, key, start = 0, stop = -1) {
    if (!this.isConnected) return [];
    try {
      const items = await this.client.lRange(this._key(namespace, key), start, stop);
      return items.map((item) => {
        try {
          return JSON.parse(item);
        } catch {
          return item;
        }
      });
    } catch (error) {
      logger.error(`[RedisStore] lrange error: ${error.message}`);
      return [];
    }
  }

  async ltrim(namespace, key, start, stop) {
    if (!this.isConnected) return false;
    try {
      await this.client.lTrim(this._key(namespace, key), start, stop);
      return true;
    } catch (error) {
      logger.error(`[RedisStore] ltrim error: ${error.message}`);
      return false;
    }
  }

  async llen(namespace, key) {
    if (!this.isConnected) return 0;
    try {
      return await this.client.lLen(this._key(namespace, key));
    } catch (error) {
      logger.error(`[RedisStore] llen error: ${error.message}`);
      return 0;
    }
  }

  // ========== Set Operations ==========

  async sadd(namespace, key, ...members) {
    if (!this.isConnected) return false;
    try {
      await this.client.sAdd(this._key(namespace, key), members);
      return true;
    } catch (error) {
      logger.error(`[RedisStore] sadd error: ${error.message}`);
      return false;
    }
  }

  async srem(namespace, key, ...members) {
    if (!this.isConnected) return false;
    try {
      await this.client.sRem(this._key(namespace, key), members);
      return true;
    } catch (error) {
      logger.error(`[RedisStore] srem error: ${error.message}`);
      return false;
    }
  }

  async smembers(namespace, key) {
    if (!this.isConnected) return [];
    try {
      return await this.client.sMembers(this._key(namespace, key));
    } catch (error) {
      logger.error(`[RedisStore] smembers error: ${error.message}`);
      return [];
    }
  }

  async sismember(namespace, key, member) {
    if (!this.isConnected) return false;
    try {
      return await this.client.sIsMember(this._key(namespace, key), member);
    } catch (error) {
      logger.error(`[RedisStore] sismember error: ${error.message}`);
      return false;
    }
  }

  // ========== Scan for keys matching pattern ==========

  async scan(namespace, pattern = '*') {
    if (!this.isConnected) return [];
    try {
      const keys = [];
      const fullPattern = `${this.prefix}${namespace}:${pattern}`;
      
      for await (const key of this.client.scanIterator({ MATCH: fullPattern })) {
        // Remove prefix from key
        keys.push(key.replace(`${this.prefix}${namespace}:`, ''));
      }
      return keys;
    } catch (error) {
      logger.error(`[RedisStore] scan error: ${error.message}`);
      return [];
    }
  }

  // ========== Sorted Set Operations (for leaderboards) ==========

  async zadd(namespace, key, score, member) {
    if (!this.isConnected) return false;
    try {
      await this.client.zAdd(this._key(namespace, key), { score, value: member });
      return true;
    } catch (error) {
      logger.error(`[RedisStore] zadd error: ${error.message}`);
      return false;
    }
  }

  async zrevrange(namespace, key, start, stop, withScores = false) {
    if (!this.isConnected) return [];
    try {
      // Redis v4 syntax for zRange with REV
      // zRange(key, min, max, { REV: true, BY: 'RANK' }) is equivalent to ZREVRANGE
      // But simpler: client.zRange(key, start, stop, { REV: true })
      // Note: Redis node client v4 changed zRevRange to zRange with options
      
      // Check if we are using node-redis v4
      if (this.client.zRange) {
         // For node-redis v4
         const options = { REV: true };
         if (withScores) {
             // In v4, withScores returns objects { value, score }
             const results = await this.client.zRangeWithScores(this._key(namespace, key), start, stop, options);
             return results; 
         }
         return await this.client.zRange(this._key(namespace, key), start, stop, options);
      } else {
         // Fallback for older clients if any (unlikely given package.json)
         // But package.json says redis ^4.7.0
         if (withScores) {
             return await this.client.zRevRangeWithScores(this._key(namespace, key), start, stop);
         }
         return await this.client.zRevRange(this._key(namespace, key), start, stop);
      }
    } catch (error) {
      logger.error(`[RedisStore] zrevrange error: ${error.message}`);
      return [];
    }
  }

  async zscore(namespace, key, member) {
    if (!this.isConnected) return null;
    try {
      return await this.client.zScore(this._key(namespace, key), member);
    } catch (error) {
      logger.error(`[RedisStore] zscore error: ${error.message}`);
      return null;
    }
  }

  // ========== Utility ==========

  async ping() {
    if (!this.isConnected) return false;
    try {
      const response = await this.client.ping();
      return response === 'PONG';
    } catch (error) {
      return false;
    }
  }

  async flushNamespace(namespace) {
    if (!this.isConnected) return false;
    try {
      const keys = await this.scan(namespace);
      if (keys.length > 0) {
        const fullKeys = keys.map((k) => this._key(namespace, k));
        await this.client.del(fullKeys);
      }
      return true;
    } catch (error) {
      logger.error(`[RedisStore] flushNamespace error: ${error.message}`);
      return false;
    }
  }
}

// Singleton instance
let redisStore = null;

export async function getRedisStore() {
  if (!redisStore) {
    redisStore = new RedisStore();
    await redisStore.connect();
  }
  return redisStore;
}

export default RedisStore;
