/**
 * Rules (bellwick.md §13 test 1): each row of §1.2 on the hero step, the Buckler (front only), every
 * Vinehook case, keys, the shop, max hp, revival and respawn, drops and the boss's scaling, on the
 * runtime the server and the device share.
 */
import { describe, expect, it } from 'vitest';
import { ByteWriter } from '../../../src/arcade/core/bytes.js';
import { EV, newEvView, readEv, writeBuy, writeDamageTaken, writeInteract, writeRespawn, writeUseBrew } from '../../../src/arcade/core/bellwick/codec.js';
import { flagId } from '../../../src/arcade/core/bellwick/content/flags.js';
import { T } from '../../../src/arcade/core/bellwick/content/legend.js';
import { content } from '../../../src/arcade/core/bellwick/content/parse.js';
import { createBellwick } from '../../../src/arcade/core/bellwick/runtime.js';
import { HERO_RULES as R, maxHp, respawnHp, SHOP } from '../../../src/arcade/core/bellwick/rules.js';
import { CUE, newHeroEnv, newHeroOut, newHeroState, stepHero, type Hero, type HeroEnv } from '../../../src/arcade/core/bellwick/sim/hero.js';
import { applyHitTarget, newOutbox, placeHero } from '../../../src/arcade/core/bellwick/sim/party.js';
import { enemyById, spawnEnemy, spawnPickup, pushBlock, tileDrop } from '../../../src/arcade/core/bellwick/sim/room.js';
import { Act, Attack, Btn, ItemBit, Kind, Pick, Proj, Status } from '../../../src/arcade/core/bellwick/types.js';
import { ByteReader } from '../../../src/arcade/core/bytes.js';

/** An open floor room for the hero step, walled at the screen edges. */
const env = (items = ItemBit.sword | ItemBit.buckler | ItemBit.hook): HeroEnv => {
  const e = newHeroEnv();
  e.tiles = new Uint8Array(108).fill(T.FLOOR);
  for (let i = 0; i < 12; i += 1) {
    e.tiles[i] = T.DWALL;
    e.tiles[96 + i] = T.DWALL;
  }
  for (let j = 0; j < 9; j += 1) {
    e.tiles[j * 12] = T.DWALL;
    e.tiles[j * 12 + 11] = T.DWALL;
  }
  e.items = items;
  return e;
};

const heroAt = (x: number, y: number, facing = 0): Hero => {
  const h = newHeroState(0);
  h.x = x;
  h.y = y;
  h.facing = facing;
  h.entryX = x;
  h.entryY = y;
  return h;
};

const out = newHeroOut();
const step = (h: Hero, e: HeroEnv, buttons: number, n = 1): void => {
  for (let i = 0; i < n; i += 1) {
    e.tick += 1;
    stepHero(h, buttons, e, out);
  }
};

const addEnt = (e: HeroEnv, id: number, kind: number, x: number, y: number, pose = 0): void => {
  const i = e.nEnt++;
  e.entId[i] = id;
  e.entKind[i] = kind;
  e.entX[i] = x;
  e.entY[i] = y;
  e.entPose[i] = pose;
  e.entStunned[i] = 0;
};

const addProj = (e: HeroEnv, id: number, kind: number, dir: number, x: number, y: number): void => {
  const i = e.nProj++;
  e.projId[i] = id;
  e.projKind[i] = kind;
  e.projDir[i] = dir;
  e.projX[i] = x;
  e.projY[i] = y;
};

/** A one-hero match standing in room `key` at tile (tx, ty). */
const matchIn = (key: string, tx: number, ty: number, heroes = 1) => {
  const m = createBellwick({ seed: 3, mode: 'local', save: null, taleSlot: 0xff });
  for (let s = 0; s < heroes; s += 1) m.join(s, s, s);
  const room = content().byKey[key]!.id;
  const o = newOutbox();
  for (let s = 0; s < heroes; s += 1) placeHero(m.world, m.world.heroes[s]!, room, tx * 256 + 128, ty * 256 + 128, 1, 0, o, 0);
  m.takeHostEvents();
  return { m, room: m.world.rooms[room]!, w: m.world, o };
};

const setFlag = (flags: Uint8Array, name: string): void => {
  const id = flagId(name);
  flags[id >> 3] = (flags[id >> 3] as number) | (1 << (id & 7));
};
const flagSet = (flags: Uint8Array, name: string): boolean => {
  const id = flagId(name);
  return ((flags[id >> 3] as number) & (1 << (id & 7))) !== 0;
};

describe('Bellwick hero rules (§1.2)', () => {
  it('walks 32 sub per tick, 22 per axis on diagonals, facing along the dominant axis', () => {
    const e = env();
    const h = heroAt(1536, 1152);
    step(h, e, Btn.right);
    expect(h.x - 1536).toBe(R.speed);
    expect(h.facing).toBe(3);
    const x = h.x;
    const y = h.y;
    step(h, e, Btn.down | Btn.right);
    expect([h.x - x, h.y - y]).toEqual([R.diag, R.diag]);
    expect(h.facing).toBe(3);
    step(h, e, Btn.up);
    expect(h.facing).toBe(1);
  });

  it('slashes for 10 ticks, live on ticks 2–5, movement locked for 8', () => {
    const e = env();
    const h = heroAt(1536, 1152, 0);
    addEnt(e, 7, Kind.Burrlet, 1536, 1152 + 200);
    const hitsAt: number[] = [];
    step(h, e, Btn.a);
    expect(h.act).toBe(Act.Slash);
    for (let t = 1; t < 10; t += 1) {
      step(h, e, Btn.a | Btn.right);
      if (out.hitN > 0) hitsAt.push(h.actT);
      if (h.actT < R.slashLock) expect(h.x).toBe(1536);
    }
    expect(hitsAt).toEqual([2]);
  });

  it('charges a spin by holding A for 18 ticks after the slash, then spins 12 ticks within 22 px', () => {
    const e = env();
    const h = heroAt(1536, 1152, 0);
    step(h, e, Btn.a, R.slashTicks + 1);
    expect(h.act).toBe(Act.Charge);
    step(h, e, Btn.a | Btn.right, R.chargeTicks);
    expect(h.charged).toBe(true);
    expect(h.facing).toBe(0);
    addEnt(e, 9, Kind.Shellback, h.x + 300, h.y - 64);
    step(h, e, 0);
    expect(h.act).toBe(Act.Spin);
    let hit = false;
    for (let t = 0; t < R.spinTicks; t += 1) {
      step(h, e, 0);
      if (out.hitN > 0 && out.hitAttack === Attack.Spin) hit = true;
    }
    expect(hit).toBe(true);
    expect(h.act).toBe(Act.Idle);
  });

  it('interacts instead of slashing when a chest is just ahead', () => {
    const e = env();
    e.tiles[4 * 12 + 6] = T.CHEST;
    const h = heroAt(6 * 256 + 128, 5 * 256 + 128, 1);
    step(h, e, Btn.a);
    expect(out.interact).toBe(4 * 12 + 6);
    expect(h.act).not.toBe(Act.Slash);
  });

  it('takes contact damage with 5 ticks of knockback at 48 sub/tick, then 45 ticks of invincibility', () => {
    const e = env();
    const h = heroAt(1536, 1152);
    addEnt(e, 3, Kind.Snapjaw, 1536 + 120, 1152 - 64);
    step(h, e, 0);
    expect(out.dmgSource).toBe(3);
    expect(out.dmgAmount).toBe(2);
    expect(h.iframes).toBe(R.iframes);
    const x = h.x;
    step(h, e, 0, R.hurtTicks);
    expect(x - h.x).toBe(R.hurtSpeed * R.hurtTicks);
    step(h, e, 0, 10);
    expect(out.dmgSource).toBe(-1);
  });

  it('pushes a block after 15 ticks; the block slides 16 px over 16 ticks', () => {
    const e = env();
    e.tiles[4 * 12 + 6] = T.BLOCK;
    const h = heroAt(5 * 256 + 128, 4 * 256 + 128, 3);
    let pushedAt = -1;
    for (let t = 0; t < 20 && pushedAt < 0; t += 1) {
      step(h, e, Btn.right);
      if (out.push >= 0) pushedAt = t;
    }
    expect(out.push).toBe(4 * 12 + 6);
    expect(pushedAt).toBeGreaterThanOrEqual(R.pushTicks - 4);
    const { m, room } = matchIn('gallery', 4, 5);
    expect(pushBlock(room, 4 * 12 + 4, 1)).toBe(true);
    for (let t = 0; t < R.slideTicks + 1; t += 1) m.step();
    expect(room.tiles[3 * 12 + 4]).toBe(T.BLOCK);
    expect(room.tiles[4 * 12 + 4]).toBe(T.FLOOR);
  });

  it('falls into a pit: one half heart, back at the room entry', () => {
    const e = env();
    e.tiles[4 * 12 + 7] = T.PIT;
    const h = heroAt(6 * 256 + 128, 4 * 256 + 128, 3);
    let fell = false;
    for (let t = 0; t < 60 && out.dmgSource !== 0xfe; t += 1) {
      step(h, e, t < 6 ? Btn.right : 0);
      if (h.act === Act.Fall) fell = true;
    }
    expect(fell).toBe(true);
    expect(out.dmgAmount).toBe(R.pitDamage);
    expect([h.x, h.y]).toEqual([h.entryX, h.entryY]);
  });

  it('hops ledges going south only', () => {
    const e = env();
    for (let x = 1; x < 11; x += 1) e.tiles[4 * 12 + x] = T.LEDGE;
    const h = heroAt(5 * 256 + 128, 3 * 256 + 128, 0);
    let hopped = false;
    for (let t = 0; t < 30; t += 1) {
      step(h, e, Btn.down);
      if (h.act === Act.Ledge) hopped = true;
    }
    expect(hopped).toBe(true);
    expect(h.y >> 8).toBeGreaterThanOrEqual(5);
    const y = h.y;
    step(h, e, Btn.up, 30);
    expect(h.y >> 8).toBe(5);
    expect(h.y).toBeLessThan(y + 1);
  });

  it('blocks pebbles from the front with the Buckler, never from behind', () => {
    const e = env();
    const h = heroAt(1536, 1152, 1);
    step(h, e, Btn.b);
    expect(h.act).toBe(Act.Shield);
    addProj(e, 20, Proj.Pebble, 0, 1536, 1152 - 100);
    step(h, e, Btn.b);
    expect(out.blockedId).toBe(20);
    e.nProj = 0;
    addProj(e, 21, Proj.Pebble, 1, 1536, 1152 - 40);
    step(h, e, Btn.b);
    expect(out.blockedId).toBe(-1);
    expect(out.dmgSource).toBe(21);
  });

  it('lets a Sentinel repel shot push without damage, even through invincibility', () => {
    const e = env();
    const h = heroAt(1536, 1152, 3);
    h.iframes = 30;
    addProj(e, 22, Proj.Repel, 0, 1536, 1152 - 80);
    step(h, e, 0);
    expect(out.dmgSource).toBe(22);
    expect(out.dmgAmount).toBe(0);
    expect(h.kbT).toBe(R.repelTicks);
  });
});

describe('Bellwick Vinehook', () => {
  it('pulls the hero to the tile before a post, over pits, without harm', () => {
    const e = env();
    e.tiles[2 * 12 + 5] = T.POST;
    e.tiles[3 * 12 + 5] = T.FLOOR;
    e.tiles[4 * 12 + 5] = T.PIT;
    e.tiles[5 * 12 + 5] = T.PIT;
    const h = heroAt(5 * 256 + 128, 6 * 256 + 128, 1);
    h.item = 1;
    step(h, e, Btn.b);
    expect(h.act).toBe(Act.Hook);
    let pulled = false;
    for (let t = 0; t < 40; t += 1) {
      step(h, e, 0);
      if (h.act === Act.Pulled) pulled = true;
      expect(h.act).not.toBe(Act.Fall);
    }
    expect(pulled).toBe(true);
    expect([h.x >> 8, h.y >> 8]).toEqual([5, 3]);
  });

  it('stuns an enemy 45 ticks, flips a Shellback 120, toggles a crystal, takes a pickup, pulls the clapper', () => {
    const { m, room, w } = matchIn('nave', 5, 4);
    const h = w.heroes[0]!;
    const burr = spawnEnemy(room, Kind.Burrlet, 1536, 600, 0, false, false)!;
    applyHitTarget(w, h, room, Attack.Hook, burr.id, h.x, h.y);
    expect(burr.stun).toBe(45);
    const shell = spawnEnemy(room, Kind.Shellback, 2000, 600, 0, false, false)!;
    applyHitTarget(w, h, room, Attack.Hook, shell.id, h.x, h.y);
    expect([shell.ai, shell.aiT]).toEqual([1, 120]);
    // A flipped Shellback takes double damage, from any side.
    applyHitTarget(w, h, room, Attack.Slash, shell.id, shell.x, shell.y - 200);
    expect(shell.hp).toBe(6 - 4);
    spawnPickup(room, Pick.Spark, 800, 800, 300);
    const pk = room.pk.find((k) => k.on)!;
    const purse = w.party.purse;
    applyHitTarget(w, h, room, Attack.Hook, pk.id, h.x, h.y);
    expect(w.party.purse).toBe(purse + 5);
    const clock = matchIn('clockwork', 6, 6);
    const tile = 6 * 12 + 10;
    applyHitTarget(clock.w, clock.w.heroes[0]!, clock.room, Attack.Hook, 128 + tile, 0, 0);
    expect(clock.room.tiles[tile]).toBe(T.CRYSTAL_ON);
    expect(clock.room.tiles[4 * 12 + 8]).toBe(T.BRIDGE_ON);
    expect(flagSet(clock.w.party.flags, 'clock_bridge')).toBe(true);
    const fight = matchIn('belfry', 5, 6);
    fight.m.step();
    const boss = fight.room.en.find((e) => e.kind === Kind.Boss)!;
    fight.room.boss!.phase = 3;
    fight.room.boss!.mode = 0;
    applyHitTarget(fight.w, fight.w.heroes[0]!, fight.room, Attack.Hook, boss.id, boss.x, boss.y + 300);
    expect(fight.room.boss!.mode).toBe(1);
    expect(fight.room.boss!.clapperT).toBe(90);
    void m;
  });
});

describe('Bellwick party rules', () => {
  it('opens one door pair per key, for good, and the boss door only with the Boss Key', () => {
    const { m, room, w } = matchIn('nave', 10, 4);
    const wr = new ByteWriter(8);
    m.onEvent(0, writeInteract(wr.reset(), 4 * 12 + 11).copy());
    m.step();
    expect(room.tiles[4 * 12 + 11]).toBe(T.LOCK);
    w.party.keys = 1;
    m.onEvent(0, writeInteract(wr.reset(), 4 * 12 + 11).copy());
    m.step();
    expect(room.tiles[4 * 12 + 11]).toBe(T.LOCK_OPEN);
    expect(room.tiles[5 * 12 + 11]).toBe(T.LOCK_OPEN);
    expect(w.party.keys).toBe(0);
    expect(flagSet(w.party.flags, 'lock_l1')).toBe(true);
    const ante = matchIn('ante', 5, 1);
    ante.w.party.keys = 3;
    ante.m.onEvent(0, writeInteract(wr.reset(), 5).copy());
    ante.m.step();
    expect(ante.room.tiles[5]).toBe(T.BOSSDOOR);
    ante.w.party.bossKey = true;
    ante.m.onEvent(0, writeInteract(wr.reset(), 5).copy());
    ante.m.step();
    expect(ante.room.tiles[5]).toBe(T.BOSSDOOR_OPEN);
    expect(ante.w.party.keys).toBe(3);
  });

  it('sells the Buckler (30), Hearthbrews (20, one each) and the shard (80, once)', () => {
    const { m, w } = matchIn('shop', 5, 3);
    const wr = new ByteWriter(8);
    w.party.purse = 200;
    m.onEvent(0, writeBuy(wr.reset(), 2).copy());
    m.onEvent(0, writeBuy(wr.reset(), 2).copy());
    m.onEvent(0, writeBuy(wr.reset(), 10).copy());
    m.onEvent(0, writeBuy(wr.reset(), 10).copy());
    m.onEvent(0, writeBuy(wr.reset(), 8).copy());
    m.onEvent(0, writeBuy(wr.reset(), 8).copy());
    m.step();
    expect(w.party.buckler).toBe(true);
    expect(w.heroes[0]!.brew).toBe(true);
    expect(w.party.shards).toBe(1);
    expect(w.party.purse).toBe(200 - SHOP.buckler - SHOP.brew - SHOP.shard);
    w.heroes[0]!.hp = 2;
    m.onEvent(0, writeUseBrew(wr.reset()).copy());
    m.step();
    expect(w.heroes[0]!.hp).toBe(maxHp(0, 1));
    expect(w.heroes[0]!.brew).toBe(false);
  });

  it('grows hearts by 6 + 2 per vessel + 2 per four shards, capped at 6 hearts', () => {
    expect(maxHp(0, 3)).toBe(6);
    expect(maxHp(0, 4)).toBe(8);
    expect(maxHp(1, 8)).toBe(12);
    expect(respawnHp(12)).toBe(6);
    expect(respawnHp(6)).toBe(6);
  });

  it('revives a downed ally after 60 ticks within 16 px; respawns after 600 or on rest', () => {
    const { m, w } = matchIn('meadow', 5, 5, 2);
    const wr = new ByteWriter(8);
    const [a, b] = [w.heroes[0]!, w.heroes[1]!];
    m.onEvent(1, writeDamageTaken(wr.reset(), 0xfe, 12, 0).copy());
    m.step();
    expect(b.status).toBe(Status.Downed);
    // The ally was beside the hero already on the tick it went down: 60 ticks in all.
    a.x = b.x + 100;
    a.y = b.y;
    for (let t = 0; t < R.reviveTicks - 2; t += 1) m.step();
    expect(b.status).toBe(Status.Downed);
    m.step();
    expect(b.status).toBe(Status.Active);
    expect(b.hp).toBe(R.reviveHp);
    // Down again with nobody near: the lantern after 600 ticks.
    a.x = b.x + 1500;
    m.onEvent(1, writeDamageTaken(wr.reset(), 0xfe, 12, 0).copy());
    for (let t = 0; t < 601; t += 1) m.step();
    expect(b.status).toBe(Status.Active);
    expect(b.room).toBe(content().byKey.square!.id);
    expect(b.hp).toBe(respawnHp(maxHp(0, 0)));
    // Alone and down, resting at the lantern is a wipe: back at the lantern, the fight reset.
    const solo = matchIn('meadow', 5, 5);
    solo.m.onEvent(0, writeDamageTaken(wr.reset(), 0xfe, 12, 0).copy());
    solo.m.step();
    solo.m.onEvent(0, writeRespawn(wr.reset()).copy());
    for (let t = 0; t < 5; t += 1) solo.m.step();
    expect(solo.w.heroes[0]!.status).toBe(Status.Active);
    expect(solo.w.heroes[0]!.room).toBe(content().byKey.square!.id);
  });

  it('drops from grass and bushes at about 70 % nothing, 20 % chip, 8 % heart (if hurt), 2 % spark', () => {
    const { room, w } = matchIn('meadow', 5, 5);
    w.heroes[0]!.hp = 1;
    const counts = [0, 0, 0, 0, 0];
    for (let i = 0; i < 5000; i += 1) {
      for (const k of room.pk) k.on = 0;
      room.ev.reset();
      tileDrop(w, room, T.BUSH, 1000, 1000, 6);
      const k = room.pk.find((x) => x.on);
      counts[k ? k.kind + 1 : 0] += 1;
    }
    const pct = (n: number): number => (100 * n) / 5000;
    expect(pct(counts[0]!)).toBeGreaterThan(66);
    expect(pct(counts[0]!)).toBeLessThan(74);
    expect(pct(counts[Pick.Chip + 1]!)).toBeGreaterThan(17);
    expect(pct(counts[Pick.Heart + 1]!)).toBeGreaterThan(6);
    expect(pct(counts[Pick.Spark + 1]!)).toBeGreaterThan(1);
    // Nobody hurt: no hearts.
    w.heroes[0]!.hp = 6;
    let hearts = 0;
    for (let i = 0; i < 2000; i += 1) {
      for (const k of room.pk) k.on = 0;
      room.ev.reset();
      tileDrop(w, room, T.BUSH, 1000, 1000, 6);
      if (room.pk.some((x) => x.on && x.kind === Pick.Heart)) hearts += 1;
    }
    expect(hearts).toBe(0);
  });

  it('sizes Old Clapper by the heroes in the room when the first one enters', () => {
    for (const n of [1, 2, 4]) {
      const { m, room } = matchIn('belfry', 5, 6, n);
      m.step();
      const boss = room.en.find((e) => e.kind === Kind.Boss)!;
      expect(boss.hp).toBe(24 + 12 * (n - 1));
    }
  });

  it('opens a chest once and sets its flag; Hesper gives her glints once', () => {
    const { m, room, w } = matchIn('hesper', 9, 3);
    const wr = new ByteWriter(8);
    m.onEvent(0, writeInteract(wr.reset(), 2 * 12 + 9).copy());
    m.step();
    expect(w.party.sword).toBe(true);
    expect(room.tiles[2 * 12 + 9]).toBe(T.CHEST_OPEN);
    expect(flagSet(w.party.flags, 'chest_sword')).toBe(true);
    w.heroes[0]!.x = 2 * 256 + 128;
    m.onEvent(0, writeInteract(wr.reset(), 2 * 12 + 2).copy());
    m.onEvent(0, writeInteract(wr.reset(), 2 * 12 + 2).copy());
    m.step();
    expect(w.party.purse).toBe(5);
    void setFlag;
    void enemyById;
    void newEvView;
    void readEv;
    void EV;
    void ByteReader;
    void CUE;
  });
});
