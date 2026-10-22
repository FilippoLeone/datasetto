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
  /** Skip callbacks closer than 1000/maxFps − 1 ms. When every subscriber asks for ≤ 15, the scheduler uses setTimeout plus one rAF. */
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

const LOW_RATE_FPS = 15;

const createFrames = () => {
  const subs = new Set<FrameSub>();
  let onceQueue: Array<(now: number) => void> = [];
  let raf: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const lowRate = (): boolean => {
    if (onceQueue.length > 0 || subs.size === 0) return false;
    for (const sub of subs) if (!(sub.maxFps > 0 && sub.maxFps <= LOW_RATE_FPS)) return false;
    return true;
  };

  const tick = (now: number): void => {
    raf = null;
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
    schedule();
  };

  const schedule = (): void => {
    if (raf !== null || timer !== null) return;
    if (subs.size === 0 && onceQueue.length === 0) return;
    if (lowRate()) {
      let soonest = Infinity;
      const now = performance.now();
      for (const sub of subs) soonest = Math.min(soonest, sub.last + 1000 / sub.maxFps - now);
      timer = setTimeout(() => {
        timer = null;
        if (raf === null) raf = requestAnimationFrame(tick);
      }, Math.max(0, Math.min(1000, soonest - 8)));
      return;
    }
    raf = requestAnimationFrame(tick);
  };

  const stopIfIdle = (): void => {
    if (subs.size > 0 || onceQueue.length > 0) return;
    if (raf !== null) cancelAnimationFrame(raf);
    if (timer !== null) clearTimeout(timer);
    raf = null;
    timer = null;
  };

  const api = {
    add(cb: (now: number, dt: number) => void, opts: FrameOpts = {}): () => void {
      const sub: FrameSub = { cb, maxFps: opts.maxFps ?? 0, label: opts.label ?? 'anonymous', last: 0 };
      subs.add(sub);
      // A full-rate subscriber must not wait out a low-rate timer.
      if (timer !== null && !lowRate()) {
        clearTimeout(timer);
        timer = null;
      }
      schedule();
      return () => {
        subs.delete(sub);
        stopIfIdle();
      };
    },
    once(cb: (now: number) => void): void {
      onceQueue.push(cb);
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
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
