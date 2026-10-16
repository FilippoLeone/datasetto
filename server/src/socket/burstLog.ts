import type { Logger } from '../logger.js';

/**
 * Connection logging that survives a deploy: when every client reconnects at
 * once, one line per burst says how many came back instead of one line per
 * socket. A lone event is written as the usual single line; the per-socket
 * detail of a burst is kept at debug level.
 */
export interface BurstLoggerOptions {
  log: Pick<Logger, 'info' | 'debug'>;
  /** Quiet time after the last event that ends a burst. */
  windowMs?: number;
  /** A burst is written after this long even while events keep coming. */
  maxWindowMs?: number;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface BurstLogger {
  /**
   * Count one event of `kind`. `detail` is the line for a lone event (and goes to
   * debug inside a burst); `key` is what the burst line counts as distinct (an ip,
   * an account id).
   */
  record(kind: string, detail: Record<string, unknown>, key?: string | null): void;
  /** Write every pending burst now (shutdown). */
  flush(): void;
  /** Events waiting to be written, per kind. */
  pending(kind: string): number;
}

export const BURST_WINDOW_MS = 2_000;
export const BURST_MAX_WINDOW_MS = 10_000;

interface Burst {
  count: number;
  startedAt: number;
  first: Record<string, unknown>;
  keys: Set<string>;
  timer: unknown;
}

export const createBurstLogger = ({
  log,
  windowMs = BURST_WINDOW_MS,
  maxWindowMs = BURST_MAX_WINDOW_MS,
  now = Date.now,
  setTimeout: schedule = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: cancel = (handle) => clearTimeout(handle as NodeJS.Timeout),
}: BurstLoggerOptions): BurstLogger => {
  const bursts = new Map<string, Burst>();

  const write = (kind: string) => {
    const burst = bursts.get(kind);
    if (!burst) return;
    bursts.delete(kind);
    cancel(burst.timer);
    if (burst.count === 1) {
      log.info(burst.first, kind);
      return;
    }
    log.info(
      { burst: burst.count, distinct: burst.keys.size, durationMs: now() - burst.startedAt, firstSocketId: burst.first.socketId ?? null },
      kind + ' (' + burst.count + ' in a burst)',
    );
  };

  return {
    record(kind, detail, key) {
      const at = now();
      let burst = bursts.get(kind);
      if (!burst) {
        burst = { count: 0, startedAt: at, first: detail, keys: new Set(), timer: null };
        bursts.set(kind, burst);
      } else {
        // Inside a burst the per-socket line is still available, just quieter.
        log.debug(detail, kind);
      }
      burst.count += 1;
      if (key) burst.keys.add(key);
      cancel(burst.timer);
      const deadline = Math.max(0, Math.min(windowMs, burst.startedAt + maxWindowMs - at));
      burst.timer = schedule(() => write(kind), deadline);
    },
    flush() {
      for (const kind of Array.from(bursts.keys())) write(kind);
    },
    pending(kind) {
      return bursts.get(kind)?.count ?? 0;
    },
  };
};
