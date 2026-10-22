/**
 * The authoritative world state (bellwick.md §3.3): rooms with fixed-capacity pools, the shared party
 * and one record per hero. Online the server owns it; offline the device runs the same code. Pools
 * are preallocated: a free slot has `kind` (or `on`) 0, and spawning past a cap is refused.
 */
import { ByteWriter } from '../../bytes.js';
import type { ScreenDef } from '../content/parse.js';
import { CAP, TILES } from '../types.js';

export interface Enemy {
  /** 0 = free slot. */
  kind: number;
  id: number;
  x: number;
  y: number;
  facing: number;
  hp: number;
  /** State and its timer; t2 and the targets are per-kind scratch. */
  ai: number;
  aiT: number;
  t2: number;
  tx: number;
  ty: number;
  homeX: number;
  homeY: number;
  iframes: number;
  kbDx: number;
  kbDy: number;
  kbT: number;
  stun: number;
  /** Ticks to show the hurt flash. */
  hurt: number;
  /** Animation pose (4 bits). */
  pose: number;
  /** Summoned by the boss (no drops). */
  summoned: boolean;
}

export interface Projectile {
  /** 0 = free; else kind + 1. */
  on: number;
  id: number;
  kind: number;
  /** Origin in sub (pixel-centred, so the wire's pixels reproduce it exactly) and spawn tick. */
  x0: number;
  y0: number;
  dir: number;
  t0: number;
  ttl: number;
  /** Who fired a bounced pebble (slot), or 255. */
  by: number;
}

export interface Pickup {
  on: number;
  id: number;
  kind: number;
  x: number;
  y: number;
  /** Ticks left; −1 never expires. */
  ttl: number;
}

export interface Block {
  on: number;
  id: number;
  /** Resting tile (the destination while sliding). */
  tile: number;
  /** The code under the block. */
  under: number;
  /** Sliding: ticks done (0 when resting) and direction. */
  moveT: number;
  dir: number;
  /** The tile it slides from. */
  from: number;
}

export interface Shock {
  on: number;
  x: number;
  y: number;
  t0: number;
}

export interface BossState {
  phase: number;
  /** Phase 1: 0 wait, 1 airborne, 2 stuck. Phase 2: 0 roll, 1 dizzy. Phase 3: 0 chase, 1 clapper out. 9 = idle (no fight yet). */
  mode: number;
  timer: number;
  laps: number;
  /** Corners passed this run (4 per lap). */
  corners: number;
  clapperT: number;
  /** Damage taken in the current window. */
  windowDmg: number;
  heroes: number;
  maxHp: number;
  noteT: number;
  batT: number;
  /** Where it is heading (sub). */
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  /** Roll direction around the room, 0–3. */
  rollDir: number;
}

export interface Room {
  id: number;
  def: ScreenDef;
  tick: number;
  rng: number;
  activation: number;
  tiles: Uint8Array;
  en: Enemy[];
  pr: Projectile[];
  pk: Pickup[];
  bl: Block[];
  sh: Shock[];
  boss: BossState | null;
  nextId: number;
  /** Tick it became empty, or −1 while someone is in it. */
  emptySince: number;
  /** Room events this tick (game wire format) and their count. */
  ev: ByteWriter;
  evCount: number;
  /** Rewind ring: 16 ticks × 14 entities × (id, x px, y px), and the tick of each row. */
  ringIds: Uint8Array;
  ringXY: Int16Array;
  ringTick: Int32Array;
  /** Tile changes since activation (for keyframes it is the tiles themselves). */
  dirty: boolean;
  /** Any change this tick that the snapshot shows. */
  moved: boolean;
}

export const RING_TICKS = 16;
export const RING_ENTS = 14;

export const newRoom = (def: ScreenDef): Room => {
  const en: Enemy[] = [];
  for (let i = 0; i < CAP.enemies; i += 1) {
    en.push({ kind: 0, id: 0, x: 0, y: 0, facing: 0, hp: 0, ai: 0, aiT: 0, t2: 0, tx: 0, ty: 0, homeX: 0, homeY: 0, iframes: 0, kbDx: 0, kbDy: 0, kbT: 0, stun: 0, hurt: 0, pose: 0, summoned: false });
  }
  const pr: Projectile[] = [];
  for (let i = 0; i < CAP.projectiles; i += 1) pr.push({ on: 0, id: 0, kind: 0, x0: 0, y0: 0, dir: 0, t0: 0, ttl: 0, by: 255 });
  const pk: Pickup[] = [];
  for (let i = 0; i < CAP.pickups; i += 1) pk.push({ on: 0, id: 0, kind: 0, x: 0, y: 0, ttl: 0 });
  const bl: Block[] = [];
  for (let i = 0; i < CAP.blocks; i += 1) bl.push({ on: 0, id: 0, tile: 0, under: 0, moveT: 0, dir: 0, from: 0 });
  const sh: Shock[] = [];
  for (let i = 0; i < CAP.shocks; i += 1) sh.push({ on: 0, x: 0, y: 0, t0: 0 });
  return {
    id: def.id,
    def,
    tick: 0,
    rng: 1,
    activation: 0,
    tiles: new Uint8Array(TILES),
    en,
    pr,
    pk,
    bl,
    sh,
    boss: null,
    nextId: 0,
    emptySince: -1,
    ev: new ByteWriter(2048),
    evCount: 0,
    ringIds: new Uint8Array(RING_TICKS * RING_ENTS),
    ringXY: new Int16Array(RING_TICKS * RING_ENTS * 2),
    ringTick: new Int32Array(RING_TICKS).fill(-1),
    dirty: false,
    moved: false,
  };
};

export interface Party {
  /** 256 flags as 32 bytes. */
  flags: Uint8Array;
  purse: number;
  keys: number;
  bossKey: boolean;
  map: boolean;
  compass: boolean;
  sword: boolean;
  buckler: boolean;
  hook: boolean;
  shards: number;
  vessels: number;
  lantern: number;
  playTicks: number;
  /** Dungeon rooms cleared (bit n − 1 for room n); not saved. */
  cleared: number;
  /** Party events this tick and their count. */
  ev: ByteWriter;
  evCount: number;
}

export const newParty = (): Party => ({
  flags: new Uint8Array(32),
  purse: 0,
  keys: 0,
  bossKey: false,
  map: false,
  compass: false,
  sword: false,
  buckler: false,
  hook: false,
  shards: 0,
  vessels: 0,
  lantern: 0,
  playTicks: 0,
  cleared: 0,
  ev: new ByteWriter(1024),
  evCount: 0,
});

export const hasFlag = (p: Party, id: number): boolean => id >= 0 && ((p.flags[id >> 3] as number) & (1 << (id & 7))) !== 0;
export const setFlagBit = (p: Party, id: number, on: boolean): void => {
  if (id < 0) return;
  const i = id >> 3;
  const b = 1 << (id & 7);
  p.flags[i] = on ? (p.flags[i] as number) | b : (p.flags[i] as number) & ~b;
};

/** One hero as the authority knows it. */
export interface HeroRec {
  slot: number;
  /** Seated (a player holds the slot). */
  present: boolean;
  tunic: number;
  joinOrder: number;
  status: number;
  room: number;
  x: number;
  y: number;
  facing: number;
  act: number;
  actT: number;
  moving: boolean;
  charged: boolean;
  hp: number;
  iframes: number;
  heroTick: number;
  brew: boolean;
  /** Where the hero entered its room (pit return). */
  entryX: number;
  entryY: number;
  downedT: number;
  reviveT: number;
  /** Ticks left of the room-change slide (status Transit). */
  transitT: number;
  /** Stats for the save: downs, foes defeated, revives given. */
  downs: number;
  foes: number;
  revives: number;
  /** Ticks since the last input change (3 min idle → rest). */
  idleT: number;
  /** Last accepted UP tick, for move checks. */
  upTick: number;
  /** Server-side allowance for the next move check (knockback, pull, ledge, slide), in sub. */
  allow: number;
  /** Corrects in the last 2 s. */
  corrects: number;
  correctT: number;
  /** Swing key of the last accepted hit claim. */
  lastSwing: number;
}

export const newHero = (slot: number): HeroRec => ({
  slot,
  present: false,
  tunic: slot,
  joinOrder: 0,
  status: 2,
  room: 0,
  x: 0,
  y: 0,
  facing: 0,
  act: 0,
  actT: 0,
  moving: false,
  charged: false,
  hp: 6,
  iframes: 0,
  heroTick: 0,
  brew: false,
  entryX: 0,
  entryY: 0,
  downedT: 0,
  reviveT: 0,
  transitT: 0,
  downs: 0,
  foes: 0,
  revives: 0,
  idleT: 0,
  upTick: 0,
  allow: 0,
  corrects: 0,
  correctT: 0,
  lastSwing: -1,
});
