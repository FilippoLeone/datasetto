/**
 * Interpolation by server tick, not arrival time (platform.md §8.4). Other players render at
 * `estServerTick − delay`, with `delay = clamp(2 × interval + jitterP90, 100, 300) ms`, where the
 * interval comes from the divisor in the FRAME flags (so skipped slots do not inflate it). From a
 * LocalHost (divisor 1) the delay is 0. Extrapolation is capped at 100 ms, then motion holds.
 */
import { TICK_MS, type Divisor } from './lane.js';

export const interpDelayMs = (divisor: Divisor | 1, jitterP90Ms: number): number => {
  if (divisor === 1) return 0;
  return Math.max(100, Math.min(300, 2 * divisor * TICK_MS + Math.max(0, jitterP90Ms)));
};

/** Ticks of extrapolation past the newest sample before motion holds (100 ms). */
export const EXTRAP_TICKS = 3;

export interface TickRing {
  /**
   * Record a sample's tick; returns the slot index where the caller stores that sample's data.
   * Ticks must increase: a tick at or below the newest returns the newest slot for an equal tick
   * and -1 for an older one (ignore that sample).
   */
  push(tick: number): number;
  /** The samples around `renderTick`: draw `a + (b − a) × t`. null while empty. */
  bracket(renderTick: number): { a: number; b: number; t: number; mode: 'interp' | 'extrap' | 'hold' } | null;
  clear(): void;
  readonly size: number;
}

export const createTickRing = (capacity: number): TickRing => {
  const ticks = new Float64Array(capacity);
  let head = 0; // next write
  let size = 0;

  const slotOf = (age: number): number => (head - 1 - age + capacity * 2) % capacity; // age 0 = newest

  return {
    push(tick) {
      if (size > 0) {
        const newest = ticks[slotOf(0)] as number;
        if (tick === newest) return slotOf(0);
        if (tick < newest) return -1;
      }
      const slot = head;
      ticks[slot] = tick;
      head = (head + 1) % capacity;
      size = Math.min(capacity, size + 1);
      return slot;
    },
    bracket(renderTick) {
      if (size === 0) return null;
      const newestSlot = slotOf(0);
      const newest = ticks[newestSlot] as number;
      if (renderTick >= newest) {
        if (size < 2 || renderTick - newest > EXTRAP_TICKS) return { a: newestSlot, b: newestSlot, t: 0, mode: 'hold' };
        const prevSlot = slotOf(1);
        const prev = ticks[prevSlot] as number;
        return { a: prevSlot, b: newestSlot, t: (renderTick - prev) / (newest - prev), mode: 'extrap' };
      }
      for (let age = 1; age < size; age += 1) {
        const aSlot = slotOf(age);
        const aTick = ticks[aSlot] as number;
        if (aTick <= renderTick) {
          const bSlot = slotOf(age - 1);
          const bTick = ticks[bSlot] as number;
          return { a: aSlot, b: bSlot, t: (renderTick - aTick) / (bTick - aTick), mode: 'interp' };
        }
      }
      const oldest = slotOf(size - 1);
      return { a: oldest, b: oldest, t: 0, mode: 'hold' };
    },
    clear() {
      head = 0;
      size = 0;
    },
    get size() {
      return size;
    },
  };
};
