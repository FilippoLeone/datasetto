/**
 * The phase 0 interfaces the Arcade builds on (docs/arcade/plan.md §2.6.1), in one place:
 * the frame scheduler, merged app visibility, the shared Capacitor app-state listener, the desktop
 * shell's window visibility and attention calls, and the constrained-link signal.
 *
 * Until the phase 0 PRs (arcade/frames, arcade/window-visibility, arcade/voice-cap) are on main,
 * this file holds thin local versions with exactly their signatures. Once they land it becomes
 * re-exports of '@/lib/frames', '@/services/native/appVisibility', '@/services/native/appState'
 * and '@/services/voice/linkConstraint', and nothing that imports it changes.
 * Game chunks import `frames` from here ('@/arcade/runtime/p0').
 */
import { signal, type ReadonlySignal } from '@preact/signals';
import { isCapacitor } from '@/lib/device';

// ------------------------------------------------------------------ frames (P0c)

export interface FrameOpts {
  /**
   * Skip callbacks closer than 1000/maxFps − 1 ms. When every subscriber is capped well below the
   * display's rate (≤ 15 fps, or a period of at least 1.5 display frames), the scheduler sleeps on a
   * timer until just before the soonest one is due and then asks for a single frame, instead of
   * keeping a frame request pending on every refresh (a 60 fps game on a 240 Hz screen).
   */
  maxFps?: number;
  /** Shown in the dev counter. */
  label?: string;
}

interface FrameSub {
  cb: (now: number, dt: number) => void;
  maxFps: number;
  label: string;
  last: number;
}

/** The scheduler's timer functions; `installFakeFrames()` swaps them for virtual time. */
export const frameTimers: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void } = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const LOW_RATE_FPS = 15;
/**
 * Timer wake-up ahead of the soonest due subscriber: 8 ms in low-rate mode. When pacing a capped
 * rate it is just under one display frame, so the one frame requested on waking is the one the
 * subscriber is due at even when the timer fires late (a busy or throttled main thread): it may be
 * up to a frame late and still lands on the right refresh.
 */
const LOW_RATE_LEAD_MS = 8;
const pacedLeadMs = (vsyncMs: number): number => Math.max(1, vsyncMs - 1.25);
/** Pace a capped subscriber only when its period is at least this many display frames. */
const PACE_MIN_FRAMES = 1.5;

const createFrames = () => {
  const subs = new Set<FrameSub>();
  let onceQueue: Array<(now: number) => void> = [];
  let raf: number | null = null;
  let timer: unknown = null;
  // The display's frame period, from back-to-back frames (the smallest of the last 8 gaps).
  let vsyncMs = 0;
  const gaps: number[] = [];
  let lastTick = 0;
  let backToBack = false;
  let inTick = false;

  const mode = (): 'frame' | 'low' | 'paced' => {
    if (onceQueue.length > 0 || subs.size === 0) return 'frame';
    let low = true;
    let paceable = vsyncMs > 0;
    for (const sub of subs) {
      if (!(sub.maxFps > 0)) return 'frame';
      if (sub.maxFps > LOW_RATE_FPS) low = false;
      if (1000 / sub.maxFps < vsyncMs * PACE_MIN_FRAMES) paceable = false;
    }
    return low ? 'low' : paceable ? 'paced' : 'frame';
  };

  const clearTimer = (): void => {
    if (timer === null) return;
    frameTimers.clear(timer);
    timer = null;
  };

  const tick = (now: number): void => {
    raf = null;
    if (backToBack && lastTick > 0) {
      const gap = now - lastTick;
      if (gap > 2 && gap < 50) {
        gaps.push(gap);
        if (gaps.length > 8) gaps.shift();
        if (gaps.length >= 4) vsyncMs = Math.min(...gaps);
      }
    }
    lastTick = now;
    backToBack = false;
    inTick = true;
    const queued = onceQueue;
    onceQueue = [];
    for (const cb of queued) {
      try {
        cb(now);
      } catch (error) {
        console.error('[frames] once callback failed', error);
      }
    }
    for (const sub of Array.from(subs)) {
      if (!subs.has(sub)) continue;
      if (sub.maxFps > 0 && sub.last > 0 && now - sub.last < 1000 / sub.maxFps - 1) continue;
      const dt = sub.last > 0 ? now - sub.last : 0;
      sub.last = now;
      try {
        sub.cb(now, dt);
      } catch (error) {
        console.error('[frames] callback failed', sub.label, error);
      }
    }
    inTick = false;
    schedule(true);
  };

  const schedule = (fromTick = false): void => {
    if (raf !== null || timer !== null) return;
    if (subs.size === 0 && onceQueue.length === 0) return;
    const m = mode();
    if (m !== 'frame') {
      let soonest = Infinity;
      const now = performance.now();
      // Due at last + period − 1 ms (the tick's tolerance); a new subscriber (last 0) is due at once.
      for (const sub of subs) soonest = Math.min(soonest, sub.last + 1000 / sub.maxFps - 1 - now);
      const lead = m === 'low' ? LOW_RATE_LEAD_MS : pacedLeadMs(vsyncMs);
      const delay = Math.min(1000, soonest - lead);
      // Already inside the last frame before it is due: ask for that frame now, not via a timer that
      // could itself fire late and miss it.
      if (delay <= 0) {
        backToBack = false;
        raf = requestAnimationFrame(tick);
        return;
      }
      timer = frameTimers.set(() => {
        timer = null;
        if (raf === null) raf = requestAnimationFrame(tick);
      }, delay);
      return;
    }
    backToBack = fromTick && !inTick;
    raf = requestAnimationFrame(tick);
  };

  const stopIfIdle = (): void => {
    if (subs.size > 0 || onceQueue.length > 0) return;
    if (raf !== null) cancelAnimationFrame(raf);
    clearTimer();
    raf = null;
    // Measure the display again next time (the window may be on another screen by then).
    gaps.length = 0;
    vsyncMs = 0;
    lastTick = 0;
  };

  const api = {
    add(cb: (now: number, dt: number) => void, opts: FrameOpts = {}): () => void {
      const sub: FrameSub = { cb, maxFps: opts.maxFps ?? 0, label: opts.label ?? 'anonymous', last: 0 };
      subs.add(sub);
      // The newcomer may be due sooner than the running timer, or not cappable at all.
      clearTimer();
      schedule();
      return () => {
        subs.delete(sub);
        stopIfIdle();
      };
    },
    once(cb: (now: number) => void): void {
      onceQueue.push(cb);
      clearTimer();
      schedule();
    },
    get active(): number {
      return subs.size + onceQueue.length;
    },
  };
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    (window as unknown as { __frames?: unknown }).__frames = { get subscribers() { return Array.from(subs, (s) => s.label); } };
  }
  return api;
};

export const frames: {
  add(cb: (now: number, dt: number) => void, opts?: FrameOpts): () => void;
  once(cb: (now: number) => void): void;
  readonly active: number;
} = createFrames();

// ------------------------------------------------------------------ desktop bridge (P0b)

/** The desktop shell's bridge with the window-visibility and attention calls (absent in older shells and in browsers). */
export type DesktopBridge = NonNullable<Window['desktopAPI']> & {
  onWindowVisibility?(cb: (visible: boolean) => void): () => void;
  requestAttention?(on: boolean): void;
};

export const desktopBridge = (): DesktopBridge | null => (typeof window !== 'undefined' ? ((window.desktopAPI as DesktopBridge | undefined) ?? null) : null);

// ------------------------------------------------------------------ app state (P0b)

type AppStateListener = (active: boolean) => void;
const appStateListeners = new Set<AppStateListener>();
let appStateHandle: { remove(): Promise<void> | void } | null = null;
let appStateInstalling = false;

/** One shared Capacitor `appStateChange` listener; a no-op on the web and in Electron. */
export const onAppStateChange = (cb: AppStateListener): (() => void) => {
  appStateListeners.add(cb);
  if (isCapacitor() && !appStateHandle && !appStateInstalling) {
    appStateInstalling = true;
    void import('@capacitor/app')
      .then(async ({ App }) => {
        const handle = await App.addListener('appStateChange', ({ isActive }) => {
          for (const listener of Array.from(appStateListeners)) listener(isActive);
        });
        appStateInstalling = false;
        if (appStateListeners.size === 0) void handle.remove();
        else appStateHandle = handle;
      })
      .catch(() => {
        appStateInstalling = false;
      });
  }
  return () => {
    appStateListeners.delete(cb);
    if (appStateListeners.size === 0 && appStateHandle) {
      const handle = appStateHandle;
      appStateHandle = null;
      void handle.remove();
    }
  };
};

// ------------------------------------------------------------------ app visibility (P0b)

type VisibilityListener = (visible: boolean) => void;

const createAppVisibility = () => {
  const listeners = new Set<VisibilityListener>();
  let docVisible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  let pageShown = true;
  let nativeActive = true;
  let windowVisible = true;
  let last = true;
  let teardown: Array<() => void> = [];

  const compute = (): boolean => docVisible && pageShown && nativeActive && windowVisible;
  const update = (): void => {
    const next = compute();
    if (next === last) return;
    last = next;
    for (const listener of Array.from(listeners)) listener(next);
  };

  const install = (): void => {
    docVisible = document.visibilityState !== 'hidden';
    last = compute();
    const onVisibility = () => {
      docVisible = document.visibilityState !== 'hidden';
      update();
    };
    const onHide = () => {
      pageShown = false;
      update();
    };
    const onShow = () => {
      pageShown = true;
      update();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    teardown.push(() => document.removeEventListener('visibilitychange', onVisibility));
    teardown.push(() => window.removeEventListener('pagehide', onHide));
    teardown.push(() => window.removeEventListener('pageshow', onShow));
    teardown.push(
      onAppStateChange((active) => {
        nativeActive = active;
        update();
      }),
    );
    const off = desktopBridge()?.onWindowVisibility?.((visible: boolean) => {
      windowVisible = visible;
      update();
    });
    if (off) teardown.push(off);
  };

  return {
    get visible(): boolean {
      if (listeners.size === 0) return typeof document === 'undefined' || document.visibilityState !== 'hidden';
      return last;
    },
    subscribe(cb: VisibilityListener): () => void {
      if (listeners.size === 0) install();
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0) {
          for (const off of teardown) off();
          teardown = [];
          pageShown = true;
          nativeActive = true;
          windowVisible = true;
        }
      };
    },
  };
};

export const appVisibility: { readonly visible: boolean; subscribe(cb: (visible: boolean) => void): () => void } = createAppVisibility();

// ------------------------------------------------------------------ constrained link (P0a)

interface NetworkInformationLike {
  type?: string;
  effectiveType?: string;
  saveData?: boolean;
  downlink?: number;
}

const detectConstrained = (): boolean => {
  const connection = typeof navigator !== 'undefined' ? (navigator as Navigator & { connection?: NetworkInformationLike }).connection : undefined;
  if (!connection) return false;
  if (connection.type === 'cellular') return true;
  if (connection.effectiveType && ['slow-2g', '2g', '3g'].includes(connection.effectiveType)) return true;
  if (connection.saveData) return true;
  return typeof connection.downlink === 'number' && connection.downlink > 0 && connection.downlink < 2;
};

const constrained = signal(detectConstrained());
// One listener for the life of the page (the runtime chunk loads with the first game).
const connection = typeof navigator !== 'undefined' ? (navigator as Navigator & { connection?: NetworkInformationLike & EventTarget }).connection : undefined;
connection?.addEventListener?.('change', () => {
  constrained.value = detectConstrained();
});

/** The link counts as constrained (cellular, ≤ 3g, data saver, or under 2 Mbit/s). */
export const linkConstrained: ReadonlySignal<boolean> = constrained;
