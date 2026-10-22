/**
 * Soft-lock solver (bellwick.md §13 test 3): a search over progress states (items, keys, opened doors,
 * the glints in the purse) where each step takes something the real maps let a hero reach. From every
 * state the search can reach, victory must stay reachable, whatever order keys are spent in.
 */
import { describe, expect, it } from 'vitest';
import { flagId } from '../../../src/arcade/core/bellwick/content/flags.js';
import { content } from '../../../src/arcade/core/bellwick/content/parse.js';
import { SHOP } from '../../../src/arcade/core/bellwick/rules.js';
import { besideReachable, reach } from './reach.js';

interface Loc {
  name: string;
  room: string;
  /** Tile to stand beside (x, y). */
  x: number;
  y: number;
  needs?: (s: number) => boolean;
}

// Bits of the progress state.
const B = {
  sword: 1,
  gift: 2,
  windmill: 4,
  cave: 8,
  buckler: 16,
  keyA: 32,
  keyC: 64,
  keyB: 128,
  hook: 256,
  bossKey: 512,
  l1: 1024,
  l2: 2048,
  l3: 4096,
  door: 8192,
} as const;

const keys = (s: number): number =>
  ((s & B.keyA) ? 1 : 0) + ((s & B.keyC) ? 1 : 0) + ((s & B.keyB) ? 1 : 0) - ((s & B.l1) ? 1 : 0) - ((s & B.l2) ? 1 : 0) - ((s & B.l3) ? 1 : 0);
const purse = (s: number): number => ((s & B.gift) ? 5 : 0) + ((s & B.windmill) ? 10 : 0) + ((s & B.cave) ? 20 : 0) - ((s & B.buckler) ? SHOP.buckler : 0);

const LOCS: readonly (Loc & { bit: number })[] = [
  { bit: B.sword, name: 'Rootsword', room: 'hesper', x: 9, y: 2 },
  { bit: B.gift, name: "Hesper's glints", room: 'hesper', x: 2, y: 2 },
  { bit: B.windmill, name: 'Windmill chest', room: 'windmill', x: 3, y: 3 },
  { bit: B.cave, name: 'Cave chest', room: 'cave', x: 1, y: 1 },
  { bit: B.buckler, name: 'Bark Buckler', room: 'shop', x: 3, y: 2, needs: (s) => purse(s) >= SHOP.buckler },
  { bit: B.keyA, name: 'key A', room: 'cistern', x: 2, y: 6 },
  { bit: B.keyC, name: 'key C', room: 'chapel', x: 5, y: 2, needs: (s) => (s & B.sword) !== 0 },
  { bit: B.keyB, name: 'key B', room: 'crypt', x: 2, y: 1 },
  { bit: B.hook, name: 'Vinehook', room: 'vault', x: 6, y: 7 },
  { bit: B.bossKey, name: 'Boss Key', room: 'clockwork', x: 10, y: 2 },
  { bit: B.l1, name: 'L1', room: 'nave', x: 11, y: 4, needs: (s) => keys(s) > 0 },
  { bit: B.l2, name: 'L2', room: 'nave', x: 5, y: 0, needs: (s) => keys(s) > 0 },
  { bit: B.l3, name: 'L3', room: 'ropehall', x: 11, y: 2, needs: (s) => keys(s) > 0 },
  { bit: B.door, name: 'boss door', room: 'ante', x: 5, y: 0, needs: (s) => (s & B.bossKey) !== 0 },
];

const reachCache = new Map<number, Set<number>>();
const reachOf = (s: number): Set<number> => {
  const key = s & (B.sword | B.buckler | B.hook | B.l1 | B.l2 | B.l3 | B.door);
  let r = reachCache.get(key);
  if (!r) {
    const flags = new Set<number>();
    if (s & B.l1) flags.add(flagId('lock_l1'));
    if (s & B.l2) flags.add(flagId('lock_l2'));
    if (s & B.l3) flags.add(flagId('lock_l3'));
    if (s & B.door) flags.add(flagId('boss_door'));
    r = reach({ sword: (s & B.sword) !== 0, buckler: (s & B.buckler) !== 0, hook: (s & B.hook) !== 0, flags });
    reachCache.set(key, r);
  }
  return r;
};

const victory = (s: number): boolean => {
  if ((s & B.sword) === 0 || (s & B.door) === 0) return false;
  const belfry = content().byKey.belfry!.id;
  return reachOf(s).has(belfry * 108 + 4 * 12 + 5);
};

const moves = (s: number): number[] => {
  const out: number[] = [];
  const seen = reachOf(s);
  for (const l of LOCS) {
    if ((s & l.bit) !== 0 || (l.needs && !l.needs(s))) continue;
    const room = content().byKey[l.room]!.id;
    if (besideReachable(seen, room, l.y * 12 + l.x)) out.push(s | l.bit);
  }
  return out;
};

describe('Bellwick soft-lock solver', () => {
  it('keeps victory reachable from every reachable progress state, whatever the key order', () => {
    const states = new Map<number, number[]>();
    const queue = [0];
    states.set(0, []);
    for (let head = 0; head < queue.length; head += 1) {
      const s = queue[head] as number;
      const next = moves(s);
      states.set(s, next);
      for (const n of next) {
        if (!states.has(n)) {
          states.set(n, []);
          queue.push(n);
        }
      }
    }
    // Backwards from the winning states.
    const good = new Set<number>();
    for (const s of states.keys()) if (victory(s)) good.add(s);
    expect(good.size).toBeGreaterThan(0);
    for (let changed = true; changed; ) {
      changed = false;
      for (const [s, next] of states) {
        if (good.has(s)) continue;
        if (next.some((n) => good.has(n))) {
          good.add(s);
          changed = true;
        }
      }
    }
    const stuck = [...states.keys()].filter((s) => !good.has(s));
    expect(stuck.map((s) => s.toString(2)), 'progress states with no way to the bell').toEqual([]);
    // Both orders of spending keys A and C are explored, and key B never opens L1 or L2 first.
    expect(states.size).toBeGreaterThan(20);
  });

  it('needs the Buckler to pass Gloam Gate and the Vinehook to reach key B', () => {
    const shore = content().byKey.shore!.id;
    expect(reachOf(B.sword).has(shore * 108 + 3 * 12 + 6)).toBe(false);
    expect(reachOf(B.sword | B.buckler).has(shore * 108 + 3 * 12 + 6)).toBe(true);
    const crypt = content().byKey.crypt!.id;
    expect(besideReachable(reachOf(B.sword | B.buckler | B.l1 | B.l2), crypt, 1 * 12 + 2)).toBe(false);
    expect(besideReachable(reachOf(B.sword | B.buckler | B.l1 | B.hook), crypt, 1 * 12 + 2)).toBe(true);
  });
});
