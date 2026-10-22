import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFrames, frames, type FrameEnv } from './frames';

/**
 * A simulated display: vsyncs every 1000/hz ms, rAF callbacks run on the next
 * vsync with its timestamp, timers fire at their time. Counts every rAF and
 * timer the scheduler asks for.
 */
function fakeDisplay(hz: number) {
  const period = 1000 / hz;
  let clock = 0;
  let nextVsync = period;
  let nextId = 1;
  let paused = false;
  const frameCbs = new Map<number, (now: number) => void>();
  const timers = new Map<number, { at: number; cb: () => void }>();
  const stats = { rafCalls: 0, timerCalls: 0, errors: [] as unknown[] };

  const env: FrameEnv = {
    requestFrame(cb) {
      stats.rafCalls += 1;
      const id = nextId++;
      frameCbs.set(id, cb);
      return id;
    },
    cancelFrame: (id) => void frameCbs.delete(id),
    setTimer(cb, ms) {
      stats.timerCalls += 1;
      const id = nextId++;
      timers.set(id, { at: clock + Math.max(0, ms), cb });
      return id;
    },
    clearTimer: (id) => void timers.delete(id as number),
    now: () => clock,
  };

  const run = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      stats.errors.push(err);
    }
  };

  /** Runs every vsync and timer up to `ms` from now. */
  const advance = (ms: number) => {
    const end = clock + ms;
    for (;;) {
      let timer: [number, { at: number; cb: () => void }] | null = null;
      for (const entry of timers) if (!timer || entry[1].at < timer[1].at) timer = entry;
      const vsync = paused ? Infinity : nextVsync;
      const next = Math.min(vsync, timer ? timer[1].at : Infinity);
      if (next > end) break;
      clock = next;
      if (timer && timer[1].at === next) {
        timers.delete(timer[0]);
        run(timer[1].cb);
        continue;
      }
      nextVsync += period;
      const batch = [...frameCbs.values()];
      frameCbs.clear();
      for (const cb of batch) run(() => cb(clock));
    }
    clock = end;
    while (nextVsync <= clock) nextVsync += period;
  };

  return {
    env,
    stats,
    advance,
    pending: () => frameCbs.size + timers.size,
    pendingFrames: () => frameCbs.size,
    pendingTimers: () => timers.size,
    pause: (on: boolean) => void (paused = on),
  };
}

describe('frames', () => {
  it('schedules no rAF and no timer while nothing is subscribed', () => {
    const display = fakeDisplay(240);
    const f = createFrames(display.env);
    expect(f.active).toBe(0);
    display.advance(1000);
    expect(display.stats.rafCalls + display.stats.timerCalls).toBe(0);

    const off = f.add(() => undefined);
    expect(f.active).toBe(1);
    expect(display.pending()).toBe(1);
    off();
    off(); // a second call is harmless
    expect(f.active).toBe(0);
    expect(display.pending()).toBe(0);

    const slow = f.add(() => undefined, { maxFps: 10 });
    display.advance(250);
    slow();
    expect(display.pending()).toBe(0);
    expect(f.snapshot().mode).toBe('idle');
  });

  it('runs once callbacks on the next frame with its timestamp, then goes idle', () => {
    const display = fakeDisplay(60);
    const f = createFrames(display.env);
    const seen: number[] = [];
    f.once((now) => seen.push(now));
    f.once((now) => seen.push(now));
    expect(f.active).toBe(2);
    display.advance(20);
    expect(seen).toEqual([1000 / 60, 1000 / 60]);
    expect(f.active).toBe(0);
    expect(display.pending()).toBe(0);
    expect(display.stats.rafCalls).toBe(1);
  });

  it('caps a 60 fps subscriber at 60 callbacks a second on a 240 Hz display', () => {
    const display = fakeDisplay(240);
    const f = createFrames(display.env);
    const dts: number[] = [];
    f.add((_now, dt) => dts.push(dt), { maxFps: 60 });
    display.advance(1000);
    expect(dts.length).toBeGreaterThanOrEqual(59);
    expect(dts.length).toBeLessThanOrEqual(61);
    expect(dts[0]).toBe(0);
    for (const dt of dts.slice(1)) expect(dt).toBeCloseTo(1000 / 60, 5);
  });

  it('keeps a 60 fps average on a 144 Hz display', () => {
    const display = fakeDisplay(144);
    const f = createFrames(display.env);
    let calls = 0;
    f.add(() => calls++, { maxFps: 60 });
    display.advance(1000);
    expect(calls).toBeGreaterThanOrEqual(58);
    expect(calls).toBeLessThanOrEqual(61);
  });

  it('runs an uncapped subscriber on every display frame', () => {
    const display = fakeDisplay(240);
    const f = createFrames(display.env);
    let calls = 0;
    f.add(() => calls++);
    display.advance(1000);
    expect(calls).toBeGreaterThanOrEqual(239);
    expect(calls).toBeLessThanOrEqual(240);
    expect(display.stats.timerCalls).toBe(0);
  });

  it('does not burst after a stall', () => {
    const display = fakeDisplay(240);
    const f = createFrames(display.env);
    let calls = 0;
    f.add(() => calls++, { maxFps: 60 });
    display.advance(100);
    display.pause(true); // a hidden tab: no frames for half a second
    display.advance(500);
    display.pause(false);
    calls = 0;
    display.advance(100);
    expect(calls).toBeLessThanOrEqual(7);
  });

  it('sleeps on a timer in low-rate mode: at most maxFps + 1 rAF calls a second', () => {
    const display = fakeDisplay(240);
    const f = createFrames(display.env);
    let calls = 0;
    f.add(() => calls++, { maxFps: 10, label: 'gamepad' });
    display.advance(1000);
    expect(calls).toBeGreaterThanOrEqual(9);
    expect(calls).toBeLessThanOrEqual(11);
    expect(display.stats.rafCalls).toBeLessThanOrEqual(11);
    expect(display.stats.timerCalls).toBeGreaterThan(0);
    expect(f.snapshot().mode).toBe('timer');
    expect(display.pendingFrames()).toBe(0);
  });

  it('runs several low-rate subscribers at their own rates', () => {
    const display = fakeDisplay(240);
    const f = createFrames(display.env);
    let ten = 0;
    let fifteen = 0;
    f.add(() => ten++, { maxFps: 10 });
    f.add(() => fifteen++, { maxFps: 15 });
    display.advance(1000);
    expect(ten).toBeGreaterThanOrEqual(9);
    expect(ten).toBeLessThanOrEqual(11);
    expect(fifteen).toBeGreaterThanOrEqual(14);
    expect(fifteen).toBeLessThanOrEqual(16);
    expect(display.stats.rafCalls).toBeLessThanOrEqual(27);
  });

  it('leaves low-rate mode while a fast subscriber exists, and returns to it', () => {
    const display = fakeDisplay(240);
    const f = createFrames(display.env);
    let slow = 0;
    f.add(() => slow++, { maxFps: 10 });
    const fast = f.add(() => undefined, { maxFps: 60 });
    display.advance(1000);
    expect(display.stats.rafCalls).toBeGreaterThan(200); // a rAF every display frame
    expect(slow).toBeGreaterThanOrEqual(9);
    expect(slow).toBeLessThanOrEqual(11);

    fast();
    display.stats.rafCalls = 0;
    slow = 0;
    display.advance(1000);
    expect(display.stats.rafCalls).toBeLessThanOrEqual(11);
    expect(slow).toBeGreaterThanOrEqual(9);
    expect(slow).toBeLessThanOrEqual(11);
  });

  it('runs a once callback promptly in low-rate mode', () => {
    const display = fakeDisplay(240);
    const f = createFrames(display.env);
    f.add(() => undefined, { maxFps: 2 });
    display.advance(10);
    let ran = -1;
    f.once((now) => (ran = now));
    display.advance(5);
    expect(ran).toBeGreaterThan(0);
    expect(f.snapshot().mode).toBe('timer');
  });

  it('handles subscribers that unsubscribe or subscribe during a frame', () => {
    const display = fakeDisplay(60);
    const f = createFrames(display.env);
    const order: string[] = [];
    let offB = () => undefined as void;
    f.add(() => {
      order.push('a');
      offB();
      f.add(() => order.push('c'));
    });
    offB = f.add(() => order.push('b'));
    display.advance(17); // one frame: b was removed before its turn, c starts next frame
    expect(order).toEqual(['a']);
    order.length = 0;
    display.advance(17);
    expect(order).toEqual(['a', 'c']); // the second frame's new c starts on the third
  });

  it('runs a once queued inside a frame on the following frame', () => {
    const display = fakeDisplay(60);
    const f = createFrames(display.env);
    const times: number[] = [];
    f.once((now) => {
      times.push(now);
      f.once((later) => times.push(later));
    });
    display.advance(40);
    expect(times).toHaveLength(2);
    expect(times[1]).toBeCloseTo(times[0] + 1000 / 60, 5);
    expect(f.active).toBe(0);
  });

  it('keeps the loop and the other subscribers running when one throws, and reports the error', () => {
    const display = fakeDisplay(60);
    const f = createFrames(display.env);
    let good = 0;
    f.add(() => {
      throw new Error('boom');
    });
    f.add(() => good++);
    display.advance(110);
    expect(good).toBe(6);
    expect(display.stats.errors.length).toBe(6);
    expect(f.active).toBe(2);
  });

  it('treats a missing or invalid maxFps as the display rate', () => {
    const display = fakeDisplay(120);
    const f = createFrames(display.env);
    let calls = 0;
    f.add(() => calls++, { maxFps: 0 });
    f.add(() => calls++, { maxFps: Number.NaN });
    display.advance(1000);
    expect(calls).toBeGreaterThanOrEqual(238); // both, on every one of ~120 frames
    expect(calls).toBeLessThanOrEqual(240);
  });
});

describe('the shared scheduler', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses requestAnimationFrame only while subscribed and shows labels on window.__frames', () => {
    const raf = vi.fn((_cb: FrameRequestCallback) => 7);
    const caf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', caf);
    expect(frames.active).toBe(0);
    const off = frames.add(() => undefined, { label: 'probe' });
    expect(raf).toHaveBeenCalledTimes(1);
    expect(window.__frames).toEqual({ active: 1, mode: 'frame', subscribers: { probe: 1 }, once: 0 });
    off();
    expect(caf).toHaveBeenCalledWith(7);
    expect(frames.active).toBe(0);
    expect(window.__frames?.mode).toBe('idle');
  });
});
