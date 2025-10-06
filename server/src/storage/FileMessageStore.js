import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import MemoryMessageStore from './MemoryMessageStore.js';

/**
 * Memory-backed message store with optional JSON persistence.
 * Suitable for lightweight deployments where state should survive restarts.
 */
export default class FileMessageStore extends MemoryMessageStore {
  constructor(options = {}) {
    super();
    this.filePath = options.filePath;
    this.flushDebounceMs = Math.max(options.debounceMs ?? 500, 0);
    this._pendingFlush = null;

    if (!this.filePath) {
      throw new Error('FileMessageStore requires a filePath option');
    }

    this.loadFromDisk();

    // Persist whenever a history changes.
    this.on('changed', ({ channelId }) => {
      if (channelId) {
        this.scheduleFlush();
      }
    });
    this.on('clear', () => this.scheduleFlush(true));
  }

  loadFromDisk() {
    if (!existsSync(this.filePath)) {
      return;
    }

    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.channels)) {
        for (const channel of parsed.channels) {
          if (!channel || typeof channel.id !== 'string' || !Array.isArray(channel.messages)) continue;
          this.histories.set(channel.id, channel.messages.map((msg) => ({ ...msg })));
        }
      }
    } catch (error) {
      console.warn('[FileMessageStore] Failed to load message archive:', error);
    }
  }

  scheduleFlush(force = false) {
    if (this.flushDebounceMs === 0 || force) {
      this.flushToDisk();
      return;
    }

    if (this._pendingFlush) {
      clearTimeout(this._pendingFlush);
    }

    this._pendingFlush = setTimeout(() => {
      this.flushToDisk();
    }, this.flushDebounceMs).unref?.();
  }

  flushToDisk() {
    this._pendingFlush = null;
    try {
      const payload = {
        version: 1,
        generatedAt: Date.now(),
        channels: Array.from(this.histories.entries()).map(([channelId, messages]) => ({
          id: channelId,
          messages,
        })),
      };

      const dir = dirname(this.filePath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(payload));
    } catch (error) {
      console.error('[FileMessageStore] Failed to persist messages:', error);
    }
  }

  deleteChannel(channelId) {
    const removed = super.deleteChannel(channelId);
    if (removed) {
      this.scheduleFlush();
    }
    return removed;
  }

  clearAll() {
    super.clearAll();
    this.scheduleFlush(true);
  }
}
