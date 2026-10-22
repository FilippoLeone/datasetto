/**
 * Routing and rekey (bellwick.md §13 test 9): the platform's delta-base fuzz (harness `deltaFuzz`, the
 * REAL sender with skipped slots, parks, reconnects and resyncs) over a Party Tale whose heroes keep
 * changing rooms, warping, falling and respawning, opening chests, buying and fighting. After every
 * keyframe plus its events, the client mirror's room and party must equal the server's view for that
 * hero: tiles, flags, purse, keys, items, shards, the lantern, cleared rooms, the enemies (with hp) and
 * pickups in the room, and the hero's own room, status and hp. (Projectiles are left out: a client also
 * ends them by its own clock, and the fuzz's event sections carry no tick to replay that with.)
 */
import { describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter } from '../../../src/arcade/core/bytes.js';
import { createClientWorld, onFrame, onKeyframe, type ClientWorld } from '../../../src/arcade/core/bellwick/client.js';
import { fromBase64, writeBuy, writeDamageTaken, writeEnterRoom, writeHitClaim, writeInteract, writeRespawn } from '../../../src/arcade/core/bellwick/codec.js';
import { content, screen } from '../../../src/arcade/core/bellwick/content/parse.js';
import { createBellwick, type BellwickMatch } from '../../../src/arcade/core/bellwick/runtime.js';
import { exitTarget } from '../../../src/arcade/core/bellwick/sim/party.js';
import { activateRoom } from '../../../src/arcade/core/bellwick/sim/room.js';
import type { HeroRec } from '../../../src/arcade/core/bellwick/sim/state.js';
import { Attack, Status } from '../../../src/arcade/core/bellwick/types.js';
import type { EventBlock } from '../../../src/arcade/core/net/lane.js';
import { xorshift32 } from '../../../src/arcade/core/rng.js';
import type { MatchRuntime } from '../../../src/arcade/rooms/types.js';
import { wrapCore } from '../../../src/arcade/rooms/wrap.js';
import { deltaFuzz, withWallCap, type DeltaFuzzStats } from '../harness/index.js';
import { dungeonSave } from './helpers.js';

const w = new ByteWriter(32);
const target = new Int32Array(5);

/** Rooms the heroes start in: the village, the shop, and the Bellhouse's rooms. */
const STARTS = ['square', 'shop', 'entry', 'cistern', 'chapel', 'nave', 'gallery', 'vault', 'crypt', 'clockwork'];

/**
 * A Party Tale that plays itself: every few ticks each hero does one thing a client could ask for.
 * Positions are set on the server directly (the hero is client-owned; this stands in for its UPs).
 */
const selfDriving = (seed: number): MatchRuntime => {
  const save = dungeonSave(seed);
  save.purse = 200;
  save.keys = 2;
  const core: BellwickMatch = createBellwick({ seed, mode: 'server', save: { data: save, flags: fromBase64(save.flags, 32)! }, taleSlot: 0, matchId: 'fuzz' });
  let rng = seed >>> 0 || 1;
  const next = (): number => (rng = xorshift32(rng));
  const heroes = 2 + (next() % 3);
  for (let s = 0; s < heroes; s += 1) core.setSeat(s, 'live');
  // Start everyone somewhere busy, slot 0 first.
  for (let s = 0; s < heroes; s += 1) {
    const room = content().byKey[STARTS[next() % STARTS.length] as string]!.id;
    const h = core.world.heroes[s] as HeroRec;
    activateRoom(core.world, room);
    h.room = room;
    h.x = 1536;
    h.y = 1152;
  }
  const wait = [0, 0, 0, 0];

  const act = (s: number): void => {
    const h = core.world.heroes[s] as HeroRec;
    const room = core.world.rooms[h.room];
    if (!h.present || !room) return;
    if (h.status === Status.Downed) {
      core.onEvent(s, writeRespawn(w.reset()).copy());
      return;
    }
    if (h.status !== Status.Active) return;
    const def = screen(h.room);
    const roll = next() % 10;
    if (roll < 4) {
      // Out through an open edge (the exit check needs the hero within 8 px of it).
      for (let tries = 0; tries < 8; tries += 1) {
        const edge = next() % 4;
        const pos = next() % (edge < 2 ? 12 : 9);
        if (!exitTarget(core.world, h.room, room.tiles, edge, pos, target)) continue;
        h.x = edge === 2 ? 96 : edge === 3 ? 3072 - 96 : pos * 256 + 128;
        h.y = edge === 1 ? 80 : edge === 0 ? 2304 - 80 : pos * 256 + 128;
        core.onEvent(s, writeEnterRoom(w.reset(), edge, pos).copy());
        return;
      }
    }
    if (roll === 4 && def.warps.length > 0) {
      const wp = def.warps[next() % def.warps.length]!;
      h.x = (wp.tile % 12) * 256 + 128;
      h.y = Math.floor(wp.tile / 12) * 256 + 128;
      core.onEvent(s, writeEnterRoom(w.reset(), 4, wp.tile).copy());
      return;
    }
    if (roll === 5) {
      // Falls to the last half heart's hit, then rests at the lantern a moment later.
      const e = room.en.find((x) => x.kind !== 0);
      if (!e) return;
      h.x = e.x;
      h.y = e.y + 200;
      h.hp = 1;
      h.iframes = 0;
      core.onEvent(s, writeDamageTaken(w.reset(), e.id, 2, core.tick).copy());
      return;
    }
    if (roll === 6) {
      // A chest, lock, lantern or counter: stand below it and interact.
      const things = [...def.chests.map((c) => c.tile), ...def.locks.map((l) => l.tile), ...(def.lantern ? [def.lantern.tile] : [])];
      const t = things[next() % Math.max(1, things.length)];
      if (t !== undefined && t + 12 < 108) {
        h.x = (t % 12) * 256 + 128;
        h.y = Math.floor(t / 12) * 256 + 128 + 256;
        h.facing = 1;
        core.onEvent(s, writeInteract(w.reset(), t).copy());
      } else core.onEvent(s, writeBuy(w.reset(), next() % 3).copy());
      return;
    }
    // Fight: next to an enemy, slash it (or get hurt by it).
    const e = room.en.find((x) => x.kind !== 0 && next() % 2 === 0) ?? room.en.find((x) => x.kind !== 0);
    if (!e) return;
    h.x = e.x;
    h.y = e.y + 240;
    h.facing = 1;
    h.actT = next() % 40;
    if (roll === 7) core.onEvent(s, writeDamageTaken(w.reset(), e.id, 1 + (next() % 2), core.tick).copy());
    else core.onEvent(s, writeHitClaim(w.reset(), core.tick, roll === 8 ? Attack.Spin : Attack.Slash, 1, Uint8Array.of(e.id), 1).copy());
  };

  return wrapCore('bellwick', 'fuzz-' + seed, {
    get idle() {
      return core.idle;
    },
    get tick() {
      return core.tick;
    },
    step() {
      for (let s = 0; s < heroes; s += 1) {
        if ((wait[s] as number) > 0) {
          wait[s] = (wait[s] as number) - 1;
          continue;
        }
        wait[s] = 4 + (next() % 20);
        act(s);
      }
      core.step();
    },
    onUp: (slot, p, seq) => core.onUp(slot, p, seq),
    onEvent: (slot, p) => core.onEvent(slot, p),
    ackUp: (slot) => core.ackUp(slot),
    setSeat: (slot, cmd) => core.setSeat(slot, cmd),
    setRtt: (slot, ms) => core.setRtt(slot, ms),
    welcomeCfg: () => core.welcomeCfg(),
    snapshotFor: (r) => core.snapshotFor(r),
    keyframeFor: (r) => core.keyframeFor(r),
    takeEvents: (r) => core.takeEvents(r),
    takeHostEvents: () => core.takeHostEvents(),
    dump: () => core.dump(),
  }, { handover: () => core.handover(), replay: () => new Uint8Array(0) });
};

/** The client's world for slot 0 after a keyframe and FRAME event sections, as comparable data. */
let trace: string[] = [];
let lastTraces: string[][] = [];
const decode = (k: Uint8Array, sections: readonly Uint8Array[]): unknown => {
  trace = [];
  lastTraces = [...lastTraces.slice(-1), trace];
  const c: ClientWorld = createClientWorld(0, { event: (e) => trace.push(`${e.kind}(${e.a},${e.b},${e.c})`) });
  if (!onKeyframe(c, new ByteReader(k), 1000)) throw new Error('keyframe does not decode');
  const block: EventBlock = { count: 0, r: new ByteReader(new Uint8Array(0)), tick: 1000 };
  for (const section of sections) {
    block.count = section[0] as number;
    block.r = new ByteReader(section.subarray(1));
    if (!onFrame(c, 1000, null, block)) throw new Error('events do not decode');
    if (block.r.remaining !== 0) throw new Error('events left over');
  }
  const ids = (xs: readonly { on: boolean; id: number; kind?: number; hp?: number }[]): string =>
    xs
      .filter((x) => x.on)
      .map((x) => `${x.id}:${x.kind ?? ''}:${x.hp ?? ''}`)
      .sort()
      .join(' ');
  return {
    room: c.room,
    hasRoom: c.hasRoom,
    tiles: Array.from(c.tiles).join(','),
    flags: Array.from(c.flags).join(','),
    party: [c.purse, c.keys, c.items, c.shards, c.vessels, c.lantern, c.cleared, c.maxHp],
    me: [c.me.room, c.me.status, c.me.hp],
    ents: ids(c.ents),
    picks: ids(c.picks.map((p) => ({ on: p.on, id: p.id, kind: p.kind }))),
    boss: c.boss.present ? c.boss.phase : -1,
  };
};

describe('Bellwick routing and rekey', () => {
  it('keeps every client mirror equal to its keyframe after room changes, warps, respawns and party events', () => {
    let stats: DeltaFuzzStats | null = null;
    let seed = 0;
    let firstDiff = '';
    try {
      withWallCap(10_000, (progress) =>
        deltaFuzz({
          create: () => selfDriving(1 + seed++),
          schedules: 120,
          seed: 0xbe11,
          decode,
          equal: (a, b) => {
            const sa = JSON.stringify(a);
            const sb = JSON.stringify(b);
            if (sa !== sb && !firstDiff) {
              const ka = a as Record<string, unknown>;
              const kb = b as Record<string, unknown>;
              firstDiff = Object.keys(ka)
                .filter((key) => JSON.stringify(ka[key]) !== JSON.stringify(kb[key]))
                .map((key) => `${key}: client ${JSON.stringify(ka[key])} server ${JSON.stringify(kb[key])}`)
                .join('; ') + ' trace ' + (lastTraces[0] ?? []).join(' ');
            }
            return sa === sb;
          },
          progress,
          onStats: (st) => (stats = st),
        }),
      );
    } catch (e) {
      throw new Error((e as Error).message + (firstDiff ? ' — ' + firstDiff : ''));
    }
    const s = stats as unknown as DeltaFuzzStats;
    expect(s.schedules).toBe(120);
    expect(s.rekeys).toBeGreaterThan(100);
    expect(s.worldChecks).toBeGreaterThan(200);
  });
});
