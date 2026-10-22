/**
 * The CI bot soak (docs/arcade/fuseyard.md §12 "fuseyard.soak", plan.md §3.5): 60 one-on-one
 * Quickfire rounds of Menace against Sprout plus 12 four-bot Brawl rounds, about 100,000 ticks,
 * hard-capped at 6 s. The 10× version runs on demand: `npx tsx test/arcade/fuseyard/soak.mts`.
 *
 * Self-kills count deaths in a fighter's own flame. The four-bot rounds use the lobby's default
 * level (Scrapper), so the Menace and Sprout figures come from the duels.
 */
import { describe, expect, it } from 'vitest';
import { median, runSoak, summary } from './soakRun.js';

describe('the bot soak', () => {
  it('Menace beats Sprout, nobody blows themselves up much, rounds end in time and nobody gets stuck', () => {
    const s = runSoak(1, 6000);
    // Shows up in the test output so the numbers are visible on every run.
    console.log('fuseyard soak: ' + summary(s));
    expect(s.stoppedEarly).toBeNull();
    expect(s.duelRounds).toBe(60);
    expect(s.brawlRounds).toBe(12);
    expect(s.roundsPastLimit).toBe(0);
    expect(s.menaceWins / s.duelRounds).toBeGreaterThanOrEqual(0.8);
    expect(s.selfKills[2]! / Math.max(1, s.deaths[2]!)).toBeLessThan(0.1);
    expect(s.selfKills[0]! / Math.max(1, s.deaths[0]!)).toBeLessThan(0.4);
    const med = median(s.brawlLengths) / 30;
    expect(med).toBeGreaterThanOrEqual(30);
    expect(med).toBeLessThanOrEqual(110);
    expect(s.maxStuck).toBeLessThan(300);
    expect(s.thinkP99Ms).toBeLessThanOrEqual(0.1);
    expect(s.ticks).toBeGreaterThan(60_000);
  }, 15_000);
});
