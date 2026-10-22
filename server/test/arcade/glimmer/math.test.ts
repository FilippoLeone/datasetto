/**
 * Glimmerhall's return, proven (glimmerhall.md §3, §18.1 tests 3–4; plan.md §3.4 "Math"):
 * - `exactRtp` matches the design's figures to 1e-9 and every machine lies in [0.94, 0.97];
 * - exact hit frequencies match the design;
 * - 1M seeded base spins through the engine land within 4 standard errors of the exact base spin
 *   return and hit frequency, and 50k seeded features within 4 SE of the exact feature value.
 */
import { describe, expect, it } from 'vitest';
import { randInt, seedXoshiro, xoshiro128ss } from '../../../src/arcade/core/rng.js';
import { evaluate } from '../../../src/arcade/core/glimmer/evaluate.js';
import { shuffleDoors } from '../../../src/arcade/core/glimmer/feature.js';
import { DEFS_BY_IDX, EMBERVAULT, ORCHARD, TIDEPOOL, type MachineDef } from '../../../src/arcade/core/glimmer/machines.js';
import { exactHit, exactRtp, PUBLISHED_HIT } from '../../../src/arcade/core/glimmer/rtp.js';
import { openVault, playFeature, spinBase, type Rng } from '../../../src/arcade/core/glimmer/spin.js';

const seeded = (seed: number): Rng => {
  const state = seedXoshiro(seed);
  const next = (): number => xoshiro128ss(state);
  return (n) => randInt(next, n);
};

describe('exact return', () => {
  const designed: Record<string, number> = { orchard: 0.948464500375662, tidepool: 0.9422046018125284, embervault: 0.9472091408049044 };

  it('matches the designed machine return to 1e-9, each in [0.94, 0.97]', () => {
    for (const def of DEFS_BY_IDX) {
      const r = exactRtp(def);
      expect(Math.abs(r.total - (designed[def.code] as number))).toBeLessThan(1e-9);
      expect(r.total).toBeGreaterThanOrEqual(0.94);
      expect(r.total).toBeLessThanOrEqual(0.97);
      expect(r.base + r.feature).toBeCloseTo(r.total, 12);
    }
  });

  it('matches the designed parts of each machine', () => {
    const o = exactRtp(ORCHARD);
    expect(o.base).toBeCloseTo(0.89923, 5);
    expect(o.triggerP).toBe(27 / 10648);
    expect(o.featureRun).toBeCloseTo(19.4167, 4);
    expect(o.feature).toBeCloseTo(0.04923, 5);

    const t = exactRtp(TIDEPOOL);
    expect(t.base).toBeCloseTo(0.82441, 5);
    expect(t.triggerP).toBeCloseTo((9 / 49) * (9 / 51) * (9 / 49), 15);
    expect(1 / t.triggerP).toBeCloseTo(167.97, 2);
    expect(t.freeSpins).toBeCloseTo(10.633, 3);
    expect(2 + t.featureRun).toBeCloseTo(19.785, 3);
    expect(t.feature).toBeCloseTo(0.11779, 5);

    const e = exactRtp(EMBERVAULT);
    expect(e.base).toBeCloseTo(0.71109, 5);
    expect(1 / e.triggerP).toBeCloseTo(158.02, 2);
    expect(e.fsValue - 3 * e.retriggerP).toBeCloseTo(1.4411, 4);
    expect(e.retriggerP).toBeCloseTo(0.009637, 6);
    expect(e.doors.map((d) => Math.round(d * 100) / 100)).toEqual([30.28, 36.33, 36.33]);
    expect(e.featureRun).toBeCloseTo(34.313, 3);
    expect(e.feature).toBeCloseTo(0.23612, 5);
  });

  it('gives the exact hit frequencies the pages publish', () => {
    expect(exactHit(ORCHARD)).toBeCloseTo(0.5513, 4);
    expect(exactHit(TIDEPOOL)).toBeCloseTo(0.451, 3);
    expect(exactHit(EMBERVAULT)).toBeCloseTo(0.509, 3);
    for (const def of DEFS_BY_IDX) expect(Math.abs(exactHit(def) - (PUBLISHED_HIT[def.idx] as number))).toBeLessThan(1e-12);
  });

  it('keeps the online total (Glimmer Pot +1.5 %) in the designed range', () => {
    const online = DEFS_BY_IDX.map((def) => Math.round((exactRtp(def).total + 0.015) * 10000) / 100);
    expect(online).toEqual([96.35, 95.72, 96.22]);
  });
});

interface Moments {
  n: number;
  sum: number;
  sumSq: number;
}

const within4Se = (m: Moments, exact: number): { mean: number; se: number; z: number } => {
  const mean = m.sum / m.n;
  const variance = m.sumSq / m.n - mean * mean;
  const se = Math.sqrt(variance / m.n);
  return { mean, se, z: (mean - exact) / se };
};

describe('engine against the exact math (seeded Monte Carlo)', () => {
  const BASE_SPINS = 1_000_000;
  const FEATURES = 50_000;

  const baseRun = (def: MachineDef, seed: number) => {
    const rng = seeded(seed);
    const bet = def.bets[0] as number;
    const ret: Moments = { n: 0, sum: 0, sumSq: 0 };
    let hits = 0;
    let triggers = 0;
    let atLeastBet = 0;
    for (let i = 0; i < BASE_SPINS; i += 1) {
      const r = spinBase(def, bet, rng);
      const x = r.win / bet;
      ret.n += 1;
      ret.sum += x;
      ret.sumSq += x * x;
      if (r.win > 0 || r.trigger) hits += 1;
      if (r.trigger) triggers += 1;
      if (r.win >= bet) atLeastBet += 1;
      // The detailed evaluation agrees with the engine's fast path.
      if (i < 20_000) {
        const e = evaluate(def, r.stops, bet);
        if (e.win !== r.win || e.trigger !== r.trigger) throw new Error(def.code + ': evaluate disagrees at spin ' + i);
      }
    }
    return { ret, hits, triggers, atLeastBet };
  };

  for (const def of DEFS_BY_IDX) {
    it(def.name + ': 1M base spins within 4 SE of the exact base return and hit frequency', () => {
      const exact = exactRtp(def);
      const run = baseRun(def, 0x91a7 + def.idx);
      const r = within4Se(run.ret, exact.baseSpin);
      expect(Math.abs(r.z)).toBeLessThan(4);
      const hit = exactHit(def);
      const hitSe = Math.sqrt((hit * (1 - hit)) / BASE_SPINS);
      expect(Math.abs(run.hits / BASE_SPINS - hit)).toBeLessThan(4 * hitSe);
      const trigSe = Math.sqrt((exact.triggerP * (1 - exact.triggerP)) / BASE_SPINS);
      expect(Math.abs(run.triggers / BASE_SPINS - exact.triggerP)).toBeLessThan(4 * trigSe);
    }, 20_000);

    it(def.name + ': 50k features within 4 SE of the exact feature value', () => {
      const exact = exactRtp(def);
      const rng = seeded(0x5eed + def.idx);
      const bet = def.bets[0] as number;
      const m: Moments = { n: 0, sum: 0, sumSq: 0 };
      let maxSpins = 0;
      for (let i = 0; i < FEATURES; i += 1) {
        const f = def.feature.kind === 'vault' ? openVault(def, bet, rng, shuffleDoors(rng), rng(3)) : playFeature(def, bet, rng);
        const x = f.win / bet;
        m.n += 1;
        m.sum += x;
        m.sumSq += x * x;
        maxSpins = Math.max(maxSpins, f.spins);
        if (!Number.isInteger(f.win)) throw new Error('fractional feature win');
      }
      const r = within4Se(m, exact.featureRun);
      expect(Math.abs(r.z)).toBeLessThan(4);
      expect(maxSpins).toBeLessThanOrEqual(200);
    }, 20_000);
  }
});
