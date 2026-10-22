/**
 * Golden replays (fuseyard.md §12 "fuseyard.determinism"): five seeded four-bot Brawl matches,
 * hashed at ticks 300 and 1,800. The same table is checked in Node (server tests) and in jsdom (the
 * client's chunk tests), so an engine difference shows up as a failure. A rules change changes the
 * hashes: bump `VERSION.sim` in version.ts and record the new hashes here together.
 *
 * Only tests import this module.
 */
import { hashMatch } from './replay.js';
import { BotLevel, newStepIn, type MatchConfig } from './rules.js';
import { createMatch, step } from './sim.js';

export const GOLDEN = {
  sim: 1,
  seeds: [1, 2, 3, 4, 5],
  at: [300, 1800],
  /** hashes[i] = [hash at 300, hash at 1,800] for seeds[i]. */
  hashes: [
    [0x8e151e8c, 0xd237543e],
    [0x1a2f5b35, 0x9a72e7c2],
    [0x035224b1, 0xe64e00dd],
    [0x5c2e00fe, 0x44249115],
    [0x10838562, 0x962f0ee1],
  ] as readonly (readonly number[])[],
};

export const goldenConfig = (seed: number): MatchConfig => ({ mode: 'brawl', arena: 'rotation', fighters: 4, winsNeeded: 3, botLevel: BotLevel.Scrapper, seed });

/** Runs one golden match and returns its hashes at `GOLDEN.at`. */
export const goldenRun = (seed: number): number[] => {
  const m = createMatch(goldenConfig(seed), [
    { slot: 0, human: false, botLevel: BotLevel.Menace },
    { slot: 1, human: false, botLevel: BotLevel.Scrapper },
    { slot: 2, human: false, botLevel: BotLevel.Sprout },
    { slot: 3, human: false, botLevel: BotLevel.Scrapper },
  ]);
  const input = newStepIn();
  const out: number[] = [];
  const last = GOLDEN.at[GOLDEN.at.length - 1] as number;
  for (let t = 1; t <= last; t += 1) {
    step(m, input);
    if (GOLDEN.at.includes(t)) out.push(hashMatch(m));
  }
  return out;
};
