/**
 * Message Manager
 * Handles chat messages and history
 */

import { validateMessage } from '../utils/helpers.js';
import { appConfig } from '../config/index.js';
import logger from '../utils/logger.js';
import { messageStore } from '../storage/index.js';

export class MessageManager {
  constructor(store = messageStore) {
    this.store = store;
    this.messageRateLimits = new Map();
  }

  /**
   * Create a new message
   */
  createMessage(channelId, userId, userName, text, userRoles = [], isSuperuser = false) {
    try {
      // Validate message
      const validation = validateMessage(text);
      if (!validation.valid) {
        throw new Error(validation.error);
      }

      const message = {
        id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        channelId,
        from: userName,
        fromId: userId,
        text: validation.value,
        ts: Date.now(),
        roles: userRoles,
        isSuperuser,
        edited: false,
        deleted: false,
      };

      // Store in history
      this.addToHistory(channelId, message);

      logger.debug(`Message created in channel ${channelId}`, { messageId: message.id, userId });
      return message;
    } catch (error) {
      logger.error(`Failed to create message: ${error.message}`);
      throw error;
    }
  }

  /**
   * Add message to channel history
   */
  addToHistory(channelId, message) {
    const history = this.store.getHistory(channelId);
    history.push(message);

    // Keep only last N messages
    const maxMessages = appConfig.messages.maxHistoryPerChannel;
    if (history.length > maxMessages) {
      history.splice(0, history.length - maxMessages);
    }

    this.store.touch(channelId);
  }

  /**
   * Get message history for a channel
   */
  getHistory(channelId, limit = null) {
    const history = this.store.getHistory(channelId) || [];
    
    if (limit && limit > 0) {
      return history.slice(-limit);
    }

    return history;
  }

  /**
   * Get recent messages (last N messages)
   */
  getRecentMessages(channelId, count = 50) {
    return this.getHistory(channelId, count);
  }

  /**
   * Get message by ID
   */
  getMessage(channelId, messageId) {
    const history = this.store.getHistory(channelId) || [];
    return history.find(msg => msg.id === messageId);
  }

  /**
   * Edit a message
   */
  editMessage(channelId, messageId, newText, userId) {
    const message = this.getMessage(channelId, messageId);
    if (!message) {
      throw new Error('Message not found');
    }

    // Check if user owns the message
    if (message.fromId !== userId) {
      throw new Error('You can only edit your own messages');
    }

    // Validate new text
    const validation = validateMessage(newText);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    message.text = validation.value;
    message.edited = true;
    message.editedAt = Date.now();

    this.store.touch(channelId);

    logger.debug(`Message edited`, { channelId, messageId, userId });
    return message;
  }

  /**
   * Delete a message
   */
  deleteMessage(channelId, messageId, deletedBy) {
    const history = this.store.getHistory(channelId);
    if (!history) {
      throw new Error('Channel not found');
    }

    const messageIndex = history.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1) {
      throw new Error('Message not found');
    }

    const message = history[messageIndex];
    message.deleted = true;
    message.deletedBy = deletedBy;
    message.deletedAt = Date.now();

    this.store.touch(channelId);

    logger.debug(`Message deleted`, { channelId, messageId, deletedBy });
    return message;
  }

  /**
   * Permanently remove a message
   */
  removeMessage(channelId, messageId) {
    const history = this.store.getHistory(channelId);
    if (!history) {
      return false;
    }

    const messageIndex = history.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1) {
      return false;
    }

    history.splice(messageIndex, 1);
    this.store.touch(channelId);
    logger.debug(`Message permanently removed`, { channelId, messageId });
    return true;
  }

  // Rate limiting removed - handled by Cloudflare

  /**
   * Clear channel history
   */
  clearHistory(channelId) {
    const history = this.store.getHistory(channelId);
    if (!history || history.length === 0) {
      return 0;
    }

    const count = history.length;
    this.store.deleteChannel(channelId);
    logger.info(`Cleared ${count} messages from channel ${channelId}`);
    return count;
  }

  /**
   * Get message count for channel
   */
  getMessageCount(channelId) {
    const history = this.store.getHistory(channelId) || [];
    return history.length;
  }

  /**
   * Get total message count across all channels
   */
  getTotalMessageCount() {
    return this.store.countAllMessages();
  }

  /**
   * Get message statistics
   */
  getStatistics() {
    const channelIds = this.store.listChannels();
    const channels = channelIds.length;
    const totalMessages = this.getTotalMessageCount();
    const activeRateLimits = this.messageRateLimits.size;

    let oldestMessage = null;
    let newestMessage = null;

    for (const channelId of channelIds) {
      const history = this.store.getHistory(channelId) || [];
      if (history.length > 0) {
        const first = history[0];
        const last = history[history.length - 1];

        if (!oldestMessage || first.ts < oldestMessage.ts) {
          oldestMessage = first;
        }
        if (!newestMessage || last.ts > newestMessage.ts) {
          newestMessage = last;
        }
      }
    }

    return {
      channels,
      totalMessages,
      activeRateLimits,
      oldestMessageTime: oldestMessage?.ts || null,
      newestMessageTime: newestMessage?.ts || null,
    };
  }

  /**
   * Search messages
   */
  searchMessages(channelId, query, limit = 50) {
    const history = this.store.getHistory(channelId) || [];
    const lowerQuery = query.toLowerCase();

    return history
      .filter(msg => 
        !msg.deleted &&
        msg.text.toLowerCase().includes(lowerQuery)
      )
      .slice(-limit);
  }

  /**
   * Get messages from user
   */
  getMessagesByUser(channelId, userId, limit = 50) {
    const history = this.store.getHistory(channelId) || [];

    return history
      .filter(msg => msg.fromId === userId && !msg.deleted)
      .slice(-limit);
  }

  /**
   * Export message data
   */
  exportMessages(channelId) {
    const history = this.store.getHistory(channelId) || [];
    return history.filter(msg => !msg.deleted);
  }

  /**
   * Clear all data (for testing)
   */
  clear() {
    this.store.clearAll();
    this.messageRateLimits.clear();
    logger.warn('All message data cleared');
  }
}

export default new MessageManager();
