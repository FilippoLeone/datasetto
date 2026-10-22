/**
 * Maths (bellwick.md §13 test 12): the glints a tale guarantees cover the Buckler; hits needed for each
 * enemy; Old Clapper's time to kill against ideal attackers is at least 45 s alone and 35 s with four;
 * there are eight heart shards and the hearts cap at six.
 */
import { describe, expect, it } from 'vitest';
import { content } from '../../../src/arcade/core/bellwick/content/parse.js';
import { flagId } from '../../../src/arcade/core/bellwick/content/flags.js';
import { createBellwick } from '../../../src/arcade/core/bellwick/runtime.js';
import { BOSS_RULES, bossHp, ENEMY_STATS, HERO_RULES, maxHp, SHOP } from '../../../src/arcade/core/bellwick/rules.js';
import { bossVulnerable } from '../../../src/arcade/core/bellwick/sim/boss.js';
import { applyHitTarget, newOutbox, placeHero } from '../../../src/arcade/core/bellwick/sim/party.js';
import { Attack, Item, Kind } from '../../../src/arcade/core/bellwick/types.js';

const hasFlag = (flags: Uint8Array, name: string): boolean => {
  const id = flagId(name);
  return ((flags[id >> 3] as number) & (1 << (id & 7))) !== 0;
};

/** Ticks until Old Clapper falls to `n` heroes who hit whenever he can be hurt (and hook him when they should). */
const idealKill = (n: number): number => {
  const m = createBellwick({ seed: 11, mode: 'local', save: null, taleSlot: 0xff });
  for (let s = 0; s < n; s += 1) m.join(s, s, s);
  const belfry = content().byKey.belfry!.id;
  const o = newOutbox();
  for (let s = 0; s < n; s += 1) placeHero(m.world, m.world.heroes[s]!, belfry, 600 + s * 500, 1900, 1, 0, o, 0);
  const room = m.world.rooms[belfry]!;
  const last = [-99, -99, -99, -99];
  for (let t = 0; t < 30 * 600; t += 1) {
    m.step();
    m.takeHostEvents();
    const boss = room.en.find((e) => e.kind === Kind.Boss);
    if (!boss) return t;
    const b = room.boss!;
    for (let s = 0; s < n; s += 1) {
      const h = m.world.heroes[s]!;
      if (b.phase === 3 && b.mode === 0) applyHitTarget(m.world, h, room, Attack.Hook, boss.id, boss.x, boss.y + 300);
      else if (bossVulnerable(room) && t - (last[s] as number) >= HERO_RULES.slashTicks) {
        last[s] = t;
        applyHitTarget(m.world, h, room, Attack.Slash, boss.id, boss.x, boss.y + 300);
      }
    }
    // Keep everyone alive and standing: this is about the boss's clock, not dodging.
    for (let s = 0; s < n; s += 1) m.world.heroes[s]!.hp = 12;
  }
  return -1;
};

describe('Bellwick maths', () => {
  it('guarantees the glints for the Bark Buckler before Gloam Gate', () => {
    const c = content().byKey;
    const hesper = c.hesper!.npcs.find((x) => x.gift === Item.Glints)!.n;
    const windmill = c.windmill!.chests.find((x) => x.item === Item.Glints)!.n;
    const cave = c.cave!.chests.find((x) => x.item === Item.Glints)!.n;
    expect(hesper + windmill + cave).toBeGreaterThanOrEqual(SHOP.buckler);
  });

  it('prices the shop within the purse, and counts the hits each enemy takes', () => {
    expect(Math.max(SHOP.buckler, SHOP.brew, SHOP.shard)).toBeLessThanOrEqual(500);
    const slashes = (k: number): number => Math.ceil((ENEMY_STATS[k]?.hp ?? 0) / HERO_RULES.slashDamage);
    expect(slashes(Kind.Burrlet)).toBe(1);
    expect(slashes(Kind.Snapjaw)).toBe(2);
    expect(slashes(Kind.Slingkin)).toBe(2);
    expect(slashes(Kind.Wisp)).toBe(1);
    expect(slashes(Kind.Rootling)).toBe(2);
    expect(slashes(Kind.Bat)).toBe(1);
    // A Shellback takes two spins (4 each), or two slashes once flipped (double damage).
    expect(Math.ceil((ENEMY_STATS[Kind.Shellback]?.hp ?? 0) / HERO_RULES.spinDamage)).toBe(2);
  });

  it('scales Old Clapper with the heroes there when the fight starts', () => {
    expect([1, 2, 3, 4].map(bossHp)).toEqual([24, 36, 48, 60]);
    expect(BOSS_RULES.contact).toBe(2);
  });

  it('takes ideal attackers at least 45 s alone and 35 s with four', () => {
    const solo = idealKill(1);
    const four = idealKill(4);
    expect(solo).toBeGreaterThan(0);
    expect(four).toBeGreaterThan(0);
    expect(solo / 30).toBeGreaterThanOrEqual(45);
    expect(four / 30).toBeGreaterThanOrEqual(35);
  });

  it('caps hearts at six with eight shards and the Heart Vessel', () => {
    expect(maxHp(0, 0)).toBe(6);
    expect(maxHp(0, 4)).toBe(8);
    expect(maxHp(1, 8)).toBe(12);
    expect(maxHp(1, 9)).toBe(12);
    expect(hasFlag(new Uint8Array(32), 'boss_down')).toBe(false);
  });
});
