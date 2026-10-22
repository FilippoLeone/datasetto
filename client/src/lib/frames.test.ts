import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFrames, frames, type FrameEnv } from './frames';

/**
 * A simulated display: vsyncs every 1000/hz ms, rAF callbacks run on the next
 * vsync with its timestamp, timers fire at their time. Counts every rAF and
 * timer the scheduler asks for. With `missedFrames`, it behaves like Chrome
 * after a page stopped asking for frames: the next rAF runs at once, stamped
 * with the vsync that already passed.
 */
function fakeDisplay(hz: number, options: { missedFrames?: boolean } = {}) {
  let period = 1000 / hz;
  let clock = 0;
  let nextVsync = period;
  let nextId = 1;
  let paused = false;
  /** How late every timer fires (CPU throttling, coarse OS timers). */
  let timerLate = 0;
  const frameCbs = new Map<number, (now: number) => void>();
  const immediate = new Map<number, (now: number) => void>();
  let lastVsync = -Infinity;
  /** Whether the last vsync ran any frame (Chrome keeps listening for vsyncs then). */
  let observing = false;
  let inFrame = false;
  const timers = new Map<number, { at: number; cb: () => void }>();
  const stats = { rafCalls: 0, timerCalls: 0, errors: [] as unknown[] };

  const env: FrameEnv = {
    requestFrame(cb) {
      stats.rafCalls += 1;
      const id = nextId++;
      const missed = options.missedFrames && !observing && !inFrame && !paused && lastVsync > -Infinity;
      (missed ? immediate : frameCbs).set(id, cb);
      return id;
    },
    cancelFrame: (id) => void (frameCbs.delete(id) || immediate.delete(id)),
    setTimer(cb, ms) {
      stats.timerCalls += 1;
      const id = nextId++;
      timers.set(id, { at: clock + Math.max(0, ms) + timerLate, cb });
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
      if (immediate.size > 0) {
        const batch = [...immediate.values()];
        immediate.clear();
        observing = true;
        inFrame = true;
        for (const cb of batch) run(() => cb(lastVsync));
        inFrame = false;
        continue;
      }
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
      lastVsync = clock;
      const batch = [...frameCbs.values()];
      frameCbs.clear();
      observing = batch.length > 0;
      inFrame = true;
      for (const cb of batch) run(() => cb(clock));
      inFrame = false;
    }
    clock = end;
    while (nextVsync <= clock) nextVsync += period;
  };

  return {
    env,
    stats,
    advance,
    pending: () => frameCbs.size + immediate.size + timers.size,
    pendingFrames: () => frameCbs.size + immediate.size,
    pendingTimers: () => timers.size,
    pause: (on: boolean) => void (paused = on),
    lateTimers: (ms: number) => void (timerLate = ms),
    /** The window moves to a screen with another refresh rate. */
    setHz(next: number) {
      period = 1000 / next;
      nextVsync = clock + period;
    },
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

  it('keeps a frame loop while an uncapped subscriber exists, and paces again without it', () => {
    const display = fakeDisplay(240);
    const f = createFrames(display.env);
    let slow = 0;
    f.add(() => slow++, { maxFps: 10 });
    const fast = f.add(() => undefined);
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

  it('paces a 60 fps subscriber on a 240 Hz display: one rAF per call, plus one a second to keep measuring', () => {
    const display = fakeDisplay(240);
    const f = createFrames(display.env);
    const dts: number[] = [];
    f.add((_now, dt) => dts.push(dt), { maxFps: 60, label: 'game' });
    display.advance(100); // a few back-to-back frames measure the display
    expect(f.snapshot().displayHz).toBe(240);
    display.stats.rafCalls = 0;
    display.stats.timerCalls = 0;
    dts.length = 0;
    display.advance(1000);
    expect(dts.length).toBeGreaterThanOrEqual(59);
    expect(dts.length).toBeLessThanOrEqual(61);
    for (const dt of dts) expect(dt).toBeCloseTo(1000 / 60, 5); // every call still lands on the 4th vsync
    expect(display.stats.rafCalls).toBeLessThanOrEqual(62);
    expect(display.stats.timerCalls).toBeGreaterThanOrEqual(55);
    expect(f.snapshot().mode).toBe('timer');
  });

  it('paces 60 fps on 144 Hz and 30 fps on 60 Hz, but keeps a loop when the cap is near the display rate', () => {
    const cases: Array<[hz: number, fps: number, paced: boolean]> = [
      [144, 60, true],
      [60, 30, true],
      [90, 60, false],
      [60, 60, false],
      [240, 200, false],
    ];
    for (const [hz, fps, paced] of cases) {
      const display = fakeDisplay(hz);
      const f = createFrames(display.env);
      let calls = 0;
      f.add(() => calls++, { maxFps: fps });
      display.advance(200);
      display.stats.rafCalls = 0;
      display.stats.timerCalls = 0;
      calls = 0;
      display.advance(1000);
      const label = `${fps} fps on ${hz} Hz`;
      expect(calls, label).toBeGreaterThanOrEqual(Math.min(fps, hz) - 2);
      expect(calls, label).toBeLessThanOrEqual(fps + 1);
      if (paced) expect(display.stats.rafCalls, label).toBeLessThanOrEqual(fps + 2);
      else {
        expect(display.stats.rafCalls, label).toBeGreaterThanOrEqual(hz - 2);
        expect(display.stats.timerCalls, label).toBe(0);
      }
    }
  });

  it('measures again when the window moves to a slower screen, and goes back to a loop there', () => {
    const display = fakeDisplay(240);
    const f = createFrames(display.env);
    let calls = 0;
    f.add(() => calls++, { maxFps: 60 });
    display.advance(2000);
    expect(f.snapshot().displayHz).toBe(240);
    display.setHz(60);
    calls = 0;
    display.advance(10000);
    expect(calls).toBeGreaterThanOrEqual(590); // no frame lost while the measurement catches up
    expect(f.snapshot().displayHz).toBe(60);
    display.stats.rafCalls = 0;
    display.stats.timerCalls = 0;
    calls = 0;
    display.advance(1000);
    expect(display.stats.timerCalls).toBe(0);
    expect(calls).toBeGreaterThanOrEqual(59);
  });

  it('paces as soon as the window moves to a faster screen', () => {
    const display = fakeDisplay(60);
    const f = createFrames(display.env);
    f.add(() => undefined, { maxFps: 60 });
    display.advance(1000);
    expect(display.stats.timerCalls).toBe(0);
    display.setHz(240);
    display.advance(100);
    expect(f.snapshot().displayHz).toBe(240);
    display.stats.rafCalls = 0;
    display.advance(1000);
    expect(display.stats.rafCalls).toBeLessThanOrEqual(62);
  });

  it('chains no timers while a hidden tab gets no frames', () => {
    const display = fakeDisplay(240);
    const f = createFrames(display.env);
    let calls = 0;
    f.add(() => calls++, { maxFps: 60 });
    display.advance(500);
    display.pause(true);
    display.stats.timerCalls = 0;
    calls = 0;
    display.advance(5000);
    expect(calls).toBe(0);
    expect(display.stats.timerCalls).toBeLessThanOrEqual(1); // the timer asks for a frame, which waits
    expect(display.pendingFrames()).toBe(1);
    display.pause(false);
    display.advance(1000);
    expect(calls).toBeGreaterThanOrEqual(58);
  });

  it('measures the display again after going idle', () => {
    const display = fakeDisplay(240);
    const f = createFrames(display.env);
    const off = f.add(() => undefined, { maxFps: 60 });
    display.advance(500);
    expect(f.snapshot().displayHz).toBe(240);
    off();
    expect(f.snapshot()).toMatchObject({ mode: 'idle', displayHz: null });
  });

  it('still lands every paced call on its vsync when timers fire a little late', () => {
    const display = fakeDisplay(240);
    display.lateTimers(2.5);
    const f = createFrames(display.env);
    const dts: number[] = [];
    f.add((_now, dt) => dts.push(dt), { maxFps: 60 });
    display.advance(200);
    display.stats.rafCalls = 0;
    dts.length = 0;
    display.advance(2000);
    for (const dt of dts) expect(dt).toBeCloseTo(1000 / 60, 5);
    expect(dts.length).toBeGreaterThanOrEqual(119);
    expect(display.stats.rafCalls).toBeLessThanOrEqual(124); // still paced
  });

  it('falls back to a frame loop while timers fire far too late (CPU throttling), so the rate holds', () => {
    const display = fakeDisplay(240);
    display.lateTimers(40);
    const f = createFrames(display.env);
    let calls = 0;
    f.add(() => calls++, { maxFps: 60 });
    display.advance(12000);
    expect(calls).toBeGreaterThanOrEqual(12 * 57); // pacing is retried every 5 s and gives up again
    display.lateTimers(0);
    display.advance(6000); // the back-off ends and pacing sticks
    display.stats.rafCalls = 0;
    calls = 0;
    display.advance(1000);
    expect(calls).toBeGreaterThanOrEqual(59);
    expect(display.stats.rafCalls).toBeLessThanOrEqual(62);
  });

  it('lands paced calls on their own vsync when the browser hands out a missed frame stamped with the last one', () => {
    const display = fakeDisplay(240, { missedFrames: true });
    const f = createFrames(display.env);
    const calls: Array<[now: number, dt: number]> = [];
    f.add((now, dt) => calls.push([now, dt]), { maxFps: 60 });
    display.advance(200);
    display.stats.rafCalls = 0;
    calls.length = 0;
    display.advance(2000);
    expect(calls.length).toBeGreaterThanOrEqual(119);
    for (const [, dt] of calls) expect(dt).toBeCloseTo(1000 / 60, 5);
    // One missed frame plus the real one per call: still about half of a 240 Hz loop's frames.
    expect(display.stats.rafCalls).toBeLessThanOrEqual(2 * 120 + 4);
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
    expect(window.__frames).toEqual({ active: 1, mode: 'frame', subscribers: { probe: 1 }, once: 0, displayHz: null });
    off();
    expect(caf).toHaveBeenCalledWith(7);
    expect(frames.active).toBe(0);
    expect(window.__frames?.mode).toBe('idle');
  });
});
