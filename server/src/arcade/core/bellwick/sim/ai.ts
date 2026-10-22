/**
 * Enemy behaviours (bellwick.md §1.5): one state machine per kind on integer timers (`ai`, `aiT`, plus
 * `t2` and a target). Enemies go after the nearest active hero by Manhattan distance; line of sight is
 * a ray along the row or column. No loops beyond the fixed hero list.
 */
import { isin } from '../content/sine.js';
import { AI, ENEMY_STATS, F } from '../rules.js';
import { Kind, Proj } from '../types.js';
import { clearLine } from './collide.js';
import { enemyCanStand, faceDX, faceDY, moveEnemy, nearestHero, rnd, spawnProjectile, targetable } from './room.js';
import type { Enemy, HeroRec, Room } from './state.js';
import type { World } from './world.js';

/** The facing (down, up, left, right) from a vector, along its dominant axis. */
export const facingOf = (dx: number, dy: number): number => (Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 2 : 3) : dy < 0 ? 1 : 0);

const SIGHT_MASK = F.SOLID | F.WATER | F.PIT;

const burrlet = (room: Room, e: Enemy): void => {
  if (e.ai === 0) {
    e.pose = 0;
    e.aiT -= 1;
    if (e.aiT > 0) return;
    const dir = rnd(room, 4);
    const tx = e.x + faceDX(dir) * 256;
    const ty = e.y + faceDY(dir) * 256;
    if (enemyCanStand(room, e.kind, tx, ty)) {
      e.ai = 1;
      e.aiT = AI.burrletHopTicks;
      e.facing = dir;
    } else e.aiT = 5;
    return;
  }
  e.pose = 1;
  moveEnemy(room, e, faceDX(e.facing) * 32, faceDY(e.facing) * 32);
  e.aiT -= 1;
  if (e.aiT <= 0) {
    e.ai = 0;
    e.aiT = AI.burrletHopMin + rnd(room, AI.burrletHopMax - AI.burrletHopMin + 1);
  }
};

const snapjaw = (w: World, room: Room, e: Enemy): void => {
  if (e.ai === 2) {
    e.pose = 3;
    e.aiT -= 1;
    if (e.aiT <= 0) e.ai = 0;
    return;
  }
  if (e.ai === 1) {
    e.pose = 2;
    const blocked = moveEnemy(room, e, faceDX(e.facing) * AI.snapjawCharge, faceDY(e.facing) * AI.snapjawCharge);
    if (blocked !== 0) {
      e.ai = 2;
      e.aiT = AI.snapjawStun;
    }
    return;
  }
  // Patrol, and look along the row and column.
  e.pose = (w.tick >> 3) & 1;
  const etx = e.x >> 8;
  const ety = e.y >> 8;
  for (let i = 0; i < 4; i += 1) {
    const h = w.heroes[i] as HeroRec;
    if (!targetable(h, room.id)) continue;
    const htx = h.x >> 8;
    const hty = h.y >> 8;
    const inRow = hty === ety && Math.abs(htx - etx) <= AI.snapjawSight;
    const inCol = htx === etx && Math.abs(hty - ety) <= AI.snapjawSight;
    if ((inRow || inCol) && clearLine(room.tiles, etx, ety, htx, hty, SIGHT_MASK)) {
      e.ai = 1;
      e.facing = inRow ? (htx < etx ? 2 : 3) : hty < ety ? 1 : 0;
      return;
    }
  }
  const speed = ENEMY_STATS[Kind.Snapjaw]!.speed;
  const blocked = moveEnemy(room, e, faceDX(e.facing) * speed, faceDY(e.facing) * speed);
  if (blocked !== 0) e.facing = e.facing ^ 1;
};

const slingkin = (w: World, room: Room, e: Enemy): void => {
  if (e.ai === 1) {
    e.pose = 2;
    e.aiT -= 1;
    if (e.aiT <= 0) e.ai = 0;
    return;
  }
  e.pose = (w.tick >> 3) & 1;
  e.t2 += 1;
  const h = nearestHero(w, room, e.x, e.y);
  if (!h) return;
  const dx = h.x - e.x;
  const dy = h.y - e.y;
  e.facing = facingOf(dx, dy);
  const speed = ENEMY_STATS[Kind.Slingkin]!.speed;
  const near = AI.slingkinNear * 256;
  const far = AI.slingkinFar * 256;
  let mx = 0;
  let my = 0;
  if (Math.abs(dx) <= Math.abs(dy)) {
    // Line up on the hero's column, keep 3–5 tiles away vertically.
    if (Math.abs(dx) > 48) mx = dx > 0 ? speed : -speed;
    if (Math.abs(dy) < near) my = dy > 0 ? -speed : speed;
    else if (Math.abs(dy) > far) my = dy > 0 ? speed : -speed;
  } else {
    if (Math.abs(dy) > 48) my = dy > 0 ? speed : -speed;
    if (Math.abs(dx) < near) mx = dx > 0 ? -speed : speed;
    else if (Math.abs(dx) > far) mx = dx > 0 ? speed : -speed;
  }
  moveEnemy(room, e, mx, my);
  const lined = Math.abs(dx) < 96 || Math.abs(dy) < 96;
  if (e.t2 >= AI.slingkinFire && lined) {
    e.t2 = 0;
    e.ai = 1;
    e.aiT = 10;
    const f = facingOf(dx, dy);
    spawnProjectile(room, Proj.Pebble, e.x + faceDX(f) * 128, e.y + faceDY(f) * 128, f, 255);
  }
};

const shellback = (w: World, room: Room, e: Enemy): void => {
  if (e.ai === 1) {
    e.pose = 2;
    e.aiT -= 1;
    if (e.aiT <= 0) e.ai = 0;
    return;
  }
  e.pose = (w.tick >> 4) & 1;
  const h = nearestHero(w, room, e.x, e.y);
  if (!h) return;
  const dx = h.x - e.x;
  const dy = h.y - e.y;
  // It turns slowly: once every 30 ticks, so a quick hero can get round its shell.
  e.t2 += 1;
  if (e.t2 >= 30) {
    e.t2 = 0;
    e.facing = facingOf(dx, dy);
  }
  const s = ENEMY_STATS[Kind.Shellback]!.speed;
  moveEnemy(room, e, Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? s : -s) : 0, Math.abs(dx) < Math.abs(dy) ? (dy > 0 ? s : -s) : 0);
};

/** Moth Wisp: a figure-eight on the integer sine table around its home; after contact it retreats. */
const wisp = (w: World, room: Room, e: Enemy): void => {
  e.pose = (w.tick >> 2) & 1;
  let gx: number;
  let gy: number;
  if (e.ai === 1) {
    e.aiT -= 1;
    if (e.aiT <= 0) e.ai = 0;
    const h = nearestHero(w, room, e.x, e.y);
    gx = h ? e.x + (e.x >= h.x ? 512 : -512) : e.homeX;
    gy = h ? e.y + (e.y >= h.y ? 512 : -512) : e.homeY;
  } else {
    const phase = w.tick + e.id * 7;
    gx = e.homeX + ((isin(phase) * AI.wispRadius) >> 8);
    gy = e.homeY + ((isin(phase * 2) * (AI.wispRadius >> 1)) >> 8);
  }
  const step = ENEMY_STATS[Kind.Wisp]!.speed;
  const dx = Math.max(-step, Math.min(step, gx - e.x));
  const dy = Math.max(-step, Math.min(step, gy - e.y));
  moveEnemy(room, e, dx, dy);
  e.x = Math.max(160, Math.min(2912, e.x));
  e.y = Math.max(160, Math.min(2144, e.y));
};

const rootling = (w: World, room: Room, e: Enemy): void => {
  switch (e.ai) {
    case 0: {
      e.pose = 0;
      if (e.t2 > 0) {
        e.t2 -= 1;
        return;
      }
      const h = nearestHero(w, room, e.x, e.y);
      if (!h) return;
      const dx = h.x - e.x;
      const dy = h.y - e.y;
      if (dx * dx + dy * dy <= AI.rootlingRange * AI.rootlingRange) {
        e.ai = 1;
        e.aiT = AI.rootlingShake;
        e.facing = facingOf(dx, dy);
      }
      return;
    }
    case 1:
      e.pose = 1;
      e.aiT -= 1;
      if (e.aiT <= 0) {
        e.ai = 2;
        e.aiT = AI.rootlingLunge / ENEMY_STATS[Kind.Rootling]!.speed;
      }
      return;
    case 2: {
      e.pose = 2;
      const s = ENEMY_STATS[Kind.Rootling]!.speed;
      moveEnemy(room, e, faceDX(e.facing) * s, faceDY(e.facing) * s);
      e.aiT -= 1;
      if (e.aiT <= 0) {
        e.ai = 3;
        e.aiT = AI.rootlingExposed;
      }
      return;
    }
    default:
      e.pose = 2 + ((w.tick >> 3) & 1);
      e.aiT -= 1;
      if (e.aiT <= 0) {
        e.ai = 0;
        e.t2 = AI.rootlingHide;
      }
  }
};

/** Bell Bat: roosts, then swoops on a fixed 36-tick loop out to where a hero stood and back. */
const bat = (w: World, room: Room, e: Enemy): void => {
  if (e.ai === 0) {
    e.pose = 0;
    if (e.t2 > 0) {
      e.t2 -= 1;
      return;
    }
    const h = nearestHero(w, room, e.x, e.y);
    if (!h) return;
    const dx = h.x - e.x;
    const dy = h.y - 64 - e.y;
    if (dx * dx + dy * dy > AI.batRange * AI.batRange) return;
    e.ai = 1;
    e.aiT = 0;
    e.homeX = e.x;
    e.homeY = e.y;
    e.tx = h.x;
    e.ty = h.y - 64;
    return;
  }
  e.pose = 1 + ((w.tick >> 2) & 1);
  e.aiT += 1;
  const half = AI.batSwoop >> 1;
  const u = e.aiT <= half ? e.aiT : AI.batSwoop - e.aiT;
  const vx = e.tx - e.homeX;
  const vy = e.ty - e.homeY;
  const bulge = isin(Math.floor((e.aiT * 32) / AI.batSwoop));
  e.x = e.homeX + Math.floor((vx * u) / half) + Math.floor((-vy * bulge) / (256 * 3));
  e.y = e.homeY + Math.floor((vy * u) / half) + Math.floor((vx * bulge) / (256 * 3));
  e.x = Math.max(128, Math.min(2944, e.x));
  e.y = Math.max(128, Math.min(2176, e.y));
  e.facing = vx < 0 ? 2 : 3;
  if (e.aiT >= AI.batSwoop) {
    e.ai = 0;
    e.x = e.homeX;
    e.y = e.homeY;
    e.t2 = AI.batRest;
  }
};

/** Pebble Sentinel: fires a repel shot along its facing every 20 ticks (they alternate by spawn order). */
const sentinel = (room: Room, e: Enemy): void => {
  e.aiT += 1;
  e.pose = e.aiT % AI.sentinelFire < 4 ? 1 : 0;
  if (e.aiT % AI.sentinelFire === 0) spawnProjectile(room, Proj.Repel, e.x + faceDX(e.facing) * 160, e.y + faceDY(e.facing) * 160, e.facing, 255);
};

export const stepEnemy = (w: World, room: Room, e: Enemy): void => {
  switch (e.kind) {
    case Kind.Burrlet:
      burrlet(room, e);
      return;
    case Kind.Snapjaw:
      snapjaw(w, room, e);
      return;
    case Kind.Slingkin:
      slingkin(w, room, e);
      return;
    case Kind.Shellback:
      shellback(w, room, e);
      return;
    case Kind.Wisp:
      wisp(w, room, e);
      return;
    case Kind.Rootling:
      rootling(w, room, e);
      return;
    case Kind.Bat:
      bat(w, room, e);
      return;
    case Kind.Sentinel:
      sentinel(room, e);
      return;
    default:
  }
};

/** Does this enemy hurt on contact right now? */
export const contactHurts = (kind: number, ai: number, pose: number): boolean => {
  if (kind === Kind.Sentinel || kind === Kind.Block || kind === Kind.None) return false;
  if (kind === Kind.Rootling) return ai >= 2 || pose >= 2;
  if (kind === Kind.Bat) return pose !== 0;
  if (kind === Kind.Snapjaw) return pose !== 3;
  if (kind === Kind.Shellback) return pose !== 2;
  return true;
};

