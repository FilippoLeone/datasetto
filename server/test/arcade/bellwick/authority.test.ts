/**
 * Authority (bellwick.md §13 test 8): the server's checks of what clients say their heroes did. Moves
 * faster than walking or into walls get a `Correct`; claims older than the ring, out of reach or with
 * too many targets are refused; damage from beyond 24 px is refused; a key raced at two doors opens one;
 * a `heroTick` from the future is clamped. And the other way round: a walkthrough bot behind 167 ms each
 * way (a 3G phone) is never corrected and nearly all its claims stand.
 */
import { describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter } from '../../../src/arcade/core/bytes.js';
import { createHeroBot } from '../../../src/arcade/core/bellwick/bots/hero.js';
import { CORRECT, EV, EVT, fromBase64, newEvView, readEv, REFUSE, writeDamageTaken, writeHitClaim, writeInteract, writeUp, type EvView } from '../../../src/arcade/core/bellwick/codec.js';
import { content } from '../../../src/arcade/core/bellwick/content/parse.js';
import { flagId } from '../../../src/arcade/core/bellwick/content/flags.js';
import { createBellwick, type BellwickMatch } from '../../../src/arcade/core/bellwick/runtime.js';
import { activateRoom } from '../../../src/arcade/core/bellwick/sim/room.js';
import { hasFlag, type HeroRec } from '../../../src/arcade/core/bellwick/sim/state.js';
import { Act, Attack, Kind } from '../../../src/arcade/core/bellwick/types.js';
import { dungeonSave, dungeonScript } from './helpers.js';
import { createPartyRun } from './party.js';

const w = new ByteWriter(32);

/** A server session with `n` heroes seated and settled. */
const session = (n: number): BellwickMatch => {
  const core = createBellwick({ seed: 5, mode: 'server', save: null, taleSlot: 0xff, matchId: 'auth' });
  for (let s = 0; s < n; s += 1) core.setSeat(s, 'live');
  core.step();
  core.takeHostEvents();
  return core;
};

const hero = (core: BellwickMatch, slot: number): HeroRec => core.world.heroes[slot] as HeroRec;

/** Puts a hero on a tile of a room (activated), with no allowances left. */
const place = (core: BellwickMatch, slot: number, roomKey: string, tx: number, ty: number): HeroRec => {
  const room = content().byKey[roomKey]!.id;
  activateRoom(core.world, room);
  const h = hero(core, slot);
  h.room = room;
  h.x = tx * 256 + 128;
  h.y = ty * 256 + 128;
  h.allow = 0;
  h.transitT = 0;
  h.iframes = 0;
  return h;
};

/** The self and room events this hero got in the last step. */
const eventsOf = (core: BellwickMatch, slot: number): EvView[] => {
  const chunk = core.takeEvents({ slot, view: 0 });
  const out: EvView[] = [];
  if (!chunk) return out;
  const r = new ByteReader(chunk.bytes);
  for (let i = 0; i < chunk.count; i += 1) {
    const e = newEvView();
    if (!readEv(r.u8(), r, e)) throw new Error('bad event');
    out.push(e);
  }
  return out;
};

const up = (core: BellwickMatch, slot: number, x: number, y: number, heroTick: number, act: number = Act.Walk): void => {
  const h = hero(core, slot);
  core.onUp(slot, writeUp(w.reset(), { room: h.room, x, y, facing: h.facing, act, moving: true, charged: false, actT: 0, hp: h.hp, heroTick }).copy(), heroTick);
};

describe('Bellwick authority: moves', () => {
  it('accepts walking speed, corrects a faster move and keeps the hero where it was', () => {
    const core = session(1);
    const h = place(core, 0, 'square', 5, 4);
    const x0 = h.x;
    up(core, 0, x0 + 32, h.y, core.tick + 1);
    core.step();
    expect(h.x).toBe(x0 + 32);
    expect(eventsOf(core, 0).some((e) => e.kind === EV.Correct)).toBe(false);
    // 400 sub in one tick: 12 times walking speed.
    up(core, 0, h.x + 400, h.y, core.tick + 1);
    core.step();
    expect(h.x).toBe(x0 + 32);
    const c = eventsOf(core, 0).find((e) => e.kind === EV.Correct);
    expect(c?.d).toBe(CORRECT.move);
    expect([c?.b, c?.c]).toEqual([h.x, h.y]);
  });

  it('corrects a move through a wall, and lets a hero inside a closed tile walk out', () => {
    const core = session(1);
    // Square (1,3) is grass with a tree to its west.
    const h = place(core, 0, 'square', 1, 3);
    up(core, 0, h.x - 32, h.y, core.tick + 1);
    core.step();
    // 6 px further west the shrunk feet box is inside the tree: within speed (a knockback allowance) but through a wall.
    h.allow = 400;
    up(core, 0, h.x - 200, h.y, core.tick + 1);
    core.step();
    const c = eventsOf(core, 0).find((e) => e.kind === EV.Correct);
    expect(c?.d).toBe(CORRECT.wall);
    // Standing in a tree already (a shutter closed on it): walking out is fine.
    h.x = 200;
    up(core, 0, 232, h.y, core.tick + 1);
    core.step();
    expect(h.x).toBe(232);
  });

  it('clamps a heroTick from the future to 3 ticks ahead and ignores repeats', () => {
    const core = session(1);
    const h = place(core, 0, 'square', 5, 4);
    up(core, 0, h.x + 16, h.y, core.tick + 50);
    core.step();
    expect(h.upTick).toBe(core.tick - 1 + 3);
    const x = h.x;
    // Not newer than the last one: ignored.
    up(core, 0, h.x + 16, h.y, h.upTick);
    core.step();
    expect(h.x).toBe(x);
  });

  it('sends a resync keyframe after three Corrects within 2 s', () => {
    const core = session(1);
    const h = place(core, 0, 'square', 5, 4);
    up(core, 0, h.x + 16, h.y, core.tick + 1);
    core.step();
    let rekeys = 0;
    for (let i = 0; i < 3; i += 1) {
      up(core, 0, h.x + 2000, h.y, core.tick + 1);
      core.step();
      for (const e of core.takeHostEvents()) if (e.t === 'rekey' && e.reason === 5) rekeys += 1;
      // Past the quiet window for UPs that were in flight.
      for (let k = 0; k < 20; k += 1) core.step();
    }
    expect(rekeys).toBe(1);
  });
});

describe('Bellwick authority: claims, damage, races', () => {
  /** The nave with a hero in it, and one of its enemies (a Slingkin takes two slashes). */
  const nave = (n: number, kind: number = Kind.Burrlet): { core: BellwickMatch; enemy: number; ex: number; ey: number } => {
    const core = session(n);
    const h = place(core, 0, 'nave', 5, 5);
    up(core, 0, h.x, h.y, core.tick + 1, Act.Idle);
    for (let i = 0; i < 4; i += 1) core.step();
    const room = core.world.rooms[h.room]!;
    const e = room.en.find((x) => x.kind === kind)!;
    return { core, enemy: e.id, ex: e.x, ey: e.y };
  };

  it('accepts a claim in reach, refuses one older than the ring or out of reach', () => {
    const { core, enemy } = nave(1, Kind.Slingkin);
    const h = hero(core, 0);
    const room = core.world.rooms[h.room]!;
    const e = room.en.find((x) => x.id === enemy)!;
    // Stand right below it and slash up.
    e.stun = 200;
    e.ai = 0;
    h.x = e.x;
    h.y = e.y + 260;
    h.facing = 1;
    // Long enough for the ring to have turned over since the stale tick below.
    for (let i = 0; i < 24; i += 1) core.step();
    const hp0 = e.hp;
    const targets = Uint8Array.of(enemy);
    // Older than the 16-tick ring.
    core.onEvent(0, writeHitClaim(w.reset(), core.tick - 20, Attack.Slash, 1, targets, 1).copy());
    core.step();
    expect(eventsOf(core, 0).some((x) => x.kind === EV.Refused && x.a === EVT.HitClaim && x.c === REFUSE.claim)).toBe(true);
    expect(e.hp).toBe(hp0);
    // In reach and fresh.
    core.onEvent(0, writeHitClaim(w.reset(), core.tick, Attack.Slash, 1, targets, 1).copy());
    core.step();
    expect(e.hp).toBeLessThan(hp0);
    // From across the room.
    const hp1 = e.hp;
    h.x = 200 + 256;
    h.y = 2000;
    h.actT = 40;
    core.onEvent(0, writeHitClaim(w.reset(), core.tick, Attack.Slash, 1, targets, 1).copy());
    core.step();
    expect(e.hp).toBe(hp1);
    expect(eventsOf(core, 0).some((x) => x.kind === EV.Refused && x.a === EVT.HitClaim)).toBe(true);
  });

  it('drops a claim naming more than 8 targets', () => {
    const { core, enemy } = nave(1);
    const raw = new ByteWriter(32).u8(EVT.HitClaim).u16(core.tick & 0xffff).u8(Attack.Spin).u8(0).u8(9);
    for (let i = 0; i < 9; i += 1) raw.u8(enemy);
    const e = core.world.rooms[hero(core, 0).room]!.en.find((x) => x.id === enemy)!;
    const hp0 = e.hp;
    core.onEvent(0, raw.copy());
    core.step();
    expect(e.hp).toBe(hp0);
  });

  it('refuses damage from a source more than 24 px away, and the hero hears its real hp', () => {
    const { core, enemy, ex, ey } = nave(1);
    const h = hero(core, 0);
    h.x = ex > 1536 ? 300 : 2800;
    h.y = ey;
    const hp0 = h.hp;
    core.onEvent(0, writeDamageTaken(w.reset(), enemy, 2, core.tick).copy());
    core.step();
    expect(h.hp).toBe(hp0);
    expect(eventsOf(core, 0).some((x) => x.kind === EV.Hp && x.a === 0 && x.b === hp0)).toBe(true);
    // Up close it counts.
    const e = core.world.rooms[h.room]!.en.find((x) => x.id === enemy)!;
    h.x = e.x;
    h.y = e.y + 160;
    for (let i = 0; i < 2; i += 1) core.step();
    core.onEvent(0, writeDamageTaken(w.reset(), enemy, 2, core.tick).copy());
    core.step();
    expect(h.hp).toBe(hp0 - 2);
  });

  it('opens one door when a single key is raced at two', () => {
    const core = session(2);
    core.world.party.keys = 1;
    // L2 (tiles 5–6) from below, L1 (tiles 59, 71) from the west.
    place(core, 0, 'nave', 5, 1);
    hero(core, 0).facing = 1;
    place(core, 1, 'nave', 10, 4);
    hero(core, 1).facing = 3;
    core.onEvent(0, writeInteract(w.reset(), 5).copy());
    core.onEvent(1, writeInteract(w.reset(), 59).copy());
    core.step();
    const p = core.world.party;
    const opened = [hasFlag(p, flagId('lock_l2')), hasFlag(p, flagId('lock_l1'))];
    expect(opened.filter(Boolean).length).toBe(1);
    expect(p.keys).toBe(0);
    const loser = opened[0] ? 1 : 0;
    expect(eventsOf(core, loser).some((x) => x.kind === EV.Refused && x.a === EVT.Interact && x.c === REFUSE.locked)).toBe(true);
  });
});

describe('Bellwick authority: a lagged bot', () => {
  it('plays the dungeon through 167 ms each way without a Correct, and ≥ 98 % of its claims stand', () => {
    const save = dungeonSave(41);
    const run = createPartyRun({ seed: 41, heroes: 1, save: { data: save, flags: fromBase64(save.flags, 32)! }, delay: 5 });
    const bot = createHeroBot(dungeonScript());
    const act = run.actions(0);
    for (let t = 0; t < 40_000 && !bot.done; t += 1) run.step([bot.tick(run.clients[0]!, act)]);
    expect(bot.done, 'stopped at step ' + bot.step).toBe(true);
    expect(hasFlag(run.core.world.party, flagId('boss_down'))).toBe(true);
    expect(run.stats.corrects[0]).toBe(0);
    expect(run.stats.claims[0]).toBeGreaterThan(50);
    expect(run.stats.refusedClaims[0]! / run.stats.claims[0]!).toBeLessThanOrEqual(0.02);
  });
});
