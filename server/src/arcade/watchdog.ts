/**
 * Runaway-sim safety and the degrade ladder (platform.md §6.5, §13.2–13.4).
 *
 * - Per-step timing: a match whose step takes over 20 ms once, or over 4 ms on 3 consecutive ticks,
 *   ends as "overload" (with a HANDOVER and a replay dump, match.ts).
 * - Event-loop delay: `monitorEventLoopDelay` sampled every 10 s while any match exists. A p99 above
 *   30 ms raises the degrade level; new matches stay refused until p99 stays under 20 ms for 30 s.
 *   The histogram records the whole interval between samples, so the sampling resolution is taken
 *   off first (an idle loop reads about 20 ms on Linux and about 31 ms on Windows, whose timer ticks
 *   every 15.6 ms).
 * - Lane egress: summed per second; above `egressKbps` the level rises one step per second.
 *
 * Degrade levels: 1 spectators to d = 6; 2 players' default to d = 3; 3 new spectators refused;
 * 4 new matches refused.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

/** The histogram's sampling interval; its readings include it. */
const LOOP_RESOLUTION_MS = 20;

type LoopHistogram = ReturnType<typeof monitorEventLoopDelay>;
import type { Logger } from '../logger.js';
import type { Clock } from './clock.js';

export interface Watchdog {
  /** A match's step time; true = end it as overloaded. */
  step(matchId: string, ms: number): boolean;
  forget(matchId: string): void;
  /** Lane wire bytes sent. */
  egress(bytes: number): void;
  /** 0 normal … 4 refuse new matches. */
  readonly level: number;
  /** New matches are refused: level 4, or the event loop has not been calm (p99 < 20 ms) for 30 s. */
  readonly refuseMatches: boolean;
  /** Matches exist: run the samplers (10 s loop delay, 1 s egress). */
  setActive(active: boolean): void;
  stop(): void;
  readonly stats: { loopP99Ms: number; egressKbps: number };
}

export interface WatchdogOptions {
  clock: Clock;
  log: Logger;
  egressKbps(): number;
  /** Tests inject a fake loop-delay p99 (ms). */
  loopP99?(): number;
}

export const STEP_LIMIT_MS = 20;
export const STEP_SLOW_MS = 4;
export const STEP_SLOW_RUN = 3;

export const createWatchdog = (o: WatchdogOptions): Watchdog => {
  const { clock, log } = o;
  const slowRuns = new Map<string, number>();
  let level = 0;
  let egressBytes = 0;
  let egressKbps = 0;
  let loopP99 = 0;
  let loopCalmSince: number | null = null;
  let loopHot = false;
  let active = false;
  let histogram: LoopHistogram | null = null;
  let secondTimer: unknown = null;
  let loopTimer: unknown = null;

  const setLevel = (next: number, why: string): void => {
    const bounded = Math.max(0, Math.min(4, next));
    if (bounded === level) return;
    log.info({ from: level, to: bounded, why, egressKbps, loopP99 }, 'arcade degrade level changed');
    level = bounded;
  };

  const everySecond = (): void => {
    secondTimer = null;
    egressKbps = (egressBytes * 8) / 1000;
    egressBytes = 0;
    if (egressKbps > o.egressKbps()) setLevel(level + 1, 'egress');
    else if (!loopHot && level > 0 && egressKbps < o.egressKbps() * 0.7) setLevel(level - 1, 'egress calm');
    if (active) secondTimer = clock.setTimeout(everySecond, 1000);
  };

  const everyTenSeconds = (): void => {
    loopTimer = null;
    loopP99 = o.loopP99 ? o.loopP99() : histogram ? Math.max(0, histogram.percentile(99) / 1e6 - LOOP_RESOLUTION_MS) : 0;
    histogram?.reset();
    const now = clock.now();
    if (loopP99 > 30) {
      loopHot = true;
      loopCalmSince = null;
      setLevel(level + 1, 'event loop delay');
    } else if (loopHot) {
      if (loopP99 < 20) {
        loopCalmSince ??= now;
        if (now - loopCalmSince >= 30_000) {
          loopHot = false;
          loopCalmSince = null;
          setLevel(active ? level - 1 : 0, active ? 'event loop calm' : 'event loop calm, no matches');
        }
      } else loopCalmSince = null;
    }
    // While the loop is hot the sampling goes on even with no match left, or nothing could ever
    // clear it and new matches would stay refused until a restart.
    if (active || loopHot) loopTimer = clock.setTimeout(everyTenSeconds, 10_000);
    else stopLoopSampling();
  };

  const stopLoopSampling = (): void => {
    if (loopTimer !== null) clock.clearTimeout(loopTimer);
    loopTimer = null;
    histogram?.disable();
    histogram = null;
  };

  const stopTimers = (): void => {
    if (secondTimer !== null) clock.clearTimeout(secondTimer);
    secondTimer = null;
    stopLoopSampling();
  };

  return {
    step(matchId, ms) {
      if (ms > STEP_LIMIT_MS) {
        slowRuns.delete(matchId);
        return true;
      }
      if (ms > STEP_SLOW_MS) {
        const run = (slowRuns.get(matchId) ?? 0) + 1;
        slowRuns.set(matchId, run);
        if (run >= STEP_SLOW_RUN) {
          slowRuns.delete(matchId);
          return true;
        }
      } else if (slowRuns.has(matchId)) slowRuns.delete(matchId);
      return false;
    },
    forget(matchId) {
      slowRuns.delete(matchId);
    },
    egress(bytes) {
      egressBytes += bytes;
    },
    get level() {
      return level;
    },
    get refuseMatches() {
      return level >= 4 || loopHot;
    },
    setActive(next) {
      if (next === active) return;
      active = next;
      if (active) {
        // Sampling may still be running from a hot spell after the last match ended.
        if (!o.loopP99 && histogram === null) {
          histogram = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
          histogram.enable();
        }
        secondTimer = clock.setTimeout(everySecond, 1000);
        loopTimer ??= clock.setTimeout(everyTenSeconds, 10_000);
      } else {
        if (secondTimer !== null) clock.clearTimeout(secondTimer);
        secondTimer = null;
        if (loopHot) return;
        stopLoopSampling();
        setLevel(0, 'no matches');
      }
    },
    stop() {
      active = false;
      stopTimers();
    },
    get stats() {
      return { loopP99Ms: loopP99, egressKbps };
    },
  };
};
