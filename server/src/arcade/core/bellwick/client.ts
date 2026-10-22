/**
 * The client's side of Bellwick (bellwick.md §3.5, §4): a mirror of the hero's room and the party, built
 * from KEYFRAMEs, FRAME snapshots and events, plus the own hero, stepped locally with `stepHero` and
 * reported as UPs and EVTs. Pure and shared: the browser module draws from it, the walkthrough bot and
 * the bench's Node heroes drive it, and the tests run it against the runtime.
 */
import { ByteReader, ByteWriter } from '../bytes.js';
import { forEachEvent, type PlatformEvent } from '../net/events.js';
import type { EventBlock } from '../net/lane.js';
import {
  CORRECT,
  ENTRY,
  EV,
  newEvView,
  newHeroView,
  readEv,
  readHeroView,
  readTiles,
  readWelcomeCfg,
  writeBlocked,
  writeDamageTaken,
  writeEnterRoom,
  writeHitClaim,
  writeInteract,
  writePush,
  writeUp,
  type EvView,
  type HeroView,
  type WelcomeCfg,
} from './codec.js';
import { flaggedTile, screen } from './content/parse.js';
import { CUT_TO, edgeOpen, ENEMY_RULES, F, HERO_RULES, maxHp, TILE_FLAGS } from './rules.js';
import { tileCenterX, tileCenterY } from './sim/collide.js';
import { newHeroEnv, newHeroOut, newHeroState, stepHero, type Hero, type HeroEnv, type HeroOut } from './sim/hero.js';
import { projX, projY, pxSub } from './sim/room.js';
import { Act, Attack, Item, Kind, Status } from './types.js';

export interface CEnt {
  on: boolean;
  id: number;
  kind: number;
  /** Pixels: current and previous snapshot (for interpolation) and the tick of each. */
  x: number;
  y: number;
  px: number;
  py: number;
  pose: number;
  facing: number;
  hurt: boolean;
  stunned: boolean;
  hp: number;
  /** Predicted kill: hidden since this tick (−1 not hidden). */
  hiddenAt: number;
}

export interface CPick { on: boolean; id: number; kind: number; x: number; y: number; ttl: number }
export interface CProj { on: boolean; id: number; kind: number; dir: number; x0: number; y0: number; t0: number }
export interface CShock { on: boolean; x: number; y: number; t0: number }
export interface COther extends HeroView { on: boolean; px: number; py: number }

/** What the module hears about (sound, particles, banners, dialogue). */
export interface ClientHooks {
  /** A decoded event, after it was applied. */
  event?(e: EvView, tick: number): void;
  /** A platform event (seat changes, notices). */
  platform?(e: PlatformEvent): void;
  /** The own hero did something local (CUE bits) or asked to interact with a tile. */
  cue?(cues: number): void;
  interact?(tile: number): void;
  /** A predicted room change started (old room id, new room id, edge or 4). */
  roomChange?(from: number, to: number, edge: number): void;
  /** A keyframe replaced the room. */
  keyframe?(entry: number): void;
}

export interface ClientWorld {
  slot: number;
  me: Hero;
  welcome: WelcomeCfg | null;
  /** Latest server tick seen. */
  tick: number;
  /** Party. */
  flags: Uint8Array;
  purse: number;
  keys: number;
  items: number;
  shards: number;
  vessels: number;
  lantern: number;
  maxHp: number;
  cleared: number;
  /** The room on screen. */
  room: number;
  hasRoom: boolean;
  awaitingKey: boolean;
  tiles: Uint8Array;
  /** Tiles cut on a claim before the server confirmed it: the code to put back if it refuses (-1: none). */
  cutPred: Int16Array;
  edges: Int32Array;
  roomCleared: boolean;
  ents: CEnt[];
  picks: CPick[];
  projs: CProj[];
  shocks: CShock[];
  others: COther[];
  boss: { phase: number; laps: number; timer: number; clapperT: number; present: boolean };
  roster: EvView;
  /** Tick of the snapshot the entity positions come from, and of the one before. */
  snapTick: number;
  prevSnapTick: number;
  victory: boolean;
  hooks: ClientHooks;
  // Local stepping.
  env: HeroEnv;
  out: HeroOut;
  lastUpTick: number;
  lastUpHash: number;
  /** Swing whose claims were sent, for de-duplication. */
  evtW: ByteWriter;
  upW: ByteWriter;
}

const ENTS = 16;

export const createClientWorld = (slot: number, hooks: ClientHooks = {}): ClientWorld => {
  const ents: CEnt[] = [];
  for (let i = 0; i < ENTS; i += 1) ents.push({ on: false, id: 0, kind: 0, x: 0, y: 0, px: 0, py: 0, pose: 0, facing: 0, hurt: false, stunned: false, hp: 0, hiddenAt: -1 });
  const picks: CPick[] = [];
  for (let i = 0; i < 12; i += 1) picks.push({ on: false, id: 0, kind: 0, x: 0, y: 0, ttl: 0 });
  const projs: CProj[] = [];
  for (let i = 0; i < 12; i += 1) projs.push({ on: false, id: 0, kind: 0, dir: 0, x0: 0, y0: 0, t0: 0 });
  const others: COther[] = [];
  for (let i = 0; i < 3; i += 1) others.push({ ...newHeroView(), on: false, px: 0, py: 0 });
  return {
    slot,
    me: newHeroState(slot),
    welcome: null,
    tick: 0,
    flags: new Uint8Array(32),
    purse: 0,
    keys: 0,
    items: 0,
    shards: 0,
    vessels: 0,
    lantern: 0,
    maxHp: 6,
    cleared: 0,
    room: -1,
    hasRoom: false,
    awaitingKey: true,
    tiles: new Uint8Array(108),
    cutPred: new Int16Array(108).fill(-1),
    edges: new Int32Array(4),
    roomCleared: false,
    ents,
    picks,
    projs,
    shocks: [
      { on: false, x: 0, y: 0, t0: 0 },
      { on: false, x: 0, y: 0, t0: 0 },
    ],
    others,
    boss: { phase: 0, laps: 0, timer: 0, clapperT: 0, present: false },
    roster: newEvView(),
    snapTick: 0,
    prevSnapTick: 0,
    victory: false,
    hooks,
    env: newHeroEnv(),
    out: newHeroOut(),
    lastUpTick: -100,
    lastUpHash: -1,
    evtW: new ByteWriter(32),
    upW: new ByteWriter(16),
  };
};

export const hasFlagC = (c: ClientWorld, id: number): boolean => id >= 0 && ((c.flags[id >> 3] as number) & (1 << (id & 7))) !== 0;

/** Extends a u16 wire tick to the full tick near `ref`. */
export const extendTick = (t16: number, ref: number): number => {
  const d = ((ref - t16) & 0xffff) - (((ref - t16) & 0xffff) >= 0x8000 ? 0x10000 : 0);
  return ref - d;
};

/** Which screen edge positions lead somewhere from this room (client view; the server decides). */
export const computeEdges = (room: number, tiles: Uint8Array, out: Int32Array, flags: Uint8Array): void => {
  const def = screen(room);
  const flagOn = (id: number): boolean => id >= 0 && ((flags[id >> 3] as number) & (1 << (id & 7))) !== 0;
  for (let e = 0; e < 4; e += 1) {
    let mask = 0;
    const n = e < 2 ? 12 : 9;
    const to = def.near[e] as number;
    const override = def.exits[e] !== null;
    for (let k = 0; k < n; k += 1) {
      const t = e === 0 ? 96 + k : e === 1 ? k : e === 2 ? k * 12 : k * 12 + 11;
      const code = tiles[t] as number;
      if (!edgeOpen(code) || ((TILE_FLAGS[code] ?? 0) & F.SOLID) !== 0) continue;
      if (override) {
        mask |= 1 << k;
        continue;
      }
      if (to < 0) continue;
      const o = e === 0 ? k : e === 1 ? 96 + k : e === 2 ? k * 12 + 11 : k * 12;
      const oc = flaggedTile(screen(to), o, flagOn);
      if (edgeOpen(oc) && ((TILE_FLAGS[oc] ?? 0) & F.SOLID) === 0) mask |= 1 << k;
    }
    out[e] = mask;
  }
};

const findEnt = (c: ClientWorld, id: number): CEnt | null => {
  for (let i = 0; i < ENTS; i += 1) {
    const e = c.ents[i] as CEnt;
    if (e.on && e.id === id) return e;
  }
  return null;
};

const freeEnt = (c: ClientWorld): CEnt | null => {
  for (let i = 0; i < ENTS; i += 1) if (!(c.ents[i] as CEnt).on) return c.ents[i] as CEnt;
  return null;
};

const setEnt = (e: CEnt, id: number, kind: number, x: number, y: number, state: number, hp: number): void => {
  e.on = true;
  e.id = id;
  e.kind = kind;
  e.x = e.px = x;
  e.y = e.py = y;
  e.pose = state & 15;
  e.facing = (state >> 4) & 3;
  e.hurt = (state & 64) !== 0;
  e.stunned = (state & 128) !== 0;
  e.hp = hp;
  e.hiddenAt = -1;
};

const addPick = (c: ClientWorld, id: number, kind: number, x: number, y: number, ttl: number): void => {
  for (let i = 0; i < c.picks.length; i += 1) {
    const p = c.picks[i] as CPick;
    if (p.on) continue;
    p.on = true;
    p.id = id;
    p.kind = kind;
    p.x = x;
    p.y = y;
    p.ttl = ttl;
    return;
  }
};

const addProj = (c: ClientWorld, id: number, kind: number, dir: number, x: number, y: number, t0: number): void => {
  for (let i = 0; i < c.projs.length; i += 1) {
    const p = c.projs[i] as CProj;
    if (p.on) continue;
    p.on = true;
    p.id = id;
    p.kind = kind;
    p.dir = dir;
    p.x0 = pxSub(x);
    p.y0 = pxSub(y);
    p.t0 = t0;
    return;
  }
};

const clearRoom = (c: ClientWorld): void => {
  for (const e of c.ents) e.on = false;
  for (const p of c.picks) p.on = false;
  for (const p of c.projs) p.on = false;
  for (const s of c.shocks) s.on = false;
  for (const o of c.others) o.on = false;
  c.boss.present = false;
};

const syncMaxHp = (c: ClientWorld): void => {
  c.maxHp = maxHp(c.vessels, c.shards);
  c.me.maxHp = c.maxHp;
};

export const onWelcome = (c: ClientWorld, cfg: Uint8Array): void => {
  c.welcome = readWelcomeCfg(cfg);
  if (c.welcome) for (const s of c.welcome.seats) if (s.slot === c.slot) c.me.tunic = s.tunic;
};

/** Applies a KEYFRAME body (bellwick.md §4.5). Returns false if it was malformed. */
export const onKeyframe = (c: ClientWorld, r: ByteReader, tick: number): boolean => {
  const room = r.u8();
  const entry = r.u8();
  const hx = r.u16();
  const hy = r.u16();
  const hp = r.u8();
  const st = r.u8();
  if (!r.ok) return false;
  c.tick = Math.max(c.tick, tick);
  const me = c.me;
  const predicted = c.awaitingKey && me.room === room && (entry === ENTRY.edge || entry === ENTRY.warp) && Math.abs(me.x - hx) <= 32 && Math.abs(me.y - hy) <= 32;
  me.room = room;
  me.hp = hp;
  me.status = st & 3;
  me.brew = (st & 16) !== 0;
  if (!predicted) {
    me.x = hx;
    me.y = hy;
    me.facing = (st >> 2) & 3;
    me.entryX = hx;
    me.entryY = hy;
    if (me.act === Act.Transit || entry >= ENTRY.respawn || me.status !== Status.Active) {
      me.act = me.status === Status.Downed ? Act.Downed : Act.Idle;
      me.actT = 0;
    }
    me.kbT = 0;
  }
  clearRoom(c);
  c.room = room;
  if (r.remaining < 81) {
    c.hasRoom = false;
    return r.ok;
  }
  readTiles(r, c.tiles);
  c.cutPred.fill(-1);
  r.u8();
  c.roomCleared = (r.u8() & 1) !== 0;
  const nh = r.u8();
  if (nh > 3) return false;
  const hv = newHeroView();
  for (let i = 0; i < nh; i += 1) {
    readHeroView(r, hv);
    const o = c.others[i] as COther;
    Object.assign(o, hv);
    o.on = true;
    o.px = o.x;
    o.py = o.y;
  }
  const ne = r.u8();
  if (ne > 16) return false;
  for (let i = 0; i < ne; i += 1) {
    const id = r.u8();
    const kind = r.u8();
    const x = r.u8();
    const y = r.u8();
    const state = r.u8();
    const ehp = r.u8();
    if (kind === Kind.Block) continue;
    const e = freeEnt(c);
    if (e) setEnt(e, id, kind, x, y, state, ehp);
    if (kind === Kind.Boss) c.boss.present = true;
  }
  const np = r.u8();
  for (let i = 0; i < np && i < 12; i += 1) {
    const id = r.u8();
    const kt = r.u8();
    const x = r.u8();
    const y = r.u8();
    addPick(c, id, kt & 15, x, y, (kt >> 4) === 0 ? -1 : (kt >> 4) * 20);
  }
  const npr = r.u8();
  for (let i = 0; i < npr && i < 12; i += 1) {
    const id = r.u8();
    const kd = r.u8();
    const x = r.u8();
    const y = r.u8();
    const t0 = extendTick(r.u16(), tick);
    addProj(c, id, kd & 15, kd >> 4, x, y, t0);
  }
  const nsh = r.u8();
  for (let i = 0; i < nsh && i < 2; i += 1) {
    const s = c.shocks[i] as CShock;
    s.on = true;
    s.x = pxSub(r.u8());
    s.y = pxSub(r.u8());
    s.t0 = extendTick(r.u16(), tick);
  }
  if (screen(room).boss >= 0) {
    c.boss.phase = r.u8();
    c.boss.laps = r.u8();
    c.boss.timer = r.u8();
    c.boss.clapperT = r.u8();
  }
  // Every keyframe carries the party block.
  for (let i = 0; i < 32; i += 1) c.flags[i] = r.u8();
  c.purse = r.u16();
  c.keys = r.u8();
  c.items = r.u8();
  c.shards = r.u8();
  c.vessels = r.u8();
  c.lantern = r.u8();
  r.u8();
  c.cleared = r.u16();
  syncMaxHp(c);
  c.victory = hasFlagC(c, 32);
  if (!r.ok) return false;
  c.hasRoom = true;
  c.awaitingKey = false;
  c.snapTick = c.prevSnapTick = tick;
  computeEdges(room, c.tiles, c.edges, c.flags);
  c.hooks.keyframe?.(entry);
  return true;
};

const ev = newEvView();
let evTickRef = 0;
let evClient: ClientWorld | null = null;

const applyEvent = (c: ClientWorld, e: EvView, tick: number): void => {
  const me = c.me;
  switch (e.kind) {
    case EV.Spawn: {
      const ent = findEnt(c, e.a) ?? freeEnt(c);
      if (ent) setEnt(ent, e.a, e.b, e.c, e.d, e.e, e.f);
      break;
    }
    case EV.Projectile:
      addProj(c, e.a, e.b, e.c, e.d, e.e, extendTick(e.f, tick));
      break;
    case EV.Despawn: {
      const ent = findEnt(c, e.a);
      if (ent) ent.on = false;
      for (const p of c.projs) if (p.on && p.id === e.a) p.on = false;
      for (const p of c.picks) if (p.on && p.id === e.a) p.on = false;
      break;
    }
    case EV.Damage: {
      if (e.a < 128) {
        const ent = findEnt(c, e.a);
        if (ent) {
          ent.hp = e.c;
          if (e.b > 0) ent.hurt = true;
        }
      }
      break;
    }
    case EV.Drop:
      addPick(c, e.a, e.b, e.d, e.e, e.c);
      break;
    case EV.Tile:
      if (e.a < 108) {
        c.cutPred[e.a] = -1;
        c.tiles[e.a] = e.b;
        computeEdges(c.room, c.tiles, c.edges, c.flags);
      }
      break;
    case EV.Correct:
      if (e.a === me.room && e.a === c.room && !c.awaitingKey) {
        me.x = e.b;
        me.y = e.c;
        if (e.d !== CORRECT.move) me.act = Act.Idle;
      }
      break;
    case EV.Hp:
      if (e.a === c.slot) me.hp = e.b;
      else for (const o of c.others) if (o.on && o.slot === e.a) o.hp = e.b;
      break;
    case EV.Downed:
      if (e.a === c.slot) {
        me.status = Status.Downed;
        me.act = Act.Downed;
        me.hp = 0;
      }
      break;
    case EV.Revived:
      if (e.a === c.slot) {
        me.status = Status.Active;
        me.act = Act.Idle;
        me.hp = HERO_RULES.reviveHp;
        me.iframes = HERO_RULES.iframes;
      }
      break;
    case EV.BossPhase:
      c.boss.phase = e.a;
      break;
    case EV.Shock: {
      const s = c.shocks[0]!.on ? c.shocks[1]! : c.shocks[0]!;
      s.on = true;
      s.x = pxSub(e.a);
      s.y = pxSub(e.b);
      s.t0 = extendTick(e.c, tick);
      break;
    }
    case EV.Refused:
      if (e.a === 0x01 && e.b >= 128 && e.b - 128 < 108 && (c.cutPred[e.b - 128] as number) >= 0) {
        // A cut the server did not accept: the bush grows back.
        c.tiles[e.b - 128] = c.cutPred[e.b - 128] as number;
        c.cutPred[e.b - 128] = -1;
        computeEdges(c.room, c.tiles, c.edges, c.flags);
      }
      if (e.a === 0x06 && c.awaitingKey) {
        // The exit was closed after all: back into the room on screen (a Correct follows with the spot).
        c.awaitingKey = false;
        me.room = c.room;
        me.act = Act.Idle;
        c.hooks.roomChange?.(c.room, c.room, -1);
      }
      break;
    case EV.Party:
      switch (e.a) {
        case 0:
          c.purse = e.b;
          break;
        case 1:
          c.keys = e.b;
          break;
        case 2:
          c.items = e.b;
          break;
        case 3:
          c.shards = e.b;
          syncMaxHp(c);
          break;
        case 4:
          c.vessels = e.b;
          syncMaxHp(c);
          break;
        case 5:
          c.lantern = e.b;
          break;
        case 6:
          c.maxHp = e.b;
          me.maxHp = e.b;
          break;
        case 7:
          c.cleared = e.b;
          break;
        default:
      }
      break;
    case EV.Flag:
      if (e.b) c.flags[e.a >> 3] = (c.flags[e.a >> 3] as number) | (1 << (e.a & 7));
      else c.flags[e.a >> 3] = (c.flags[e.a >> 3] as number) & ~(1 << (e.a & 7));
      if (c.hasRoom) computeEdges(c.room, c.tiles, c.edges, c.flags);
      break;
    case EV.Got:
      if (e.a === c.slot && e.b !== Item.Glints && me.status === Status.Active && me.act !== Act.Transit) {
        me.act = Act.Got;
        me.actT = 0;
      }
      if (e.a === c.slot && e.b === Item.Brew) me.brew = true;
      break;
    case EV.Roster: {
      const r = c.roster;
      r.n = e.n;
      for (let i = 0; i < e.n; i += 1) Object.assign(r.rows[i] as object, e.rows[i]);
      break;
    }
    case EV.Victory:
      c.victory = true;
      break;
    default:
  }
  c.hooks.event?.(e, tick);
};

const gameEvent = (kind: number, r: ByteReader, tick: number): boolean => {
  const c = evClient;
  if (!c || !readEv(kind, r, ev)) return false;
  applyEvent(c, ev, tick || evTickRef);
  return true;
};

const platformEvent = (e: PlatformEvent): void => {
  evClient?.hooks.platform?.(e);
};

const hv = newHeroView();

/** Applies a FRAME: the snapshot (positions) and the event block. Returns false on a decode error. */
export const onFrame = (c: ClientWorld, tick: number, snapshot: ByteReader | null, events: EventBlock | null): boolean => {
  c.tick = Math.max(c.tick, tick);
  if (snapshot && c.hasRoom) {
    const room = snapshot.u8();
    if (room === c.room && !c.awaitingKey) {
      const nh = snapshot.u8();
      for (const o of c.others) o.on = false;
      for (let i = 0; i < nh && i < 3; i += 1) {
        readHeroView(snapshot, hv);
        const o = c.others[i] as COther;
        const was = o.slot === hv.slot;
        o.px = was ? o.x : hv.x;
        o.py = was ? o.y : hv.y;
        Object.assign(o, hv);
        o.on = true;
      }
      const ne = snapshot.u8();
      for (let i = 0; i < ne; i += 1) {
        const id = snapshot.u8();
        const x = snapshot.u8();
        const y = snapshot.u8();
        const state = snapshot.u8();
        const hp = snapshot.u8();
        const e = findEnt(c, id);
        if (!e) continue;
        e.px = e.x;
        e.py = e.y;
        e.x = x;
        e.y = y;
        e.pose = state & 15;
        e.facing = (state >> 4) & 3;
        e.hurt = (state & 64) !== 0;
        e.stunned = (state & 128) !== 0;
        e.hp = hp;
      }
      c.prevSnapTick = c.snapTick;
      c.snapTick = tick;
      if (!snapshot.ok) return false;
    }
  }
  if (events) {
    evClient = c;
    evTickRef = events.tick;
    const ok = forEachEvent(events, gameEvent, platformEvent);
    evClient = null;
    if (!ok) return false;
  }
  // Projectiles past a wall or their lifetime end locally too; pickups count down.
  for (const p of c.projs) {
    if (!p.on) continue;
    const t = c.tick - p.t0;
    const x = projX(p.x0, p.dir, p.kind, t);
    const y = projY(p.y0, p.dir, p.kind, t);
    if (t > ENEMY_RULES.projTtl || x < 0 || y < 0 || x >= 3072 || y >= 2304 || ((TILE_FLAGS[c.tiles[(y >> 8) * 12 + (x >> 8)] as number] ?? 1) & F.SOLID) !== 0) p.on = false;
  }
  return true;
};

/** Fills the hero env from the mirror at `tick` (entity positions from the newest snapshot). */
export const fillEnv = (c: ClientWorld, tick: number, env: HeroEnv): void => {
  env.tick = tick;
  env.tiles = c.tiles;
  env.edges = c.edges;
  env.items = c.items;
  let n = 0;
  for (const e of c.ents) {
    if (!e.on || e.hiddenAt >= 0 || n >= env.entId.length) continue;
    env.entId[n] = e.id;
    env.entKind[n] = e.kind;
    env.entX[n] = pxSub(e.x);
    env.entY[n] = pxSub(e.y);
    env.entPose[n] = e.pose;
    env.entStunned[n] = e.stunned ? 1 : 0;
    n += 1;
  }
  env.nEnt = n;
  n = 0;
  for (const p of c.projs) {
    if (!p.on || n >= env.projId.length) continue;
    const t = tick - p.t0;
    if (t < 0) continue;
    env.projId[n] = p.id;
    env.projKind[n] = p.kind;
    env.projDir[n] = p.dir;
    env.projX[n] = projX(p.x0, p.dir, p.kind, t);
    env.projY[n] = projY(p.y0, p.dir, p.kind, t);
    n += 1;
  }
  env.nProj = n;
  n = 0;
  for (const p of c.picks) {
    if (!p.on || n >= env.pickId.length) continue;
    env.pickId[n] = p.id;
    env.pickX[n] = pxSub(p.x);
    env.pickY[n] = pxSub(p.y);
    n += 1;
  }
  env.nPick = n;
  n = 0;
  for (const s of c.shocks) {
    if (!s.on) continue;
    const r = (tick - s.t0) * 48;
    if (r < 0 || r > 1536) {
      if (r > 1536) s.on = false;
      continue;
    }
    env.shockX[n] = s.x;
    env.shockY[n] = s.y;
    env.shockR[n] = r;
    n += 1;
  }
  env.nShock = n;
};

/** Sends EVTs and UPs. */
export interface ClientSend {
  up(payload: Uint8Array): void;
  evt(payload: Uint8Array): void;
}

const target = new Int32Array(5);

/** The client's prediction of where an exit leads (the server checks it). */
const predictExit = (c: ClientWorld, edge: number, pos: number): boolean => {
  const def = screen(c.room);
  if (edge === 4) {
    for (const wp of def.warps) {
      if (wp.tile !== pos) continue;
      target[0] = wp.to;
      target[1] = tileCenterX(wp.tile2);
      target[2] = tileCenterY(wp.tile2);
      target[3] = 1;
      return true;
    }
    return false;
  }
  const ex = def.exits[edge];
  if (ex) {
    target[0] = ex.to;
    target[1] = tileCenterX(ex.tile2);
    target[2] = tileCenterY(ex.tile2);
    target[3] = 0;
    return true;
  }
  const to = def.near[edge] as number;
  if (to < 0) return false;
  target[0] = to;
  target[1] = edge === 2 ? 2944 : edge === 3 ? 128 : c.me.x;
  target[2] = edge === 1 ? 2176 : edge === 0 ? 128 : c.me.y;
  target[3] = edge;
  return true;
};

/** Is the party carrying the item bit? */
export const hasItem = (c: ClientWorld, bit: number): boolean => (c.items & bit) !== 0;

const tw = new ByteWriter(32);

/**
 * Steps the own hero once for `tick` (the server tick this state is for) with `buttons`, sends what it
 * did, and an UP when the state changed (every `upEvery` ticks at most). `seenTick` is the tick of the
 * entity positions the hero acted on (online: the interpolated render tick).
 */
export const stepOwn = (c: ClientWorld, buttons: number, tick: number, seenTick: number, send: ClientSend, upEvery: number): void => {
  const me = c.me;
  if (!c.hasRoom) return;
  if (c.awaitingKey && me.act !== Act.Transit) {
    // The slide finished but the new room has not arrived: hold.
    me.heroTick = tick;
    return;
  }
  const env = c.env;
  fillEnv(c, tick, env);
  const o = c.out;
  stepHero(me, buttons, env, o);
  if (o.hitN > 0) {
    // Predicted cuts and kills; the server confirms with Tile and Despawn events.
    for (let i = 0; i < o.hitN; i += 1) {
      const t = o.hitTargets[i] as number;
      if (t >= 128) {
        const code = c.tiles[t - 128] as number;
        if (((TILE_FLAGS[code] ?? 0) & F.CUT) !== 0 && o.hitAttack !== Attack.Hook) {
          c.cutPred[t - 128] = code;
          c.tiles[t - 128] = CUT_TO(code);
        }
      }
    }
    for (let base = 0; base < o.hitN && base < 24; base += 8) {
      const n = Math.min(8, o.hitN - base);
      send.evt(writeHitClaim(tw.reset(), seenTick, o.hitAttack, o.hitDir, o.hitTargets.subarray(base, base + n), n).copy());
    }
  }
  if (o.blockedId >= 0) {
    for (const p of c.projs) if (p.on && p.id === o.blockedId) p.on = false;
    send.evt(writeBlocked(tw.reset(), o.blockedId, seenTick).copy());
  }
  if (o.dmgSource >= 0) {
    if (o.dmgSource < 128) for (const p of c.projs) if (p.on && p.id === o.dmgSource) p.on = false;
    me.hp = Math.max(0, me.hp - o.dmgAmount);
    send.evt(writeDamageTaken(tw.reset(), o.dmgSource, o.dmgAmount, seenTick).copy());
  }
  if (o.push >= 0) send.evt(writePush(tw.reset(), o.push, o.pushDir).copy());
  if (o.interact >= 0) c.hooks.interact?.(o.interact);
  if (o.enter >= 0) {
    if (predictExit(c, o.enter, o.enterPos)) {
      send.evt(writeEnterRoom(tw.reset(), o.enter, o.enterPos).copy());
      const from = c.room;
      me.room = target[0] as number;
      me.x = target[1] as number;
      me.y = target[2] as number;
      me.entryX = me.x;
      me.entryY = me.y;
      me.facing = target[3] as number;
      c.awaitingKey = true;
      c.hooks.roomChange?.(from, me.room, o.enter);
    } else {
      // Not an exit after all: step back inside.
      me.act = Act.Idle;
      me.x = Math.max(HERO_RULES.feetHW, Math.min(3072 - HERO_RULES.feetHW, me.x));
      me.y = Math.max(HERO_RULES.feetHH, Math.min(2304 - HERO_RULES.feetHH, me.y));
    }
  }
  if (o.cues !== 0) c.hooks.cue?.(o.cues);
  // UP when the state changed.
  const hash = (me.x * 31 + me.y) * 131 + me.act * 7 + me.facing + me.actT * 977 + me.room * 13 + me.hp;
  if (hash !== c.lastUpHash && tick - c.lastUpTick >= upEvery) {
    c.lastUpHash = hash;
    c.lastUpTick = tick;
    send.up(writeUp(c.upW.reset(), { room: me.room, x: me.x, y: me.y, facing: me.facing, act: me.act, moving: me.moving, charged: me.charged, actT: me.actT, hp: me.hp, heroTick: tick }).copy());
  }
};

/** Sends an Interact for a tile (chests, locks, lanterns, NPC gifts). */
export const sendInteract = (send: ClientSend, tile: number): void => send.evt(writeInteract(tw.reset(), tile).copy());

/** What kind of thing is at a tile, for the UI. */
export const tileKind = (c: ClientWorld, tile: number): number => c.tiles[tile] as number;

