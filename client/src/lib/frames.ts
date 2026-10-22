/**
 * One frame scheduler for the whole client, and the only requestAnimationFrame
 * user. Everything that draws or polls per frame subscribes here, so an idle
 * app costs nothing: with no subscribers there is no rAF and no timer at all.
 *
 * - `add(cb, {maxFps})` calls `cb(now, dt)` once per display frame, or at most
 *   `maxFps` times a second. The cap keeps an even grid: on a 240 Hz screen a
 *   60 fps subscriber runs every 4th frame, and on 144 Hz it still averages
 *   60 (it never runs more than `maxFps + 1` times in any second).
 * - Low-rate mode: when every subscriber asks for 15 fps or less (a gamepad
 *   poll on a static screen), the scheduler sleeps on a `setTimeout` until the
 *   next one is due and then asks for a single rAF, instead of waking every
 *   display frame.
 * - `once(cb)` runs `cb(now)` on the next frame, like a one-shot rAF.
 * - `active` counts subscribers plus pending `once` callbacks.
 *
 * In dev builds `window.__frames` shows the subscribers by label.
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
  /** 'frame': a rAF is pending; 'timer': low-rate mode is sleeping; 'idle': nothing scheduled. */
  mode: 'idle' | 'frame' | 'timer';
  /** Subscriber count by label ('unlabelled' for none). */
  subscribers: Record<string, number>;
  once: number;
}

/** The timing primitives the scheduler uses; tests pass fakes. */
export interface FrameEnv {
  requestFrame(cb: (now: number) => void): number;
  cancelFrame(id: number): void;
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  now(): number;
}

/** Subscribers at or below this rate let the scheduler sleep on a timer between frames. */
export const LOW_RATE_MAX_FPS = 15;

/** A frame this close to a subscriber's due time counts as due (rAF timestamps jitter). */
const TOLERANCE_MS = 1;

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
  /** Subscribers faster than LOW_RATE_MAX_FPS (they need every display frame). */
  let fastCount = 0;
  let frameId: number | null = null;
  let timerId: unknown = null;
  /** When the low-rate timer fired; the frame it asked for counts subscribers due at that moment. */
  let wokeAt: number | null = null;
  let ticking = false;

  const active = () => subs.size + onceQueue.length;

  const clearTimer = () => {
    if (timerId === null) return;
    env.clearTimer(timerId);
    timerId = null;
  };

  const requestFrame = () => {
    clearTimer();
    if (frameId === null) frameId = env.requestFrame(tick);
  };

  const stop = () => {
    clearTimer();
    if (frameId !== null) env.cancelFrame(frameId);
    frameId = null;
    wokeAt = null;
  };

  /** Leaves exactly what the current subscribers need scheduled: a frame, a timer, or nothing. */
  const plan = () => {
    if (ticking) return; // the tick plans once it is done
    if (active() === 0) return stop();
    if (frameId !== null) return; // a frame is coming, and its tick plans again
    if (onceQueue.length > 0 || fastCount > 0) return requestFrame();
    // Low-rate mode: sleep until the soonest subscriber is due, then take one frame.
    let due = Infinity;
    for (const sub of subs) due = Math.min(due, sub.due);
    const wait = Math.ceil(due - TOLERANCE_MS - env.now());
    if (wait <= 0) return requestFrame();
    clearTimer();
    timerId = env.setTimer(() => {
      timerId = null;
      wokeAt = env.now();
      requestFrame();
    }, wait);
  };

  function tick(now: number) {
    frameId = null;
    // A frame asked for by the low-rate timer may carry a timestamp from just before it fired.
    const at = wokeAt === null ? now : Math.max(now, wokeAt);
    wokeAt = null;
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
      for (const sub of [...subs]) {
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
    plan();
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
      const fast = !capped || fps > LOW_RATE_MAX_FPS;
      subs.add(sub);
      if (fast) fastCount += 1;
      plan();
      return () => {
        if (!sub.live) return;
        sub.live = false;
        subs.delete(sub);
        if (fast) fastCount -= 1;
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
      return { active: active(), mode, subscribers, once: onceQueue.length };
    },
  };
}

const scheduler = createFrames();

export const frames: Frames = scheduler;

declare global {
  interface Window {
    /** Dev builds only: the frame scheduler's subscribers. */
    readonly __frames?: FramesSnapshot;
  }
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  Object.defineProperty(window, '__frames', { configurable: true, get: () => scheduler.snapshot() });
}
