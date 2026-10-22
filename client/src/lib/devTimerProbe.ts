/**
 * Dev builds only: every live interval of 100 ms or less, with the stack that started it, on
 * `window.__timers`. Outside a call there should be none; in a call, the mic meter (50 ms) and
 * the shared speaking check (100 ms). Production builds drop this module's body entirely.
 *
 * It wraps setInterval and clearInterval as soon as it is imported (state/voice.ts imports it,
 * which loads before the app starts any timer).
 */

export interface ShortInterval {
  ms: number;
  /** When it was started (performance.now()). */
  since: number;
  /** Where it was started: the first frames of the stack. */
  stack: string;
}

/** Intervals at or below this period are listed. */
export const SHORT_INTERVAL_MS = 100;

/** Wraps `target`'s setInterval/clearInterval; returns the live short intervals and an uninstall. */
export function installTimerProbe(target: Window = window): { list(): ShortInterval[]; uninstall(): void } {
  const live = new Map<number, ShortInterval>();
  const setInterval = target.setInterval;
  const clearInterval = target.clearInterval;
  target.setInterval = function (handler: TimerHandler, ms?: number, ...args: unknown[]): number {
    const id = setInterval.call(target, handler, ms, ...args);
    const period = Number(ms) || 0;
    if (period <= SHORT_INTERVAL_MS) {
      const stack = (new Error().stack ?? '').split('\n').slice(2, 6).map((line) => line.trim()).join(' | ');
      live.set(id, { ms: period, since: performance.now(), stack });
    }
    return id;
  } as typeof target.setInterval;
  target.clearInterval = function (id?: number): void {
    if (id !== undefined) live.delete(id);
    clearInterval.call(target, id);
  };
  return {
    list: () => [...live.values()],
    uninstall() {
      target.setInterval = setInterval;
      target.clearInterval = clearInterval;
    },
  };
}

declare global {
  interface Window {
    /** Dev builds only: live intervals of 100 ms or less (lib/devTimerProbe.ts). */
    readonly __timers?: ShortInterval[];
  }
}

if (import.meta.env.DEV && import.meta.env.MODE !== 'test' && typeof window !== 'undefined') {
  const probe = installTimerProbe(window);
  Object.defineProperty(window, '__timers', { configurable: true, get: () => probe.list() });
}
