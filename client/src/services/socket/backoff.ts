/**
 * Reconnect pacing. A dropped connection is retried with exponential backoff
 * (1 s, 2 s, 4 s … capped at 30 s) and jitter so a whole friend group does not
 * knock on the door in the same millisecond after a deploy. Three things cut
 * the wait short: the server's own "back in about N seconds" notice replaces the
 * first delay, the browser's `online` event retries at once, and so does the
 * "Retry now" button in the banner.
 */
export interface BackoffOptions {
  /** First delay. */
  baseMs?: number;
  /** Longest delay, jitter included. */
  maxMs?: number;
  factor?: number;
  /** Spread around the computed delay: 0.5 means anywhere from 75 % to 125 % of it. */
  jitter?: number;
  /** Uniform [0, 1) source; injectable for tests. */
  random?: () => number;
}

export const BACKOFF = { baseMs: 1_000, maxMs: 30_000, factor: 2, jitter: 0.5 } as const;

/** Delay in ms before reconnect attempt `attempt` (1 is the first retry). */
export const backoffDelay = (attempt: number, options: BackoffOptions = {}): number => {
  const { baseMs = BACKOFF.baseMs, maxMs = BACKOFF.maxMs, factor = BACKOFF.factor, jitter = BACKOFF.jitter, random = Math.random } = options;
  const exponent = Math.max(0, Math.min(attempt, 1) === 0 ? 0 : attempt - 1);
  const raw = Math.min(maxMs, baseMs * Math.pow(factor, Math.min(exponent, 30)));
  const spread = raw * jitter;
  const jittered = raw - spread / 2 + random() * spread;
  return Math.round(Math.min(maxMs, Math.max(0, jittered)));
};

export type WaitingFor = 'backoff' | 'server' | 'network' | null;

export interface ReconnectState {
  /** Attempts made since the last successful connection. */
  attempt: number;
  /** When the next attempt fires; null while none is scheduled. */
  nextAt: number | null;
  /** Why we are waiting: the backoff timer, the server's announced restart, or the network being down. */
  waitingFor: WaitingFor;
}

export interface ReconnectSchedulerOptions {
  /** Start one connection attempt. */
  connect: () => void;
  onChange?: (state: ReconnectState) => void;
  backoff?: BackoffOptions;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface ReconnectScheduler {
  /** The connection dropped or an attempt failed: schedule the next attempt (no-op while one is scheduled). */
  schedule(): void;
  /** The server said it will be back in `ms`: the next attempt waits that long instead of the backoff. */
  expectBackIn(ms: number): void;
  /** Try now (the banner button, the browser's `online` event, the page becoming visible). */
  retryNow(): void;
  /** Connected: reset the attempt count and any pending timer. */
  connected(): void;
  /** The browser reports no network: hold attempts until `retryNow()`. */
  offline(): void;
  /** Forget everything (the socket was closed on purpose). */
  stop(): void;
  readonly state: ReconnectState;
}

export const createReconnectScheduler = ({
  connect,
  onChange,
  backoff = {},
  now = Date.now,
  setTimeout: schedule = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: cancel = (handle) => globalThis.clearTimeout(handle as number),
}: ReconnectSchedulerOptions): ReconnectScheduler => {
  const state: ReconnectState = { attempt: 0, nextAt: null, waitingFor: null };
  let timer: unknown = null;
  let hintMs: number | null = null;
  let networkDown = false;

  const notify = () => onChange?.({ ...state });

  const clearTimer = () => {
    if (timer !== null) cancel(timer);
    timer = null;
    state.nextAt = null;
  };

  const attempt = () => {
    clearTimer();
    state.attempt += 1;
    state.waitingFor = null;
    notify();
    connect();
  };

  return {
    get state() {
      return { ...state };
    },
    schedule() {
      if (timer !== null) return;
      if (networkDown) {
        state.waitingFor = 'network';
        notify();
        return;
      }
      const delay = hintMs ?? backoffDelay(state.attempt + 1, backoff);
      state.waitingFor = hintMs !== null ? 'server' : 'backoff';
      hintMs = null;
      state.nextAt = now() + delay;
      timer = schedule(attempt, delay);
      notify();
    },
    expectBackIn(ms) {
      hintMs = Math.max(0, Math.min(ms, backoff.maxMs ?? BACKOFF.maxMs));
      // A timer already running (the drop came first) is replaced by the announced wait.
      if (timer !== null) {
        clearTimer();
        this.schedule();
      }
    },
    retryNow() {
      networkDown = false;
      hintMs = null;
      attempt();
    },
    connected() {
      clearTimer();
      state.attempt = 0;
      state.waitingFor = null;
      hintMs = null;
      networkDown = false;
      notify();
    },
    offline() {
      networkDown = true;
      clearTimer();
      state.waitingFor = 'network';
      notify();
    },
    stop() {
      clearTimer();
      state.attempt = 0;
      state.waitingFor = null;
      hintMs = null;
      networkDown = false;
      notify();
    },
  };
};
