/**
 * A fake Arcade clock: `now()` and `hr()` move only when the test advances them, and timers fire in
 * order as time passes. Real sockets still deliver in real time, so integration tests advance the
 * clock to drive the scheduler, reapers and tickets, then await the messages that result.
 */
import type { Clock } from '../../../src/arcade/clock.js';

export interface FakeClock extends Clock {
  /** Move time forward, firing every timer that falls due, in order (and those they set up). */
  advance(ms: number): void;
  /** Advance in steps of `stepMs`, yielding to the event loop between steps so sockets can deliver. */
  run(ms: number, stepMs?: number): Promise<void>;
  /** Jump forward WITHOUT firing timers (a stalled event loop); the next advance() fires them late. */
  skip(ms: number): void;
  readonly pending: number;
}

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

export const createFakeClock = (start = Date.UTC(2026, 9, 22, 12, 0, 0)): FakeClock => {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, Timer>();

  const due = (until: number): Timer | null => {
    let best: Timer | null = null;
    for (const timer of timers.values()) if (timer.at <= until && (!best || timer.at < best.at || (timer.at === best.at && timer.id < best.id))) best = timer;
    return best;
  };

  const clock: FakeClock = {
    now: () => now,
    hr: () => BigInt(Math.round(now * 1e6)),
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { id, at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      const until = now + ms;
      for (let guard = 0; guard < 1_000_000; guard += 1) {
        const timer = due(until);
        if (!timer) break;
        timers.delete(timer.id);
        now = Math.max(now, timer.at);
        timer.fn();
      }
      now = until;
    },
    async run(ms, stepMs = 34) {
      for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
        clock.advance(Math.min(stepMs, ms - elapsed));
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    skip(ms) {
      now += ms;
    },
    get pending() {
      return timers.size;
    },
  };
  return clock;
};
