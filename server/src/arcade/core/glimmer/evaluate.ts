/**
 * Evaluating a window (glimmerhall.md §2). Integer maths only.
 *
 * - Lines pay left to right from reel 1 on consecutive reels. The line's symbol is the first
 *   non-wild symbol; the wild stands in for every paying symbol but never for the scatter. Each
 *   line pays its highest win: the higher of the wild run (Orchard's Sunseed pays on its own) and
 *   the symbol run. Line wins add up.
 * - Ways (Ember Vault): for each paying symbol, count the reels from reel 1 that show it or a wild,
 *   stopping at the first reel without one; ways = the product of the matching positions; win =
 *   pay[k] × ways.
 * - The scatter or bonus symbol counts anywhere in the windows of its reels. One on each of those
 *   reels triggers the feature, and Tidepool and Ember Vault pay `scatterPay × bet` for it.
 *
 * `evaluate` returns the details the client draws (lines, ways, highlighted cells); `scanUnits` is
 * the allocation-free path the engine and the Monte Carlo checks use.
 */
import { ROWS, type MachineDef } from './machines.js';

export interface LineHit {
  /** Index into `def.lines`. */
  line: number;
  sym: number;
  /** Reels in the run, from reel 1. */
  count: number;
  /** Chips. */
  win: number;
}

export interface WayHit {
  sym: number;
  count: number;
  ways: number;
  win: number;
}

export interface Evaluation {
  /** Line or way wins plus the scatter pay, in chips, before any free-spin multiplier. */
  win: number;
  /** Line or way wins only. */
  payWin: number;
  /** The trigger's scatter pay (0 without a trigger, and always 0 on Orchard). */
  scatterPay: number;
  lines: LineHit[];
  ways: WayHit[];
  /** Scatter reels showing the scatter (or Orchard's Basket). */
  scatters: number;
  trigger: boolean;
  /** Bit per cell (reel × 3 + row) that is part of a win or a trigger. */
  cells: number;
}

/** Scratch for `scanUnits`, reused across calls (one engine call at a time). */
export interface Scan {
  /** Line or way units (line bets or coins). */
  units: number;
  scatters: number;
}

const win3 = new Uint8Array(15);

const fillWindow = (def: MachineDef, strips: readonly Uint8Array[], stops: readonly number[]): void => {
  for (let r = 0; r < def.reels; r += 1) {
    const strip = strips[r] as Uint8Array;
    const len = strip.length;
    const stop = stops[r] as number;
    for (let y = 0; y < ROWS; y += 1) win3[r * ROWS + y] = strip[(stop + y) % len] as number;
  }
};

/** Units of line `l` in the current window, and the run through `out`. */
const lineUnits = (def: MachineDef, l: number, out: { sym: number; count: number }): number => {
  const reels = def.reels;
  const wild = def.wild;
  const cells = def.lineCells;
  const pays = def.payFlat;
  const stride = reels + 1;
  const base = l * reels;
  let wildRun = 0;
  for (let r = 0; r < reels; r += 1) {
    if (win3[cells[base + r] as number] !== wild) break;
    wildRun += 1;
  }
  const wildPay = def.wildPays ? (pays[wild * stride + wildRun] as number) : 0;
  let symPay = 0;
  let symCount = 0;
  let sym = -1;
  if (wildRun < reels) {
    sym = win3[cells[base + wildRun] as number] as number;
    if (sym !== def.scatter) {
      symCount = wildRun;
      for (let r = wildRun; r < reels; r += 1) {
        const c = win3[cells[base + r] as number];
        if (c !== sym && c !== wild) break;
        symCount += 1;
      }
      symPay = pays[sym * stride + symCount] as number;
    }
  }
  if (wildPay > symPay) {
    out.sym = wild;
    out.count = wildRun;
    return wildPay;
  }
  out.sym = sym;
  out.count = symCount;
  return symPay;
};

const run = { sym: 0, count: 0 };
/** Per reel, how many cells show each symbol (reel × 16 + symbol). */
const perReel = new Uint8Array(5 * 16);

/** Ways units of symbol `s` from the per-reel counts; the run length through `out`. */
const wayUnits = (def: MachineDef, s: number, out: { ways: number; count: number }): number => {
  const wild = def.wild;
  let ways = 1;
  let count = 0;
  for (let r = 0; r < def.reels; r += 1) {
    const m = (perReel[r * 16 + s] as number) + (perReel[r * 16 + wild] as number);
    if (m === 0) break;
    ways *= m;
    count += 1;
  }
  out.ways = ways;
  out.count = count;
  return (def.payFlat[s * (def.reels + 1) + count] as number) * ways;
};

const fillCounts = (def: MachineDef): void => {
  perReel.fill(0);
  for (let i = 0; i < def.reels * ROWS; i += 1) {
    const r = (i / ROWS) | 0;
    perReel[r * 16 + (win3[i] as number)] = (perReel[r * 16 + (win3[i] as number)] as number) + 1;
  }
};

const way = { ways: 0, count: 0 };

const countScatters = (def: MachineDef): number => {
  let scatters = 0;
  for (let i = 0; i < def.scatterReels.length; i += 1) {
    const r = def.scatterReels[i] as number;
    const at = r * ROWS;
    if (win3[at] === def.scatter || win3[at + 1] === def.scatter || win3[at + 2] === def.scatter) scatters += 1;
  }
  return scatters;
};

/**
 * Units won by line or ways in the window at `stops` on `strips`, and the scatter count, into
 * `out`. Allocation-free.
 */
export const scanUnits = (def: MachineDef, strips: readonly Uint8Array[], stops: readonly number[], out: Scan): Scan => {
  fillWindow(def, strips, stops);
  let units = 0;
  if (def.eval === 'lines') {
    const n = def.lines.length;
    for (let l = 0; l < n; l += 1) units += lineUnits(def, l, run);
  } else {
    fillCounts(def);
    for (let s = 0; s < def.symbols.length; s += 1) {
      if (s === def.wild || s === def.scatter) continue;
      units += wayUnits(def, s, way);
    }
  }
  out.units = units;
  out.scatters = countScatters(def);
  return out;
};

/** The trigger's scatter pay in `× bet` (0 for the Harvest Wheel). */
export const scatterPayX = (def: MachineDef): number => (def.feature.kind === 'wheel' ? 0 : def.feature.scatterPay);

/** Full evaluation with line and way details for drawing. */
export const evaluate = (def: MachineDef, stops: readonly number[], bet: number, strips: readonly Uint8Array[] = def.strips): Evaluation => {
  fillWindow(def, strips, stops);
  const unit = bet / def.unitDiv;
  const lines: LineHit[] = [];
  const ways: WayHit[] = [];
  let payWin = 0;
  let cells = 0;
  if (def.eval === 'lines') {
    for (let l = 0; l < def.lines.length; l += 1) {
      const line = def.lines[l] as readonly number[];
      const units = lineUnits(def, l, run);
      if (units <= 0) continue;
      const w = units * unit;
      payWin += w;
      lines.push({ line: l, sym: run.sym, count: run.count, win: w });
      for (let r = 0; r < run.count; r += 1) cells |= 1 << (r * ROWS + (line[r] as number));
    }
  } else {
    const wild = def.wild;
    for (let s = 0; s < def.symbols.length; s += 1) {
      if (s === wild || s === def.scatter) continue;
      let n = 1;
      let count = 0;
      let mask = 0;
      for (let r = 0; r < def.reels; r += 1) {
        let m = 0;
        for (let y = 0; y < ROWS; y += 1) {
          const c = win3[r * ROWS + y];
          if (c === s || c === wild) {
            m += 1;
            mask |= 1 << (r * ROWS + y);
          }
        }
        if (m === 0) break;
        n *= m;
        count += 1;
      }
      const pay = (def.pays[s] as readonly number[])[count] as number;
      if (pay <= 0) continue;
      const w = pay * n * unit;
      payWin += w;
      ways.push({ sym: s, count, ways: n, win: w });
      cells |= mask;
    }
  }
  let scatters = 0;
  let scatterCells = 0;
  for (let i = 0; i < def.scatterReels.length; i += 1) {
    const r = def.scatterReels[i] as number;
    for (let y = 0; y < ROWS; y += 1) {
      if (win3[r * ROWS + y] === def.scatter) {
        scatters += 1;
        scatterCells |= 1 << (r * ROWS + y);
        break;
      }
    }
  }
  const trigger = scatters === def.scatterReels.length;
  if (trigger) cells |= scatterCells;
  const scatterPay = trigger ? scatterPayX(def) * bet : 0;
  return { win: payWin + scatterPay, payWin, scatterPay, lines, ways, scatters, trigger, cells };
};

/** The symbols in a window, reel by reel (reels × 3), for drawing. */
export const windowOf = (def: MachineDef, stops: readonly number[], strips: readonly Uint8Array[] = def.strips): number[] => {
  const out: number[] = [];
  for (let r = 0; r < def.reels; r += 1) {
    const strip = strips[r] as Uint8Array;
    for (let y = 0; y < ROWS; y += 1) out.push(strip[((stops[r] as number) + y) % strip.length] as number);
  }
  return out;
};
