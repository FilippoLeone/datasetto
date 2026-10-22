/**
 * Codec (bellwick.md §13 test 7): round trips; snapshot ≤ 91 B with 3 others and 14 entities; keyframe
 * ≤ 384 B with every pool full and ≤ 200 B for a typical room change; UP = 16 B on the wire; EVT ≤ 17 B;
 * fuzzed bytes decode to nothing and never throw; u16 ticks extend across the wrap.
 */
import { describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter } from '../../../src/arcade/core/bytes.js';
import { extendTick } from '../../../src/arcade/core/bellwick/client.js';
import {
  ENTRY,
  EVT,
  KEYFRAME_MAX,
  newEvView,
  newEvtView,
  newHeroState,
  parseSave,
  readEv,
  readEvt,
  readUp,
  readWelcomeCfg,
  SNAPSHOT_MAX,
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
  writeWelcomeCfg,
} from '../../../src/arcade/core/bellwick/codec.js';
import { content } from '../../../src/arcade/core/bellwick/content/parse.js';
import { createBellwick } from '../../../src/arcade/core/bellwick/runtime.js';
import { placeHero, newOutbox } from '../../../src/arcade/core/bellwick/sim/party.js';
import { spawnEnemy, spawnPickup, spawnProjectile, spawnShock } from '../../../src/arcade/core/bellwick/sim/room.js';
import { Kind, Pick, Proj } from '../../../src/arcade/core/bellwick/types.js';
import { writeEvt as laneEvt, writeUp as laneUp } from '../../../src/arcade/core/net/lane.js';
import { xorshift32 } from '../../../src/arcade/core/rng.js';

const crowd = (others: number, enemies: number, fill: boolean) => {
  const m = createBellwick({ seed: 5, mode: 'server', save: null, taleSlot: 0xff });
  for (let s = 0; s <= others; s += 1) m.join(s, s, s);
  const belfry = content().byKey.belfry!.id;
  const o = newOutbox();
  for (let s = 0; s <= others; s += 1) placeHero(m.world, m.world.heroes[s]!, belfry, 1536 + s * 200, 1800, 1, 0, o, 0);
  m.takeHostEvents();
  const room = m.world.rooms[belfry]!;
  for (let i = 0; i < 12; i += 1) if (room.en[i]!.kind === 0 && i < enemies) spawnEnemy(room, Kind.Bat, 400 + i * 180, 600, 0, true, false);
  if (fill) {
    for (let i = 0; i < 12; i += 1) spawnPickup(room, Pick.Chip, 300 + i * 200, 1200, 300);
    for (let i = 0; i < 12; i += 1) spawnProjectile(room, Proj.Note, 300 + i * 200, 900, i & 7, 255);
    spawnShock(room, 1500, 1000);
    spawnShock(room, 1600, 1000);
  }
  return { m, room };
};

describe('Bellwick codec', () => {
  it('round-trips the hero state in a 10 B payload and a 16 B UP', () => {
    const s = { room: 39, x: 3000, y: 2200, facing: 3, act: 9, moving: true, charged: true, actT: 200, hp: 11, heroTick: 65535 };
    const p = writeUp(new ByteWriter(16), s).copy();
    expect(p.length).toBe(10);
    const out = newHeroState();
    expect(readUp(p, out)).toBe(true);
    expect(out).toEqual(s);
    expect(laneUp(1, 2, 3, p).length).toBe(16);
  });

  it('round-trips every EVT and keeps each message within 17 B', () => {
    const w = new ByteWriter(32);
    const targets = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 128 + 107]);
    const cases: Uint8Array[] = [
      writeHitClaim(w.reset(), 4321, 1, 2, targets, 8).copy(),
      writeDamageTaken(w.reset(), 0xfe, 1, 9).copy(),
      writeBlocked(w.reset(), 17, 12).copy(),
      writeInteract(w.reset(), 107).copy(),
      writePush(w.reset(), 50, 3).copy(),
      writeEnterRoom(w.reset(), 4, 77).copy(),
      writeBuy(w.reset(), 8).copy(),
      writeUseBrew(w.reset()).copy(),
      writeRespawn(w.reset()).copy(),
      writeGoToAlly(w.reset(), 2).copy(),
    ];
    const v = newEvtView();
    for (const p of cases) {
      expect(readEvt(p, v), 'kind ' + p[0]).toBe(true);
      expect(laneEvt(1, p).length).toBeLessThanOrEqual(17);
    }
    readEvt(cases[0] as Uint8Array, v);
    expect(v.kind).toBe(EVT.HitClaim);
    expect(v.seenTick).toBe(4321);
    expect(Array.from(v.targets.subarray(0, v.n))).toEqual(Array.from(targets));
  });

  it('keeps the snapshot within 91 B with 3 others and 14 moving entities', () => {
    const { m, room } = crowd(3, 12, false);
    // The enemy pool is full (the boss and 11 bats); two blocks sliding make 14.
    for (let i = 0; i < 2; i += 1) Object.assign(room.bl[i]!, { on: 1, id: 100 + i, tile: 50 + i, from: 49 + i, moveT: 5, dir: 3, under: 28 });
    const snap = m.snapshotFor({ slot: 0, view: 0 });
    expect(snap).not.toBeNull();
    expect(snap!.length).toBe(1 + 1 + 3 * 6 + 1 + 14 * 5);
    expect(snap!.length).toBeLessThanOrEqual(SNAPSHOT_MAX);
  });

  it('keeps keyframes within 384 B with every pool full and under 200 B for a typical room change', () => {
    const full = crowd(3, 12, true);
    const join = full.m.keyframeFor({ slot: 0, view: 0 });
    expect(join.length).toBeLessThanOrEqual(KEYFRAME_MAX);
    expect(join[1]).toBe(ENTRY.resume);
    const typical = crowd(2, 4, false);
    const room = typical.room;
    spawnPickup(room, Pick.Heart, 900, 900, 300);
    spawnProjectile(room, Proj.Pebble, 900, 900, 0, 255);
    // A room change: the runtime's own rekey (no party block).
    const h = typical.m.world.heroes[0]!;
    placeHero(typical.m.world, h, room.id, 1536, 1900, 1, 15, newOutbox(), 0);
    (typical.m as unknown as { join(): void }).join;
    const r = typical.m.keyframeFor({ slot: 0, view: 0 });
    expect(r.length).toBeLessThan(200);
  });

  it('decodes events written by the runtime and walks a block', () => {
    const v = newEvView();
    const w = new ByteWriter(64);
    w.u8(0x02).u8(9).u8(1 | (5 << 4)).u8(10).u8(20).u16(65000);
    const r = new ByteReader(w.copy());
    expect(readEv(r.u8(), r, v)).toBe(true);
    expect([v.a, v.b, v.c, v.d, v.e, v.f]).toEqual([9, 1, 5, 10, 20, 65000]);
  });

  it('turns fuzzed bytes into nothing, without throwing', () => {
    let s = 12345;
    const up = newHeroState();
    const evt = newEvtView();
    const ev = newEvView();
    for (let i = 0; i < 20_000; i += 1) {
      s = xorshift32(s);
      const n = s % 24;
      const b = new Uint8Array(n);
      for (let k = 0; k < n; k += 1) {
        s = xorshift32(s);
        b[k] = s & 255;
      }
      if (n !== 10) expect(readUp(b, up)).toBe(false);
      readEvt(b, evt);
      readWelcomeCfg(b);
      const r = new ByteReader(b);
      readEv(r.u8(), r, ev);
    }
    expect(parseSave({ v: 1, flags: 'nope' })).toBeNull();
    expect(parseSave(null)).toBeNull();
    expect(readWelcomeCfg(writeWelcomeCfg(1, 0xdeadbeef, [{ slot: 0, tunic: 2, joinOrder: 0 }]))).toEqual({ taleSlot: 1, contentHash: 0xdeadbeef, seats: [{ slot: 0, tunic: 2, joinOrder: 0 }] });
  });

  it('extends u16 ticks across the wrap', () => {
    expect(extendTick(65530, 65540)).toBe(65530);
    expect(extendTick(4, 65540)).toBe(65540);
    expect(extendTick(10, 65546)).toBe(65546);
    expect(extendTick(65535, 131072)).toBe(131071);
  });
});
