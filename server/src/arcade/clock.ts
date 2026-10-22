/**
 * The Arcade's only source of time. Everything on the server (scheduler, reapers, tickets, table
 * clocks) reads this, so tests inject a fake clock and run minutes of game time in milliseconds.
 */
export interface Clock {
  /** Wall-clock milliseconds (Date.now()). */
  now(): number;
  /** Monotonic nanoseconds (process.hrtime.bigint()). */
  hr(): bigint;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

/** Real time. Timers are unref'd so a pending Arcade timer never keeps the process alive. */
export const systemClock: Clock = {
  now: () => Date.now(),
  hr: () => process.hrtime.bigint(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};
