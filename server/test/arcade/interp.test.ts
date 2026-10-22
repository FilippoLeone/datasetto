/**
 * Interpolation by server tick (server/src/arcade/core/net/interp.ts, platform.md §8.4): the delay
 * from the divisor and jitter, and the tick ring that brackets a render tick.
 */
import { describe, expect, it } from 'vitest';
import { EXTRAP_TICKS, createTickRing, interpDelayMs } from '../../src/arcade/core/net/interp.js';
import { DIVISORS, TICK_MS } from '../../src/arcade/core/net/lane.js';

describe('interpDelayMs', () => {
  it('is 2 × interval + jitter, clamped to [100, 300]', () => {
    expect(interpDelayMs(2, 0)).toBeCloseTo(4 * TICK_MS, 9); // 133.3
    expect(interpDelayMs(3, 0)).toBeCloseTo(200, 9);
    expect(interpDelayMs(4, 0)).toBeCloseTo(8 * TICK_MS, 9); // 266.7
    expect(interpDelayMs(6, 0)).toBe(300); // 400 before the clamp
    expect(interpDelayMs(2, 50)).toBeCloseTo(4 * TICK_MS + 50, 9);
    expect(interpDelayMs(2, 1000)).toBe(300);
    expect(interpDelayMs(3, 99.9)).toBeCloseTo(299.9, 9);
    expect(interpDelayMs(2, -80)).toBeCloseTo(4 * TICK_MS, 9); // negative jitter counts as none
    for (const d of DIVISORS) {
      for (const j of [-50, 0, 1, 10, 33, 100, 167, 250, 1e6]) {
        const v = interpDelayMs(d, j);
        expect(v).toBeGreaterThanOrEqual(100);
        expect(v).toBeLessThanOrEqual(300);
      }
    }
  });

  it('is 0 for a local host (divisor 1), whatever the jitter', () => {
    expect(interpDelayMs(1, 0)).toBe(0);
    expect(interpDelayMs(1, 500)).toBe(0);
  });
});

describe('createTickRing', () => {
  /** A ring plus the x stored for each slot, so brackets can be checked as positions. */
  const ringWith = (capacity: number) => {
    const ring = createTickRing(capacity);
    const x = new Float64Array(capacity);
    const push = (tick: number, value: number): number => {
      const slot = ring.push(tick);
      if (slot >= 0) x[slot] = value;
      return slot;
    };
    const at = (renderTick: number): { value: number; mode: string } | null => {
      const b = ring.bracket(renderTick);
      if (b === null) return null;
      return { value: (x[b.a] as number) + ((x[b.b] as number) - (x[b.a] as number)) * b.t, mode: b.mode };
    };
    return { ring, push, at };
  };

  it('is empty until the first push, then holds a single sample', () => {
    const { ring, push, at } = ringWith(8);
    expect(ring.bracket(5)).toBeNull();
    expect(ring.size).toBe(0);
    push(10, 100);
    expect(at(10)).toEqual({ value: 100, mode: 'hold' });
    expect(at(12)).toEqual({ value: 100, mode: 'hold' });
    expect(at(3)).toEqual({ value: 100, mode: 'hold' });
  });

  it('interpolates between samples, extrapolates up to 100 ms past the newest, then holds', () => {
    const { push, at } = ringWith(8);
    push(10, 100);
    push(12, 120);
    push(14, 140);
    expect(at(11)).toEqual({ value: 110, mode: 'interp' });
    expect(at(12)).toEqual({ value: 120, mode: 'interp' });
    expect(at(13.5)).toEqual({ value: 135, mode: 'interp' });
    expect(at(14)).toEqual({ value: 140, mode: 'extrap' });
    expect(at(15)).toEqual({ value: 150, mode: 'extrap' });
    expect(EXTRAP_TICKS * TICK_MS).toBeCloseTo(100, 9);
    expect(at(14 + EXTRAP_TICKS)).toEqual({ value: 170, mode: 'extrap' });
    expect(at(14 + EXTRAP_TICKS + 0.01)).toEqual({ value: 140, mode: 'hold' });
    // Older than anything kept: hold at the oldest sample.
    expect(at(9)).toEqual({ value: 100, mode: 'hold' });
  });

  it('wraps at its capacity, keeping the newest samples', () => {
    const { ring, push, at } = ringWith(4);
    const slots: number[] = [];
    for (let t = 1; t <= 10; t += 1) slots.push(push(t, t * 10));
    expect(ring.size).toBe(4);
    expect(slots).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0, 1]);
    expect(at(8.5)).toEqual({ value: 85, mode: 'interp' });
    expect(at(7)).toEqual({ value: 70, mode: 'interp' });
    expect(at(9.25)).toEqual({ value: 92.5, mode: 'interp' });
    // Tick 6 was overwritten: the oldest kept is 7.
    expect(at(6.5)).toEqual({ value: 70, mode: 'hold' });
    expect(at(11)).toEqual({ value: 110, mode: 'extrap' });
  });

  it('refuses an out-of-order push and reuses the slot for an equal tick', () => {
    const { ring, push } = ringWith(4);
    const a = push(20, 1);
    const b = push(22, 2);
    expect(push(21, 3)).toBe(-1);
    expect(push(19, 3)).toBe(-1);
    expect(push(22, 4)).toBe(b);
    expect(ring.size).toBe(2);
    expect(a).not.toBe(b);
    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.bracket(22)).toBeNull();
    expect(ring.push(5)).toBe(0);
  });

  it('brackets uneven gaps between samples (skipped slots)', () => {
    const { push, at } = ringWith(16);
    push(100, 0);
    push(106, 60); // two slots skipped
    push(108, 80);
    expect(at(103)).toEqual({ value: 30, mode: 'interp' });
    expect(at(107)).toEqual({ value: 70, mode: 'interp' });
  });
});
