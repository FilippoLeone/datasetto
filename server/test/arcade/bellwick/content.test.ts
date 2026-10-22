/**
 * Content (bellwick.md §13 test 2): screens are 12 × 9 and their open edges line up; every reference
 * resolves and sits on the right tile; maps hold no backtick or `${`; flag ids are unique, at most 256
 * and append-only against flags.lock.json; every chest, door and person is reachable.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FLAG_NAMES, flagId } from '../../../src/arcade/core/bellwick/content/flags.js';
import { T } from '../../../src/arcade/core/bellwick/content/legend.js';
import { content, screen } from '../../../src/arcade/core/bellwick/content/parse.js';
import { TEXT } from '../../../src/arcade/core/bellwick/content/text.js';
import walkthrough from '../../../src/arcade/core/bellwick/content/walkthrough.js';
import { parseWalkthrough } from '../../../src/arcade/core/bellwick/bots/hero.js';
import { edgeOpen } from '../../../src/arcade/core/bellwick/rules.js';
import { Item } from '../../../src/arcade/core/bellwick/types.js';
import { besideReachable, reach, stand } from './reach.js';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/arcade/core/bellwick/content');

const all = (): Set<number> => {
  const flags = new Set<number>();
  for (let i = 0; i < FLAG_NAMES.length; i += 1) flags.add(i);
  return reach({ sword: true, buckler: true, hook: true, flags });
};

describe('Bellwick content', () => {
  it('has 20 overworld screens, 3 interiors and 13 Bellhouse rooms', () => {
    const c = content();
    const ids = c.screens.flatMap((d, i) => (d ? [i] : []));
    expect(ids.filter((i) => i < 20)).toHaveLength(20);
    expect(ids.filter((i) => i >= 20 && i < 23)).toHaveLength(3);
    expect(ids.filter((i) => i >= 32)).toHaveLength(13);
    for (const d of c.screens) if (d) expect(d.tiles).toHaveLength(108);
  });

  it('lines up open tiles on every shared screen edge', () => {
    const c = content();
    for (const d of c.screens) {
      if (!d) continue;
      for (let e = 0; e < 4; e += 1) {
        if (d.exits[e]) continue;
        const o = d.near[e] as number >= 0 ? c.screens[d.near[e] as number] : null;
        for (let k = 0; k < (e < 2 ? 12 : 9); k += 1) {
          const t = e === 0 ? 96 + k : e === 1 ? k : e === 2 ? k * 12 : k * 12 + 11;
          const t2 = e === 0 ? k : e === 1 ? 96 + k : e === 2 ? k * 12 + 11 : k * 12;
          const a = edgeOpen(d.tiles[t] as number);
          const b = o ? edgeOpen(o.tiles[t2] as number) : false;
          expect(a, d.key + ' edge ' + e + ' at ' + k).toBe(b);
        }
      }
    }
  });

  it('puts every directive on the tile it describes', () => {
    for (const d of content().screens) {
      if (!d) continue;
      const at = (t: number): number => d.tiles[t] as number;
      for (const ch of d.chests) {
        const ok = ch.onClear ? at(ch.tile) === T.FLOOR : ch.under ? at(ch.tile) === T.BLOCK : at(ch.tile) === T.CHEST;
        expect(ok, d.key + ' chest ' + ch.tile).toBe(true);
        expect(ch.flag, d.key + ' chest flag').toBeGreaterThanOrEqual(0);
      }
      for (const s of d.signs) {
        expect(at(s.tile), d.key + ' sign').toBe(T.SIGN);
        expect(TEXT[s.text], 'text ' + s.text).toBeDefined();
      }
      for (const n of d.npcs) {
        expect(at(n.tile), d.key + ' npc').toBe(T.NPC);
        expect(TEXT[n.text], 'text ' + n.text).toBeDefined();
      }
      for (const s of d.shop) expect(at(s.tile), d.key + ' shop').toBe(T.COUNTER);
      for (const l of d.locks) expect([T.LOCK, T.BOSSDOOR]).toContain(at(l.tile));
      if (d.lantern) expect(at(d.lantern.tile)).toBe(T.LANTERN);
      if (d.crystal) expect(at(d.crystal.tile)).toBe(T.CRYSTAL);
      for (const s of d.stash) expect(at(s.tile)).toBe(T.BUSH);
      for (const w of d.warps) {
        expect([T.DOOR, T.CAVE]).toContain(at(w.tile));
        expect(stand(screen(w.to).tiles[w.tile2] as number), d.key + ' warp lands on ground').toBe(true);
      }
      for (const x of d.exits) if (x) expect(stand(screen(x.to).tiles[x.tile2] as number), d.key + ' exit lands on ground').toBe(true);
      // Every lock flag opens a pair, the same on both tiles.
      const lockFlags = new Set(d.locks.map((l) => l.flag));
      for (const f of lockFlags) expect(d.locks.filter((l) => l.flag === f).length, d.key + ' lock pair').toBe(2);
    }
    const c = content();
    expect(screen(c.startRoom).key).toBe('square');
    expect(c.lanterns).toHaveLength(4);
  });

  it('keeps maps free of backticks and template holes', () => {
    for (const file of ['overworld.txt.ts', 'interiors.txt.ts', 'bellhouse.txt.ts']) {
      const src = readFileSync(resolve(DIR, file), 'utf8');
      const body = src.slice(src.indexOf('String.raw`') + 11, src.lastIndexOf('`'));
      expect(body.includes('`'), file).toBe(false);
      expect(body.includes('${'), file).toBe(false);
    }
  });

  it('numbers flags append-only against flags.lock.json, at most 256, all unique', () => {
    const lock = JSON.parse(readFileSync(resolve(DIR, 'flags.lock.json'), 'utf8')) as Record<string, number>;
    expect(FLAG_NAMES.length).toBeLessThanOrEqual(256);
    expect(new Set(FLAG_NAMES).size).toBe(FLAG_NAMES.length);
    for (const [name, id] of Object.entries(lock)) expect(flagId(name), 'flag ' + name + ' moved').toBe(id);
    expect(flagId('boss_down')).toBe(32);
  });

  it('can reach every chest, person, sign, lock, lantern and door with everything open', () => {
    const seen = all();
    for (const d of content().screens) {
      if (!d) continue;
      const room = d.id;
      // A shopkeeper is talked to across the counter.
      const behindCounter = (t: number): boolean => d.tiles[t + 12] === T.COUNTER;
      const targets = [
        ...d.chests.map((x) => x.tile),
        ...d.npcs.filter((x) => !behindCounter(x.tile)).map((x) => x.tile),
        ...d.signs.map((x) => x.tile),
        ...d.locks.map((x) => x.tile),
        ...d.shop.map((x) => x.tile),
      ];
      if (d.lantern) targets.push(d.lantern.tile);
      for (const t of targets) expect(besideReachable(seen, room, t), d.key + ' tile ' + (t % 12) + ',' + Math.floor(t / 12)).toBe(true);
      for (const w of d.warps) expect(seen.has(room * 108 + w.tile), d.key + ' door').toBe(true);
    }
  });

  it('has a walkthrough whose every step parses', () => {
    expect(parseWalkthrough(walkthrough).length).toBe(walkthrough.length);
  });

  it('hides eight heart shards in the world', () => {
    let shards = 0;
    for (const d of content().screens) {
      if (!d) continue;
      shards += d.chests.filter((c) => c.item === Item.Shard).length;
      shards += d.npcs.filter((n) => n.gift === Item.Shard).length;
      shards += d.shop.filter((s) => s.item === Item.Shard).length;
    }
    expect(shards).toBe(8);
  });
});
