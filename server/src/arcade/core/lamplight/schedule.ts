/**
 * Stakes and blind schedules (lamplight.md §2). Cash tables have fixed blinds per tier. The Lamplight
 * Cup and the Firefly Trio raise the blinds on a schedule: online by wall time (read at each hand
 * start, so no timer is needed), offline every few hands.
 */
import type { BlindLevel, Format, TableConfig, Tier } from './engine.js';

export const TIERS: readonly Tier[] = ['pebble', 'cobble', 'boulder', 'summit'];

export const TIER_BLINDS: Readonly<Record<Tier, { sb: number; bb: number }>> = {
  pebble: { sb: 5, bb: 10 },
  cobble: { sb: 25, bb: 50 },
  boulder: { sb: 100, bb: 200 },
  summit: { sb: 500, bb: 1000 },
};

export const TIER_NAMES: Readonly<Record<Tier, string>> = { pebble: 'Pebble', cobble: 'Cobble', boulder: 'Boulder', summit: 'Summit' };

/** "Cobble 25/50". */
export const tierLabel = (tier: Tier): string => TIER_NAMES[tier] + ' ' + TIER_BLINDS[tier].sb + '/' + TIER_BLINDS[tier].bb;

/** Cash buy-ins in big blinds. */
export const BUY_IN_BB = { min: 40, max: 100, default: 100 } as const;

export const CUP_BUY_INS = [500, 2000, 10000] as const;
export const TRIO_BUY_INS = [200, 1000, 5000] as const;
export const CUP_STACK = 1500;
export const TRIO_STACK = 500;

const CUP_LEVELS: readonly [number, number][] = [
  [10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200], [150, 300], [200, 400], [300, 600], [400, 800], [600, 1200], [800, 1600], [1000, 2000],
];
const TRIO_LEVELS: readonly [number, number][] = [
  [10, 20], [15, 30], [20, 40], [30, 60], [40, 80], [50, 100], [60, 120], [80, 160], [100, 200], [120, 240], [150, 300], [200, 400],
];

/** Level length: online in ms of wall time, offline in hands. */
export const LEVEL_TIME = {
  cup: { ms: 5 * 60_000, hands: 10 },
  trio: { ms: 2 * 60_000, hands: 5 },
} as const;

/** Round half up to a multiple of 10. */
const round10 = (x: number): number => Math.floor((x + 5) / 10) * 10;

/**
 * Blinds of level `index` (0-based). Past the listed levels the big blind grows by ×1.5 (Cup) or
 * ×1.25 (Trio), rounded to 10, and the small blind is half of it. The growth stops at a level
 * where the big blind would pass a billion, so the numbers stay integers.
 */
export const blindsAt = (format: 'cup' | 'trio', index: number): { sb: number; bb: number } => {
  const table = format === 'cup' ? CUP_LEVELS : TRIO_LEVELS;
  if (index < table.length) return { sb: table[index][0], bb: table[index][1] };
  let bb = table[table.length - 1][1];
  const steps = Math.min(index - table.length + 1, 60);
  for (let i = 0; i < steps && bb < 1_000_000_000; i++) bb = format === 'cup' ? round10((bb * 3) / 2) : round10((bb * 5) / 4);
  return { sb: bb / 2, bb };
};

/** The level for a tournament after `elapsedMs` of play (online) or `hands` hands (offline). */
export const levelAt = (format: 'cup' | 'trio', at: { elapsedMs: number; startedAt: number } | { hands: number }): BlindLevel => {
  const t = LEVEL_TIME[format];
  if ('hands' in at) {
    const index = Math.floor(at.hands / t.hands);
    const b = blindsAt(format, index);
    return { index, sb: b.sb, bb: b.bb, ante: 0, endsAt: null, endsAfterHand: (index + 1) * t.hands };
  }
  const index = Math.floor(Math.max(0, at.elapsedMs) / t.ms);
  const b = blindsAt(format, index);
  return { index, sb: b.sb, bb: b.bb, ante: 0, endsAt: at.startedAt + (index + 1) * t.ms, endsAfterHand: null };
};

export const cashLevel = (tier: Tier): BlindLevel => ({ index: 0, ...TIER_BLINDS[tier], ante: 0, endsAt: null, endsAfterHand: null });

/** Clocks per format (lamplight.md §5). */
export const CLOCKS: Readonly<Record<Format, { actionMs: number; timeBankMs: number; addMs: number; maxMs: number }>> = {
  open: { actionMs: 15_000, timeBankMs: 30_000, addMs: 5_000, maxMs: 60_000 },
  cup: { actionMs: 15_000, timeBankMs: 30_000, addMs: 0, maxMs: 30_000 },
  trio: { actionMs: 10_000, timeBankMs: 15_000, addMs: 0, maxMs: 15_000 },
};

/** A table config for a format (buy-in bounds in chips for cash; the stack for tournaments). */
export const tableConfig = (o: { format: Format; tier?: Tier | null; seats: number; bots: TableConfig['bots'] }): TableConfig => {
  const c = CLOCKS[o.format];
  const tier = o.format === 'open' ? (o.tier ?? 'pebble') : null;
  const bb = tier ? TIER_BLINDS[tier].bb : 0;
  const stack = o.format === 'cup' ? CUP_STACK : o.format === 'trio' ? TRIO_STACK : 0;
  return {
    format: o.format,
    tier,
    seats: o.format === 'trio' ? 3 : Math.max(2, Math.min(9, o.seats)),
    buyInMin: tier ? BUY_IN_BB.min * bb : stack,
    buyInMax: tier ? BUY_IN_BB.max * bb : stack,
    actionMs: c.actionMs,
    timeBankMs: c.timeBankMs,
    timeBankAddMs: c.addMs,
    timeBankMaxMs: c.maxMs,
    bots: o.bots,
  };
};
