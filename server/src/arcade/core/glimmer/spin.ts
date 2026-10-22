/**
 * The spin engine (glimmerhall.md §6, §7.1): one base spin, then the feature it triggered. The
 * same code decides every online spin on the server and every offline spin on the device.
 *
 * Draw order (part of the contract, golden-hashed in both test suites):
 * 1. `rng(len_r)` for each reel, in order;
 * 2. the feature: the wheel `rng(12)`; Tide Turn per free spin `rng(len)` per reel; a Three Vaults
 *    trigger shuffles the doors (`rng(3)`, `rng(2)`) and the Forge Spins are drawn at the pick;
 * 3. the Glimmer Pot draw, server only, last (not here).
 */
import { scanUnits, scatterPayX, type Scan } from './evaluate.js';
import { freeRun, shuffleDoors, wheelWin, type Rng } from './feature.js';
import type { MachineDef } from './machines.js';

export type { Rng } from './feature.js';

export interface BaseResult {
  stops: number[];
  /** Chips: line or way wins plus the trigger's scatter pay. */
  win: number;
  trigger: boolean;
}

export interface FeatureResult {
  kind: 'wheel' | 'tide' | 'vault';
  /** Wheel segment. */
  segment?: number;
  /** Vault: the prize index behind each door. */
  doors?: number[];
  /** Vault: the door that was opened. */
  picked?: number;
  mult: number;
  /** Free spins, `reels` stops per spin, flat. */
  stops: number[];
  spins: number;
  /** Chips, multiplied, retrigger scatter pays included (the trigger's own scatter pay is in the base win). */
  win: number;
}

const scan: Scan = { units: 0, scatters: 0 };

/** Draws one stop per reel on `strips`. */
export const drawStops = (def: MachineDef, rng: Rng, strips: readonly Uint8Array[] = def.strips): number[] => {
  const stops: number[] = [];
  for (let r = 0; r < def.reels; r += 1) stops.push(rng((strips[r] as Uint8Array).length));
  return stops;
};

const settle = (def: MachineDef, stops: number[], bet: number): BaseResult => {
  scanUnits(def, def.strips, stops, scan);
  const trigger = scan.scatters === def.scatterReels.length;
  const win = scan.units * (bet / def.unitDiv) + (trigger ? scatterPayX(def) * bet : 0);
  return { stops, win, trigger };
};

/** The base result for given stops (no draws). */
export const settleBase = (def: MachineDef, stops: readonly number[], bet: number): BaseResult => settle(def, stops.slice(), bet);

export const spinBase = (def: MachineDef, bet: number, rng: Rng): BaseResult => settle(def, drawStops(def, rng), bet);

/**
 * The feature after a triggering base spin. Wheel and Tide Turn play at once. For Three Vaults pass
 * the prize behind the opened door (`prize`, from `shuffleDoors`) to play the Forge Spins; without
 * it the result only carries `doors` (the pending state, kept server-side until the pick).
 */
export const playFeature = (def: MachineDef, bet: number, rng: Rng, prize?: number): FeatureResult => {
  const f = def.feature;
  if (f.kind === 'wheel') {
    const segment = rng(f.segments.length);
    return { kind: 'wheel', segment, mult: 1, stops: [], spins: 0, win: wheelWin(def, segment, bet) };
  }
  if (f.kind === 'tide') {
    const run = freeRun(def, bet, rng, { spins: f.spins, mult: f.mult, retrigger: f.retrigger, scatterPay: f.scatterPay, strips: def.fsStrips });
    return { kind: 'tide', mult: f.mult, stops: run.stops, spins: run.spins, win: run.win };
  }
  if (prize === undefined) return { kind: 'vault', doors: shuffleDoors(rng), mult: 1, stops: [], spins: 0, win: 0 };
  const p = f.prizes[prize] ?? (f.prizes[0] as { spins: number; mult: number });
  const run = freeRun(def, bet, rng, { spins: p.spins, mult: p.mult, retrigger: f.retrigger, scatterPay: f.scatterPay, strips: def.fsStrips });
  return { kind: 'vault', mult: p.mult, stops: run.stops, spins: run.spins, win: run.win };
};

/** Opens a vault: the Forge Spins for the prize behind `door`. */
export const openVault = (def: MachineDef, bet: number, rng: Rng, doors: readonly number[], door: number): FeatureResult => {
  const prize = doors[door] ?? 0;
  const run = playFeature(def, bet, rng, prize);
  return { ...run, doors: doors.slice(), picked: door };
};
