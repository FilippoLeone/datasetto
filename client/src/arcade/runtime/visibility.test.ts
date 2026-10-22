import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The app's merged visibility (document, page, Capacitor, desktop window) is the phase 0 module,
// tested in services/native/appVisibility.test.ts. Here it is a switch, and the stage adds being
// on screen, not minimized and not idle.
const app = vi.hoisted(() => {
  const listeners = new Set<(visible: boolean) => void>();
  return {
    visible: true,
    listeners,
    set(next: boolean) {
      this.visible = next;
      for (const cb of [...listeners]) cb(next);
    },
  };
});
vi.mock('@/services/native/appVisibility', () => ({
  appVisibility: {
    get visible() {
      return app.visible;
    },
    subscribe(cb: (visible: boolean) => void) {
      app.listeners.add(cb);
      return () => app.listeners.delete(cb);
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

beforeEach(() => {
  app.visible = true;
  app.listeners.clear();
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeObserver;
  arcadeSession.value = { game: 'fuseyard', id: 'local', role: 'player', mode: 'local', status: 'live', attention: false, minimized: false };
});

afterEach(() => {
  arcadeSession.value = null;
});

describe('watchStageVisibility', () => {
  it('merges app visibility, being on screen (10 %) and not minimized into one flag, and stops cleanly', () => {
    const stage = document.createElement('div');
    const seen: boolean[] = [];
    const stop = watchStageVisibility(stage, (v) => seen.push(v));
    expect(seen).toEqual([true]);

    app.set(false);
    app.set(true);

    FakeObserver.last?.fire(0.05);
    FakeObserver.last?.fire(0.5);

    arcadeSession.value = { ...arcadeSession.value!, minimized: true };
    arcadeSession.value = { ...arcadeSession.value!, minimized: false };

    expect(seen).toEqual([true, false, true, false, true, false, true]);

    stop();
    expect(FakeObserver.last?.disconnected).toBe(true);
    expect(app.listeners.size).toBe(0);
    // Nothing reacts after stop.
    app.set(false);
    expect(seen).toHaveLength(7);
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

  it('starts hidden when the app is hidden and reports only changes', () => {
    app.visible = false;
    const seen: boolean[] = [];
    const stop = watchStageVisibility(document.createElement('div'), (v) => seen.push(v));
    FakeObserver.last?.fire(1);
    expect(seen).toEqual([false]);
    app.set(true);
    expect(seen).toEqual([false, true]);
    stop();
  });
});
