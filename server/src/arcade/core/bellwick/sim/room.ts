/**
 * Room life: activation from the screen definition and the party's flags, the per-tick step (enemies,
 * the boss, projectiles, pickups, blocks, switches) and the room events it writes in the wire format
 * (bellwick.md §3.2, §4.4). Step functions allocate nothing; every loop runs over a fixed pool.
 */
import { xorshift32 } from '../../rng.js';
import {
  DESPAWN,
  entState,
  evBlockSlide,
  evDamage,
  evDespawn,
  evDrop,
  evFlag,
  evParty,
  evProjectile,
  evShock,
  evSpawn,
  evTile,
  PF,
} from '../codec.js';
import { T } from '../content/legend.js';
import { AREA, screen, type ScreenDef } from '../content/parse.js';
import {
  AI,
  BOSS_RULES,
  CUT_TO,
  DROPS,
  ENEMY_DROPS,
  ENEMY_RULES,
  ENEMY_STATS,
  F,
  HERO_RULES,
  TILE_FLAGS,
  countsForClear,
} from '../rules.js';
import { Attack, CAP, DX4, DX8, DY4, DY8, Kind, Pick, Proj, Status } from '../types.js';
import { stepEnemy } from './ai.js';
import { bossVulnerable, startBoss, stepBoss } from './boss.js';
import { boxBlocked, moveBox, overlap, SOLID_FLIER, SOLID_WALKER, tileCenterX, tileCenterY } from './collide.js';
import { hasFlag, newRoom, RING_ENTS, RING_TICKS, setFlagBit, type Block, type Enemy, type HeroRec, type Room } from './state.js';
import { roomSeed, touchProgress, type World } from './world.js';

const pos = new Int32Array(2);

/** A uniform-ish integer in [0, n) from the room's RNG. */
export const rnd = (room: Room, n: number): number => {
  room.rng = xorshift32(room.rng);
  return n <= 1 ? 0 : (room.rng >>> 0) % n;
};

export const px = (sub: number): number => sub >> 4;
/** Pixel-centred sub value: what a pixel coordinate on the wire stands for. */
export const pxSub = (p: number): number => (p << 4) + 8;

/** Which item bit is "under" a block start position (what the tile shows once it moves). */
const groundOf = (def: ScreenDef): number =>
  def.area === AREA.dungeon || def.area === AREA.cave ? T.FLOOR : def.area === AREA.home ? T.WOOD : T.GRASS;

/** The next free entity id (0–127) in the room, or −1. */
export const allocId = (room: Room): number => {
  for (let tries = 0; tries < 128; tries += 1) {
    const id = room.nextId;
    room.nextId = (room.nextId + 1) & 127;
    let used = false;
    for (let i = 0; i < CAP.enemies && !used; i += 1) if ((room.en[i] as Enemy).kind !== 0 && (room.en[i] as Enemy).id === id) used = true;
    for (let i = 0; i < CAP.projectiles && !used; i += 1) if (room.pr[i]!.on !== 0 && room.pr[i]!.id === id) used = true;
    for (let i = 0; i < CAP.pickups && !used; i += 1) if (room.pk[i]!.on !== 0 && room.pk[i]!.id === id) used = true;
    for (let i = 0; i < CAP.blocks && !used; i += 1) if (room.bl[i]!.on !== 0 && room.bl[i]!.id === id) used = true;
    if (!used) return id;
  }
  return -1;
};

export const setTile = (room: Room, tile: number, code: number): void => {
  if (room.tiles[tile] === code) return;
  room.tiles[tile] = code;
  evTile(room.ev, tile, code);
  room.evCount += 1;
};

export const enemyById = (room: Room, id: number): Enemy | null => {
  for (let i = 0; i < CAP.enemies; i += 1) {
    const e = room.en[i] as Enemy;
    if (e.kind !== 0 && e.id === id) return e;
  }
  return null;
};

export const spawnEnemy = (room: Room, kind: number, x: number, y: number, facing: number, summoned: boolean, announce: boolean): Enemy | null => {
  for (let i = 0; i < CAP.enemies; i += 1) {
    const e = room.en[i] as Enemy;
    if (e.kind !== 0) continue;
    const id = allocId(room);
    if (id < 0) return null;
    const st = ENEMY_STATS[kind];
    e.kind = kind;
    e.id = id;
    e.x = x;
    e.y = y;
    e.facing = facing;
    e.hp = st ? st.hp : 1;
    e.ai = 0;
    e.aiT = 0;
    e.t2 = 0;
    e.tx = x;
    e.ty = y;
    e.homeX = x;
    e.homeY = y;
    e.iframes = 0;
    e.kbDx = 0;
    e.kbDy = 0;
    e.kbT = 0;
    e.stun = 0;
    e.hurt = 0;
    e.pose = 0;
    e.summoned = summoned;
    if (announce) {
      evSpawn(room.ev, e.id, kind, px(x), px(y), entState(0, facing, false, false), Math.min(255, e.hp));
      room.evCount += 1;
    }
    return e;
  }
  return null;
};

/** Spawns a projectile at a pixel-centred origin (so clients compute the same path). */
export const spawnProjectile = (room: Room, kind: number, x: number, y: number, dir: number, by: number): void => {
  for (let i = 0; i < CAP.projectiles; i += 1) {
    const p = room.pr[i]!;
    if (p.on !== 0) continue;
    const id = allocId(room);
    if (id < 0) return;
    p.on = 1;
    p.id = id;
    p.kind = kind;
    p.x0 = pxSub(px(x));
    p.y0 = pxSub(px(y));
    p.dir = dir;
    p.t0 = room.tick;
    p.ttl = ENEMY_RULES.projTtl;
    p.by = by;
    evProjectile(room.ev, id, kind, dir, px(p.x0), px(p.y0), p.t0);
    room.evCount += 1;
    return;
  }
};

export const projSpeed = (kind: number): number =>
  kind === Proj.Note ? ENEMY_RULES.noteSpeed : kind === Proj.Repel ? ENEMY_RULES.repelSpeed : kind === Proj.Bounce ? ENEMY_RULES.bounceSpeed : ENEMY_RULES.pebbleSpeed;

/** A projectile's position at `tick` (a straight path from its origin; both sides compute it). */
export const projX = (x0: number, dir: number, kind: number, t: number): number => x0 + (((DX8[dir] as number) * projSpeed(kind) * t) >> 4);
export const projY = (y0: number, dir: number, kind: number, t: number): number => y0 + (((DY8[dir] as number) * projSpeed(kind) * t) >> 4);

export const despawnProjectile = (room: Room, i: number, reason: number): void => {
  const p = room.pr[i]!;
  if (p.on === 0) return;
  p.on = 0;
  evDespawn(room.ev, p.id, reason);
  room.evCount += 1;
};

export const spawnPickup = (room: Room, kind: number, x: number, y: number, ttl: number): void => {
  for (let i = 0; i < CAP.pickups; i += 1) {
    const k = room.pk[i]!;
    if (k.on !== 0) continue;
    const id = allocId(room);
    if (id < 0) return;
    k.on = 1;
    k.id = id;
    k.kind = kind;
    k.x = pxSub(px(Math.max(64, Math.min(3008, x))));
    k.y = pxSub(px(Math.max(64, Math.min(2240, y))));
    k.ttl = ttl;
    evDrop(room.ev, id, kind, ttl, px(k.x), px(k.y));
    room.evCount += 1;
    return;
  }
};

export const spawnShock = (room: Room, x: number, y: number): void => {
  for (let i = 0; i < CAP.shocks; i += 1) {
    const s = room.sh[i]!;
    if (s.on !== 0) continue;
    s.on = 1;
    s.x = pxSub(px(x));
    s.y = pxSub(px(y));
    s.t0 = room.tick;
    evShock(room.ev, px(s.x), px(s.y), s.t0);
    room.evCount += 1;
    return;
  }
};

/** Is any hero in `w` hurt (a heart may drop)? */
const anyoneHurt = (w: World, maxHp: number): boolean => {
  for (let i = 0; i < 4; i += 1) {
    const h = w.heroes[i] as HeroRec;
    if (h.present && h.status !== Status.Resting && h.hp < maxHp) return true;
  }
  return false;
};

/** Drops from grass, bushes and pots (bellwick.md §1.3). */
export const tileDrop = (w: World, room: Room, code: number, x: number, y: number, maxHp: number): void => {
  const r = rnd(room, 100);
  if (code === T.POT) {
    if (r < DROPS.potHeart) spawnPickup(room, anyoneHurt(w, maxHp) ? Pick.Heart : Pick.Chip, x, y, ENEMY_RULES.pickupTtl);
    else if (r < DROPS.potHeart + DROPS.potChip) spawnPickup(room, Pick.Chip, x, y, ENEMY_RULES.pickupTtl);
    return;
  }
  if (r < DROPS.grassChip) spawnPickup(room, Pick.Chip, x, y, ENEMY_RULES.pickupTtl);
  else if (r < DROPS.grassChip + DROPS.grassHeart) {
    if (anyoneHurt(w, maxHp)) spawnPickup(room, Pick.Heart, x, y, ENEMY_RULES.pickupTtl);
  } else if (r < DROPS.grassChip + DROPS.grassHeart + DROPS.grassSpark) spawnPickup(room, Pick.Spark, x, y, ENEMY_RULES.pickupTtl);
};

const enemyDrop = (w: World, room: Room, e: Enemy, maxHp: number): void => {
  if (e.summoned) {
    // Old Clapper's bats bring a little relief to a long fight.
    if (rnd(room, 100) < 30 && anyoneHurt(w, maxHp)) spawnPickup(room, Pick.Heart, e.x, e.y, ENEMY_RULES.pickupTtl);
    return;
  }
  if (e.kind === Kind.Wisp) {
    const n = 2 + rnd(room, 4);
    for (let i = 0; i < n; i += 1) spawnPickup(room, Pick.Chip, e.x + (i - 2) * 96, e.y + ((i & 1) === 0 ? -64 : 64), ENEMY_RULES.pickupTtl);
    return;
  }
  const d = ENEMY_DROPS[e.kind];
  if (!d) return;
  const r = rnd(room, 100);
  if (r < d.chip) spawnPickup(room, Pick.Chip, e.x, e.y, ENEMY_RULES.pickupTtl);
  else if (r < d.chip + d.heart) {
    if (anyoneHurt(w, maxHp)) spawnPickup(room, Pick.Heart, e.x, e.y, ENEMY_RULES.pickupTtl);
  } else if (r < d.chip + d.heart + d.spark) spawnPickup(room, Pick.Spark, e.x, e.y, ENEMY_RULES.pickupTtl);
};

/** Is the enemy invulnerable right now (hidden rootling, airborne or guarded boss, sentinel)? */
export const enemyInvulnerable = (room: Room, e: Enemy): boolean => {
  if (e.kind === Kind.Sentinel || e.kind === Kind.Block) return true;
  if (e.kind === Kind.Rootling && (e.ai === 0 || e.ai === 1)) return true;
  if (e.kind === Kind.Boss) return !bossVulnerable(room);
  return false;
};

/** Live dungeon enemies that count for "cleared". */
const enemiesLeft = (room: Room): number => {
  let n = 0;
  for (let i = 0; i < CAP.enemies; i += 1) {
    const e = room.en[i] as Enemy;
    if (e.kind !== 0 && countsForClear(e.kind) && !e.summoned) n += 1;
  }
  return n;
};

/** Marks a dungeon room cleared and shows its clear chest. */
const checkCleared = (w: World, room: Room): void => {
  if (!room.def.dungeon || enemiesLeft(room) > 0) return;
  const bit = 1 << (room.id - 32);
  if ((w.party.cleared & bit) === 0) {
    w.party.cleared |= bit;
    evParty(w.party.ev, PF.cleared, w.party.cleared);
    w.party.evCount += 1;
  }
  for (const c of room.def.chests) {
    if (c.onClear && !hasFlag(w.party, c.flag) && room.tiles[c.tile] !== T.CHEST) setTile(room, c.tile, T.CHEST);
  }
};

export const killEnemy = (w: World, room: Room, e: Enemy, bySlot: number, maxHp: number): void => {
  evDespawn(room.ev, e.id, DESPAWN.killed);
  room.evCount += 1;
  const hero = bySlot < 4 ? (w.heroes[bySlot] as HeroRec) : null;
  if (hero && e.kind !== Kind.Boss) hero.foes += 1;
  enemyDrop(w, room, e, maxHp);
  e.kind = 0;
  checkCleared(w, room);
};

/** What a hit did. */
export const HIT = { none: 0, damage: 1, clink: 2, kill: 3, stun: 4 } as const;

/**
 * Applies one hit to an enemy: damage and knockback away from (fromX, fromY), a clink for frontal
 * slashes on a Shellback or a guarded target, a stun for the hook. Writes the Damage event.
 */
export const hitEnemy = (w: World, room: Room, e: Enemy, attack: number, dmg: number, bySlot: number, fromX: number, fromY: number, maxHp: number): number => {
  if (e.kind === 0) return HIT.none;
  if (e.kind === Kind.Boss) return hitBoss(w, room, e, attack, dmg, bySlot, maxHp);
  if (attack === Attack.Hook) {
    if (e.kind === Kind.Sentinel) return HIT.none;
    if (e.kind === Kind.Shellback) {
      e.ai = 1;
      e.aiT = AI.shellbackFlip;
    } else e.stun = AI.hookStun;
    evDamage(room.ev, e.id, 0, e.hp, bySlot);
    room.evCount += 1;
    return HIT.stun;
  }
  if (e.iframes > 0) return HIT.none;
  if (enemyInvulnerable(room, e)) {
    evDamage(room.ev, e.id, 0, e.hp, bySlot);
    room.evCount += 1;
    return HIT.clink;
  }
  let amount = dmg;
  if (e.kind === Kind.Shellback) {
    if (e.ai === 1) amount *= 2;
    else if (attack === Attack.Slash) {
      // In front: the attacker is on the side the shell faces.
      const dx = fromX - e.x;
      const dy = fromY - e.y;
      const front = e.facing === 0 ? dy > 0 : e.facing === 1 ? dy < 0 : e.facing === 2 ? dx < 0 : dx > 0;
      if (front) {
        evDamage(room.ev, e.id, 0, e.hp, bySlot);
        room.evCount += 1;
        return HIT.clink;
      }
    }
  }
  e.hp -= amount;
  e.iframes = ENEMY_RULES.iframes;
  e.hurt = 8;
  // Knockback along the dominant axis, away from the attacker.
  const dx = e.x - fromX;
  const dy = e.y - fromY;
  if (Math.abs(dx) >= Math.abs(dy)) {
    e.kbDx = dx >= 0 ? ENEMY_RULES.knockSpeed : -ENEMY_RULES.knockSpeed;
    e.kbDy = 0;
  } else {
    e.kbDx = 0;
    e.kbDy = dy >= 0 ? ENEMY_RULES.knockSpeed : -ENEMY_RULES.knockSpeed;
  }
  e.kbT = ENEMY_RULES.knockTicks;
  evDamage(room.ev, e.id, amount, e.hp, bySlot);
  room.evCount += 1;
  if (e.kind === Kind.Rootling && e.ai === 2) e.ai = 3;
  if (e.hp <= 0) {
    killEnemy(w, room, e, bySlot, maxHp);
    return HIT.kill;
  }
  return HIT.damage;
};

const hitBoss = (w: World, room: Room, e: Enemy, attack: number, dmg: number, bySlot: number, maxHp: number): number => {
  const b = room.boss;
  if (!b || b.mode === 9) return HIT.none;
  if (attack === Attack.Hook) {
    if (b.phase === 3 && b.mode === 0) {
      b.mode = 1;
      b.timer = BOSS_RULES.clapperTicks;
      b.clapperT = BOSS_RULES.clapperTicks;
      b.windowDmg = 0;
      evDamage(room.ev, e.id, 0, e.hp, bySlot);
      room.evCount += 1;
      return HIT.stun;
    }
    return HIT.none;
  }
  if (e.iframes > 0) return HIT.none;
  if (!bossVulnerable(room)) {
    evDamage(room.ev, e.id, 0, e.hp, bySlot);
    room.evCount += 1;
    return HIT.clink;
  }
  const cap = BOSS_RULES.capBase + BOSS_RULES.capPerHero * Math.max(0, b.heroes - 1);
  let amount = b.phase === 3 ? dmg * 2 : dmg;
  amount = Math.max(0, Math.min(amount, cap - b.windowDmg));
  if (amount <= 0) return HIT.none;
  b.windowDmg += amount;
  e.hp -= amount;
  e.iframes = 6;
  e.hurt = 8;
  evDamage(room.ev, e.id, amount, Math.max(0, e.hp), bySlot);
  room.evCount += 1;
  if (e.hp <= 0) {
    defeatBoss(w, room, e, maxHp);
    return HIT.kill;
  }
  return HIT.damage;
};

const defeatBoss = (w: World, room: Room, e: Enemy, maxHp: number): void => {
  const x = e.x;
  const y = e.y;
  killEnemy(w, room, e, 255, maxHp);
  // The summoned bats leave with it.
  for (let i = 0; i < CAP.enemies; i += 1) {
    const o = room.en[i] as Enemy;
    if (o.kind !== 0 && o.summoned) {
      evDespawn(room.ev, o.id, DESPAWN.removed);
      room.evCount += 1;
      o.kind = 0;
    }
  }
  for (let i = 0; i < CAP.projectiles; i += 1) despawnProjectile(room, i, DESPAWN.removed);
  for (let i = 0; i < CAP.shocks; i += 1) room.sh[i]!.on = 0;
  if (room.boss) room.boss.mode = 8;
  spawnPickup(room, Pick.Vessel, x, y, -1);
  setFlagBit(w.party, 32, true);
  evFlag(w.party.ev, 32, 1);
  w.party.evCount += 1;
  touchProgress(w);
};

/** Cuts a tile (grass, bush, thorns, pot) and rolls its drop; a stash bush gives its stash once. */
export const cutTile = (w: World, room: Room, tile: number, maxHp: number): boolean => {
  const code = room.tiles[tile] as number;
  if (((TILE_FLAGS[code] ?? 0) & F.CUT) === 0) return false;
  setTile(room, tile, CUT_TO(code));
  const x = tileCenterX(tile);
  const y = tileCenterY(tile);
  for (const s of room.def.stash) {
    if (s.tile === tile && !hasFlag(w.party, s.flag)) {
      setFlagBit(w.party, s.flag, true);
      evFlag(w.party.ev, s.flag, 1);
      w.party.evCount += 1;
      touchProgress(w);
      for (let i = 0; i < s.n; i += 1) spawnPickup(room, Pick.Spark, x + (i * 2 - 1) * 96, y, ENEMY_RULES.pickupTtl);
      return true;
    }
  }
  tileDrop(w, room, code, x, y, maxHp);
  return true;
};

/** Toggles a crystal on (once): the room's retracted bridge extends. */
export const toggleCrystal = (w: World, room: Room, tile: number): boolean => {
  const code = room.tiles[tile];
  if (code !== T.CRYSTAL) return false;
  setTile(room, tile, T.CRYSTAL_ON);
  for (let i = 0; i < room.tiles.length; i += 1) if (room.tiles[i] === T.BRIDGE_OFF) setTile(room, i, T.BRIDGE_ON);
  const c = room.def.crystal;
  if (c && !hasFlag(w.party, c.flag)) {
    setFlagBit(w.party, c.flag, true);
    evFlag(w.party.ev, c.flag, 1);
    w.party.evCount += 1;
    touchProgress(w);
  }
  return true;
};

/** Every switch in the def has a resting block on it → set the shutter flag and open the shutters. */
const checkSwitches = (w: World, room: Room): void => {
  const def = room.def;
  if (def.shutterFlag < 0 || hasFlag(w.party, def.shutterFlag)) return;
  let total = 0;
  let covered = 0;
  for (let i = 0; i < def.tiles.length; i += 1) {
    if (def.tiles[i] !== T.SWITCH) continue;
    total += 1;
    for (let b = 0; b < CAP.blocks; b += 1) {
      const bl = room.bl[b] as Block;
      if (bl.on !== 0 && bl.moveT === 0 && bl.tile === i) covered += 1;
    }
  }
  if (total === 0 || covered < total) return;
  setFlagBit(w.party, def.shutterFlag, true);
  evFlag(w.party.ev, def.shutterFlag, 1);
  w.party.evCount += 1;
  touchProgress(w);
  for (let i = 0; i < room.tiles.length; i += 1) if (room.tiles[i] === T.SHUTTER) setTile(room, i, T.SHUTTER_OPEN);
};

/** Starts a block slide from `tile` in `dir` if the target tile is free; false otherwise. */
export const pushBlock = (room: Room, tile: number, dir: number): boolean => {
  let block: Block | null = null;
  for (let i = 0; i < CAP.blocks; i += 1) {
    const b = room.bl[i] as Block;
    if (b.on !== 0 && b.tile === tile && b.moveT === 0) block = b;
  }
  if (!block) return false;
  const tx = (tile % 12) + (DX4[dir] as number);
  const ty = Math.floor(tile / 12) + (DY4[dir] as number);
  if (tx < 0 || ty < 0 || tx >= 12 || ty >= 9) return false;
  const target = ty * 12 + tx;
  const code = room.tiles[target] as number;
  if (code !== T.FLOOR && code !== T.GRASS && code !== T.WOOD && code !== T.PATH && code !== T.SWITCH && code !== T.STUBBLE) return false;
  // Nothing alive may stand on the target tile.
  for (let i = 0; i < CAP.enemies; i += 1) {
    const e = room.en[i] as Enemy;
    if (e.kind !== 0 && !(ENEMY_STATS[e.kind]?.flies ?? false) && e.x >> 8 === tx && e.y >> 8 === ty) return false;
  }
  evBlockSlide(room.ev, tile, dir);
  room.evCount += 1;
  setTile(room, tile, block.under);
  block.under = code;
  block.from = tile;
  block.tile = target;
  block.dir = dir;
  block.moveT = 1;
  setTile(room, target, T.BLOCK);
  return true;
};

/** A block's current position (sub, centre). */
export const blockX = (b: Block): number =>
  b.moveT === 0 ? tileCenterX(b.tile) : tileCenterX(b.from) + (((DX4[b.dir] as number) * 256 * b.moveT) / HERO_RULES.slideTicks | 0);
export const blockY = (b: Block): number =>
  b.moveT === 0 ? tileCenterY(b.tile) : tileCenterY(b.from) + (((DY4[b.dir] as number) * 256 * b.moveT) / HERO_RULES.slideTicks | 0);

/** Creates (or wakes from frozen) the room `id`, applying the party's flags to its tiles. */
export const activateRoom = (w: World, id: number): Room => {
  const existing = w.rooms[id];
  if (existing) {
    existing.emptySince = -1;
    return existing;
  }
  const def = screen(id);
  const room = newRoom(def);
  const party = w.party;
  w.activations[id] = (w.activations[id] as number) + 1;
  room.activation = w.activations[id] as number;
  room.rng = roomSeed(w.seed, id, room.activation);
  room.tick = w.tick;
  room.tiles.set(def.tiles);
  const ground = groundOf(def);
  // Chests: opened ones stay open; a chest under a block is revealed once opened; clear chests appear when cleared.
  for (const c of def.chests) {
    if (hasFlag(party, c.flag)) room.tiles[c.tile] = T.CHEST_OPEN;
    else if (c.onClear) room.tiles[c.tile] = (party.cleared & (1 << (id - 32))) !== 0 ? T.CHEST : def.tiles[c.tile] as number;
  }
  for (const l of def.locks) if (hasFlag(party, l.flag)) room.tiles[l.tile] = l.boss ? T.BOSSDOOR_OPEN : T.LOCK_OPEN;
  if (def.shutterFlag >= 0 && hasFlag(party, def.shutterFlag)) {
    for (let i = 0; i < room.tiles.length; i += 1) if (room.tiles[i] === T.SHUTTER) room.tiles[i] = T.SHUTTER_OPEN;
  }
  if (def.crystal && hasFlag(party, def.crystal.flag)) {
    room.tiles[def.crystal.tile] = T.CRYSTAL_ON;
    for (let i = 0; i < room.tiles.length; i += 1) if (room.tiles[i] === T.BRIDGE_OFF) room.tiles[i] = T.BRIDGE_ON;
  }
  if (def.lantern && hasFlag(party, 13 + def.lantern.id)) room.tiles[def.lantern.tile] = T.LANTERN_LIT;
  // Blocks: one per BLOCK tile; a chest under a block shows once the block moves (and has no block once opened).
  let nb = 0;
  for (let i = 0; i < room.tiles.length && nb < CAP.blocks; i += 1) {
    if (room.tiles[i] !== T.BLOCK) continue;
    let under = ground;
    for (const c of def.chests) if (c.under && c.tile === i) under = T.CHEST;
    const b = room.bl[nb] as Block;
    b.on = 1;
    b.id = allocId(room);
    b.tile = i;
    b.from = i;
    b.under = under;
    b.moveT = 0;
    b.dir = 0;
    nb += 1;
  }
  // Enemies, unless this dungeon room is cleared; the boss unless it is down.
  const cleared = def.dungeon && (party.cleared & (1 << (id - 32))) !== 0;
  if (!cleared) {
    for (let i = 0; i < def.enemies.length; i += 1) {
      const d = def.enemies[i]!;
      const e = spawnEnemy(room, d.kind, tileCenterX(d.tile), tileCenterY(d.tile), d.dir, false, false);
      if (e && d.kind === Kind.Sentinel) e.aiT = i * 10;
      if (e && d.kind === Kind.Burrlet) e.aiT = 20 + rnd(room, 30);
    }
  }
  if (def.boss >= 0 && !hasFlag(party, 32)) {
    const e = spawnEnemy(room, Kind.Boss, tileCenterX(def.boss) - 128, tileCenterY(def.boss), 0, false, false);
    if (e) startBoss(room, e);
  }
  room.ev.reset();
  room.evCount = 0;
  w.rooms[id] = room;
  return room;
};

/** Frees a room (only its flags remain). */
export const freeRoom = (w: World, id: number): void => {
  w.rooms[id] = null;
};

/** Writes this tick's entity positions into the rewind ring. */
const writeRing = (room: Room): void => {
  const row = room.tick & (RING_TICKS - 1);
  room.ringTick[row] = room.tick;
  let n = 0;
  const base = row * RING_ENTS;
  for (let i = 0; i < CAP.enemies && n < RING_ENTS; i += 1) {
    const e = room.en[i] as Enemy;
    if (e.kind === 0) continue;
    room.ringIds[base + n] = e.id | 128;
    room.ringXY[(base + n) * 2] = e.x;
    room.ringXY[(base + n) * 2 + 1] = e.y;
    n += 1;
  }
  for (; n < RING_ENTS; n += 1) room.ringIds[base + n] = 0;
};

/** The ring's position of entity `id` at `tick`; false when the tick or the id is not in the ring. */
export const ringAt = (room: Room, id: number, tick: number, out: Int32Array): boolean => {
  const row = tick & (RING_TICKS - 1);
  if (room.ringTick[row] !== tick) return false;
  const base = row * RING_ENTS;
  for (let i = 0; i < RING_ENTS; i += 1) {
    if (room.ringIds[base + i] === (id | 128)) {
      out[0] = room.ringXY[(base + i) * 2] as number;
      out[1] = room.ringXY[(base + i) * 2 + 1] as number;
      return true;
    }
  }
  return false;
};

/** Heroes in this room the AI may target. */
export const targetable = (h: HeroRec, room: number): boolean =>
  h.present && h.room === room && h.status === Status.Active && h.transitT === 0;

/** The nearest targetable hero by Manhattan distance (ties: the lowest slot), or null. */
export const nearestHero = (w: World, room: Room, x: number, y: number): HeroRec | null => {
  let best: HeroRec | null = null;
  let bestD = 0x7fffffff;
  for (let i = 0; i < 4; i += 1) {
    const h = w.heroes[i] as HeroRec;
    if (!targetable(h, room.id)) continue;
    const d = Math.abs(h.x - x) + Math.abs(h.y - y);
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
};

/** Moves an enemy with collision; returns the blocked-axis bits. */
export const moveEnemy = (room: Room, e: Enemy, dx: number, dy: number): number => {
  const st = ENEMY_STATS[e.kind];
  const half = st ? st.half : 96;
  const halfY = e.kind === Kind.Boss ? BOSS_RULES.halfH : half;
  pos[0] = e.x;
  pos[1] = e.y;
  const mask = st && st.flies ? SOLID_FLIER : SOLID_WALKER;
  const blocked = moveBox(room.tiles, pos, dx, dy, half - 16, halfY - 16, mask, null);
  e.x = pos[0] as number;
  e.y = pos[1] as number;
  return blocked;
};

export const enemyCanStand = (room: Room, kind: number, x: number, y: number): boolean => {
  const st = ENEMY_STATS[kind];
  const half = (st ? st.half : 96) - 16;
  return !boxBlocked(room.tiles, x, y, half, half, st && st.flies ? SOLID_FLIER : SOLID_WALKER, null);
};

/** One tick of a room: enemies, boss, projectiles, pickups, blocks and shocks. */
export const stepRoom = (w: World, room: Room, maxHp: number): void => {
  room.tick = w.tick;
  // Enemies.
  for (let i = 0; i < CAP.enemies; i += 1) {
    const e = room.en[i] as Enemy;
    if (e.kind === 0) continue;
    if (e.iframes > 0) e.iframes -= 1;
    if (e.hurt > 0) e.hurt -= 1;
    if (e.kbT > 0) {
      moveEnemy(room, e, e.kbDx, e.kbDy);
      e.kbT -= 1;
      continue;
    }
    if (e.stun > 0) {
      e.stun -= 1;
      continue;
    }
    if (e.kind === Kind.Boss) stepBoss(w, room, e);
    else stepEnemy(w, room, e);
  }
  // Overlapping walkers drift apart.
  for (let i = 0; i < CAP.enemies; i += 1) {
    const a = room.en[i] as Enemy;
    if (a.kind === 0 || a.kind === Kind.Sentinel || a.kind === Kind.Boss || (ENEMY_STATS[a.kind]?.flies ?? false)) continue;
    for (let j = i + 1; j < CAP.enemies; j += 1) {
      const b = room.en[j] as Enemy;
      if (b.kind === 0 || b.kind === Kind.Sentinel || b.kind === Kind.Boss || (ENEMY_STATS[b.kind]?.flies ?? false)) continue;
      if (!overlap(a.x, a.y, 80, 80, b.x, b.y, 80, 80)) continue;
      const sx = a.x < b.x || (a.x === b.x && a.id < b.id) ? -1 : 1;
      const sy = a.y < b.y ? -1 : a.y > b.y ? 1 : 0;
      moveEnemy(room, a, sx * ENEMY_RULES.separate, sy * ENEMY_RULES.separate);
      moveEnemy(room, b, -sx * ENEMY_RULES.separate, -sy * ENEMY_RULES.separate);
    }
  }
  // Projectiles: fly straight; solid tiles and their lifetime end them; bounced pebbles hurt enemies.
  for (let i = 0; i < CAP.projectiles; i += 1) {
    const p = room.pr[i]!;
    if (p.on === 0) continue;
    const t = room.tick - p.t0;
    const x = projX(p.x0, p.dir, p.kind, t);
    const y = projY(p.y0, p.dir, p.kind, t);
    p.ttl -= 1;
    if (p.ttl <= 0 || x < 0 || y < 0 || x >= 3072 || y >= 2304 || (TILE_FLAGS[room.tiles[(y >> 8) * 12 + (x >> 8)] as number]! & F.SOLID) !== 0) {
      despawnProjectile(room, i, DESPAWN.expired);
      continue;
    }
    if (p.kind === Proj.Bounce) {
      for (let k = 0; k < CAP.enemies; k += 1) {
        const e = room.en[k] as Enemy;
        if (e.kind === 0 || e.kind === Kind.Sentinel) continue;
        const half = ENEMY_STATS[e.kind]?.half ?? 96;
        if (!overlap(x, y, ENEMY_RULES.projHalf, ENEMY_RULES.projHalf, e.x, e.y, half, half)) continue;
        hitEnemy(w, room, e, Attack.Bounce, 2, p.by, x - (DX8[p.dir] as number) * 8, y - (DY8[p.dir] as number) * 8, maxHp);
        despawnProjectile(room, i, DESPAWN.blocked);
        break;
      }
    }
  }
  // Pickups expire.
  for (let i = 0; i < CAP.pickups; i += 1) {
    const k = room.pk[i]!;
    if (k.on === 0 || k.ttl < 0) continue;
    k.ttl -= 1;
    if (k.ttl <= 0) {
      k.on = 0;
      evDespawn(room.ev, k.id, DESPAWN.expired);
      room.evCount += 1;
    }
  }
  // Blocks slide 16 px over 16 ticks.
  for (let i = 0; i < CAP.blocks; i += 1) {
    const b = room.bl[i] as Block;
    if (b.on === 0 || b.moveT === 0) continue;
    b.moveT += 1;
    if (b.moveT > HERO_RULES.slideTicks) {
      b.moveT = 0;
      checkSwitches(w, room);
    }
  }
  // Shock rings fade past their reach.
  for (let i = 0; i < CAP.shocks; i += 1) {
    const s = room.sh[i]!;
    if (s.on !== 0 && (room.tick - s.t0) * BOSS_RULES.ringSpeed > BOSS_RULES.ringMax) s.on = 0;
  }
  writeRing(room);
};

/** Resets a room's fight after a wipe: enemies respawn as on activation, the boss fight restarts. */
export const resetRoom = (w: World, id: number): void => {
  if (!w.rooms[id]) return;
  w.rooms[id] = null;
  activateRoom(w, id);
};

/** The pose nibble shown for an enemy (snapshot and keyframe). */
export const enemyPose = (room: Room, e: Enemy): number => {
  if (e.kind === Kind.Boss) {
    const b = room.boss;
    if (!b) return 7;
    if (b.mode === 9 || b.mode === 8) return 7;
    return b.phase === 1 ? b.mode : b.phase === 2 ? 3 + b.mode : 5 + b.mode;
  }
  return e.pose & 15;
};

/** DX/DY of the facing (used by AI and the boss). */
export const faceDX = (f: number): number => DX4[f] as number;
export const faceDY = (f: number): number => DY4[f] as number;
