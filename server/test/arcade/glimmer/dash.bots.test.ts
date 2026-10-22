/**
 * Glimmer Dash payouts and the bot neighbours' habits (glimmerhall.md §5.3, §14, §18.1 tests 13–14).
 */
import { describe, expect, it } from 'vitest';
import { BOTS, BOT_BANKROLL, botAfterSpin, botBet, botDelay, createBot } from '../../../src/arcade/core/glimmer/bots.js';
import { dashPayout, dashShares, type DashEntrant } from '../../../src/arcade/core/glimmer/dash.js';
import { seededRng } from '../../../src/arcade/core/glimmer/golden.js';
import { shuffleDoors } from '../../../src/arcade/core/glimmer/feature.js';
import { machineDef } from '../../../src/arcade/core/glimmer/machines.js';
import { openVault, playFeature, spinBase } from '../../../src/arcade/core/glimmer/spin.js';

const entrant = (key: string, score: number, finishedAt = 0, order = 0): DashEntrant => ({ key, score, finishedAt, order });

describe('Dash payouts', () => {
  it('splits 100 / 70-30 / 50-30-20 and always sums to the pool', () => {
    expect(dashShares(1000, 2)).toEqual([1000]);
    expect(dashShares(1500, 3)).toEqual([1050, 450]);
    expect(dashShares(2000, 4)).toEqual([1400, 600]);
    expect(dashShares(2500, 5)).toEqual([1250, 750, 500]);
    // floor() remainders go to first place.
    expect(dashShares(1001, 3)).toEqual([701, 300]);
    expect(dashShares(997, 8)).toEqual([499, 299, 199]);
    const rng = seededRng(3);
    for (let i = 0; i < 2000; i += 1) {
      const n = 2 + rng(7);
      const pool = rng(9000);
      const list = Array.from({ length: n }, (_, k) => entrant('a' + k, rng(4) * 100, rng(5), k));
      const paid = dashPayout(pool, list);
      expect(paid).toHaveLength(n);
      expect(paid.reduce((s, p) => s + p.prize, 0)).toBe(pool);
      for (const p of paid) expect(p.prize).toBeGreaterThanOrEqual(0);
    }
  });

  it('ranks by score and gives an untied winner the top share', () => {
    const paid = dashPayout(1500, [entrant('a', 300), entrant('b', 900), entrant('c', 600)]);
    expect(paid.map((p) => [p.key, p.place, p.prize])).toEqual([
      ['b', 1, 1050],
      ['c', 2, 450],
      ['a', 3, 0],
    ]);
  });

  it('splits tied places and gives the odd chip to the earlier finisher', () => {
    // Three entrants, two tied for first: they split 70 % + 30 % of 1001 = 1001; 500 each, the odd chip to the earlier.
    const paid = dashPayout(1001, [entrant('late', 800, 50), entrant('early', 800, 10), entrant('third', 100, 5)]);
    expect(paid.map((p) => [p.key, p.place, p.prize])).toEqual([
      ['early', 1, 501],
      ['late', 1, 500],
      ['third', 3, 0],
    ]);
    // Two tied for second of five: they split 30 % + 20 %.
    const five = dashPayout(1000, [entrant('a', 9), entrant('b', 5, 2), entrant('c', 5, 1), entrant('d', 1), entrant('e', 0)]);
    expect(five.map((p) => [p.key, p.place, p.prize])).toEqual([
      ['a', 1, 500],
      ['c', 2, 250],
      ['b', 2, 250],
      ['d', 4, 0],
      ['e', 5, 0],
    ]);
    // Odd chips in a three-way tie go one each to the earliest finishers.
    const three = dashPayout(1000, [entrant('x', 7, 3), entrant('y', 7, 1), entrant('z', 7, 2)]);
    expect(three.map((p) => [p.key, p.prize])).toEqual([
      ['y', 334],
      ['z', 333],
      ['x', 333],
    ]);
  });

  it('pays a freeroll nothing (the trophy is the stat)', () => {
    const paid = dashPayout(0, [entrant('a', 10), entrant('b', 20)]);
    expect(paid.map((p) => [p.key, p.place, p.prize])).toEqual([
      ['b', 1, 0],
      ['a', 2, 0],
    ]);
  });
});

describe('bot neighbours', () => {
  it('are the four designed bots on their machines and bets', () => {
    expect(BOTS.map((b) => b.name)).toEqual(['Juniper', 'Wex', 'Saffi', 'Gus']);
    const rng = seededRng(1);
    const [juniper, wex, saffi] = [createBot(0, rng), createBot(1, rng), createBot(2, rng)];
    expect([juniper.machine, botBet(juniper)]).toEqual([0, 5]);
    expect([wex.machine, botBet(wex)]).toEqual([1, 40]);
    expect(saffi.machine).toBe(2);
    expect([100, 200]).toContain(botBet(saffi));
    for (let i = 0; i < 200; i += 1) {
      const d = botDelay(wex, rng, 0, false);
      expect(d).toBeGreaterThanOrEqual(1600);
      expect(d).toBeLessThanOrEqual(2500);
      const dash = botDelay(wex, rng, 0, true);
      expect(dash).toBeGreaterThanOrEqual(1400);
      expect(dash).toBeLessThanOrEqual(2200);
    }
  });

  it('soak: 100k bot spins on the real engine keep bankrolls whole and habits bounded', () => {
    const rng = seededRng(77);
    const bots = BOTS.map((_, i) => createBot(i, rng));
    let now = 0;
    let moves = 0;
    let rests = 0;
    for (let i = 0; i < 100_000; i += 1) {
      const b = bots[i % 4] as (typeof bots)[number];
      const def = machineDef(b.machine);
      const bet = botBet(b);
      const base = spinBase(def, bet, rng);
      let win = base.win;
      if (base.trigger) {
        const f = def.feature.kind === 'vault' ? openVault(def, bet, rng, shuffleDoors(rng), rng(3)) : playFeature(def, bet, rng);
        win += f.win;
      }
      const before = b.restUntil;
      const out = botAfterSpin(b, { win, bet, feature: base.trigger }, rng, now);
      if (out.moved) moves += 1;
      if (b.restUntil > before) rests += 1;
      now += botDelay(b, rng, now, false);
      expect(Number.isFinite(b.bankroll)).toBe(true);
      if (b.bankroll < 0) throw new Error('negative bankroll');
      if (b.step < b.def.steps[0] || b.step > b.def.steps[1]) throw new Error('bet step out of range');
    }
    expect(moves).toBeGreaterThan(100);
    expect(rests).toBeGreaterThan(0);
    for (const b of bots) expect(b.bankroll).toBeLessThanOrEqual(BOT_BANKROLL * 100);
  }, 10_000);
});
