/**
 * The fuzz routine shared by fuzz.test.ts and fuzz2.test.ts. Fuzz (bellwick.md §13 test 5), in virtual time: four heroes in each of the 36 rooms send 10,000 ticks
 * of random hero states and random events (any target, any tile, any exit) straight to the server
 * runtime. Nothing throws, pools stay within their caps, live entity ids stay unique, and no step is slow.
 */
import { expect } from 'vitest';
import { ByteWriter } from '../../../src/arcade/core/bytes.js';
import {
  writeBlocked,
  writeBuy,
  writeDamageTaken,
  writeEnterRoom,
  writeGoToAlly,
  writeHitClaim,
  writeInteract,
  writePush,
  writeRespawn,
  writeUp,
  writeUseBrew,
} from '../../../src/arcade/core/bellwick/codec.js';
import { content } from '../../../src/arcade/core/bellwick/content/parse.js';
import { createBellwick } from '../../../src/arcade/core/bellwick/runtime.js';
import { newOutbox, placeHero } from '../../../src/arcade/core/bellwick/sim/party.js';
import type { Room } from '../../../src/arcade/core/bellwick/sim/state.js';
import { CAP } from '../../../src/arcade/core/bellwick/types.js';
import { xorshift32 } from '../../../src/arcade/core/rng.js';

const TICKS = 10_000;

const checkRoom = (room: Room): void => {
  const ids = new Set<number>();
  const add = (id: number): void => {
    expect(id).toBeGreaterThanOrEqual(0);
    expect(id).toBeLessThan(128);
    expect(ids.has(id), 'duplicate id ' + id + ' in room ' + room.id).toBe(false);
    ids.add(id);
  };
  expect(room.en.length).toBe(CAP.enemies);
  expect(room.pr.length).toBe(CAP.projectiles);
  expect(room.pk.length).toBe(CAP.pickups);
  for (const e of room.en) if (e.kind !== 0) add(e.id);
  for (const p of room.pr) if (p.on) add(p.id);
  for (const k of room.pk) if (k.on) add(k.id);
  for (const b of room.bl) if (b.on) add(b.id);
};

/** Runs the fuzz over a slice of the 36 rooms (two test files share the work, so each stays short). */
export const fuzzRooms = (from: number, to: number): void => {
  {
    const w = new ByteWriter(32);
    const targets = new Uint8Array(8);
    let s = 0x5eed;
    const rnd = (n: number): number => {
      s = xorshift32(s);
      return (s >>> 0) % n;
    };
    const times: number[] = [];
    const all = content().screens.filter((d) => d !== null);
    expect(all).toHaveLength(36);
    for (const def of all.slice(from, to)) {
      const m = createBellwick({ seed: def!.id + 1, mode: 'server', save: null, taleSlot: 0xff });
      for (let h = 0; h < 4; h += 1) m.join(h, h, h);
      const o = newOutbox();
      for (let h = 0; h < 4; h += 1) placeHero(m.world, m.world.heroes[h]!, def!.id, 1536, 1152, 0, 0, o, 0);
      m.takeHostEvents();
      for (let t = 0; t < TICKS; t += 1) {
        for (let h = 0; h < 4; h += 1) {
          const hero = m.world.heroes[h]!;
          if (rnd(3) === 0) {
            const up = { room: hero.room, x: 200 + rnd(2700), y: 200 + rnd(1900), facing: rnd(4), act: rnd(16), moving: rnd(2) === 0, charged: false, actT: rnd(40), hp: rnd(13), heroTick: t + 1 };
            m.onUp(h, writeUp(w.reset(), up).copy(), t);
          }
          if (rnd(8) === 0) {
            const k = rnd(11);
            let p: Uint8Array;
            if (k === 0) {
              const n = 1 + rnd(8);
              for (let i = 0; i < n; i += 1) targets[i] = rnd(2) === 0 ? rnd(128) : 128 + rnd(108);
              p = writeHitClaim(w.reset(), t, rnd(4), rnd(4), targets, n).copy();
            } else if (k === 1) p = writeDamageTaken(w.reset(), rnd(256), rnd(3), t).copy();
            else if (k === 2) p = writeBlocked(w.reset(), rnd(128), t).copy();
            else if (k === 3) p = writeInteract(w.reset(), rnd(108)).copy();
            else if (k === 4) p = writePush(w.reset(), rnd(108), rnd(4)).copy();
            else if (k === 5) p = writeEnterRoom(w.reset(), rnd(5), rnd(108)).copy();
            else if (k === 6) p = writeBuy(w.reset(), rnd(12)).copy();
            else if (k === 7) p = writeUseBrew(w.reset()).copy();
            else if (k === 8) p = writeRespawn(w.reset()).copy();
            else if (k === 9) p = writeGoToAlly(w.reset(), rnd(4)).copy();
            else {
              p = new Uint8Array(1 + rnd(18));
              for (let i = 0; i < p.length; i += 1) p[i] = rnd(256);
            }
            m.onEvent(h, p);
          }
        }
        if ((t & 15) === 0) {
          const a = performance.now();
          m.step();
          times.push(performance.now() - a);
        } else m.step();
        m.takeHostEvents();
        const r = { slot: t & 3, view: 0 };
        m.snapshotFor(r);
        m.takeEvents(r);
        if ((t & 2047) === 0) for (const room of m.world.rooms) if (room) checkRoom(room);
      }
      for (const room of m.world.rooms) if (room) checkRoom(room);
    }
    times.sort((a, b) => a - b);
    // p99 well under the 0.1 ms budget per room is not asserted on a shared CI box; a stuck loop would show here.
    expect(times[Math.floor(times.length * 0.99)], 'p99 step (ms)').toBeLessThan(1);
    expect(times[times.length - 1], 'slowest step (ms)').toBeLessThan(25);
  }
};

