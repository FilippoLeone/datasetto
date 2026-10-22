/**
 * Old Clapper, the bell golem (bellwick.md §1.7). HP 24 + 12·(n − 1), with n the heroes in the room when
 * the first one walks in. Phase 1 Toll: hops near a hero (a shadow for 20 ticks), slams a ring, stuck 45.
 * Phase 2 Peal: rolls along the walls, 3 notes every 60 ticks, 2 Bell Bats every 240 (4 alive at most),
 * dizzy 60 after 3 laps. Phase 3 Cracked: chases; only hurt while the hooked-out clapper hangs (90 ticks,
 * double damage). Each window ends early once it has taken 6 + 3·(n − 1) damage.
 */
import { evBossPhase } from '../codec.js';
import { BOSS_RULES, bossHp } from '../rules.js';
import { CAP, Kind, Proj, Status } from '../types.js';
import { facingOf } from './ai.js';
import { moveEnemy, nearestHero, spawnEnemy, spawnProjectile, spawnShock } from './room.js';
import type { BossState, Enemy, HeroRec, Room } from './state.js';
import type { World } from './world.js';

/** The rectangle its centre rolls around in phase 2 (sub): inside the walls by its half size. */
const RX0 = 256 + BOSS_RULES.halfW;
const RX1 = 2816 - BOSS_RULES.halfW;
const RY0 = 256 + BOSS_RULES.halfH;
const RY1 = 2048 - BOSS_RULES.halfH;

export const startBoss = (room: Room, e: Enemy): void => {
  room.boss = {
    phase: 1,
    mode: 9,
    timer: 0,
    laps: 0,
    corners: 0,
    clapperT: 0,
    windowDmg: 0,
    heroes: 1,
    maxHp: e.hp,
    noteT: 0,
    batT: 0,
    tx: e.x,
    ty: e.y,
    sx: e.x,
    sy: e.y,
    rollDir: 0,
  };
};

export const bossVulnerable = (room: Room): boolean => {
  const b = room.boss;
  if (!b) return false;
  return (b.phase === 1 && b.mode === 2) || (b.phase === 2 && b.mode === 1) || (b.phase === 3 && b.mode === 1);
};

const announce = (room: Room, b: BossState, e: Enemy): void => {
  evBossPhase(room.ev, b.phase, Math.max(0, e.hp), room.tick);
  room.evCount += 1;
};

const heroesIn = (w: World, room: Room): number => {
  let n = 0;
  for (let i = 0; i < 4; i += 1) {
    const h = w.heroes[i] as HeroRec;
    if (h.present && h.room === room.id && (h.status === Status.Active || h.status === Status.Downed)) n += 1;
  }
  return n;
};

const bossBats = (room: Room): number => {
  let n = 0;
  for (let i = 0; i < CAP.enemies; i += 1) {
    const o = room.en[i] as Enemy;
    if (o.kind === Kind.Bat && o.summoned) n += 1;
  }
  return n;
};

/** The Dir8 closest to a vector. */
const dir8Of = (dx: number, dy: number): number => {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax * 5 < ay * 2) return dy < 0 ? 1 : 0;
  if (ay * 5 < ax * 2) return dx < 0 ? 2 : 3;
  if (dy > 0) return dx < 0 ? 4 : 5;
  return dx < 0 ? 6 : 7;
};

/** The two Dir8 neighbours of each Dir8 (±45°). */
const NEXT8: readonly number[] = [5, 6, 7, 4, 0, 3, 2, 1];
const PREV8: readonly number[] = [4, 7, 6, 5, 2, 0, 1, 3];

const checkPhase = (room: Room, b: BossState, e: Enemy): void => {
  if (b.phase === 1 && e.hp * 3 <= b.maxHp * 2) {
    b.phase = 2;
    b.mode = 0;
    b.corners = 0;
    b.laps = 0;
    b.noteT = BOSS_RULES.noteEvery;
    b.batT = BOSS_RULES.batEvery >> 1;
    b.windowDmg = 0;
    announce(room, b, e);
  } else if (b.phase === 2 && e.hp * 3 <= b.maxHp) {
    b.phase = 3;
    b.mode = 0;
    b.windowDmg = 0;
    announce(room, b, e);
  }
};

const capOf = (b: BossState): number => BOSS_RULES.capBase + BOSS_RULES.capPerHero * Math.max(0, b.heroes - 1);

export const stepBoss = (w: World, room: Room, e: Enemy): void => {
  const b = room.boss;
  if (!b || b.mode === 8) return;
  if (b.mode === 9) {
    // Waiting for the first hero; HP scales with the heroes present then.
    const n = heroesIn(w, room);
    if (n === 0) return;
    b.heroes = n;
    b.maxHp = bossHp(n);
    e.hp = b.maxHp;
    b.phase = 1;
    b.mode = 0;
    b.timer = BOSS_RULES.waitTicks;
    announce(room, b, e);
    return;
  }
  checkPhase(room, b, e);
  const cap = capOf(b);
  if (b.phase === 1) {
    if (b.mode === 0) {
      b.timer -= 1;
      if (b.timer > 0) return;
      const h = nearestHero(w, room, e.x, e.y);
      b.sx = e.x;
      b.sy = e.y;
      b.tx = h ? Math.max(RX0, Math.min(RX1, h.x)) : e.x;
      b.ty = h ? Math.max(RY0, Math.min(RY1, h.y - 64)) : e.y;
      b.mode = 1;
      b.timer = BOSS_RULES.shadowTicks;
      return;
    }
    if (b.mode === 1) {
      b.timer -= 1;
      const done = BOSS_RULES.shadowTicks - b.timer;
      e.x = b.sx + Math.floor(((b.tx - b.sx) * done) / BOSS_RULES.shadowTicks);
      e.y = b.sy + Math.floor(((b.ty - b.sy) * done) / BOSS_RULES.shadowTicks);
      if (b.timer <= 0) {
        spawnShock(room, e.x, e.y + 96);
        b.mode = 2;
        b.timer = BOSS_RULES.stuckTicks;
        b.windowDmg = 0;
      }
      return;
    }
    b.timer -= 1;
    if (b.timer <= 0 || b.windowDmg >= cap) {
      b.mode = 0;
      b.timer = BOSS_RULES.waitTicks;
    }
    return;
  }
  if (b.phase === 2) {
    if (b.mode === 1) {
      b.timer -= 1;
      if (b.timer <= 0 || b.windowDmg >= cap) {
        b.mode = 0;
        b.corners = 0;
      }
      return;
    }
    // Roll clockwise along the walls: top → right → bottom → left.
    const s = BOSS_RULES.rollSpeed;
    let dx = 0;
    let dy = 0;
    if (b.rollDir === 0) {
      dx = s;
      dy = e.y > RY0 ? -s : 0;
    } else if (b.rollDir === 1) {
      dy = s;
      dx = e.x < RX1 ? s : 0;
    } else if (b.rollDir === 2) {
      dx = -s;
      dy = e.y < RY1 ? s : 0;
    } else {
      dy = -s;
      dx = e.x > RX0 ? -s : 0;
    }
    e.x = Math.max(RX0, Math.min(RX1, e.x + dx));
    e.y = Math.max(RY0, Math.min(RY1, e.y + dy));
    const atEnd = (b.rollDir === 0 && e.x >= RX1) || (b.rollDir === 1 && e.y >= RY1) || (b.rollDir === 2 && e.x <= RX0) || (b.rollDir === 3 && e.y <= RY0);
    if (atEnd) {
      b.rollDir = (b.rollDir + 1) & 3;
      b.corners += 1;
      if (b.corners >= BOSS_RULES.laps * 4) {
        b.laps += 1;
        b.mode = 1;
        b.timer = BOSS_RULES.dizzyTicks;
        b.windowDmg = 0;
        b.corners = 0;
        return;
      }
    }
    e.facing = b.rollDir === 0 ? 3 : b.rollDir === 1 ? 0 : b.rollDir === 2 ? 2 : 1;
    b.noteT -= 1;
    if (b.noteT <= 0) {
      b.noteT = BOSS_RULES.noteEvery;
      const h = nearestHero(w, room, e.x, e.y);
      if (h) {
        const d = dir8Of(h.x - e.x, h.y - 64 - e.y);
        spawnProjectile(room, Proj.Note, e.x, e.y, d, 255);
        spawnProjectile(room, Proj.Note, e.x, e.y, NEXT8[d] as number, 255);
        spawnProjectile(room, Proj.Note, e.x, e.y, PREV8[d] as number, 255);
      }
    }
    b.batT -= 1;
    if (b.batT <= 0) {
      b.batT = BOSS_RULES.batEvery;
      for (let k = 0; k < 2 && bossBats(room) < BOSS_RULES.batMax; k += 1) {
        spawnEnemy(room, Kind.Bat, k === 0 ? 768 : 2304, 640, 0, true, true);
      }
    }
    return;
  }
  // Phase 3.
  if (b.mode === 1) {
    b.timer -= 1;
    b.clapperT = Math.max(0, b.timer);
    if (b.timer <= 0 || b.windowDmg >= cap) {
      b.mode = 0;
      b.clapperT = 0;
    }
    return;
  }
  const h = nearestHero(w, room, e.x, e.y);
  if (!h) return;
  const dx = h.x - e.x;
  const dy = h.y - 64 - e.y;
  const mx = dx > 16 ? 1 : dx < -16 ? -1 : 0;
  const my = dy > 16 ? 1 : dy < -16 ? -1 : 0;
  // 20 sub/tick in total: 14 per axis on a diagonal.
  const s = mx !== 0 && my !== 0 ? (BOSS_RULES.chaseSpeed * 11) >> 4 : BOSS_RULES.chaseSpeed;
  e.facing = facingOf(dx, dy);
  moveEnemy(room, e, mx * s, my * s);
};
