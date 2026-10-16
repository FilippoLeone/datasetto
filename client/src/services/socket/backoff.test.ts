import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKOFF, backoffDelay, createReconnectScheduler, type ReconnectState } from './backoff';

describe('backoffDelay', () => {
  it('doubles from one second and never exceeds the cap, whatever the jitter', () => {
    const mid = { random: () => 0.5 };
    expect([1, 2, 3, 4, 5, 6].map((attempt) => backoffDelay(attempt, mid))).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    expect(backoffDelay(7, mid)).toBe(30000);
    expect(backoffDelay(40, mid)).toBe(30000);
    expect(backoffDelay(0, mid)).toBe(1000);
    for (const value of [0, 0.25, 0.999]) {
      for (let attempt = 1; attempt <= 12; attempt += 1) {
        expect(backoffDelay(attempt, { random: () => value })).toBeLessThanOrEqual(BACKOFF.maxMs);
      }
    }
  });

  it('spreads each delay within the jitter band', () => {
    expect(backoffDelay(3, { random: () => 0 })).toBe(3000);
    expect(backoffDelay(3, { random: () => 1 })).toBe(5000);
    expect(backoffDelay(3, { random: () => 0.5, jitter: 0 })).toBe(4000);
    // A real random source stays inside the band too.
    for (let i = 0; i < 200; i += 1) {
      const delay = backoffDelay(2);
      expect(delay).toBeGreaterThanOrEqual(1500);
      expect(delay).toBeLessThanOrEqual(2500);
    }
  });
});

describe('reconnect scheduler', () => {
  beforeEach(() => vi.useFakeTimers({ now: 100_000 }));
  afterEach(() => vi.useRealTimers());

  const make = () => {
    const connect = vi.fn();
    const states: ReconnectState[] = [];
    const scheduler = createReconnectScheduler({ connect, onChange: (state) => states.push(state), backoff: { random: () => 0.5 } });
    return { connect, states, scheduler };
  };

  it('retries on the backoff schedule, counts attempts, and resets once connected', () => {
    const { connect, scheduler } = make();
    scheduler.schedule();
    expect(scheduler.state).toEqual({ attempt: 0, nextAt: 101_000, waitingFor: 'backoff' });
    // Scheduling again while a timer runs keeps the first timer.
    scheduler.schedule();
    expect(scheduler.state.nextAt).toBe(101_000);
    vi.advanceTimersByTime(999);
    expect(connect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(scheduler.state).toEqual({ attempt: 1, nextAt: null, waitingFor: null });

    // The attempt failed: the next wait doubles.
    scheduler.schedule();
    expect(scheduler.state.nextAt).toBe(Date.now() + 2000);
    vi.advanceTimersByTime(2000);
    expect(connect).toHaveBeenCalledTimes(2);
    scheduler.schedule();
    expect(scheduler.state.nextAt).toBe(Date.now() + 4000);
    vi.advanceTimersByTime(4000);
    expect(scheduler.state.attempt).toBe(3);

    scheduler.connected();
    expect(scheduler.state).toEqual({ attempt: 0, nextAt: null, waitingFor: null });
    scheduler.schedule();
    expect(scheduler.state.nextAt).toBe(Date.now() + 1000);
  });

  it('caps the wait at 30 s however many attempts failed', () => {
    const { scheduler } = make();
    for (let i = 0; i < 10; i += 1) {
      scheduler.schedule();
      const wait = scheduler.state.nextAt! - Date.now();
      expect(wait).toBeLessThanOrEqual(30_000);
      vi.advanceTimersByTime(wait);
    }
    expect(scheduler.state.attempt).toBe(10);
    scheduler.schedule();
    expect(scheduler.state.nextAt! - Date.now()).toBe(30_000);
  });

  it('uses the announced restart wait for the next attempt, then goes back to the backoff', () => {
    const { connect, scheduler } = make();
    // The notice usually comes right before the drop.
    scheduler.expectBackIn(7_000);
    scheduler.schedule();
    expect(scheduler.state).toEqual({ attempt: 0, nextAt: 107_000, waitingFor: 'server' });
    vi.advanceTimersByTime(7_000);
    expect(connect).toHaveBeenCalledTimes(1);
    scheduler.schedule();
    expect(scheduler.state.waitingFor).toBe('backoff');
    expect(scheduler.state.nextAt).toBe(Date.now() + 2000);

    // A notice that arrives while a backoff timer runs replaces it, and is clamped to the cap.
    scheduler.expectBackIn(90_000);
    expect(scheduler.state).toEqual({ attempt: 1, nextAt: Date.now() + 30_000, waitingFor: 'server' });
  });

  it('retries at once on demand and when the network comes back, and holds while offline', () => {
    const { connect, scheduler, states } = make();
    scheduler.schedule();
    scheduler.retryNow();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(scheduler.state).toEqual({ attempt: 1, nextAt: null, waitingFor: null });
    vi.advanceTimersByTime(60_000);
    expect(connect).toHaveBeenCalledTimes(1);

    scheduler.offline();
    expect(scheduler.state.waitingFor).toBe('network');
    scheduler.schedule();
    expect(scheduler.state.nextAt).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(connect).toHaveBeenCalledTimes(1);

    // `online`: immediate attempt, and the following failures schedule normally again.
    scheduler.retryNow();
    expect(connect).toHaveBeenCalledTimes(2);
    scheduler.schedule();
    expect(scheduler.state.waitingFor).toBe('backoff');
    expect(states.length).toBeGreaterThan(0);

    scheduler.stop();
    expect(scheduler.state).toEqual({ attempt: 0, nextAt: null, waitingFor: null });
    vi.advanceTimersByTime(60_000);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
