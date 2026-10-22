import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVisibilityHeartbeat, HEARTBEAT_INTERVAL_MS } from './visibilityHeartbeat';
import type { AppVisibility } from './native/appVisibility';

/** A visibility source the test flips (the app visibility merger in the app). */
const fakeSource = () => {
  const listeners = new Set<(visible: boolean) => void>();
  let visible = true;
  const set = (next: boolean) => {
    visible = next;
    listeners.forEach((listener) => listener(next));
  };
  const source: AppVisibility & { show(): void; hide(): void; readonly listenerCount: number; visible: boolean } = {
    get visible() {
      return visible;
    },
    set visible(next: boolean) {
      visible = next;
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    show: () => set(true),
    hide: () => set(false),
    get listenerCount() {
      return listeners.size;
    },
  };
  return source;
};

describe('visibility heartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports on start, repeats while visible and falls silent while hidden', () => {
    const source = fakeSource();
    const send = vi.fn();
    const heartbeat = createVisibilityHeartbeat({ send, source, intervalMs: 1000 });
    expect(heartbeat.running).toBe(false);

    heartbeat.start();
    expect(heartbeat.running).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(true);

    vi.advanceTimersByTime(3000);
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls.every(([visible]) => visible === true)).toBe(true);

    // Switching tabs or minimizing the desktop window: one "hidden" report, then nothing until it is back.
    source.hide();
    expect(send).toHaveBeenCalledTimes(5);
    expect(send).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(10_000);
    expect(send).toHaveBeenCalledTimes(5);

    source.show();
    expect(send).toHaveBeenCalledTimes(6);
    expect(send).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(2000);
    expect(send).toHaveBeenCalledTimes(8);
  });

  it('pulses the current state on demand and stops cleanly', () => {
    const source = fakeSource();
    source.visible = false;
    const send = vi.fn();
    const heartbeat = createVisibilityHeartbeat({ send, source });

    // Not running: a pulse is ignored.
    heartbeat.pulse();
    expect(send).not.toHaveBeenCalled();

    heartbeat.start();
    heartbeat.start();
    expect(source.listenerCount).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(false);

    heartbeat.pulse();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(false);

    source.show();
    expect(send).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(4);

    heartbeat.stop();
    heartbeat.stop();
    expect(heartbeat.running).toBe(false);
    expect(source.listenerCount).toBe(0);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    source.hide();
    heartbeat.pulse();
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('uses the app visibility by default: the document and a minimized desktop window', async () => {
    vi.resetModules();
    const handlers = new Set<(visible: boolean) => void>();
    window.desktopAPI = {
      onWindowVisibility: (cb: (visible: boolean) => void) => {
        handlers.add(cb);
        return () => handlers.delete(cb);
      },
    } as unknown as NonNullable<Window['desktopAPI']>;
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    try {
      const { createVisibilityHeartbeat: create } = await import('./visibilityHeartbeat');
      const send = vi.fn();
      const heartbeat = create({ send });
      heartbeat.start();
      expect(send).toHaveBeenLastCalledWith(true);

      handlers.forEach((cb) => cb(false)); // minimized
      expect(send).toHaveBeenLastCalledWith(false);
      handlers.forEach((cb) => cb(true)); // restored
      expect(send).toHaveBeenLastCalledWith(true);

      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(send).toHaveBeenLastCalledWith(false);
      expect(send).toHaveBeenCalledTimes(4);
      heartbeat.stop();
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
      if (original) Object.defineProperty(Document.prototype, 'visibilityState', original);
      delete window.desktopAPI;
    }
  });
});
