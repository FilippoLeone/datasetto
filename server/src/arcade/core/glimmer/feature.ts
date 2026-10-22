/**
 * Feature pieces (glimmerhall.md §3): the Three Vaults door shuffle, the Harvest Wheel prize and
 * the free-spin run builder shared by Tide Turn and Forge Spins.
 *
 * Draw order is part of the contract (§6) so seeded runs replay identically on server and device:
 * a run draws `rng(len)` per reel per spin, in reel order; the door shuffle draws `rng(3)`, then
 * `rng(2)`. A run never plays more than FS_CAP spins (the loop bound).
 */
import { scanUnits, type Scan } from './evaluate.js';
import { FS_CAP, type MachineDef } from './machines.js';

/** A uniform integer in [0, n), injected by the host (crypto online, a seeded generator in tests). */
export type Rng = (n: number) => number;

/**
 * Fisher–Yates over the three prizes: `doors[d]` is the prize index behind door `d`. Every door is
 * equally likely to hold every prize.
 */
export const shuffleDoors = (rng: Rng): number[] => {
  const doors = [0, 1, 2];
  for (let i = 2; i >= 1; i -= 1) {
    const j = rng(i + 1);
    const t = doors[i] as number;
    doors[i] = doors[j] as number;
    doors[j] = t;
  }
  return doors;
};

/** Harvest Wheel prize in chips for a segment. */
export const wheelWin = (def: MachineDef, segment: number, bet: number): number =>
  def.feature.kind === 'wheel' ? ((def.feature.segments[segment] as number) ?? 0) * bet : 0;

export interface FreeRun {
  /** Five stops per spin, flat. */
  stops: number[];
  spins: number;
  /** Chips, multiplied, retrigger scatter pays included. */
  win: number;
  retriggers: number;
}

const scan: Scan = { units: 0, scatters: 0 };

/**
 * Plays `spins` free spins on `strips` at `mult`; each trigger adds `retrigger` spins and pays
 * `scatterPay × bet × mult`. Stops at FS_CAP spins.
 */
export const freeRun = (def: MachineDef, bet: number, rng: Rng, o: { spins: number; mult: number; retrigger: number; scatterPay: number; strips: readonly Uint8Array[] }): FreeRun => {
  const stops: number[] = [];
  const spin: number[] = [];
  for (let r = 0; r < def.reels; r += 1) spin.push(0);
  const unit = bet / def.unitDiv;
  const need = def.scatterReels.length;
  let remaining = o.spins;
  let played = 0;
  let win = 0;
  let retriggers = 0;
  for (let i = 0; i < FS_CAP && remaining > 0; i += 1) {
    remaining -= 1;
    played += 1;
    for (let r = 0; r < def.reels; r += 1) {
      const s = rng((o.strips[r] as Uint8Array).length);
      spin[r] = s;
      stops.push(s);
    }
    scanUnits(def, o.strips, spin, scan);
    let w = scan.units * unit;
    if (scan.scatters === need) {
      w += o.scatterPay * bet;
      remaining += o.retrigger;
      retriggers += 1;
    }
    win += w * o.mult;
  }
  return { stops, spins: played, win, retriggers };
};
