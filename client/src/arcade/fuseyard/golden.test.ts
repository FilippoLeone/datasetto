/**
 * Golden replays in jsdom (plan.md §2.5, fuseyard.md §12): the same five seeded matches as the
 * server's determinism suite, hashed at ticks 300 and 1,800, must give the same hashes here.
 */
import { describe, expect, it } from 'vitest';
import { GOLDEN, goldenRun } from '@arcade/core/fuseyard/golden';
import { VERSION } from '@arcade/core/fuseyard/version';

describe('Fuseyard golden replays (jsdom)', () => {
  it('match the hashes recorded for this sim version', () => {
    expect(VERSION.sim).toBe(GOLDEN.sim);
    expect(GOLDEN.seeds.map((seed) => goldenRun(seed))).toEqual(GOLDEN.hashes.map((h) => Array.from(h)));
  });
});
