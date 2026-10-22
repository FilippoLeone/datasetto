/**
 * Exact return and hit frequency of each machine (glimmerhall.md §3), derived from the strips and
 * paytables alone. Used by the CI checks and by the "How it works" pages.
 *
 * Methods:
 * - lines on 5 reels: per-reel symbol frequencies (every row's symbol is uniform over its strip, and
 *   reels are independent), so every line has the same expectation;
 * - ways: per-symbol E[matches] per reel times P(no match) on the reel after the run;
 * - scatters: window scans (P(the scatter is in the window));
 * - free spins: N / (1 − R·p) expected spins, retriggers adding R spins with chance p per spin;
 * - Orchard (3 reels): exhaustive over all 22³ stops;
 * - hit frequency on 5 reels: a line or way win needs a run of at least 3 (the Octopus pair needs 2),
 *   so it depends on reels 1–3 only; those are enumerated and the trigger's last reel is a factor.
 *
 * Free spins are uncapped here; the 200-spin cap changes the return by less than 1e-9.
 */
import { scanUnits, scatterPayX, type Scan } from './evaluate.js';
import { ROWS, type MachineDef } from './machines.js';

export interface RtpReport {
  /** Line or way return of a base spin, × bet (scatter pay excluded). */
  base: number;
  /** Feature return per base spin, × bet, the trigger's scatter pay included. */
  feature: number;
  total: number;
  /** Chance of a trigger per base spin. */
  triggerP: number;
  /** Expected base spin return as the engine settles it: base + triggerP × scatter pay. */
  baseSpin: number;
  /** Expected feature run value after a trigger, × bet, excluding the trigger's scatter pay. */
  featureRun: number;
  /** Expected free spins per feature (0 for the wheel). */
  freeSpins: number;
  /** Free-spin value per spin before the multiplier, scatter pay included (0 for the wheel). */
  fsValue: number;
  /** Retrigger chance per free spin. */
  retriggerP: number;
  /** Vault: value of each door's prize, × bet, before the trigger's scatter pay. */
  doors: number[];
}

const count = (strip: Uint8Array, a: number, b: number): number => {
  let n = 0;
  for (let i = 0; i < strip.length; i += 1) if (strip[i] === a || strip[i] === b) n += 1;
  return n;
};

/** P(symbol `a` or `b` appears nowhere in the window) for a strip. */
const pNone = (strip: Uint8Array, a: number, b: number): number => {
  let n = 0;
  const len = strip.length;
  for (let i = 0; i < len; i += 1) {
    let seen = false;
    for (let y = 0; y < ROWS; y += 1) {
      const c = strip[(i + y) % len];
      if (c === a || c === b) seen = true;
    }
    if (!seen) n += 1;
  }
  return n / len;
};

/** P(the scatter lands on every scatter reel) on `strips`. */
export const triggerChance = (def: MachineDef, strips: readonly Uint8Array[]): number => {
  let p = 1;
  for (let i = 0; i < def.scatterReels.length; i += 1) {
    const strip = strips[def.scatterReels[i] as number] as Uint8Array;
    p *= 1 - pNone(strip, def.scatter, def.scatter);
  }
  return p;
};

/** Line return of one base spin, × bet, for 5-reel line machines (per-reel frequencies). */
const lineReturn = (def: MachineDef, strips: readonly Uint8Array[]): number => {
  let perLine = 0;
  for (let s = 0; s < def.symbols.length; s += 1) {
    if (s === def.scatter || s === def.wild) continue;
    const pays = def.pays[s] as readonly number[];
    for (let k = 1; k <= def.reels; k += 1) {
      const pay = pays[k] as number;
      if (pay <= 0) continue;
      let p = count(strips[0] as Uint8Array, s, s) / (strips[0] as Uint8Array).length;
      for (let r = 1; r < k; r += 1) p *= count(strips[r] as Uint8Array, s, def.wild) / (strips[r] as Uint8Array).length;
      if (k < def.reels) p *= 1 - count(strips[k] as Uint8Array, s, def.wild) / (strips[k] as Uint8Array).length;
      perLine += p * pay;
    }
  }
  return (perLine * def.lines.length) / def.unitDiv;
};

/** Ways return of one spin, × bet. */
const waysReturn = (def: MachineDef, strips: readonly Uint8Array[]): number => {
  let units = 0;
  for (let s = 0; s < def.symbols.length; s += 1) {
    if (s === def.scatter || s === def.wild) continue;
    const pays = def.pays[s] as readonly number[];
    for (let k = 1; k <= def.reels; k += 1) {
      const pay = pays[k] as number;
      if (pay <= 0) continue;
      let e = 1;
      for (let r = 0; r < k; r += 1) e *= (ROWS * count(strips[r] as Uint8Array, s, def.wild)) / (strips[r] as Uint8Array).length;
      if (k < def.reels) e *= pNone(strips[k] as Uint8Array, s, def.wild);
      units += e * pay;
    }
  }
  return units / def.unitDiv;
};

const scan: Scan = { units: 0, scatters: 0 };

/** Orchard: exhaustive base return and trigger count over every stop combination of 3 reels. */
const exhaustive3 = (def: MachineDef): { base: number; trigger: number; hit: number } => {
  const a = def.strips[0] as Uint8Array;
  const b = def.strips[1] as Uint8Array;
  const c = def.strips[2] as Uint8Array;
  const stops = [0, 0, 0];
  let units = 0;
  let triggers = 0;
  let hits = 0;
  for (let i = 0; i < a.length; i += 1) {
    stops[0] = i;
    for (let j = 0; j < b.length; j += 1) {
      stops[1] = j;
      for (let k = 0; k < c.length; k += 1) {
        stops[2] = k;
        scanUnits(def, def.strips, stops, scan);
        units += scan.units;
        const t = scan.scatters === def.scatterReels.length;
        if (t) triggers += 1;
        if (scan.units > 0 || t) hits += 1;
      }
    }
  }
  const n = a.length * b.length * c.length;
  return { base: units / def.unitDiv / n, trigger: triggers / n, hit: hits / n };
};

const spinsAndValue = (def: MachineDef): { fsValue: number; retriggerP: number } => {
  const strips = def.fsStrips;
  const p = triggerChance(def, strips);
  const pay = def.eval === 'lines' ? lineReturn(def, strips) : waysReturn(def, strips);
  return { fsValue: pay + scatterPayX(def) * p, retriggerP: p };
};

const reports: (RtpReport | null)[] = [null, null, null];

/** The exact return of a machine (cached). */
export const exactRtp = (def: MachineDef): RtpReport => {
  const cached = reports[def.idx];
  if (cached) return cached;
  const f = def.feature;
  let base: number;
  let triggerP: number;
  if (def.reels === 3) {
    const ex = exhaustive3(def);
    base = ex.base;
    triggerP = ex.trigger;
  } else {
    base = def.eval === 'lines' ? lineReturn(def, def.strips) : waysReturn(def, def.strips);
    triggerP = triggerChance(def, def.strips);
  }
  let featureRun = 0;
  let freeSpins = 0;
  let fsValue = 0;
  let retriggerP = 0;
  const doors: number[] = [];
  if (f.kind === 'wheel') {
    let sum = 0;
    for (let i = 0; i < f.segments.length; i += 1) sum += f.segments[i] as number;
    featureRun = sum / f.segments.length;
  } else {
    const v = spinsAndValue(def);
    fsValue = v.fsValue;
    retriggerP = v.retriggerP;
    if (f.kind === 'tide') {
      freeSpins = f.spins / (1 - f.retrigger * retriggerP);
      featureRun = freeSpins * f.mult * fsValue;
    } else {
      let sum = 0;
      let spins = 0;
      for (let i = 0; i < f.prizes.length; i += 1) {
        const prize = f.prizes[i] as { spins: number; mult: number };
        const n = prize.spins / (1 - f.retrigger * retriggerP);
        const value = n * prize.mult * fsValue;
        doors.push(value);
        sum += value;
        spins += n;
      }
      featureRun = sum / f.prizes.length;
      freeSpins = spins / f.prizes.length;
    }
  }
  const scatterPay = scatterPayX(def);
  const feature = triggerP * (scatterPay + featureRun);
  const report: RtpReport = {
    base,
    feature,
    total: base + feature,
    triggerP,
    baseSpin: base + triggerP * scatterPay,
    featureRun,
    freeSpins,
    fsValue,
    retriggerP,
    doors,
  };
  reports[def.idx] = report;
  return report;
};

/** Does any line or way pay in the window of `stops` (5-reel machines look at reels 1–3 only)? */
const payHit3 = (def: MachineDef, a: number, b: number, c: number): boolean => {
  const sa = def.strips[0] as Uint8Array;
  const sb = def.strips[1] as Uint8Array;
  const sc = def.strips[2] as Uint8Array;
  const wild = def.wild;
  const cell = (strip: Uint8Array, stop: number, row: number): number => strip[(stop + row) % strip.length] as number;
  if (def.eval === 'lines') {
    for (let l = 0; l < def.lines.length; l += 1) {
      const line = def.lines[l] as readonly number[];
      const s = cell(sa, a, line[0] as number);
      if (s === def.scatter) continue;
      const pays = def.pays[s] as readonly number[];
      const s2 = cell(sb, b, line[1] as number);
      if (s2 !== s && s2 !== wild) continue;
      if ((pays[2] as number) > 0) return true;
      const s3 = cell(sc, c, line[2] as number);
      if ((s3 === s || s3 === wild) && (pays[3] as number) > 0) return true;
    }
    return false;
  }
  const shows = (strip: Uint8Array, stop: number, s: number): boolean => {
    for (let y = 0; y < ROWS; y += 1) {
      const x = cell(strip, stop, y);
      if (x === s || x === wild) return true;
    }
    return false;
  };
  for (let s = 0; s < def.symbols.length; s += 1) {
    if (s === wild || s === def.scatter) continue;
    if (shows(sa, a, s) && shows(sb, b, s) && shows(sc, c, s) && ((def.pays[s] as readonly number[])[3] as number) > 0) return true;
  }
  return false;
};

/**
 * `exactHit` per machine, for the "How it works" pages (the enumeration takes about 0.1 s on a
 * desktop, too slow to run on a phone at open). The math test checks these against `exactHit`.
 */
export const PUBLISHED_HIT: readonly number[] = [0.5512772351615327, 0.45077418722588436, 0.5089417109929077];

const hits: (number | null)[] = [null, null, null];

/**
 * Exact hit frequency: the share of base spins that return anything, a feature trigger included
 * (cached; about 120k window checks for a 5-reel machine).
 */
export const exactHit = (def: MachineDef): number => {
  const cached = hits[def.idx];
  if (cached !== null && cached !== undefined) return cached;
  let result: number;
  if (def.reels === 3) {
    result = exhaustive3(def).hit;
  } else {
    const sa = def.strips[0] as Uint8Array;
    const sb = def.strips[1] as Uint8Array;
    const sc = def.strips[2] as Uint8Array;
    // Scatter reels beyond reel 3 contribute a factor; reels 1 and 3 are enumerated.
    let tail = 1;
    for (let i = 0; i < def.scatterReels.length; i += 1) {
      const r = def.scatterReels[i] as number;
      if (r >= 3) tail *= 1 - pNone(def.strips[r] as Uint8Array, def.scatter, def.scatter);
    }
    const hasScatter = (strip: Uint8Array, stop: number): boolean => {
      for (let y = 0; y < ROWS; y += 1) if (strip[(stop + y) % strip.length] === def.scatter) return true;
      return false;
    };
    let sum = 0;
    for (let a = 0; a < sa.length; a += 1) {
      const sA = hasScatter(sa, a);
      for (let b = 0; b < sb.length; b += 1) {
        for (let c = 0; c < sc.length; c += 1) {
          if (payHit3(def, a, b, c)) sum += 1;
          else if (sA && hasScatter(sc, c)) sum += tail;
        }
      }
    }
    result = sum / (sa.length * sb.length * sc.length);
  }
  hits[def.idx] = result;
  return result;
};
