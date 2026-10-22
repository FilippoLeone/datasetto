/**
 * The authority's side of the party (bellwick.md §1.3, §1.8, §2): applying what heroes did (hits, damage,
 * interactions, pushes, room changes, the shop, brews, respawns), and the per-tick world step (rooms,
 * pickups, revival, downed timers, wipes, frozen rooms, autosave, roster). The server runs it online and
 * the device offline; both feed it the same EVTs.
 */
import { ByteWriter } from '../../bytes.js';
import {
  CORRECT,
  DESPAWN,
  evCorrect,
  evDespawn,
  evDowned,
  evFlag,
  evGot,
  evHp,
  evParty,
  evRefused,
  evRevived,
  evRoster,
  evSaved,
  evVictory,
  EVT,
  PF,
  REFUSE,
  toBase64,
  type RosterRow,
  type SaveHero,
  type SaveV1,
} from '../codec.js';
import { T } from '../content/legend.js';
import { content, flaggedTile, screen } from '../content/parse.js';
import { edgeOpen, ENEMY_RULES, F, GLINTS, HERO_RULES, maxHp, PARTY_RULES, respawnHp, TILE_FLAGS } from '../rules.js';
import { Act, Attack, CAP, Item, ItemBit, Kind, Lantern, Pick, Status } from '../types.js';
import { tileCenterX, tileCenterY } from './collide.js';
import {
  activateRoom,
  cutTile,
  despawnProjectile,
  enemyById,
  freeRoom,
  hitEnemy,
  pushBlock,
  resetRoom,
  setTile,
  spawnProjectile,
  stepRoom,
  toggleCrystal,
} from './room.js';
import { hasFlag, setFlagBit, type HeroRec, type Party, type Room } from './state.js';
import { touchProgress, type World } from './world.js';

export const BOSS_DOWN = 32;
export const lanternFlag = (id: number): number => 13 + id;

export const partyMaxHp = (p: Party): number => maxHp(p.vessels, p.shards);

export const itemsByte = (p: Party): number =>
  (p.sword ? ItemBit.sword : 0) |
  (p.buckler ? ItemBit.buckler : 0) |
  (p.hook ? ItemBit.hook : 0) |
  (p.map ? ItemBit.map : 0) |
  (p.compass ? ItemBit.compass : 0) |
  (p.bossKey ? ItemBit.bossKey : 0);

/** Per-hero events only that hero receives (Correct, Refused) and pending rekeys. */
export interface Outbox {
  self: ByteWriter[];
  selfCount: number[];
  /** Pending KEYFRAME per slot: 0 none, else 1 + the entry reason (codec ENTRY). */
  rekey: number[];
}

export const newOutbox = (): Outbox => ({
  self: [new ByteWriter(512), new ByteWriter(512), new ByteWriter(512), new ByteWriter(512)],
  selfCount: [0, 0, 0, 0],
  rekey: [0, 0, 0, 0],
});

const pev = (w: World): ByteWriter => {
  w.party.evCount += 1;
  return w.party.ev;
};

const refuse = (o: Outbox, slot: number, kind: number, arg: number, code: number): void => {
  evRefused(o.self[slot] as ByteWriter, kind, arg, code);
  o.selfCount[slot] = (o.selfCount[slot] as number) + 1;
};

const setFlag = (w: World, id: number): void => {
  if (id < 0 || hasFlag(w.party, id)) return;
  setFlagBit(w.party, id, true);
  evFlag(pev(w), id, 1);
  touchProgress(w);
};

const sendItems = (w: World): void => evParty(pev(w), PF.items, itemsByte(w.party));

const addGlints = (w: World, n: number): void => {
  w.party.purse = Math.min(GLINTS.purseMax, w.party.purse + n);
  evParty(pev(w), PF.purse, w.party.purse);
  touchProgress(w);
};

const setHp = (w: World, h: HeroRec, hp: number): void => {
  h.hp = Math.max(0, Math.min(partyMaxHp(w.party), hp));
  const room = w.rooms[h.room];
  if (room) {
    evHp(room.ev, h.slot, h.hp);
    room.evCount += 1;
  }
};

/** Gives an item to the party (or the hero) and announces it. */
export const giveItem = (w: World, h: HeroRec, item: number, n: number): void => {
  const p = w.party;
  switch (item) {
    case Item.Sword:
      p.sword = true;
      sendItems(w);
      break;
    case Item.Buckler:
      p.buckler = true;
      sendItems(w);
      break;
    case Item.Hook:
      p.hook = true;
      sendItems(w);
      break;
    case Item.Map:
      p.map = true;
      sendItems(w);
      break;
    case Item.Compass:
      p.compass = true;
      sendItems(w);
      break;
    case Item.BossKey:
      p.bossKey = true;
      sendItems(w);
      break;
    case Item.Key:
      p.keys = Math.min(9, p.keys + 1);
      evParty(pev(w), PF.keys, p.keys);
      break;
    case Item.Shard: {
      const before = partyMaxHp(p);
      p.shards = Math.min(PARTY_RULES.maxShards, p.shards + 1);
      evParty(pev(w), PF.shards, p.shards);
      const after = partyMaxHp(p);
      if (after !== before) {
        evParty(pev(w), PF.maxHp, after);
        for (let i = 0; i < 4; i += 1) {
          const o = w.heroes[i] as HeroRec;
          if (o.present && o.status === Status.Active) setHp(w, o, o.hp + (after - before));
        }
      }
      break;
    }
    case Item.Vessel:
      p.vessels = 1;
      evParty(pev(w), PF.vessels, p.vessels);
      evParty(pev(w), PF.maxHp, partyMaxHp(p));
      setHp(w, h, partyMaxHp(p));
      break;
    case Item.Brew:
      h.brew = true;
      break;
    case Item.Glints:
      addGlints(w, n);
      break;
    default:
      return;
  }
  touchProgress(w);
  evGot(pev(w), h.slot, item);
};

/** Places a hero in a room (activating it) at a sub position; the old room may freeze. */
export const placeHero = (w: World, h: HeroRec, room: number, x: number, y: number, facing: number, transit: number, o: Outbox, entry: number): void => {
  h.room = room;
  h.x = x;
  h.y = y;
  h.entryX = x;
  h.entryY = y;
  h.facing = facing;
  h.act = transit > 0 ? Act.Transit : Act.Idle;
  h.actT = 0;
  h.transitT = transit;
  h.allow = 4096;
  activateRoom(w, room);
  o.rekey[h.slot] = 1 + entry;
};

/** The respawn point: the tile below the party's lantern. */
export const respawnAt = (w: World, h: HeroRec, o: Outbox, hp: number): void => {
  const l = content().lanterns[w.party.lantern] ?? content().lanterns[Lantern.village];
  if (!l) return;
  const below = l.tile + 12;
  h.status = Status.Active;
  h.hp = hp;
  h.iframes = HERO_RULES.iframes;
  h.downedT = 0;
  h.reviveT = 0;
  placeHero(w, h, l.room, tileCenterX(below), tileCenterY(below), 0, 0, o, 2);
};

/** A hero joins: at the start in a new tale, at the lantern in a saved one, beside the longest-present hero if any. */
export const heroJoin = (w: World, slot: number, tunic: number, joinOrder: number, o: Outbox, fresh: boolean): void => {
  const h = w.heroes[slot] as HeroRec;
  h.present = true;
  h.tunic = tunic & 3;
  h.joinOrder = joinOrder;
  h.status = Status.Active;
  h.iframes = HERO_RULES.iframes;
  h.downedT = 0;
  h.reviveT = 0;
  h.idleT = 0;
  h.lastSwing = -1;
  h.hp = partyMaxHp(w.party);
  let anchor: HeroRec | null = null;
  for (let i = 0; i < 4; i += 1) {
    const a = w.heroes[i] as HeroRec;
    if (i === slot || !a.present || a.status === Status.Resting) continue;
    if (!anchor || a.joinOrder < anchor.joinOrder) anchor = a;
  }
  if (anchor) {
    placeHero(w, h, anchor.room, anchor.x, anchor.y, anchor.facing, 0, o, 3);
    return;
  }
  if (fresh) {
    const c = content();
    placeHero(w, h, c.startRoom, tileCenterX(c.startTile), tileCenterY(c.startTile), 1, 0, o, 3);
    return;
  }
  respawnAt(w, h, o, h.hp);
  o.rekey[slot] = 1 + 3;
};

/** A hero leaves the session. */
export const heroLeave = (w: World, slot: number): void => {
  const h = w.heroes[slot] as HeroRec;
  h.present = false;
  h.status = Status.Resting;
};

// ------------------------------------------------------------------ hits

/** Applies one validated hit claim target. Returns true if it did something. */
export const applyHitTarget = (w: World, h: HeroRec, room: Room, attack: number, target: number, fromX: number, fromY: number): boolean => {
  const max = partyMaxHp(w.party);
  if (target >= 128) {
    const tile = target - 128;
    if (tile >= 108) return false;
    const code = room.tiles[tile] as number;
    if (code === T.CRYSTAL) return toggleCrystal(w, room, tile);
    if (attack === Attack.Hook) return false;
    return cutTile(w, room, tile, max);
  }
  const e = enemyById(room, target);
  if (e) {
    const dmg = attack === Attack.Spin ? HERO_RULES.spinDamage : HERO_RULES.slashDamage;
    return hitEnemy(w, room, e, attack, dmg, h.slot, fromX, fromY, max) !== 0;
  }
  if (attack === Attack.Hook) {
    for (let i = 0; i < CAP.pickups; i += 1) {
      const k = room.pk[i]!;
      if (k.on !== 0 && k.id === target) {
        collect(w, h, room, i);
        return true;
      }
    }
  }
  return false;
};

// ------------------------------------------------------------------ damage

/** Damage the hero's client reported (already validated online). */
export const applyDamage = (w: World, h: HeroRec, source: number, amount: number): void => {
  if (h.status !== Status.Active) return;
  const room = w.rooms[h.room];
  if (room && source < 128) {
    // A projectile that hit is gone; a wisp that touched retreats.
    for (let i = 0; i < CAP.projectiles; i += 1) if (room.pr[i]!.on !== 0 && room.pr[i]!.id === source) despawnProjectile(room, i, DESPAWN.blocked);
    const e = enemyById(room, source);
    if (e && e.kind === Kind.Wisp) {
      e.ai = 1;
      e.aiT = 40;
    }
  }
  if (amount <= 0) {
    h.allow += HERO_RULES.repelSpeed * HERO_RULES.repelTicks;
    return;
  }
  h.allow += HERO_RULES.hurtSpeed * HERO_RULES.hurtTicks;
  h.iframes = HERO_RULES.iframes;
  h.hp = Math.max(0, h.hp - amount);
  if (room) {
    evHp(room.ev, h.slot, h.hp);
    room.evCount += 1;
  }
  if (h.hp <= 0) downHero(w, h);
};

export const downHero = (w: World, h: HeroRec): void => {
  h.status = Status.Downed;
  h.act = Act.Downed;
  h.downedT = 0;
  h.reviveT = 0;
  h.downs += 1;
  const room = w.rooms[h.room];
  if (room) {
    evDowned(room.ev, h.slot);
    room.evCount += 1;
  }
};

/** A pebble the Buckler stopped bounces back at enemies; notes and repel shots just stop. */
export const applyBlocked = (w: World, h: HeroRec, projId: number): void => {
  const room = w.rooms[h.room];
  if (!room) return;
  for (let i = 0; i < CAP.projectiles; i += 1) {
    const p = room.pr[i]!;
    if (p.on === 0 || p.id !== projId) continue;
    despawnProjectile(room, i, DESPAWN.blocked);
    if (p.kind === 0 && w.party.buckler) {
      const back = p.dir === 0 ? 1 : p.dir === 1 ? 0 : p.dir === 2 ? 3 : p.dir === 3 ? 2 : p.dir;
      spawnProjectile(room, 3, h.x + ((back === 2 ? -1 : back === 3 ? 1 : 0) * 200), h.y - 64 + ((back === 1 ? -1 : back === 0 ? 1 : 0) * 200), back, h.slot);
    }
    return;
  }
};

// ------------------------------------------------------------------ interact, push, buy

/** Is the hero next to `tile` (within reach of its feet box)? */
const near = (h: HeroRec, tile: number, reach: number): boolean => {
  const tx = tileCenterX(tile);
  const ty = tileCenterY(tile);
  return Math.abs(h.x - tx) <= 128 + HERO_RULES.feetHW + reach && Math.abs(h.y - ty) <= 128 + HERO_RULES.feetHH + reach;
};

export const applyInteract = (w: World, h: HeroRec, tile: number, o: Outbox): void => {
  const room = w.rooms[h.room];
  if (!room || h.status !== Status.Active || !near(h, tile, HERO_RULES.interactReach + 32)) {
    refuse(o, h.slot, EVT.Interact, tile, REFUSE.far);
    return;
  }
  const def = room.def;
  const code = room.tiles[tile] as number;
  if (code === T.CHEST) {
    for (const c of def.chests) {
      if (c.tile !== tile) continue;
      setTile(room, tile, T.CHEST_OPEN);
      setFlag(w, c.flag);
      giveItem(w, h, c.item, c.n);
      return;
    }
    return;
  }
  if (code === T.LOCK || code === T.BOSSDOOR) {
    for (const l of def.locks) {
      if (l.tile !== tile) continue;
      if (l.boss ? !w.party.bossKey : w.party.keys <= 0) {
        refuse(o, h.slot, EVT.Interact, tile, REFUSE.locked);
        return;
      }
      if (!l.boss) {
        w.party.keys -= 1;
        evParty(pev(w), PF.keys, w.party.keys);
      }
      setFlag(w, l.flag);
      for (const m of def.locks) if (m.flag === l.flag) setTile(room, m.tile, m.boss ? T.BOSSDOOR_OPEN : T.LOCK_OPEN);
      return;
    }
    return;
  }
  if (code === T.LANTERN || code === T.LANTERN_LIT) {
    const l = def.lantern;
    if (!l || l.tile !== tile) return;
    setFlag(w, lanternFlag(l.id));
    setTile(room, tile, T.LANTERN_LIT);
    w.party.lantern = l.id;
    evParty(pev(w), PF.lantern, l.id);
    evSaved(pev(w), l.id);
    w.saveNow = true;
    return;
  }
  if (code === T.NPC) {
    for (const n of def.npcs) {
      if (n.tile !== tile || n.gift === Item.None || hasFlag(w.party, n.flag)) continue;
      setFlag(w, n.flag);
      giveItem(w, h, n.gift, n.n);
    }
  }
};

export const applyPush = (w: World, h: HeroRec, tile: number, dir: number, o: Outbox): void => {
  const room = w.rooms[h.room];
  if (!room || h.status !== Status.Active || !near(h, tile, 64) || !pushBlock(room, tile, dir)) refuse(o, h.slot, EVT.Push, tile, REFUSE.far);
};

export const applyBuy = (w: World, h: HeroRec, item: number, o: Outbox): void => {
  const room = w.rooms[h.room];
  const p = w.party;
  if (!room || h.status !== Status.Active) return;
  let price = -1;
  let flag = -1;
  for (const s of room.def.shop) {
    if (s.item === item) {
      price = s.price;
      flag = s.flag;
    }
  }
  if (price < 0) return refuse(o, h.slot, EVT.Buy, item, REFUSE.far);
  if ((item === Item.Buckler && p.buckler) || (flag >= 0 && hasFlag(p, flag))) return refuse(o, h.slot, EVT.Buy, item, REFUSE.soldOut);
  if (item === Item.Brew && h.brew) return refuse(o, h.slot, EVT.Buy, item, REFUSE.haveBrew);
  if (p.purse < price) return refuse(o, h.slot, EVT.Buy, item, REFUSE.glints);
  p.purse -= price;
  evParty(pev(w), PF.purse, p.purse);
  if (flag >= 0) setFlag(w, flag);
  giveItem(w, h, item, 1);
};

export const applyBrew = (w: World, h: HeroRec): void => {
  if (!h.brew || h.status !== Status.Active) return;
  h.brew = false;
  setHp(w, h, partyMaxHp(w.party));
  touchProgress(w);
};

export const applyRespawn = (w: World, h: HeroRec, o: Outbox): void => {
  if (h.status !== Status.Downed) return;
  // Resting at the lantern while nobody else stands is a wipe: the fight resets (bellwick.md §1.8).
  let standing = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = w.heroes[i] as HeroRec;
    if (a.present && a.status === Status.Active) standing += 1;
  }
  if (standing === 0) w.wipeT = 89;
  else respawnAt(w, h, o, respawnHp(partyMaxHp(w.party)));
};

/** "Go to ally": only at a lit lantern; warps next to the ally. */
export const applyGoToAlly = (w: World, h: HeroRec, slot: number, o: Outbox): void => {
  const a = w.heroes[slot & 3] as HeroRec;
  const room = w.rooms[h.room];
  if (!room || !a.present || a === h || a.status !== Status.Active || h.status !== Status.Active) return;
  const l = room.def.lantern;
  if (!l || room.tiles[l.tile] !== T.LANTERN_LIT || !near(h, l.tile, 128)) return refuse(o, h.slot, EVT.GoToAlly, slot, REFUSE.far);
  placeHero(w, h, a.room, a.x, a.y, a.facing, HERO_RULES.transitWarp, o, 1);
};

// ------------------------------------------------------------------ room changes

/** Where an exit leads: [room, x, y, facing, transit], or null if it is closed. */
export const exitTarget = (w: World, from: number, tiles: Uint8Array, edge: number, pos: number, out: Int32Array): boolean => {
  const def = screen(from);
  if (edge === 4) {
    if (((TILE_FLAGS[tiles[pos] as number] ?? 0) & F.WARP) === 0) return false;
    for (const wp of def.warps) {
      if (wp.tile !== pos) continue;
      out[0] = wp.to;
      out[1] = tileCenterX(wp.tile2);
      out[2] = tileCenterY(wp.tile2);
      out[3] = 1;
      out[4] = HERO_RULES.transitWarp;
      return true;
    }
    return false;
  }
  const edgeTile = edge === 0 ? 96 + pos : edge === 1 ? pos : edge === 2 ? pos * 12 : pos * 12 + 11;
  if (!edgeOpen(tiles[edgeTile] as number) || ((TILE_FLAGS[tiles[edgeTile] as number] ?? 0) & F.SOLID) !== 0) return false;
  const ex = def.exits[edge];
  if (ex) {
    out[0] = ex.to;
    out[1] = tileCenterX(ex.tile2);
    out[2] = tileCenterY(ex.tile2);
    out[3] = 0;
    out[4] = HERO_RULES.transitWarp;
    return true;
  }
  const to = def.near[edge] as number;
  if (to < 0) return false;
  const toRoom = w.rooms[to];
  const otherTile = edge === 0 ? pos : edge === 1 ? 96 + pos : edge === 2 ? pos * 12 + 11 : pos * 12;
  const otherCode = toRoom ? (toRoom.tiles[otherTile] as number) : flaggedTile(screen(to), otherTile, (id) => hasFlag(w.party, id));
  if (!edgeOpen(otherCode) || ((TILE_FLAGS[otherCode] ?? 0) & F.SOLID) !== 0) return false;
  out[0] = to;
  out[3] = edge === 0 ? 0 : edge === 1 ? 1 : edge === 2 ? 2 : 3;
  out[4] = edge >= 2 ? HERO_RULES.transitH : HERO_RULES.transitV;
  return true;
};

const target = new Int32Array(5);

/** Moves a hero through an exit; the new room is activated and the hero rekeyed. */
export const applyEnter = (w: World, h: HeroRec, edge: number, pos: number, o: Outbox): boolean => {
  const room = w.rooms[h.room];
  if (!room || h.status !== Status.Active || !exitTarget(w, h.room, room.tiles, edge, pos, target)) {
    refuse(o, h.slot, EVT.EnterRoom, edge, REFUSE.exit);
    evCorrect(o.self[h.slot] as ByteWriter, h.room, h.x, h.y, CORRECT.wall);
    o.selfCount[h.slot] = (o.selfCount[h.slot] as number) + 1;
    return false;
  }
  const slack = 8 * 16 + HERO_RULES.feetHW;
  if (edge === 4) {
    if ((h.y >> 8) * 12 + (h.x >> 8) !== pos && Math.abs(h.x - tileCenterX(pos)) > 256 + slack) {
      refuse(o, h.slot, EVT.EnterRoom, edge, REFUSE.far);
      evCorrect(o.self[h.slot] as ByteWriter, h.room, h.x, h.y, CORRECT.wall);
      o.selfCount[h.slot] = (o.selfCount[h.slot] as number) + 1;
      return false;
    }
  } else {
    const d = edge === 0 ? 2304 - h.y : edge === 1 ? h.y : edge === 2 ? h.x : 3072 - h.x;
    if (d > slack + 64) {
      refuse(o, h.slot, EVT.EnterRoom, edge, REFUSE.far);
      evCorrect(o.self[h.slot] as ByteWriter, h.room, h.x, h.y, CORRECT.wall);
      o.selfCount[h.slot] = (o.selfCount[h.slot] as number) + 1;
      return false;
    }
  }
  let x = target[1] as number;
  let y = target[2] as number;
  if (edge < 4 && !screen(h.room).exits[edge]) {
    // Slide: the same position along the edge, inside the facing edge tile.
    x = edge === 2 ? 2944 : edge === 3 ? 128 : h.x;
    y = edge === 1 ? 2176 : edge === 0 ? 128 : h.y;
  }
  placeHero(w, h, target[0] as number, x, y, target[3] as number, target[4] as number, o, edge === 4 || screen(h.room).exits[edge] ? 1 : 0);
  return true;
};

// ------------------------------------------------------------------ pickups and the step

const collect = (w: World, h: HeroRec, room: Room, i: number): void => {
  const k = room.pk[i]!;
  k.on = 0;
  evDespawn(room.ev, k.id, DESPAWN.collected);
  room.evCount += 1;
  switch (k.kind) {
    case Pick.Chip:
      addGlints(w, GLINTS.chip);
      break;
    case Pick.Spark:
      addGlints(w, GLINTS.spark);
      break;
    case Pick.Star:
      addGlints(w, GLINTS.star);
      break;
    case Pick.Heart:
      setHp(w, h, h.hp + 2);
      break;
    case Pick.Vessel:
      giveItem(w, h, Item.Vessel, 1);
      break;
    default:
  }
};

const ticks = (h: HeroRec): boolean => h.present && (h.status === Status.Downed || (h.status === Status.Active && h.transitT === 0));

const rosterRows: RosterRow[] = [0, 1, 2, 3].map(() => ({ slot: 0, status: 0, tunic: 0, host: false, lag: false, room: 0, tx: 0, ty: 0, hp: 0, joinOrder: 0 }));

/** The roster event (1 Hz): every hero in the session, for map pins. `hostSlot` marks the host. */
export const writeRoster = (w: World, hostSlot: number, lag: readonly boolean[]): void => {
  let n = 0;
  for (let i = 0; i < 4; i += 1) {
    const h = w.heroes[i] as HeroRec;
    if (!h.present) continue;
    const r = rosterRows[n] as RosterRow;
    r.slot = i;
    r.status = h.transitT > 0 && h.status === Status.Active ? Status.Transit : h.status;
    r.tunic = h.tunic;
    r.host = i === hostSlot;
    r.lag = lag[i] === true;
    r.room = h.room;
    r.tx = Math.min(11, Math.max(0, h.x >> 8));
    r.ty = Math.min(8, Math.max(0, h.y >> 8));
    r.hp = h.hp;
    r.joinOrder = h.joinOrder;
    n += 1;
  }
  evRoster(pev(w), rosterRows, n);
};

/** One authority tick after the queued UPs and EVTs were applied. */
export const stepWorld = (w: World, o: Outbox): void => {
  w.tick += 1;
  let anyActive = false;
  for (let i = 0; i < 4; i += 1) {
    const h = w.heroes[i] as HeroRec;
    if (!h.present) continue;
    if (h.transitT > 0) h.transitT -= 1;
    if (h.iframes > 0) h.iframes -= 1;
    if (h.status === Status.Active) anyActive = true;
  }
  if (anyActive) w.party.playTicks += 1;
  const max = partyMaxHp(w.party);
  // Rooms that hold an active or downed hero tick; the rest freeze, and are freed after 5 s.
  for (let id = 0; id < w.rooms.length; id += 1) {
    const room = w.rooms[id];
    if (!room) continue;
    let ticking = false;
    let held = false;
    for (let i = 0; i < 4; i += 1) {
      const h = w.heroes[i] as HeroRec;
      if (!h.present || h.room !== id || h.status === Status.Resting) continue;
      held = true;
      if (ticks(h)) ticking = true;
    }
    if (ticking) {
      room.emptySince = -1;
      stepRoom(w, room, max);
      // Pickups touched by active heroes.
      for (let i = 0; i < 4; i += 1) {
        const h = w.heroes[i] as HeroRec;
        if (!h.present || h.room !== id || h.status !== Status.Active || h.transitT > 0) continue;
        for (let k = 0; k < CAP.pickups; k += 1) {
          const p = room.pk[k]!;
          if (p.on === 0) continue;
          if (Math.abs(p.x - h.x) < ENEMY_RULES.pickupHalf + HERO_RULES.feetHW && Math.abs(p.y - (h.y - 32)) < ENEMY_RULES.pickupHalf + HERO_RULES.feetHH + 32) collect(w, h, room, k);
        }
      }
    } else if (!held) {
      if (room.emptySince < 0) room.emptySince = w.tick;
      else if (w.tick - room.emptySince >= PARTY_RULES.freezeTicks) freeRoom(w, id);
    }
  }
  // Revival and downed timers.
  let standing = 0;
  let downed = 0;
  for (let i = 0; i < 4; i += 1) {
    const h = w.heroes[i] as HeroRec;
    if (!h.present || h.status === Status.Resting) continue;
    if (h.status !== Status.Downed) {
      standing += 1;
      continue;
    }
    downed += 1;
    h.downedT += 1;
    let reviver: HeroRec | null = null;
    for (let j = 0; j < 4; j += 1) {
      const a = w.heroes[j] as HeroRec;
      if (j === i || !a.present || a.status !== Status.Active || a.transitT > 0 || a.room !== h.room) continue;
      const dx = a.x - h.x;
      const dy = a.y - h.y;
      if (dx * dx + dy * dy <= HERO_RULES.reviveRange * HERO_RULES.reviveRange) reviver = a;
    }
    h.reviveT = reviver ? h.reviveT + 1 : 0;
    if (reviver && h.reviveT >= HERO_RULES.reviveTicks) {
      h.status = Status.Active;
      h.act = Act.Idle;
      h.hp = HERO_RULES.reviveHp;
      h.iframes = HERO_RULES.iframes;
      h.reviveT = 0;
      h.downedT = 0;
      reviver.revives += 1;
      const room = w.rooms[h.room];
      if (room) {
        evRevived(room.ev, h.slot, reviver.slot);
        room.evCount += 1;
      }
    } else if (h.downedT >= HERO_RULES.downedTicks) respawnAt(w, h, o, respawnHp(max));
  }
  // Wipe: everyone not resting is down → after 3 s all respawn; active rooms reset, cleared rooms stay cleared.
  if (downed > 0 && standing === 0) {
    w.wipeT = w.wipeT < 0 ? 0 : w.wipeT + 1;
    if (w.wipeT >= 90) {
      w.wipeT = -1;
      for (let id = 0; id < w.rooms.length; id += 1) if (w.rooms[id]) resetRoom(w, id);
      for (let i = 0; i < 4; i += 1) {
        const h = w.heroes[i] as HeroRec;
        if (h.present && h.status === Status.Downed) respawnAt(w, h, o, respawnHp(max));
      }
    }
  } else w.wipeT = -1;
  if (hasFlag(w.party, BOSS_DOWN) && !w.victory) {
    w.victory = true;
    evVictory(pev(w), Math.floor(w.party.playTicks / 30));
    w.saveNow = true;
  }
};

// ------------------------------------------------------------------ saves

/** SaveV1 of the world; heroes are keyed `slot:<n>` (the runtime maps slots to accounts or 'solo'). */
export const toSave = (w: World, extra: Record<string, SaveHero>): SaveV1 => {
  const p = w.party;
  const heroes: Record<string, SaveHero> = { ...extra };
  for (let i = 0; i < 4; i += 1) {
    const h = w.heroes[i] as HeroRec;
    if (!h.present && h.downs === 0 && h.foes === 0) continue;
    heroes['slot:' + i] = { tunic: h.tunic, brew: h.brew, downs: h.downs, defeats: h.foes };
  }
  return {
    v: 1,
    seed: w.seed,
    flags: toBase64(p.flags),
    playSec: Math.floor(p.playTicks / 30),
    purse: p.purse,
    keys: p.keys,
    bossKey: p.bossKey,
    map: p.map,
    compass: p.compass,
    sword: p.sword,
    buckler: p.buckler,
    hook: p.hook,
    shards: p.shards,
    vessels: p.vessels,
    lantern: p.lantern,
    heroes,
  };
};

/** Loads a validated save into a fresh world's party. */
export const loadSave = (w: World, s: SaveV1, flags: Uint8Array): void => {
  const p = w.party;
  p.flags.set(flags.subarray(0, 32));
  p.purse = s.purse;
  p.keys = s.keys;
  p.bossKey = s.bossKey;
  p.map = s.map;
  p.compass = s.compass;
  p.sword = s.sword;
  p.buckler = s.buckler;
  p.hook = s.hook;
  p.shards = s.shards;
  p.vessels = s.vessels;
  p.lantern = s.lantern;
  p.playTicks = s.playSec * 30;
  w.victory = hasFlag(p, BOSS_DOWN);
};

