/**
 * Golden replays (bellwick.md §13 test 4): a seeded 4-hero `Buttons` log run through the lock-step loop,
 * hashed with FNV-1a at fixed ticks. The server suite (Node) and the client chunk's jsdom test run the
 * same log and must both produce `GOLDEN`; a rule change fails both until `SIM.bellwick` is bumped and
 * the hashes are refreshed.
 */
import { xorshift32 } from '../rng.js';
import { createLocalRun } from './replay.js';
import { Btn } from './types.js';

/** The expected hashes for the current `VERSION.sim`. */
export const GOLDEN = { sim: 1, seed: 7, t300: 0x33776a4d, t1800: 0x7206f37e } as const;

const MOVES: readonly number[] = [Btn.up, Btn.down, Btn.left, Btn.right, Btn.up | Btn.left, Btn.down | Btn.right, 0];

/** A `Buttons` log: each hero holds a direction for 8–40 ticks and taps A or B now and then. */
export const goldenButtons = (seed: number, heroes: number, ticks: number): Uint8Array => {
  const log = new Uint8Array(ticks * heroes);
  let s = seed >>> 0 || 1;
  for (let h = 0; h < heroes; h += 1) {
    let hold = 0;
    let dir = 0;
    for (let t = 0; t < ticks; t += 1) {
      if (hold <= 0) {
        s = xorshift32(s);
        dir = MOVES[s % MOVES.length] as number;
        s = xorshift32(s);
        hold = 8 + (s % 33);
      }
      hold -= 1;
      s = xorshift32(s);
      const r = s % 100;
      log[t * heroes + h] = dir | (r < 6 ? Btn.a : 0) | (r === 7 ? Btn.b : 0) | (r === 8 ? Btn.swap : 0);
    }
  }
  return log;
};

/** Runs a log and returns the world hash after each tick in `at`. */
export const runLog = (seed: number, heroes: number, log: Uint8Array, at: readonly number[]): number[] => {
  const run = createLocalRun({ seed, heroes });
  const out: number[] = [];
  const ticks = log.length / heroes;
  const buttons: number[] = [];
  let next = 0;
  for (let t = 1; t <= ticks; t += 1) {
    buttons.length = 0;
    for (let h = 0; h < heroes; h += 1) buttons.push(log[(t - 1) * heroes + h] as number);
    run.step(buttons);
    if (t === at[next]) {
      out.push(run.hash());
      next += 1;
    }
  }
  return out;
};
