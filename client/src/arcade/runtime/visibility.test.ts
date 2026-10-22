import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A Capacitor shell: the shared app-state listener comes from @capacitor/app.
let appState: ((state: { isActive: boolean }) => void) | null = null;
let appStateRemoved = 0;
vi.mock('@/lib/device', async (original) => ({ ...(await original<typeof import('@/lib/device')>()), isCapacitor: () => true }));
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: async (_event: string, cb: (state: { isActive: boolean }) => void) => {
      appState = cb;
      return {
        remove: async () => {
          appStateRemoved += 1;
          appState = null;
        },
      };
    },
  },
}));

import { arcadeSession } from '@/features/arcade/state';
import { createStageGate } from './session';
import { watchStageVisibility } from './visibility';

class FakeObserver {
  static last: FakeObserver | null = null;
  disconnected = false;
  constructor(readonly cb: IntersectionObserverCallback) {
    FakeObserver.last = this;
  }
  observe() {}
  disconnect() {
    this.disconnected = true;
  }
  fire(ratio: number) {
    this.cb([{ isIntersecting: ratio > 0, intersectionRatio: ratio } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

let docState: 'visible' | 'hidden' = 'visible';
let windowCb: ((visible: boolean) => void) | null = null;
let windowOff = 0;

beforeEach(() => {
  docState = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => docState });
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeObserver;
  (window as unknown as { desktopAPI: unknown }).desktopAPI = {
    onWindowVisibility: (cb: (visible: boolean) => void) => {
      windowCb = cb;
      return () => {
        windowOff += 1;
        windowCb = null;
      };
    },
  };
  arcadeSession.value = { game: 'fuseyard', id: 'local', role: 'player', mode: 'local', status: 'live', attention: false, minimized: false };
});

afterEach(() => {
  arcadeSession.value = null;
  delete (window as unknown as { desktopAPI?: unknown }).desktopAPI;
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('watchStageVisibility', () => {
  it('merges document, page, Capacitor, desktop window, on-screen and minimized into one flag', async () => {
    const stage = document.createElement('div');
    const seen: boolean[] = [];
    const stop = watchStageVisibility(stage, (v) => seen.push(v));
    await flush();
    expect(seen).toEqual([true]);

    docState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    docState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));

    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pageshow'));

    appState?.({ isActive: false });
    appState?.({ isActive: true });

    windowCb?.(false);
    windowCb?.(true);

    FakeObserver.last?.fire(0.05);
    FakeObserver.last?.fire(0.5);

    arcadeSession.value = { ...arcadeSession.value!, minimized: true };
    arcadeSession.value = { ...arcadeSession.value!, minimized: false };

    expect(seen).toEqual([true, false, true, false, true, false, true, false, true, false, true, false, true]);

    stop();
    await flush();
    expect(FakeObserver.last?.disconnected).toBe(true);
    expect(windowOff).toBe(1);
    expect(appStateRemoved).toBe(1);
    // Nothing reacts after stop.
    document.dispatchEvent(new Event('visibilitychange'));
    expect(seen).toHaveLength(13);
  });

  it('treats a visible stage without input for the idle time as hidden until the next input', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stage = document.createElement('div');
    const seen: boolean[] = [];
    const gate = createStageGate(stage, (v) => seen.push(v));
    gate.idleAway(600_000);
    vi.advanceTimersByTime(599_000);
    stage.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(599_000);
    expect(seen).toEqual([true]);
    vi.advanceTimersByTime(2_000);
    expect(seen).toEqual([true, false]);
    stage.dispatchEvent(new Event('keydown'));
    expect(seen).toEqual([true, false, true]);
    // Hidden pages do not count down; turning the rule off ends any idle state.
    gate.idleAway(null);
    vi.advanceTimersByTime(700_000);
    expect(seen).toEqual([true, false, true]);
    gate.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('starts hidden when the page is hidden and reports only changes', () => {
    docState = 'hidden';
    const seen: boolean[] = [];
    const stop = watchStageVisibility(document.createElement('div'), (v) => seen.push(v));
    FakeObserver.last?.fire(1);
    expect(seen).toEqual([false]);
    docState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(seen).toEqual([false, true]);
    stop();
  });
});
