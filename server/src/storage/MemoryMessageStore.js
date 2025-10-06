import { EventEmitter } from 'events';

/**
 * Simple in-memory message store.
 * Provides mutation hooks so higher level managers can persist elsewhere if desired.
 */
export default class MemoryMessageStore extends EventEmitter {
  constructor() {
    super();
    this.histories = new Map();
  }

  /**
   * Retrieve the mutable history array for a channel. Creates it if missing.
   */
  getHistory(channelId) {
    if (!this.histories.has(channelId)) {
      this.histories.set(channelId, []);
    }
    return this.histories.get(channelId);
  }

  /**
   * Replace channel history entirely (used for migrations or reloads).
   */
  setHistory(channelId, messages) {
    this.histories.set(channelId, Array.isArray(messages) ? messages : []);
    this.touch(channelId);
  }

  /**
   * Remove all history for a channel.
   */
  deleteChannel(channelId) {
    const removed = this.histories.delete(channelId);
    if (removed) {
      this.touch(channelId);
    }
    return removed;
  }

  /**
   * Clear all message histories.
   */
  clearAll() {
    if (this.histories.size === 0) return;
    this.histories.clear();
    this.emit('clear');
  }

  /**
   * Enumerate channel IDs that have history.
   */
  listChannels() {
    return Array.from(this.histories.keys());
  }

  /**
   * Total messages across all channels.
   */
  countAllMessages() {
    let total = 0;
    for (const history of this.histories.values()) {
      total += history.length;
    }
    return total;
  }

  /**
   * Hook called whenever a history mutates. Base implementation emits an event.
   */
  touch(channelId) {
    this.emit('changed', { channelId });
  }
}
