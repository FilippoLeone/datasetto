/**
 * One drift-corrected 30 Hz loop for every action match (platform.md §13.1, plan.md §1.3 #25).
 * `setTimeout` against a `process.hrtime.bigint()` target, catching up at most 3 steps and then
 * dropping the backlog. It runs fast only while some match is not idle; while every match is idle but
 * some recipient still needs traffic (a BEAT for a live or yielding client) it runs at 4 Hz; otherwise
 * it stops. With no match it holds no timer at all.
 */
import type { Clock } from './clock.js';
import { TICK_MS } from './core/net/lane.js';
import type { ServerMatch } from './match.js';

export interface Scheduler {
  add(match: ServerMatch): void;
  remove(match: ServerMatch): void;
  /** Something changed (a message, an attach): make sure the loop runs if it should. */
  wake(): void;
  stop(): void;
  readonly mode: 'fast' | 'slow' | 'stopped';
  /** µs since the current tick started (PONG's tickPhaseUs). */
  tickPhaseUs(): number;
  readonly matches: number;
}

export interface SchedulerOptions {
  clock: Clock;
  /** Per-match step time, for the watchdog; returns true when the match must end as overloaded. */
  onStep(match: ServerMatch, ms: number): boolean;
  /** After each tick with the total step time of every match (ms). */
  onTick?(totalMs: number): void;
}

const TICK_NS = BigInt(Math.round(TICK_MS * 1e6));
const SLOW_MS = 250;
const MAX_CATCH_UP = 3;

export const createScheduler = (o: SchedulerOptions): Scheduler => {
  const { clock } = o;
  const matches = new Set<ServerMatch>();
  let timer: unknown = null;
  let mode: Scheduler['mode'] = 'stopped';
  let target = 0n;
  let tickStartHr = clock.hr();

  const wanted = (): Scheduler['mode'] => {
    let slow = false;
    for (const match of matches) {
      if (match.ended) continue;
      if (match.active) return 'fast';
      if (match.sending) slow = true;
    }
    return slow ? 'slow' : 'stopped';
  };

  const tick = (step: boolean): void => {
    tickStartHr = clock.hr();
    let total = 0;
    for (const match of Array.from(matches)) {
      if (match.ended) {
        matches.delete(match);
        continue;
      }
      if (step && match.active) {
        const ms = match.step();
        total += ms;
        if (!match.ended && o.onStep(match, ms)) {
          match.abort('overload');
          continue;
        }
      }
      if (!match.ended) match.send();
      else matches.delete(match);
    }
    o.onTick?.(total);
  };

  const schedule = (): void => {
    timer = null;
    const next = wanted();
    if (next === 'stopped') {
      mode = 'stopped';
      return;
    }
    if (next === 'slow') {
      if (mode !== 'slow') mode = 'slow';
      timer = clock.setTimeout(() => {
        tick(false);
        if (wanted() === 'fast') target = clock.hr();
        schedule();
      }, SLOW_MS);
      return;
    }
    if (mode !== 'fast') {
      mode = 'fast';
      target = clock.hr() + TICK_NS;
    }
    const delayMs = Math.max(0, Number(target - clock.hr()) / 1e6);
    timer = clock.setTimeout(() => {
      const now = clock.hr();
      let steps = 0;
      while (target <= now && steps < MAX_CATCH_UP) {
        tick(true);
        target += TICK_NS;
        steps += 1;
      }
      // Too far behind: drop the backlog instead of bursting.
      if (target <= now) target = now + TICK_NS;
      if (steps === 0) {
        tick(true);
        target += TICK_NS;
      }
      schedule();
    }, delayMs);
  };

  const wake = (): void => {
    if (timer !== null) {
      if (mode === 'slow' && wanted() === 'fast') {
        clock.clearTimeout(timer);
        timer = null;
        mode = 'stopped';
        schedule();
      }
      return;
    }
    schedule();
  };

  return {
    add(match) {
      matches.add(match);
      wake();
    },
    remove(match) {
      matches.delete(match);
    },
    wake,
    stop() {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      mode = 'stopped';
      matches.clear();
    },
    get mode() {
      return mode;
    },
    tickPhaseUs: () => Number(clock.hr() - tickStartHr) / 1000,
    get matches() {
      return matches.size;
    },
  };
};
