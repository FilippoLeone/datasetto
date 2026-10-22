/**
 * Glimmerhall rules (glimmerhall.md §2–§3, §18.1 test 2): hand-built windows per machine and the
 * strip invariants. A window is built from per-reel 3-symbol strips (stop 0 shows exactly them).
 */
import { describe, expect, it } from 'vitest';
import { evaluate, scanUnits } from '../../../src/arcade/core/glimmer/evaluate.js';
import { EMBERVAULT, MACHINES, ORCHARD, TIDEPOOL, DEFS_BY_IDX, betLadder, betAllowed, type MachineDef } from '../../../src/arcade/core/glimmer/machines.js';

/** Columns top→bottom, one 3-char string per reel. */
const strips = (def: MachineDef, cols: readonly string[]): Uint8Array[] =>
  cols.map((col) => {
    expect(col).toHaveLength(3);
    return Uint8Array.from([...col].map((ch) => {
      const at = def.symbols.indexOf(ch);
      if (at < 0) throw new Error('unknown symbol ' + ch);
      return at;
    }));
  });

const stops0 = (def: MachineDef): number[] => new Array<number>(def.reels).fill(0);

const run = (def: MachineDef, cols: readonly string[], bet: number) => evaluate(def, stops0(def), bet, strips(def, cols));

/** Overwrite cells of a filler window: `edits` maps "reel,row" (1-based reel, 0-based row) to a symbol. */
const edit = (base: readonly string[], edits: Readonly<Record<string, string>>): string[] => {
  const cols = base.map((c) => [...c]);
  for (const [at, sym] of Object.entries(edits)) {
    const [reel, row] = at.split(',').map(Number) as [number, number];
    (cols[reel - 1] as string[])[row] = sym;
  }
  return cols.map((c) => c.join(''));
};

/**
 * An independent, deliberately naive reading of the rules, used as a second opinion on every
 * hand-built case.
 */
const reference = (def: MachineDef, cols: readonly string[], bet: number): { win: number; trigger: boolean } => {
  const sym = (r: number, y: number): string => (cols[r] as string)[y] as string;
  const W = 'W';
  const scatterCh = def.symbols[def.scatter] as string;
  const payOf = (ch: string, k: number): number => (def.pays[def.symbols.indexOf(ch)] as number[])[k] ?? 0;
  let units = 0;
  if (def.eval === 'lines') {
    for (const line of def.lines) {
      const s = line.map((row, r) => sym(r, row));
      let wild = 0;
      while (wild < s.length && s[wild] === W) wild += 1;
      const wildPay = def.wildPays ? payOf(W, wild) : 0;
      const first = s.find((c) => c !== W);
      let symPay = 0;
      if (first && first !== scatterCh) {
        let k = 0;
        while (k < s.length && (s[k] === first || s[k] === W)) k += 1;
        symPay = payOf(first, k);
      }
      units += Math.max(wildPay, symPay);
    }
  } else {
    for (const ch of def.symbols) {
      if (ch === W || ch === scatterCh) continue;
      let ways = 1;
      let k = 0;
      for (let r = 0; r < def.reels; r += 1) {
        const m = [0, 1, 2].filter((y) => sym(r, y) === ch || sym(r, y) === W).length;
        if (m === 0) break;
        ways *= m;
        k += 1;
      }
      units += payOf(ch, k) * ways;
    }
  }
  const scatters = def.scatterReels.filter((r) => [0, 1, 2].some((y) => sym(r, y) === scatterCh)).length;
  const trigger = scatters === def.scatterReels.length;
  const scatterPay = trigger && def.feature.kind !== 'wheel' ? def.feature.scatterPay * bet : 0;
  return { win: (units * bet) / def.unitDiv + scatterPay, trigger };
};

interface Case {
  name: string;
  cols: string[];
  bet: number;
  win: number;
  trigger?: boolean;
  scatters?: number;
}

const check = (def: MachineDef, cases: readonly Case[]): void => {
  expect(cases.length).toBeGreaterThanOrEqual(40);
  const got: unknown[] = [];
  const want: unknown[] = [];
  for (const c of cases) {
    const e = run(def, c.cols, c.bet);
    const ref = reference(def, c.cols, c.bet);
    got.push({ name: c.name, win: e.win, ref: ref.win, trigger: e.trigger, refTrigger: ref.trigger, scatters: c.scatters === undefined ? null : e.scatters });
    want.push({ name: c.name, win: c.win, ref: c.win, trigger: c.trigger ?? false, refTrigger: c.trigger ?? false, scatters: c.scatters ?? null });
  }
  expect(got).toEqual(want);
  for (const c of cases) {
    const e = run(def, c.cols, c.bet);
    // The detail list adds up, and the fast path agrees.
    const parts = e.lines.reduce((s, l) => s + l.win, 0) + e.ways.reduce((s, w) => s + w.win, 0);
    expect(parts + e.scatterPay).toBe(e.win);
    const scan = scanUnits(def, strips(def, c.cols), stops0(def), { units: 0, scatters: 0 });
    expect((scan.units * c.bet) / def.unitDiv).toBe(e.payWin);
    expect(Number.isInteger(e.win)).toBe(true);
  }
};

describe('Pocket Orchard windows (3 × 3, 5 lines, line bet = bet / 5)', () => {
  // Lines: 111 middle, 000 top, 222 bottom, 012 falling diagonal, 210 rising diagonal.
  const cases: Case[] = [
    { name: 'acorn three on the middle line', cols: ['PAR', 'RAH', 'HAF'], bet: 5, win: 5 },
    { name: 'acorn pair from the left', cols: ['PAR', 'RAH', 'HPF'], bet: 5, win: 1 },
    { name: 'acorn, wild, acorn', cols: ['PAR', 'RWH', 'HAF'], bet: 5, win: 5 },
    { name: 'three sunseeds pay 150', cols: ['PWR', 'RWH', 'HWF'], bet: 5, win: 150 },
    { name: 'two wilds then fig: the fig run (60) beats the wild pair (0)', cols: ['PWR', 'RWH', 'HFA'], bet: 5, win: 60 },
    { name: 'two wilds then acorn', cols: ['PWR', 'RWH', 'HAF'], bet: 5, win: 5 },
    { name: 'wild then acorn pair', cols: ['PWR', 'RAH', 'HPF'], bet: 5, win: 1 },
    { name: 'two wilds then the basket pay nothing', cols: ['PWR', 'RWH', 'HBF'], bet: 5, win: 0, scatters: 1 },
    { name: 'a basket on each reel triggers the wheel', cols: ['BPR', 'RBH', 'HFB'], bet: 5, win: 0, trigger: true, scatters: 3 },
    { name: 'three baskets on a line pay nothing on the line', cols: ['PBR', 'RBH', 'HBF'], bet: 5, win: 0, trigger: true },
    { name: 'fig three on the top line', cols: ['FPR', 'FRH', 'FHA'], bet: 5, win: 60 },
    { name: 'honeycomb three on the bottom line', cols: ['PRH', 'RPH', 'FAH'], bet: 5, win: 28 },
    { name: 'pear three on the falling diagonal', cols: ['RPA', 'HRF', 'PHR'], bet: 5, win: 14 },
    { name: 'plum three on the rising diagonal', cols: ['RHP', 'FPH', 'PRF'], bet: 5, win: 9 },
    { name: 'acorns everywhere: five lines of 5', cols: ['AAA', 'AAA', 'AAA'], bet: 5, win: 25 },
    { name: 'sunseeds everywhere: five lines of 150', cols: ['WWW', 'WWW', 'WWW'], bet: 5, win: 750 },
    { name: 'figs around a wild middle row', cols: ['FWF', 'FWF', 'FWF'], bet: 5, win: 390 },
    { name: 'a wild on reel 1 extends a fig run', cols: ['WRP', 'FHR', 'FPA'], bet: 5, win: 60 },
    { name: 'acorn pair then wild makes three', cols: ['PAR', 'RAH', 'HWF'], bet: 5, win: 5 },
    { name: 'acorn pairs on the top and bottom lines', cols: ['AHA', 'APA', 'FRH'], bet: 5, win: 2 },
    { name: 'plum, wild, plum on the top line', cols: ['PRA', 'WHF', 'PAR'], bet: 5, win: 9 },
    { name: 'honeycomb diagonal through two wilds plus a plum diagonal', cols: ['HRP', 'AWF', 'PFW'], bet: 5, win: 37 },
    { name: 'nothing lines up', cols: ['PRH', 'RHF', 'FPA'], bet: 5, win: 0 },
    { name: 'acorns only on reels 2 and 3 pay nothing (left to right)', cols: ['PRH', 'AAF', 'AAP'], bet: 5, win: 0 },
    { name: 'a basket first on a line blocks the wilds behind it', cols: ['BRP', 'WHA', 'WFH'], bet: 5, win: 0, scatters: 1 },
    { name: 'wild, basket, wild pays nothing', cols: ['WRP', 'BHA', 'WFR'], bet: 5, win: 0, scatters: 1 },
    { name: 'two wilds then plum', cols: ['WRH', 'WHA', 'PAR'], bet: 5, win: 9 },
    { name: 'two baskets beside an acorn line', cols: ['BAP', 'AAR', 'HAB'], bet: 5, win: 5, scatters: 2 },
    { name: 'a trigger and a line win together', cols: ['BAP', 'RAB', 'BAH'], bet: 5, win: 5, trigger: true, scatters: 3 },
    { name: 'acorn, wild, plum is an acorn pair', cols: ['ARP', 'WHF', 'PRA'], bet: 5, win: 1 },
    { name: 'wild, acorn, acorn is three acorns', cols: ['WRP', 'AHF', 'APR'], bet: 5, win: 5 },
    { name: 'scales with the bet: acorn three at 100', cols: ['PAR', 'RAH', 'HAF'], bet: 100, win: 100 },
    { name: 'scales with the bet: wild middle row at 25', cols: ['FWF', 'FWF', 'FWF'], bet: 25, win: 1950 },
    { name: 'scales with the bet: acorn pair at 10', cols: ['PAR', 'RAH', 'HPF'], bet: 10, win: 2 },
    { name: 'scales with the bet: sunseeds at 50', cols: ['PWR', 'RWH', 'HWF'], bet: 50, win: 1500 },
    { name: 'fig, fig, wild', cols: ['RFP', 'HFA', 'PWR'], bet: 5, win: 60 },
    { name: 'wild, fig, wild', cols: ['RWP', 'HFA', 'PWR'], bet: 5, win: 60 },
    { name: 'wild, wild, acorn on the bottom line, and a honeycomb rising diagonal', cols: ['PRW', 'RHW', 'HFA'], bet: 5, win: 5 + 28 },
    { name: 'pear pair pays nothing', cols: ['PRH', 'ARF', 'FHA'], bet: 5, win: 0 },
    { name: 'plum three middle, baskets on two reels', cols: ['BPR', 'HPB', 'RPF'], bet: 5, win: 9, scatters: 2 },
    { name: 'honeycomb three middle, every reel a basket', cols: ['BHR', 'RHB', 'BHF'], bet: 10, win: 56, trigger: true },
  ];
  it('pays every hand-built window as the rules say', () => check(ORCHARD, cases));
});

/**
 * Filler for 5-reel windows: every reel shows one symbol three times, a different one on each reel
 * and none of the case's own symbols, so the only runs are the ones a case builds.
 */
const mono = (pool: string, avoid: string, edits: Readonly<Record<string, string>> = {}): string[] => {
  const fill = [...pool].filter((ch) => !avoid.includes(ch)).slice(0, 5);
  return edit(fill.map((ch) => ch.repeat(3)), edits);
};

describe('Tidepool Treasures windows (5 × 3, 20 lines, coin = bet / 20)', () => {
  const t = (avoid: string, edits: Readonly<Record<string, string>> = {}): string[] => mono('SCKUHLT', avoid, edits);
  const mid3 = (s: string) => ({ '1,1': s, '2,1': s, '3,1': s });
  const cases: Case[] = [
    { name: 'filler pays nothing', cols: t(''), bet: 20, win: 0 },
    // Lines 11111, 11011 and 11211 start on the middle rows of reels 1 and 2; only 11111 reaches reel 3's middle.
    { name: 'turtle three on the middle line', cols: t('T', mid3('T')), bet: 20, win: 60 },
    { name: 'turtle four on the middle line', cols: t('T', { ...mid3('T'), '4,1': 'T' }), bet: 20, win: 250 },
    { name: 'turtle five on the middle line', cols: t('T', { ...mid3('T'), '4,1': 'T', '5,1': 'T' }), bet: 20, win: 900 },
    { name: 'octopus pair on 11111, 11011 and 11211', cols: t('', { '1,1': 'O', '2,1': 'O' }), bet: 20, win: 15 },
    { name: 'octopus then pearl: the same three pairs', cols: t('', { '1,1': 'O', '2,1': 'W' }), bet: 20, win: 15 },
    { name: 'octopus three through a pearl, plus two pairs', cols: t('', { '1,1': 'O', '2,1': 'W', '3,1': 'O' }), bet: 20, win: 120 + 5 + 5 },
    // 00000 pays five; 00122 also starts top, top: a pair.
    { name: 'octopus five on the top line plus the 00122 pair', cols: t('', { '1,0': 'O', '2,0': 'O', '3,0': 'O', '4,0': 'O', '5,0': 'O' }), bet: 20, win: 2500 + 5 },
    { name: 'shell three on the bottom line', cols: t('S', { '1,2': 'S', '2,2': 'S', '3,2': 'S' }), bet: 20, win: 10 },
    { name: 'a pearl stands in on reel 2', cols: t('H', { '1,1': 'H', '2,1': 'W', '3,1': 'H' }), bet: 20, win: 25 },
    // 11111 pays five lanternfish; the filler shells on reel 1 run through the wilds on 01110 and 21112.
    { name: 'pearls on reels 2–4 make a five, and two shell fours', cols: t('L', { '1,1': 'L', '2,1': 'W', '3,1': 'W', '4,1': 'W', '5,1': 'L' }), bet: 20, win: 500 + 35 + 35 },
    { name: 'scatter on reels 1, 3 and 5 pays 2 × bet', cols: t('', { '1,0': 'X', '3,1': 'X', '5,2': 'X' }), bet: 20, win: 40, trigger: true, scatters: 3 },
    { name: 'two scatters pay nothing', cols: t('', { '1,0': 'X', '3,1': 'X' }), bet: 20, win: 0, scatters: 2 },
    { name: 'a scatter first on a line pays nothing on the line', cols: t('S', { '1,1': 'X', '2,1': 'W', '3,1': 'S' }), bet: 20, win: 0, scatters: 1 },
    { name: 'scatter pay scales with the bet', cols: t('', { '1,2': 'X', '3,0': 'X', '5,1': 'X' }), bet: 500, win: 1000, trigger: true },
    { name: 'kelp four on 01210', cols: t('K', { '1,0': 'K', '2,1': 'K', '3,2': 'K', '4,1': 'K' }), bet: 20, win: 45 },
    { name: 'urchin three on 21012', cols: t('U', { '1,2': 'U', '2,1': 'U', '3,0': 'U' }), bet: 20, win: 15 },
    { name: 'seahorse five on 00122', cols: t('H', { '1,0': 'H', '2,0': 'H', '3,1': 'H', '4,2': 'H', '5,2': 'H' }), bet: 20, win: 300 },
    { name: 'lanternfish three on 22100', cols: t('L', { '1,2': 'L', '2,2': 'L', '3,1': 'L' }), bet: 20, win: 35 },
    { name: 'crab three on 10001', cols: t('C', { '1,1': 'C', '2,0': 'C', '3,0': 'C' }), bet: 20, win: 10 },
    { name: 'turtle three on 12221', cols: t('T', { '1,1': 'T', '2,2': 'T', '3,2': 'T' }), bet: 20, win: 60 },
    // From reel 1 top: 00000, 00122, 01210, 01110 and 01010 reach an octopus on reel 2; 02020 and 02220 do not.
    { name: 'octopus pairs on five lines from one reel-1 cell', cols: t('', { '1,0': 'O', '2,0': 'O', '2,1': 'O' }), bet: 20, win: 25 },
    {
      name: 'turtles on all nine cells of reels 1–3: twenty threes',
      cols: t('T', { '1,0': 'T', '1,1': 'T', '1,2': 'T', '2,0': 'T', '2,1': 'T', '2,2': 'T', '3,0': 'T', '3,1': 'T', '3,2': 'T' }),
      bet: 20,
      win: 60 * 20,
    },
    { name: 'shells around three pearl reels: twenty fives', cols: ['SSS', 'WWW', 'WWW', 'WWW', 'SSS'], bet: 20, win: 120 * 20 },
    { name: 'turtles, three pearl reels, crabs: twenty fours', cols: ['TTT', 'WWW', 'WWW', 'WWW', 'CCC'], bet: 20, win: 250 * 20 },
    { name: 'a trigger plus a turtle line at 40', cols: t('T', { ...mid3('T'), '1,0': 'X', '3,2': 'X', '5,0': 'X' }), bet: 40, win: 120 + 80, trigger: true },
    { name: 'reels 2–4 alone pay nothing', cols: t('T', { '2,1': 'T', '3,1': 'T', '4,1': 'T' }), bet: 20, win: 0 },
    { name: 'a turtle pair pays nothing', cols: t('T', { '1,1': 'T', '2,1': 'T' }), bet: 20, win: 0 },
    { name: 'three octopus pairs at 500', cols: t('', { '1,1': 'O', '2,1': 'O' }), bet: 500, win: 375 },
    { name: 'turtle five at 200', cols: t('T', { ...mid3('T'), '4,1': 'T', '5,1': 'T' }), bet: 200, win: 9000 },
    { name: 'shell four on 01110', cols: t('S', { '1,0': 'S', '2,1': 'S', '3,1': 'S', '4,1': 'S' }), bet: 20, win: 35 },
    { name: 'kelp three on 21112', cols: t('K', { '1,2': 'K', '2,1': 'K', '3,1': 'K' }), bet: 20, win: 15 },
    { name: 'urchin three on 10121', cols: t('U', { '1,1': 'U', '2,0': 'U', '3,1': 'U' }), bet: 20, win: 15 },
    { name: 'seahorse three on 01010', cols: t('H', { '1,0': 'H', '2,1': 'H', '3,0': 'H' }), bet: 20, win: 25 },
    { name: 'lanternfish five on 21212', cols: t('L', { '1,2': 'L', '2,1': 'L', '3,2': 'L', '4,1': 'L', '5,2': 'L' }), bet: 20, win: 500 },
    { name: 'turtle three on 02020', cols: t('T', { '1,0': 'T', '2,2': 'T', '3,0': 'T' }), bet: 20, win: 60 },
    { name: 'turtle three on 20202', cols: t('T', { '1,2': 'T', '2,0': 'T', '3,2': 'T' }), bet: 20, win: 60 },
    { name: 'octopus four on 02220, plus the 02020 pair', cols: t('', { '1,0': 'O', '2,2': 'O', '3,2': 'O', '4,2': 'O' }), bet: 20, win: 500 + 5 },
    { name: 'a pearl on reel 4 extends a three to four', cols: t('H', { ...mid3('H'), '4,1': 'W' }), bet: 20, win: 100 },
    { name: 'another symbol on reel 4 ends the run', cols: t('HL', { ...mid3('H'), '4,1': 'L' }), bet: 20, win: 25 },
    { name: 'starfish on reels 2 and 4 do not count', cols: t('', { '1,0': 'X', '2,0': 'X', '4,0': 'X' }), bet: 20, win: 0, scatters: 1 },
  ];
  it('pays every hand-built window as the rules say', () => check(TIDEPOOL, cases));
});

describe('Ember Vault windows (5 × 3, 243 ways, coin = bet / 20)', () => {
  const e = (avoid: string, edits: Readonly<Record<string, string>> = {}): string[] => mono('afmsgHAPD', avoid, edits);
  const cases: Case[] = [
    { name: 'filler pays nothing', cols: e(''), bet: 20, win: 0 },
    { name: 'drake three, one way', cols: e('D', { '1,0': 'D', '2,1': 'D', '3,2': 'D' }), bet: 20, win: 75 },
    { name: 'drake four, one way', cols: e('D', { '1,0': 'D', '2,1': 'D', '3,2': 'D', '4,0': 'D' }), bet: 20, win: 400 },
    { name: 'drake five, one way', cols: e('D', { '1,0': 'D', '2,1': 'D', '3,2': 'D', '4,0': 'D', '5,1': 'D' }), bet: 20, win: 2000 },
    { name: 'drake three, 2 × 3 × 1 ways', cols: e('D', { '1,0': 'D', '1,1': 'D', '2,0': 'D', '2,1': 'D', '2,2': 'D', '3,0': 'D' }), bet: 20, win: 75 * 6 },
    { name: 'drakes everywhere, 243 ways of five', cols: ['DDD', 'DDD', 'DDD', 'DDD', 'DDD'], bet: 20, win: 2000 * 243 },
    // The filler ash runes on reel 1 reach reel 2's core but not reel 3 (moss and an anvil).
    { name: 'a molten core stands in on reel 2', cols: e('A', { '1,0': 'A', '2,1': 'W', '3,2': 'A' }), bet: 20, win: 25 },
    { name: 'a core on reel 2 carries two of three reel-1 symbols', cols: ['afm', 'sWs', 'afg', 'HHH', 'AAA'], bet: 20, win: 4 + 4 },
    // Drake 5 × 27, hammer 4 × 27, glow 4 × 27 (reel 5 holds a drake but no hammer or glow).
    { name: 'cores on reels 2–4 make fives and fours', cols: ['DHg', 'WWW', 'WWW', 'WWW', 'Dsa'], bet: 20, win: 2000 * 27 + 50 * 27 + 20 * 27 },
    { name: 'pairs pay nothing', cols: e('D', { '1,0': 'D', '2,1': 'D' }), bet: 20, win: 0 },
    { name: 'a key on reels 1, 3 and 5 pays 3 × bet', cols: e('', { '1,0': 'K', '3,1': 'K', '5,2': 'K' }), bet: 20, win: 60, trigger: true, scatters: 3 },
    { name: 'two keys pay nothing', cols: e('', { '1,0': 'K', '5,2': 'K' }), bet: 20, win: 0, scatters: 2 },
    { name: 'key pay scales with the bet', cols: e('', { '1,1': 'K', '3,0': 'K', '5,2': 'K' }), bet: 500, win: 1500, trigger: true },
    { name: 'keys on reels 2 and 4 do not count', cols: e('', { '1,0': 'K', '2,0': 'K', '4,0': 'K' }), bet: 20, win: 0, scatters: 1 },
    { name: 'a core does not stand in for a key', cols: e('', { '1,0': 'K', '3,1': 'W', '5,0': 'K' }), bet: 20, win: 0, scatters: 2 },
    { name: 'plume four, 1 × 1 × 2 × 1 ways', cols: e('P', { '1,2': 'P', '2,0': 'P', '3,0': 'P', '3,2': 'P', '4,1': 'P' }), bet: 20, win: 150 * 2 },
    { name: 'anvil three at 100', cols: e('A', { '1,1': 'A', '2,2': 'A', '3,0': 'A' }), bet: 100, win: 125 },
    { name: 'two symbols both pay', cols: e('DP', { '1,0': 'D', '2,0': 'D', '3,0': 'D', '1,1': 'P', '2,1': 'P', '3,1': 'P' }), bet: 20, win: 75 + 40 },
    { name: 'a trigger and a ways win together at 40', cols: e('D', { '1,0': 'D', '2,0': 'D', '3,0': 'D', '1,2': 'K', '3,2': 'K', '5,0': 'K' }), bet: 40, win: 150 + 120, trigger: true },
    { name: 'a core on reel 4 extends three to four', cols: e('D', { '1,0': 'D', '2,1': 'D', '3,2': 'D', '4,1': 'W' }), bet: 20, win: 400 },
    // The drake runs to reel 4 through the cores; the two filler ash runes on reel 1 do too (4 × 2 ways).
    { name: 'cores on reels 2–4 behind a single drake', cols: e('D', { '1,0': 'D', '2,0': 'W', '3,0': 'W', '4,0': 'W' }), bet: 20, win: 400 + 10 * 2 },
    { name: 'a reel of cores triples every way', cols: e('D', { '1,0': 'D', '2,0': 'W', '2,1': 'W', '2,2': 'W', '3,1': 'D' }), bet: 20, win: 75 * 3 },
    { name: 'drakes on reel 1 only pay nothing', cols: e('D', { '1,0': 'D', '1,1': 'D', '1,2': 'D' }), bet: 20, win: 0 },
    { name: 'drake three at 200', cols: e('D', { '1,0': 'D', '2,1': 'D', '3,2': 'D' }), bet: 200, win: 750 },
    { name: 'drake five at 40', cols: e('D', { '1,0': 'D', '2,1': 'D', '3,2': 'D', '4,0': 'D', '5,1': 'D' }), bet: 40, win: 4000 },
    { name: 'plume three, three ways on reel 3', cols: e('P', { '1,1': 'P', '2,1': 'P', '3,0': 'P', '3,1': 'P', '3,2': 'P' }), bet: 20, win: 120 },
    { name: 'anvil four, two ways', cols: e('A', { '1,1': 'A', '2,1': 'A', '2,2': 'A', '3,1': 'A', '4,0': 'A' }), bet: 20, win: 150 },
    { name: 'a run broken on reel 3 pays nothing', cols: e('D', { '1,1': 'D', '2,1': 'D', '4,1': 'D', '5,1': 'D' }), bet: 20, win: 0 },
    { name: 'a key and a drake on reel 1', cols: e('D', { '1,0': 'K', '1,1': 'D', '2,1': 'D', '3,1': 'D', '3,0': 'K', '5,1': 'K' }), bet: 20, win: 75 + 60, trigger: true },
    // The hammer runs all five reels; the filler ash runes (two on reel 1) reach reel 4 through the cores.
    { name: 'hammer five through three cores', cols: e('H', { '1,1': 'H', '2,1': 'W', '3,1': 'W', '4,1': 'W', '5,1': 'H' }), bet: 20, win: 200 + 10 * 2 },
    { name: 'filler at the top bet', cols: e(''), bet: 500, win: 0 },
    { name: 'glow three, 1 × 1 × 3', cols: e('g', { '1,0': 'g', '2,0': 'g', '3,0': 'g', '3,1': 'g', '3,2': 'g' }), bet: 20, win: 6 * 3 },
    { name: 'moss three, two ways', cols: e('m', { '1,0': 'm', '2,0': 'm', '2,1': 'm', '3,2': 'm' }), bet: 20, win: 4 * 2 },
    { name: 'storm four', cols: e('s', { '1,0': 's', '2,0': 's', '3,0': 's', '4,0': 's' }), bet: 20, win: 12 },
    { name: 'ash five', cols: e('a', { '1,0': 'a', '2,0': 'a', '3,0': 'a', '4,0': 'a', '5,0': 'a' }), bet: 20, win: 30 },
    { name: 'frost three at 100', cols: e('f', { '1,1': 'f', '2,1': 'f', '3,1': 'f' }), bet: 100, win: 20 },
    { name: 'hammer four through a core on reel 3', cols: e('H', { '1,0': 'H', '2,0': 'H', '3,1': 'W', '4,2': 'H' }), bet: 20, win: 50 },
    { name: 'glow four', cols: e('g', { '1,2': 'g', '2,0': 'g', '3,1': 'g', '4,2': 'g' }), bet: 20, win: 20 },
    { name: 'plume five, 2 × 1 × 1 × 1 × 2 ways', cols: e('P', { '1,0': 'P', '1,2': 'P', '2,1': 'P', '3,1': 'P', '4,1': 'P', '5,0': 'P', '5,2': 'P' }), bet: 20, win: 600 * 4 },
    { name: 'anvil three and a trigger at 200', cols: e('A', { '1,1': 'A', '2,1': 'A', '3,1': 'A', '1,0': 'K', '3,0': 'K', '5,0': 'K' }), bet: 200, win: 250 + 600, trigger: true },
    { name: 'a reel without the symbol or a core stops every way', cols: ['DDD', 'WWW', 'sss', 'WWW', 'DDD'], bet: 20, win: 0 },
  ];
  it('pays every hand-built window as the rules say', () => check(EMBERVAULT, cases));
});

describe('strips and ladders', () => {
  it('has the three machines in wire order', () => {
    expect(MACHINES).toEqual(['orchard', 'tidepool', 'embervault']);
    expect(DEFS_BY_IDX.map((d) => d.code)).toEqual(MACHINES);
    expect(DEFS_BY_IDX.map((d) => d.idx)).toEqual([0, 1, 2]);
  });

  it('has the designed strip lengths and symbol counts', () => {
    expect(ORCHARD.stripText.map((s) => s.length)).toEqual([22, 22, 22]);
    expect(TIDEPOOL.stripText.map((s) => s.length)).toEqual([49, 48, 51, 48, 49]);
    expect(EMBERVAULT.stripText.map((s) => s.length)).toEqual([48, 47, 50, 47, 48]);
    expect(EMBERVAULT.fsStripText.map((s) => s.length)).toEqual([41, 42, 45, 42, 41]);
    const n = (s: string, ch: string): number => [...s].filter((c) => c === ch).length;
    // Wilds only where the design puts them; scatters only on their reels.
    for (const def of DEFS_BY_IDX) {
      const scatterCh = def.symbols[def.scatter] as string;
      for (const text of [...def.stripText, ...def.fsStripText]) for (const ch of text) expect(def.symbols).toContain(ch);
      def.stripText.forEach((text, r) => {
        if (!def.scatterReels.includes(r)) expect(n(text, scatterCh)).toBe(0);
        if (def !== ORCHARD && (r === 0 || r === def.reels - 1)) expect(n(text, 'W')).toBe(0);
      });
    }
    expect(TIDEPOOL.stripText.map((s) => n(s, 'X'))).toEqual([3, 0, 3, 0, 3]);
    expect(TIDEPOOL.stripText.map((s) => n(s, 'W'))).toEqual([0, 2, 2, 2, 0]);
    expect(EMBERVAULT.stripText.map((s) => n(s, 'K'))).toEqual([3, 0, 3, 0, 3]);
    expect(EMBERVAULT.fsStripText.map((s) => n(s, 'W'))).toEqual([0, 4, 4, 4, 0]);
    expect(ORCHARD.stripText.map((s) => n(s, 'B'))).toEqual([1, 1, 1]);
  });

  it('keeps every strip under 64 stops and never shows two scatters in one window', () => {
    for (const def of DEFS_BY_IDX) {
      for (const strip of [...def.strips, ...def.fsStrips]) {
        expect(strip.length).toBeLessThan(64);
        expect(strip.includes(255)).toBe(false);
        for (let i = 0; i < strip.length; i += 1) {
          let seen = 0;
          for (let y = 0; y < 3; y += 1) if (strip[(i + y) % strip.length] === def.scatter) seen += 1;
          expect(seen).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('pays whole chips at every ladder bet', () => {
    for (const def of DEFS_BY_IDX) {
      for (const bet of def.bets) {
        expect(Number.isInteger(bet / def.unitDiv)).toBe(true);
        if (def.feature.kind === 'wheel') for (const s of def.feature.segments) expect(Number.isInteger(s * bet)).toBe(true);
      }
    }
    expect(ORCHARD.bets).toEqual([5, 10, 25, 50, 100]);
    expect(TIDEPOOL.bets).toEqual([20, 40, 100, 200, 500]);
    expect(EMBERVAULT.bets).toEqual([20, 40, 100, 200, 500]);
  });

  it('trims the ladder to the admin maximum', () => {
    expect(betLadder(TIDEPOOL, 100)).toEqual([20, 40, 100]);
    expect(betAllowed(TIDEPOOL, 200, 100)).toBe(false);
    expect(betAllowed(TIDEPOOL, 40, 100)).toBe(true);
    expect(betAllowed(TIDEPOOL, 41, 1000)).toBe(false);
    expect(betAllowed(ORCHARD, 5, 5)).toBe(true);
  });
});
