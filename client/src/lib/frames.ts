/**
 * One frame scheduler for the whole client, and the only requestAnimationFrame
 * user. Everything that draws or polls per frame subscribes here, so an idle
 * app costs nothing: with no subscribers there is no rAF and no timer at all.
 *
 * - `add(cb, {maxFps})` calls `cb(now, dt)` once per display frame, or at most
 *   `maxFps` times a second. The cap keeps an even grid: on a 240 Hz screen a
 *   60 fps subscriber runs every 4th frame, and on 144 Hz it still averages
 *   60 (it never runs more than `maxFps + 1` times in any second).
 * - Paced mode: a rAF pending on every vsync costs a main-thread task per
 *   display frame even when nothing runs in it (on a 240 Hz screen, 180 empty
 *   frames a second around a 60 fps game). So when every subscriber is capped
 *   well below the display rate, the scheduler sleeps on a `setTimeout` until
 *   just before the soonest one is due and then asks for a single rAF, which
 *   still lands the call on a vsync. That needs the display rate, measured from
 *   back-to-back frames: the first frames of a session run as a plain loop,
 *   and one extra frame a second keeps the measurement fresh (a window can
 *   move to another screen). The timer aims just after the vsync before the
 *   due one, so it may fire up to almost a frame late and still hit it. Chrome
 *   answers a rAF from a page that stopped asking for frames at once, stamped
 *   with that earlier vsync; such a frame runs only `once` callbacks and the
 *   call waits one more frame, so a paced call costs about two frames. When
 *   timers keep firing later than that (DevTools CPU throttling stretches
 *   them 3–4×, some laptops on battery have coarse timers), pacing gives way
 *   to the plain loop for a few seconds, so the frame rate never drops. Caps
 *   of 15 fps or less (gamepad polls on static screens) are always paced,
 *   without the measurement. Any uncapped subscriber keeps the plain loop.
 * - `once(cb)` runs `cb(now)` on the next frame, like a one-shot rAF.
 * - `active` counts subscribers plus pending `once` callbacks.
 *
 * In dev builds `window.__frames` shows the subscribers by label, the mode and
 * the measured display rate.
 */

export interface FrameOpts {
  /** At most this many calls a second. Omitted: every display frame. */
  maxFps?: number;
  /** Name shown in the dev counter (`window.__frames`). */
  label?: string;
}

export interface Frames {
  /** Calls `cb(now, dt)` every frame (or at most `maxFps` a second); returns the unsubscribe. `dt` is 0 on the first call. */
  add(cb: (now: number, dt: number) => void, opts?: FrameOpts): () => void;
  /** Calls `cb(now)` once, on the next frame. */
  once(cb: (now: number) => void): void;
  /** Subscribers plus pending `once` callbacks. While 0, no rAF and no timer exist. */
  readonly active: number;
}

/** What the dev counter shows. */
export interface FramesSnapshot {
  active: number;
  /** 'frame': a rAF is pending; 'timer': paced, sleeping until the next frame is due; 'idle': nothing scheduled. */
  mode: 'idle' | 'frame' | 'timer';
  /** Subscriber count by label ('unlabelled' for none). */
  subscribers: Record<string, number>;
  once: number;
  /** The measured display rate, or null before there is a measurement. */
  displayHz: number | null;
}

/** The timing primitives the scheduler uses; tests pass fakes. */
export interface FrameEnv {
  requestFrame(cb: (now: number) => void): number;
  cancelFrame(id: number): void;
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  now(): number;
}

/** Subscribers at or below this rate are always paced, without measuring the display. */
export const LOW_RATE_MAX_FPS = 15;

/**
 * Pace only when every subscriber skips at least every other display frame
 * (its interval is about twice the display's or more). Closer to the display
 * rate a timer per frame saves little and risks missing the vsync.
 */
const PACE_MIN_FRAMES = 1.9;

/**
 * When the pacing timer wakes. Measured pacing wakes this long after the vsync before the one
 * the call should land on: the widest window (almost a frame) for a late timer to still hit
 * it. Low-rate pacing has no measurement and wakes a fixed lead before the due time.
 */
const LEAD_MARGIN_MS = 0.5;
const LOW_RATE_LEAD_MS = 2;

/** Measured pacing backs off when this many of the last MISS_WINDOW paced frames missed their vsync. */
const MISS_WINDOW = 10;
const MISS_LIMIT = 3;
/** How long it backs off to the plain loop before trying to pace again. */
const BACKOFF_MS = 5000;

/** A frame this close to a subscriber's due time counts as due (rAF timestamps jitter). */
const TOLERANCE_MS = 1;

/**
 * Display measurement: the median of the last few back-to-back frame gaps (timestamps jitter by
 * about a millisecond, and a dropped frame doubles a gap, so neither the shortest nor the mean).
 */
const SAMPLES = 7;
const MIN_SAMPLES = 3;
/** Gaps outside 2–50 ms (500–20 Hz) are not display frames (a stall, a duplicate timestamp). */
const SAMPLE_MIN_MS = 2;
const SAMPLE_MAX_MS = 50;
/** While paced on the measurement, one back-to-back frame this often keeps it fresh. */
const RESAMPLE_MS = 1000;

const browserEnv: FrameEnv = {
  requestFrame: (cb) => requestAnimationFrame(cb),
  cancelFrame: (id) => cancelAnimationFrame(id),
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
};

interface Subscriber {
  cb: (now: number, dt: number) => void;
  /** Milliseconds between calls; 0 means every frame. */
  interval: number;
  /** Earliest time of the next call (on the subscriber's grid). */
  due: number;
  /** Time of the last call, or null before the first. */
  last: number | null;
  label: string;
  live: boolean;
}

export function createFrames(env: FrameEnv = browserEnv): Frames & { snapshot(): FramesSnapshot } {
  const subs = new Set<Subscriber>();
  let onceQueue: Array<(now: number) => void> = [];
  /** Subscribers without a cap: they need every display frame. */
  let uncapped = 0;
  let frameId: number | null = null;
  let timerId: unknown = null;
  /** The due time the pending pacing timer aims at, and whether it relies on the measurement. */
  let timerAim: { due: number; measured: boolean } | null = null;
  /** Set when the pacing timer fired: the frame it asked for runs what was due by then. */
  let woke: { due: number; measured: boolean } | null = null;
  /** Recent measured-pacing frames: whether each missed the vsync it aimed at. */
  const misses: boolean[] = [];
  let backoffUntil = -Infinity;
  let ticking = false;
  /** Set while a tick plans its successor: a frame asked for then follows the last one back to back. */
  let planningTick = false;
  /** Whether the pending frame was asked for at the end of the previous tick (a display measurement). */
  let chained = false;
  let lastFrameAt: number | null = null;
  const samples: number[] = [];
  let sampleIndex = 0;
  let lastSampleAt = -Infinity;

  const active = () => subs.size + onceQueue.length;

  /** The display's frame interval: the median recent back-to-back gap. */
  const displayInterval = (): number | null => {
    if (samples.length < MIN_SAMPLES) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  };

  const recordSample = (gap: number, at: number) => {
    if (gap < SAMPLE_MIN_MS || gap > SAMPLE_MAX_MS) return;
    samples[sampleIndex] = gap;
    sampleIndex = (sampleIndex + 1) % SAMPLES;
    lastSampleAt = at;
  };

  /**
   * 'loop': a rAF every display frame. 'paced': a timer, then one rAF, for every
   * subscriber's next due time; 'measured' when that relies on the display rate.
   */
  const pacing = (): 'loop' | 'paced' | 'measured' => {
    if (uncapped > 0 || subs.size === 0) return 'loop';
    let shortest = Infinity;
    for (const sub of subs) shortest = Math.min(shortest, sub.interval);
    if (shortest >= 1000 / LOW_RATE_MAX_FPS - 1e-6) return 'paced';
    const display = displayInterval();
    if (display === null || shortest < PACE_MIN_FRAMES * display) return 'loop';
    return env.now() < backoffUntil ? 'loop' : 'measured';
  };

  /** A measured-pacing frame landed: back off to the plain loop when too many of them miss. */
  const recordPacedFrame = (missed: boolean, now: number) => {
    misses.push(missed);
    if (misses.length > MISS_WINDOW) misses.shift();
    if (misses.filter(Boolean).length < MISS_LIMIT) return;
    misses.length = 0;
    backoffUntil = now + BACKOFF_MS;
  };

  const clearTimer = () => {
    if (timerId === null) return;
    env.clearTimer(timerId);
    timerId = null;
    timerAim = null;
  };

  const requestFrame = () => {
    clearTimer();
    if (frameId !== null) return;
    chained = planningTick;
    frameId = env.requestFrame(tick);
  };

  const stop = () => {
    clearTimer();
    if (frameId !== null) env.cancelFrame(frameId);
    frameId = null;
    woke = null;
    chained = false;
    lastFrameAt = null;
    // The window may move to another screen while idle: measure again next time.
    samples.length = 0;
    sampleIndex = 0;
    lastSampleAt = -Infinity;
  };

  /** Leaves exactly what the current subscribers need scheduled: a frame, a timer, or nothing. */
  const plan = () => {
    if (ticking) return; // the tick plans once it is done
    if (active() === 0) return stop();
    if (frameId !== null) return; // a frame is coming, and its tick plans again
    if (onceQueue.length > 0) return requestFrame();
    const mode = pacing();
    if (mode === 'loop') return requestFrame();
    // Paced on the measured display rate: one back-to-back frame a second keeps it current.
    if (mode === 'measured' && planningTick && lastFrameAt !== null && lastFrameAt - lastSampleAt >= RESAMPLE_MS) return requestFrame();
    let due = Infinity;
    for (const sub of subs) due = Math.min(due, sub.due);
    // Wake just after the vsync before the one the call should land on: the first vsync at or
    // after the due time, predicted from the last frame's timestamp and the measured interval.
    const display = displayInterval();
    let wakeAt = due - LOW_RATE_LEAD_MS;
    if (mode === 'measured' && display !== null && lastFrameAt !== null) {
      const target = lastFrameAt + Math.max(1, Math.ceil((due - TOLERANCE_MS - lastFrameAt) / display)) * display;
      wakeAt = target - display + LEAD_MARGIN_MS;
    }
    const wait = Math.ceil(wakeAt - env.now());
    if (wait <= 0) return requestFrame();
    clearTimer();
    timerAim = { due, measured: mode === 'measured' };
    timerId = env.setTimer(() => {
      timerId = null;
      woke = timerAim;
      timerAim = null;
      requestFrame();
    }, wait);
  };

  function tick(now: number) {
    frameId = null;
    if (chained && lastFrameAt !== null) recordSample(now - lastFrameAt, now);
    chained = false;
    lastFrameAt = now;
    // A page that stopped asking for frames gets its next one at once, stamped with the vsync
    // that already passed (Chrome's "missed" frame). For a paced frame that is a vsync before the
    // one it aimed at: run only the once callbacks and take the next frame, which lands on it.
    const early = woke !== null && now < woke.due - TOLERANCE_MS;
    const at = woke === null ? now : Math.max(now, woke.due);
    if (!early) {
      if (woke?.measured) {
        const display = displayInterval();
        if (display !== null) recordPacedFrame(now - woke.due >= display - TOLERANCE_MS, now);
      }
      woke = null;
    }
    const due = onceQueue;
    onceQueue = [];
    let failed = false;
    let error: unknown;
    ticking = true;
    try {
      for (const cb of due) {
        try {
          cb(now);
        } catch (err) {
          if (!failed) error = err;
          failed = true;
        }
      }
      // A snapshot: subscribers added during this frame start on the next one.
      for (const sub of early ? [] : [...subs]) {
        if (!sub.live || at < sub.due - TOLERANCE_MS) continue;
        const dt = sub.last === null ? 0 : now - sub.last;
        sub.last = now;
        sub.due += sub.interval;
        if (sub.due <= at) sub.due = at + sub.interval; // fell behind (a stall): restart the grid, no burst
        try {
          sub.cb(now, dt);
        } catch (err) {
          if (!failed) error = err;
          failed = true;
        }
      }
    } finally {
      ticking = false;
    }
    planningTick = true;
    try {
      if (early && subs.size > 0) requestFrame();
      else plan();
    } finally {
      planningTick = false;
    }
    // One subscriber's error never stops the others or the loop; it is still reported.
    if (failed) throw error;
  }

  return {
    add(cb, opts = {}) {
      const fps = opts.maxFps;
      const capped = fps !== undefined && fps > 0 && Number.isFinite(fps);
      const sub: Subscriber = {
        cb,
        interval: capped ? 1000 / fps : 0,
        due: -Infinity,
        last: null,
        label: opts.label ?? 'unlabelled',
        live: true,
      };
      subs.add(sub);
      if (!capped) uncapped += 1;
      plan();
      return () => {
        if (!sub.live) return;
        sub.live = false;
        subs.delete(sub);
        if (!capped) uncapped -= 1;
        plan();
      };
    },
    once(cb) {
      onceQueue.push(cb);
      plan();
    },
    get active() {
      return active();
    },
    snapshot() {
      const subscribers: Record<string, number> = {};
      for (const sub of subs) subscribers[sub.label] = (subscribers[sub.label] ?? 0) + 1;
      const mode = frameId !== null ? 'frame' : timerId !== null ? 'timer' : 'idle';
      const display = displayInterval();
      return { active: active(), mode, subscribers, once: onceQueue.length, displayHz: display === null ? null : Math.round(1000 / display) };
    },
  };
}

const scheduler = createFrames();

export const frames: Frames = scheduler;

declare global {
  interface Window {
    /** Dev builds only: the frame scheduler's subscribers, mode and measured display rate. */
    readonly __frames?: FramesSnapshot;
  }
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  Object.defineProperty(window, '__frames', { configurable: true, get: () => scheduler.snapshot() });
}
