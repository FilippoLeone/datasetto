/**
 * Completion (bellwick.md §13 test 6): the walkthrough bot finishes the whole tale from seed 1 within
 * 45,000 ticks, and seeded runs from the Bellhouse's Entry Hall all finish. The bot reads only what a
 * client sees and answers with buttons, so this proves the content can be completed by play.
 */
import { describe, expect, it } from 'vitest';
import { flagId } from '../../../src/arcade/core/bellwick/content/flags.js';
import { botRun, dungeonSave, dungeonScript } from './helpers.js';

const bossDown = (r: ReturnType<typeof botRun>): boolean => {
  const id = flagId('boss_down');
  return ((r.run.core.world.party.flags[id >> 3] as number) & (1 << (id & 7))) !== 0;
};

describe('Bellwick completion', () => {
  it('the bot finishes the tale from seed 1 within 45,000 ticks', () => {
    const r = botRun(1);
    const ticks = r.play(45_000);
    expect(r.bot.done, 'stopped at step ' + r.bot.step).toBe(true);
    expect(bossDown(r)).toBe(true);
    expect(r.run.core.world.party.vessels).toBe(1);
    expect(ticks).toBeLessThan(45_000);
  });

  it('seeded runs through the Drowned Bellhouse all finish', () => {
    const script = dungeonScript();
    const failed: number[] = [];
    for (let seed = 1; seed <= 32; seed += 1) {
      const r = botRun(1000 + seed, { save: dungeonSave(1000 + seed), script });
      r.play(30_000);
      if (!r.bot.done || !bossDown(r)) failed.push(seed);
    }
    expect(failed).toEqual([]);
  });
});
