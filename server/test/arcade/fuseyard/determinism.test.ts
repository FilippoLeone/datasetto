/**
 * Determinism (docs/arcade/fuseyard.md §2.4, §12 "fuseyard.determinism"): 20 seeded Quickfire rounds
 * with random inputs, each run twice with hashes compared every 30 ticks; and the golden hashes at
 * ticks 300 and 1,800 for 5 seeds (the client's jsdom suite checks the same table). A rules change
 * fails here until VERSION.sim is bumped and GOLDEN is re-recorded.
 */
import { describe, expect, it } from 'vitest';
import { xorshift32 } from '../../../src/arcade/core/rng.js';
import { GOLDEN, goldenRun } from '../../../src/arcade/core/fuseyard/golden.js';
import { hashMatch } from '../../../src/arcade/core/fuseyard/replay.js';
import { BotLevel, inputByte, newStepIn } from '../../../src/arcade/core/fuseyard/rules.js';
import { createMatch, step } from '../../../src/arcade/core/fuseyard/sim.js';
import { VERSION } from '../../../src/arcade/core/fuseyard/version.js';

const runRound = (seed: number): number[] => {
  const m = createMatch({ mode: 'quickfire', arena: 'rotation', fighters: 4, winsNeeded: 3, botLevel: BotLevel.Scrapper, seed }, [
    { slot: 0, human: true, botLevel: 1 },
    { slot: 1, human: true, botLevel: 1 },
    { slot: 2, human: false, botLevel: BotLevel.Menace },
    { slot: 3, human: false, botLevel: BotLevel.Sprout },
  ]);
  let s = seed * 2654435761 >>> 0 || 1;
  const input = newStepIn();
  const hashes: number[] = [];
  for (let t = 1; t <= 2900 && m.current.phase !== 5; t += 1) {
    for (let k = 0; k < 2; k += 1) {
      s = xorshift32(s);
      input.inputs[k] = inputByte(s % 5, (s >>> 4) % 5, (s >>> 8) % 23 === 0, (s >>> 12) % 31 === 0);
    }
    input.grace[0] = (s >>> 16) % 5;
    step(m, input);
    if (t % 30 === 0) hashes.push(hashMatch(m));
  }
  return hashes;
};

describe('determinism', () => {
  it('20 seeded Quickfire rounds with random inputs replay to the same hashes', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const a = runRound(seed);
      const b = runRound(seed);
      expect(a.length).toBeGreaterThan(5);
      expect(b).toEqual(a);
    }
  });

  it('golden hashes at ticks 300 and 1,800 match for the current sim version', () => {
    expect(VERSION.sim, 'bump VERSION.sim and GOLDEN together').toBe(GOLDEN.sim);
    const got = GOLDEN.seeds.map((seed) => goldenRun(seed));
    expect(got).toEqual(GOLDEN.hashes.map((h) => Array.from(h)));
  });
});
