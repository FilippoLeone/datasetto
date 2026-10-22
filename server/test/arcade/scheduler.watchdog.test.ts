/**
 * The scheduler runs only while a match needs it (30 Hz while one is active, 4 Hz while only
 * BEATs are owed, no timer otherwise) and catches up at most 3 ticks; the watchdog ends slow
 * matches and walks the degrade ladder on egress and event-loop delay (platform.md §6.5, §13).
 */
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import type { ServerMatch } from '../../src/arcade/match.js';
import { createScheduler } from '../../src/arcade/scheduler.js';
import { createWatchdog } from '../../src/arcade/watchdog.js';
import { createFakeClock } from './harness/clock.js';

const log = pino({ level: 'silent' });

const fakeMatch = (state: { active: boolean; sending: boolean; ended?: boolean }) => {
  const calls = { step: 0, send: 0, abort: 0 };
  const match = {
    id: 'm',
    get active() {
      return state.active;
    },
    get sending() {
      return state.sending;
    },
    get ended() {
      return state.ended ?? false;
    },
    step: () => {
      calls.step += 1;
      return 0.1;
    },
    send: () => {
      calls.send += 1;
    },
    abort: () => {
      calls.abort += 1;
      state.ended = true;
    },
  } as unknown as ServerMatch;
  return { match, calls };
};

describe('scheduler', () => {
  it('holds no timer without a match, ticks at 30 Hz while one is active, 4 Hz while only sending, then stops', () => {
    const clock = createFakeClock();
    const scheduler = createScheduler({ clock, onStep: () => false });
    expect(clock.pending).toBe(0);
    const state = { active: true, sending: true };
    const { match, calls } = fakeMatch(state);
    scheduler.add(match);
    expect(scheduler.mode).toBe('fast');
    clock.advance(1000);
    expect(calls.step).toBeGreaterThanOrEqual(29);
    expect(calls.step).toBeLessThanOrEqual(31);
    state.active = false;
    clock.advance(100);
    const steps = calls.step;
    const sends = calls.send;
    clock.advance(1000);
    expect(scheduler.mode).toBe('slow');
    expect(calls.step).toBe(steps);
    expect(calls.send - sends).toBeGreaterThanOrEqual(3);
    expect(calls.send - sends).toBeLessThanOrEqual(5);
    state.sending = false;
    clock.advance(500);
    expect(scheduler.mode).toBe('stopped');
    expect(clock.pending).toBe(0);
    // Woken again by activity.
    state.active = true;
    scheduler.wake();
    expect(scheduler.mode).toBe('fast');
    scheduler.stop();
    expect(clock.pending).toBe(0);
  });

  it('catches up at most 3 ticks after a stall, then drops the backlog', () => {
    const clock = createFakeClock();
    const scheduler = createScheduler({ clock, onStep: () => false });
    const { match, calls } = fakeMatch({ active: true, sending: true });
    scheduler.add(match);
    clock.advance(34);
    const before = calls.step;
    // The event loop stalls for 1 s: the next timer fires that late.
    clock.skip(1000);
    clock.advance(0);
    expect(calls.step - before).toBeLessThanOrEqual(3);
    // Then the 30 Hz rhythm resumes without a burst.
    const resumed = calls.step;
    clock.advance(100);
    expect(calls.step - resumed).toBeLessThanOrEqual(4);
    scheduler.stop();
  });

  it('ends a match the watchdog flags as overloaded', () => {
    const clock = createFakeClock();
    const scheduler = createScheduler({ clock, onStep: () => true });
    const { match, calls } = fakeMatch({ active: true, sending: true });
    scheduler.add(match);
    clock.advance(100);
    expect(calls.abort).toBe(1);
    scheduler.stop();
  });
});

describe('watchdog', () => {
  it('ends a match after one step over 20 ms or three over 4 ms in a row', () => {
    const clock = createFakeClock();
    const watchdog = createWatchdog({ clock, log, egressKbps: () => 1500, loopP99: () => 0 });
    expect(watchdog.step('a', 25)).toBe(true);
    expect(watchdog.step('b', 5)).toBe(false);
    expect(watchdog.step('b', 5)).toBe(false);
    expect(watchdog.step('b', 1)).toBe(false);
    expect(watchdog.step('b', 5)).toBe(false);
    expect(watchdog.step('b', 5)).toBe(false);
    expect(watchdog.step('b', 5)).toBe(true);
  });

  it('raises the degrade level on egress over the limit and lowers it when calm, with no timer while idle', () => {
    const clock = createFakeClock();
    const watchdog = createWatchdog({ clock, log, egressKbps: () => 1500, loopP99: () => 0 });
    expect(clock.pending).toBe(0);
    watchdog.setActive(true);
    for (let s = 0; s < 3; s += 1) {
      watchdog.egress(250_000); // 2,000 kbit/s
      clock.advance(1000);
    }
    expect(watchdog.level).toBe(3);
    for (let s = 0; s < 3; s += 1) {
      watchdog.egress(10_000);
      clock.advance(1000);
    }
    expect(watchdog.level).toBe(0);
    watchdog.setActive(false);
    expect(clock.pending).toBe(0);
  });

  it('refuses new matches on event-loop delay until it stays under 20 ms for 30 s', () => {
    const clock = createFakeClock();
    let p99 = 35;
    const watchdog = createWatchdog({ clock, log, egressKbps: () => 1500, loopP99: () => p99 });
    watchdog.setActive(true);
    clock.advance(10_000);
    expect(watchdog.level).toBe(1);
    expect(watchdog.refuseMatches).toBe(true);
    p99 = 10;
    clock.advance(20_000);
    expect(watchdog.refuseMatches).toBe(true);
    clock.advance(20_000);
    expect(watchdog.refuseMatches).toBe(false);
    watchdog.stop();
    expect(clock.pending).toBe(0);
  });

  it('clears a hot event loop after the last match has ended, then stops sampling', () => {
    const clock = createFakeClock();
    let p99 = 35;
    const watchdog = createWatchdog({ clock, log, egressKbps: () => 1500, loopP99: () => p99 });
    watchdog.setActive(true);
    clock.advance(10_000);
    expect(watchdog.refuseMatches).toBe(true);
    // The last match ends while the loop is hot: sampling goes on, so calm can still clear it.
    watchdog.setActive(false);
    expect(clock.pending).toBe(1);
    p99 = 10;
    clock.advance(40_000);
    expect(watchdog.refuseMatches).toBe(false);
    expect(watchdog.level).toBe(0);
    expect(clock.pending).toBe(0);
    // A new match after that starts fresh, with one loop timer.
    watchdog.setActive(true);
    expect(clock.pending).toBe(2);
    watchdog.stop();
    expect(clock.pending).toBe(0);
  });
});
