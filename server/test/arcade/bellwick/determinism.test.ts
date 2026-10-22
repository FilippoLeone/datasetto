/**
 * Determinism and version (bellwick.md §13 test 4): golden hashes of a seeded 4-hero log at ticks 300
 * and 1,800 (the client chunk's jsdom test checks the same numbers); a 20,000-tick log replayed twice
 * agrees every 100 ticks; and the codec contract hash (`RULES_HASH`) only changes with a codec bump.
 */
import { describe, expect, it } from 'vitest';
import { GOLDEN, goldenButtons, runLog } from '../../../src/arcade/core/bellwick/golden.js';
import { RULES_HASH, rulesHash, HERO_RULES, HERO_RULE_ORDER } from '../../../src/arcade/core/bellwick/rules.js';
import { VERSION } from '../../../src/arcade/core/bellwick/version.js';

describe('Bellwick determinism', () => {
  it('matches the golden hashes at ticks 300 and 1,800 for this sim version', () => {
    const log = goldenButtons(GOLDEN.seed, 4, 1800);
    const [t300, t1800] = runLog(GOLDEN.seed, 4, log, [300, 1800]);
    if (VERSION.sim === GOLDEN.sim) {
      expect(t300?.toString(16), 'tick 300: bump SIM.bellwick (core/bellwick/version.ts) and refresh GOLDEN if the rules changed').toBe(GOLDEN.t300.toString(16));
      expect(t1800?.toString(16), 'tick 1800').toBe(GOLDEN.t1800.toString(16));
    } else {
      throw new Error('VERSION.sim is ' + VERSION.sim + ': record GOLDEN for it (t300 ' + t300 + ', t1800 ' + t1800 + ')');
    }
  });

  it('replays a 20,000-tick log twice to the same hash every 100 ticks', () => {
    const log = goldenButtons(99, 4, 20_000);
    const at: number[] = [];
    for (let t = 100; t <= 20_000; t += 100) at.push(t);
    const a = runLog(99, 4, log, at);
    const b = runLog(99, 4, log, at);
    expect(a).toHaveLength(200);
    expect(b).toEqual(a);
    expect(new Set(a).size).toBeGreaterThan(150);
  });

  it('changes the codec contract hash only together with CODEC.bellwick', () => {
    expect(HERO_RULE_ORDER.length).toBe(Object.keys(HERO_RULES).length);
    expect(new Set(HERO_RULE_ORDER).size).toBe(HERO_RULE_ORDER.length);
    if (VERSION.codec === RULES_HASH.codec) {
      expect(rulesHash().toString(16), 'HERO_RULES or TILE_FLAGS changed: bump VERSION.codec and record the new RULES_HASH').toBe(RULES_HASH.hash.toString(16));
    } else {
      throw new Error('VERSION.codec is ' + VERSION.codec + ': record RULES_HASH for it (0x' + rulesHash().toString(16) + ')');
    }
  });
});
