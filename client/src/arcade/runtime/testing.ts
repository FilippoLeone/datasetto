/**
 * Test helpers for the Arcade runtime and for game chunks' own jsdom tests. Import only from
 * `*.test.ts(x)` files; nothing in the app imports this module.
 *
 * - `installFakeFrames()`: a controllable requestAnimationFrame and performance.now, so the shared
 *   frame scheduler, loops and local hosts run in virtual time.
 * - `stubCanvas()`: a recording 2D context for jsdom (which has none).
 * - `createProbeCore()`: a scriptable CoreMatch with fixed-size snapshots and events.
 * - `trackResources()`: counts live timers, intervals, WebSockets and window/document listeners, for
 *   the zero-cost-when-closed checks.
 */
import { ByteWriter } from '@arcade/core/bytes';
import type { CoreMatch, EventChunk, HostEvent, RecipientView, SeatCmd } from '@arcade/core/net/match';

export interface FakeFrames {
  /** Advance virtual time by `ms`, running a frame every 1000/fps ms. */
  advance(ms: number, fps?: number): void;
  /** Pending rAF callbacks. */
  readonly pending: number;
  readonly now: number;
  restore(): void;
}

export const installFakeFrames = (): FakeFrames => {
  let now = 1000;
  let nextId = 1;
  const queue = new Map<number, FrameRequestCallback>();
  const raf = window.requestAnimationFrame;
  const caf = window.cancelAnimationFrame;
  const perfNow = performance.now.bind(performance);
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (id: number) => {
    queue.delete(id);
  };
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
  return {
    advance(ms, fps = 60) {
      const step = 1000 / fps;
      for (let t = 0; t < ms; t += step) {
        now += step;
        const due = Array.from(queue.entries());
        queue.clear();
        for (const [, cb] of due) cb(now);
      }
    },
    get pending() {
      return queue.size;
    },
    get now() {
      return now;
    },
    restore() {
      window.requestAnimationFrame = raf;
      window.cancelAnimationFrame = caf;
      Object.defineProperty(performance, 'now', { configurable: true, value: perfNow });
      queue.clear();
    },
  };
};

/** A 2D context that records calls; installed on HTMLCanvasElement.prototype.getContext. */
export const stubCanvas = (): { calls: string[]; restore(): void } => {
  const calls: string[] = [];
  const original = HTMLCanvasElement.prototype.getContext;
  const record =
    (name: string) =>
    (..._args: unknown[]) => {
      calls.push(name);
    };
  const ctx = new Proxy(
    { canvas: null as unknown, imageSmoothingEnabled: true },
    {
      get(target, prop) {
        if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
        if (prop === 'createImageData') return (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
        if (prop === 'measureText') return () => ({ width: 0 });
        return record(String(prop));
      },
      set(target, prop, value) {
        (target as Record<string | symbol, unknown>)[prop] = value;
        return true;
      },
    },
  );
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return ctx as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return {
    calls,
    restore() {
      HTMLCanvasElement.prototype.getContext = original;
    },
  };
};

export interface ProbeCore extends CoreMatch {
  readonly steps: number;
  readonly ups: { slot: number; payload: Uint8Array; upSeq: number }[];
  readonly events: { slot: number; payload: Uint8Array }[];
  readonly seats: { slot: number; cmd: SeatCmd }[];
  /** Host events to emit after the step at `tick`. */
  script(tick: number, events: HostEvent[]): void;
}

/**
 * A CoreMatch with a fixed-size snapshot (bytes = tick) and `eventsPerTick` one-byte game events
 * (kind 0x01, then u8 tick) visible to everyone.
 */
export const createProbeCore = (o: { snapshotBytes?: number; eventsPerTick?: number } = {}): ProbeCore => {
  const snapshotBytes = o.snapshotBytes ?? 8;
  const eventsPerTick = o.eventsPerTick ?? 1;
  let tick = 0;
  let steps = 0;
  let acked = 0;
  const ups: ProbeCore['ups'] = [];
  const events: ProbeCore['events'] = [];
  const seats: ProbeCore['seats'] = [];
  const scripted = new Map<number, HostEvent[]>();
  let pendingHost: HostEvent[] = [];
  const w = new ByteWriter(256);
  return {
    get idle() {
      return false;
    },
    get tick() {
      return tick;
    },
    get steps() {
      return steps;
    },
    ups,
    events,
    seats,
    script(at, list) {
      scripted.set(at, list);
    },
    step() {
      tick += 1;
      steps += 1;
      pendingHost = scripted.get(tick) ?? [];
    },
    onUp(slot, payload, upSeq) {
      ups.push({ slot, payload, upSeq });
      acked = upSeq;
    },
    onEvent(slot, payload) {
      events.push({ slot, payload });
    },
    ackUp: () => acked,
    setSeat(slot, cmd) {
      seats.push({ slot, cmd });
    },
    setRtt: () => undefined,
    welcomeCfg: () => new Uint8Array([1, 2, 3]),
    snapshotFor(_r: RecipientView) {
      const out = new Uint8Array(snapshotBytes);
      out.fill(tick & 0xff);
      return out;
    },
    keyframeFor(r: RecipientView) {
      return new Uint8Array([tick & 0xff, r.view & 0xff]);
    },
    takeEvents(_r: RecipientView): EventChunk | null {
      if (eventsPerTick === 0) return null;
      w.reset();
      for (let i = 0; i < eventsPerTick; i += 1) w.u8(0x01).u8(tick & 0xff);
      return { bytes: w.copy(), count: eventsPerTick };
    },
    takeHostEvents() {
      const out = pendingHost;
      pendingHost = [];
      return out;
    },
    dump: () => new Uint8Array([tick & 0xff]),
  };
};

export interface ResourceTracker {
  /** Live setTimeout handles, setInterval handles, open WebSockets and window/document listeners. */
  live(): { timeouts: number; intervals: number; sockets: number; listeners: number };
  /** Listener counts by target and event type, for a failing check's message. */
  listenerTypes(): Record<string, number>;
  restore(): void;
}

/** Spies that count what is still alive (call before mounting, read after unmounting). */
export const trackResources = (): ResourceTracker => {
  const timeouts = new Set<unknown>();
  const intervals = new Set<unknown>();
  const sockets = new Set<{ readyState: number }>();
  const listeners = new Map<string, number>();
  const st = window.setTimeout;
  const ct = window.clearTimeout;
  const si = window.setInterval;
  const ci = window.clearInterval;
  const WS = window.WebSocket;
  const targets: (Window | Document)[] = [window, document];
  const adds = targets.map((t) => t.addEventListener);
  const removes = targets.map((t) => t.removeEventListener);

  window.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
    const handle = st(
      (...args: unknown[]) => {
        timeouts.delete(handle);
        if (typeof fn === 'function') (fn as (...a: unknown[]) => void)(...args);
      },
      ms,
      ...rest,
    );
    timeouts.add(handle);
    return handle;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((handle?: number) => {
    timeouts.delete(handle);
    ct(handle);
  }) as typeof window.clearTimeout;
  window.setInterval = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
    const handle = si(fn, ms, ...rest);
    intervals.add(handle);
    return handle;
  }) as typeof window.setInterval;
  window.clearInterval = ((handle?: number) => {
    intervals.delete(handle);
    ci(handle);
  }) as typeof window.clearInterval;
  class TrackedSocket {
    readyState = 0;
    constructor() {
      sockets.add(this);
    }
    close() {
      this.readyState = 3;
      sockets.delete(this);
    }
    send() {}
    addEventListener() {}
    removeEventListener() {}
  }
  window.WebSocket = TrackedSocket as unknown as typeof WebSocket;
  targets.forEach((t, i) => {
    const key = i === 0 ? 'window:' : 'document:';
    t.addEventListener = function add(this: unknown, type: string, ...rest: unknown[]) {
      listeners.set(key + type, (listeners.get(key + type) ?? 0) + 1);
      return (adds[i] as (...a: unknown[]) => void).call(t, type, ...rest);
    } as typeof t.addEventListener;
    t.removeEventListener = function remove(this: unknown, type: string, ...rest: unknown[]) {
      listeners.set(key + type, (listeners.get(key + type) ?? 0) - 1);
      return (removes[i] as (...a: unknown[]) => void).call(t, type, ...rest);
    } as typeof t.removeEventListener;
  });

  return {
    live() {
      let count = 0;
      for (const n of listeners.values()) count += Math.max(0, n);
      return { timeouts: timeouts.size, intervals: intervals.size, sockets: sockets.size, listeners: count };
    },
    listenerTypes() {
      const out: Record<string, number> = {};
      for (const [key, n] of listeners) if (n !== 0) out[key] = n;
      return out;
    },
    restore() {
      window.setTimeout = st;
      window.clearTimeout = ct;
      window.setInterval = si;
      window.clearInterval = ci;
      window.WebSocket = WS;
      targets.forEach((t, i) => {
        t.addEventListener = adds[i] as typeof t.addEventListener;
        t.removeEventListener = removes[i] as typeof t.removeEventListener;
      });
    },
  };
};
