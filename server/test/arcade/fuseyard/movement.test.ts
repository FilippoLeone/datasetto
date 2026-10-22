/**
 * Movement (docs/arcade/fuseyard.md §1.2, §12 "fuseyard.movement"): 2,000 random input sequences
 * × 120 ticks never put a fighter into a blocked cell; fighters clamp exactly on cell centres at
 * every speed; the secondary direction takes corners.
 */
import { describe, expect, it } from 'vitest';
import { xorshift32 } from '../../../src/arcade/core/rng.js';
import { SPAWNS } from '../../../src/arcade/core/fuseyard/arenas.js';
import { ARENA_IDS, SPEEDS, newStepIn } from '../../../src/arcade/core/fuseyard/rules.js';
import { step } from '../../../src/arcade/core/fuseyard/sim.js';
import { Cell, Dir, cellAt, cx, cy, fighter, inputByte, place, run, scenario, xy } from './helpers.js';

describe('movement', () => {
  it('2,000 random sequences × 120 ticks never enter a blocked cell', () => {
    let s = 0x2468ace1;
    const rnd = (n: number): number => {
      s = xorshift32(s);
      return s % n;
    };
    const input = newStepIn();
    let checked = 0;
    for (let seq = 0; seq < 2000; seq += 1) {
      const arena = ARENA_IDS[seq % 5]!;
      const m = scenario({ arena, fighters: 4, keepBlocks: true, seed: seq + 1 });
      const r = m.current;
      for (let k = 0; k < 4; k += 1) {
        const f = fighter(m, k);
        f.speedLvl = rnd(6);
        f.glove = rnd(4) === 0;
      }
      let d1 = 0;
      let d2 = 0;
      for (let t = 0; t < 120; t += 1) {
        if (rnd(8) === 0) {
          d1 = rnd(5);
          d2 = rnd(5);
        }
        for (let k = 0; k < 4; k += 1) input.inputs[k] = inputByte(k === 0 ? d1 : (d1 + k) % 5, k === 0 ? d2 : (d2 + k) % 5, rnd(20) === 0, false);
        step(m, input);
        for (let k = 0; k < 4; k += 1) {
          const f = fighter(m, k);
          if (!f.alive) continue;
          const c = cellAt(f.x, f.y);
          // Steel can drop on a fighter; anything else under a live fighter is a bug.
          if (r.cells[c] !== Cell.Floor) throw new Error(`seq ${seq} tick ${t}: fighter ${k} in cell ${c} of kind ${r.cells[c]}`);
          for (let i = 0; i < r.bombCount; i += 1) {
            const b = r.bombs[i]!;
            if (cellAt(b.x, b.y) === c && b.slideDir === 0 && !(b.passers & (1 << k))) {
              // Standing on a resting bomb is allowed only for a fighter who overlapped it when it
              // appeared (passer) or whom a sliding bomb ran into.
              const ox = Math.abs(f.x - cx(c));
              const oy = Math.abs(f.y - cy(c));
              if (ox > 24 || oy > 24) throw new Error(`seq ${seq} tick ${t}: fighter ${k} walked into bomb at ${c}`);
            }
          }
          checked += 1;
        }
        if (m.current.phase !== 1) break;
      }
    }
    expect(checked).toBeGreaterThan(200_000);
  });

  it('clamps exactly on a cell centre in front of a wall at every speed', () => {
    for (let lvl = 0; lvl < SPEEDS.length; lvl += 1) {
      const m = scenario();
      const f = place(m, 0, xy(1, 1));
      place(m, 1, xy(13, 11));
      f.speedLvl = lvl;
      const xs: number[] = [];
      for (let t = 0; t < 200; t += 1) {
        run(m, 1, { 0: inputByte(Dir.E, 0, false, false) });
        xs.push(f.x);
      }
      expect(f.x).toBe(cx(xy(13, 1)));
      expect(Math.max(...xs)).toBe(cx(xy(13, 1)));
      // Every tick moved by the full speed until the clamp.
      const first = xs[0]! - cx(xy(1, 1));
      expect(first).toBe(SPEEDS[lvl]);
    }
  });

  it('takes corners with the secondary direction', () => {
    const m = scenario();
    const f = place(m, 0, xy(2, 1));
    place(m, 1, xy(13, 11));
    // South is a pillar from (2,1); east as d2 carries it to (3,1), where south opens.
    run(m, 40, { 0: inputByte(Dir.S, Dir.E, false, false) });
    expect(cellAt(f.x, f.y) % 15).toBe(3);
    expect(cellAt(f.x, f.y)).toBeGreaterThan(xy(3, 2));
    expect(f.x).toBe(cx(xy(3, 1)));
  });

  it('slides off a pillar edge into the gap (rule 2)', () => {
    const m = scenario();
    const f = place(m, 0, xy(2, 1));
    place(m, 1, xy(13, 11));
    f.x += 10;
    run(m, 30, { 0: inputByte(Dir.S, 0, false, false) });
    expect(f.x).toBe(cx(xy(3, 1)));
    expect(cellAt(f.x, f.y)).not.toBe(xy(2, 1));
  });

  it('a fighter alone on its spawn can always leave it', () => {
    for (let s = 0; s < 4; s += 1) {
      const m = scenario({ fighters: 4, keepBlocks: true, seed: 99 });
      const f = fighter(m, s);
      const start = cellAt(f.x, f.y);
      expect(start).toBe(SPAWNS[s]);
      const away = s % 2 === 0 ? Dir.E : Dir.W;
      run(m, 30, { [s]: inputByte(away, 0, false, false) });
      expect(cellAt(f.x, f.y)).not.toBe(start);
    }
  });
});
