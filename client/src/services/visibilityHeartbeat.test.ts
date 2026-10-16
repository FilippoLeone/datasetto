import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVisibilityHeartbeat, HEARTBEAT_INTERVAL_MS } from './visibilityHeartbeat';

/** A document stand-in whose visibility the test flips. */
const fakeDocument = () => {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => listeners.add(listener as () => void),
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => listeners.delete(listener as () => void),
    show() {
      this.visibilityState = 'visible';
      listeners.forEach((listener) => listener());
    },
    hide() {
      this.visibilityState = 'hidden';
      listeners.forEach((listener) => listener());
    },
    get listenerCount() {
      return listeners.size;
    },
  };
  return doc;
};

describe('visibility heartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports on start, repeats while visible and falls silent while hidden', () => {
    const doc = fakeDocument();
    const send = vi.fn();
    const heartbeat = createVisibilityHeartbeat({ send, doc, intervalMs: 1000 });
    expect(heartbeat.running).toBe(false);

    heartbeat.start();
    expect(heartbeat.running).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(true);

    vi.advanceTimersByTime(3000);
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls.every(([visible]) => visible === true)).toBe(true);

    // Switching tabs: one "hidden" report, then nothing until the page is back.
    doc.hide();
    expect(send).toHaveBeenCalledTimes(5);
    expect(send).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(10_000);
    expect(send).toHaveBeenCalledTimes(5);

    doc.show();
    expect(send).toHaveBeenCalledTimes(6);
    expect(send).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(2000);
    expect(send).toHaveBeenCalledTimes(8);
  });

  it('pulses the current state on demand and stops cleanly', () => {
    const doc = fakeDocument();
    doc.visibilityState = 'hidden';
    const send = vi.fn();
    const heartbeat = createVisibilityHeartbeat({ send, doc });

    // Not running: a pulse is ignored.
    heartbeat.pulse();
    expect(send).not.toHaveBeenCalled();

    heartbeat.start();
    heartbeat.start();
    expect(doc.listenerCount).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(false);

    heartbeat.pulse();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(false);

    doc.show();
    expect(send).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(4);

    heartbeat.stop();
    heartbeat.stop();
    expect(heartbeat.running).toBe(false);
    expect(doc.listenerCount).toBe(0);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    doc.hide();
    heartbeat.pulse();
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('observes the real document by default', () => {
    const send = vi.fn();
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      const heartbeat = createVisibilityHeartbeat({ send });
      heartbeat.start();
      expect(send).toHaveBeenLastCalledWith(false);
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(send).toHaveBeenLastCalledWith(true);
      heartbeat.stop();
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
      if (original) Object.defineProperty(Document.prototype, 'visibilityState', original);
    }
  });
});
