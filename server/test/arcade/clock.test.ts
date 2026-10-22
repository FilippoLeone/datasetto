/**
 * The client's server-tick estimate from PING/PONG (server/src/arcade/core/net/clock.ts,
 * platform.md §8.4), driven by a simulated server whose clock runs at an offset from the client's.
 */
import { describe, expect, it } from 'vitest';
import { createTickClock, type TickClock } from '../../src/arcade/core/net/clock.js';
import { TICK_MS } from '../../src/arcade/core/net/lane.js';
import { xorshift32 } from '../../src/arcade/core/rng.js';

const seeded = (seed: number): (() => number) => {
  let s = seed >>> 0 || 1;
  return () => (s = xorshift32(s));
};

/** The server's clock reads client time + OFFSET ms. */
const OFFSET = 123_456.789;
const trueTick = (clientMs: number): number => (clientMs + OFFSET) / TICK_MS;

/**
 * One PING/PONG exchange: sent at client time `sentMs`, reaches the server after `upMs`, whose
 * reply (whole tick plus the phase inside it, as PONG carries them) is back after `downMs`.
 */
const exchange = (clock: TickClock, sentMs: number, upMs: number, downMs: number): number => {
  const serverMs = sentMs + upMs + OFFSET;
  const whole = Math.floor(serverMs / TICK_MS);
  const phaseUs = Math.round((serverMs - whole * TICK_MS) * 1000);
  const nowMs = sentMs + upMs + downMs;
  clock.onPong(sentMs, nowMs, whole, phaseUs);
  return nowMs;
};

describe('createTickClock', () => {
  it('is not ready and reads 0 before the first PONG', () => {
    const clock = createTickClock();
    expect(clock.ready).toBe(false);
    expect(clock.serverTickAt(1000)).toBe(0);
    expect(clock.rttMs).toBe(0);
    expect(clock.jitterP90Ms).toBe(0);
  });

  it('converges on the server tick with a constant, symmetric RTT', () => {
    const clock = createTickClock();
    let t = 5000;
    for (let i = 0; i < 12; i += 1) {
      const now = exchange(clock, t, 60, 60);
      expect(clock.ready).toBe(true);
      // Within a microsecond of phase rounding, at the PONG and 1.7 s later.
      expect(Math.abs(clock.serverTickAt(now) - trueTick(now))).toBeLessThan(0.001);
      expect(Math.abs(clock.serverTickAt(now + 1700) - trueTick(now + 1700))).toBeLessThan(0.001);
      t += i < 4 ? 200 : 2000;
    }
    expect(clock.rttMs).toBeCloseTo(120, 9);
    expect(clock.jitterP90Ms).toBe(0);
  });

  it('anchors on the minimum-RTT sample, so queueing on one path does not drag the clock', () => {
    const next = seeded(0xc10c);
    const clock = createTickClock();
    let t = 1000;
    let last = 0;
    for (let i = 0; i < 8; i += 1) {
      // The return path carries 0–250 ms of queueing, except on one clean exchange.
      const extra = i === 5 ? 0 : 20 + (next() % 230);
      last = exchange(clock, t, 50, 50 + extra);
      t += 2000;
    }
    expect(Math.abs(clock.serverTickAt(last) - trueTick(last))).toBeLessThan(0.001);
    expect(Math.abs(clock.serverTickAt(last + 5000) - trueTick(last + 5000))).toBeLessThan(0.001);

    // A late spike afterwards (2 s on the return path) leaves the estimate where it was.
    const spike = exchange(clock, t, 50, 2050);
    expect(Math.abs(clock.serverTickAt(spike) - trueTick(spike))).toBeLessThan(0.001);
  });

  it('a naive estimate from the latest sample would have been off, for contrast', () => {
    const clock = createTickClock();
    const now = exchange(clock, 1000, 50, 250); // only an asymmetric sample so far
    // Half the asymmetry, 100 ms, is 3 ticks of error, which the min-RTT choice later removes.
    expect(trueTick(now) - clock.serverTickAt(now)).toBeCloseTo(100 / TICK_MS, 3);
    const clean = exchange(clock, 3000, 50, 50);
    expect(Math.abs(clock.serverTickAt(clean) - trueTick(clean))).toBeLessThan(0.001);
  });

  it('forgets samples older than the last 8', () => {
    const clock = createTickClock();
    let t = 0;
    exchange(clock, t, 25, 25); // RTT 50: the best, for now
    for (let i = 0; i < 8; i += 1) {
      t += 2000;
      exchange(clock, t, 50, 70); // RTT 120, asymmetric by 20 ms
    }
    // The clean sample left the window: the estimate now carries the 10 ms asymmetry error.
    expect(trueTick(t + 120) - clock.serverTickAt(t + 120)).toBeCloseTo(10 / TICK_MS, 3);
    expect(clock.jitterP90Ms).toBe(0);
  });

  it('reports jitterP90 as the 90th percentile of RTT above the minimum, over the last 8', () => {
    const clock = createTickClock();
    const rtts = [100, 140, 110, 180, 120, 105, 160, 130];
    rtts.forEach((rtt, i) => exchange(clock, i * 2000, rtt / 2, rtt / 2));
    // Spreads above the minimum, sorted: 0 5 10 20 30 40 60 80; index floor(8 × 0.9) = 7.
    expect(clock.jitterP90Ms).toBe(80);

    const two = createTickClock();
    exchange(two, 0, 50, 50);
    expect(two.jitterP90Ms).toBe(0);
    exchange(two, 2000, 70, 70);
    expect(two.jitterP90Ms).toBe(40);
  });

  it('smooths rttMs with a 1/8 EWMA and clamps a negative RTT to 0', () => {
    const clock = createTickClock();
    exchange(clock, 0, 50, 50);
    exchange(clock, 2000, 100, 100);
    expect(clock.rttMs).toBeCloseTo(0.875 * 100 + 0.125 * 200, 9);

    const odd = createTickClock();
    odd.onPong(500, 400, 10, 0); // a PONG "before" its PING: RTT counts as 0
    expect(odd.rttMs).toBe(0);
    expect(odd.serverTickAt(400)).toBe(10);
  });
});
