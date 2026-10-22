/**
 * The server's checks of what a client says its hero did (bellwick.md §3.5). Each client owns its own
 * hero, so the server only checks that a move, a hit, a hurt or a block was possible from where it
 * last saw that hero and from where its rewind ring saw the target. Co-op among friends needs no hard
 * anti-cheat: the slack covers lag and the 2-tick UP cadence, and a failed check costs a `Correct`, not
 * a kick.
 */
import { BOSS_RULES, ENEMY_STATS, F, HERO_RULES, TILE_FLAGS } from './rules.js';
import { slashBox } from './sim/hero.js';
import { enemyById, projX, projY, ringAt } from './sim/room.js';
import { RING_TICKS, type HeroRec, type Room } from './sim/state.js';
import { Act, Attack, CAP, DX4, DY4, Kind, Status } from './types.js';

export const CHECK = {
  /** Slack on target positions and attack boxes: 4 px, plus two ticks of walking (UPs go out every 2 ticks). */
  slack: 64 + 2 * 32,
  /** A source of damage within 24 px of the hero. */
  hurtRange: 384,
  /** A blocked projectile within 20 px in front of the hero. */
  blockRange: 320,
  /** A feet box may overlap a wall by up to 4 px. */
  wallSlack: 64,
  /** A UP may be at most this many ticks ahead of the server. */
  ahead: 3,
  /** Moves are checked over at most 1 s since the last accepted UP (a hero standing still sends none). */
  maxDt: 30,
  /** Three Corrects within 2 s send a resync keyframe. */
  resyncCorrects: 3,
  resyncTicks: 60,
  /** After a Correct, failing UPs already in flight are dropped quietly for this long. */
  correctQuiet: 20,
  /** At most this many targets per swing. */
  swingTargets: 24,
} as const;

/** The full tick nearest `now` whose low 16 bits are `t16`. */
export const fullTick = (now: number, t16: number): number => now + ((((t16 - now) & 0xffff) << 16) >> 16);

const entHalf = (kind: number): number => (kind === Kind.Boss ? BOSS_RULES.halfW : (ENEMY_STATS[kind]?.half ?? 96));
const entHalfY = (kind: number): number => (kind === Kind.Boss ? BOSS_RULES.halfH : (ENEMY_STATS[kind]?.half ?? 96));

/** Is (x, y) in a tile blocked for `mask` (off the grid: free; the exit check is separate)? */
const wallAt = (tiles: Uint8Array, x: number, y: number, mask: number): boolean => {
  const tx = x >> 8;
  const ty = y >> 8;
  if (tx < 0 || ty < 0 || tx >= 12 || ty >= 9) return false;
  return ((TILE_FLAGS[tiles[ty * 12 + tx] as number] ?? F.SOLID) & mask) !== 0;
};

/** Does a feet box shrunk by the wall slack overlap a blocked tile at (x, y)? */
const boxWall = (tiles: Uint8Array, x: number, y: number, mask: number): boolean => {
  const hw = HERO_RULES.feetHW - CHECK.wallSlack;
  const hh = Math.max(16, HERO_RULES.feetHH - CHECK.wallSlack);
  return wallAt(tiles, x - hw, y - hh, mask) || wallAt(tiles, x + hw - 1, y - hh, mask) || wallAt(tiles, x - hw, y + hh - 1, mask) || wallAt(tiles, x + hw - 1, y + hh - 1, mask);
};

/**
 * Checks a move from the hero's last accepted state to (x, y) over `dt` ticks with the act the client
 * reports. Returns -1 when the move is fine, else the CORRECT reason (0 move, 1 wall).
 */
export const checkMove = (room: Room | null, h: HeroRec, x: number, y: number, act: number, dt: number): number => {
  if (x < 0 || y < 0 || x >= 3072 || y >= 2304) return 0;
  let lim = HERO_RULES.speed * dt + 32 + h.allow;
  const pulled = act === Act.Pulled || h.act === Act.Pulled;
  const ledge = act === Act.Ledge || h.act === Act.Ledge;
  if (pulled) lim += (HERO_RULES.pullSpeed - HERO_RULES.speed) * dt;
  if (ledge) lim += HERO_RULES.ledgeSpeed * HERO_RULES.ledgeTicks;
  if (h.transitT > 0) lim += 512;
  if (Math.abs(x - h.x) > lim || Math.abs(y - h.y) > lim) return 0;
  if (!room) return -1;
  // Swept against the server's grid: a pull crosses water and pits, a hop crosses the ledge.
  const mask = pulled ? F.SOLID : ledge ? F.SOLID | F.WATER : F.SOLID | F.WATER | F.LEDGE_S;
  const tiles = room.tiles;
  if (boxWall(tiles, h.x, h.y, mask)) return -1; // Already overlapping (a shutter closed on it): let it walk out.
  const dx = x - h.x;
  const dy = y - h.y;
  const steps = Math.min(16, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 96));
  for (let i = 1; i <= steps; i += 1) {
    const sx = h.x + Math.trunc((dx * i) / steps);
    const sy = h.y + Math.trunc((dy * i) / steps);
    if (boxWall(tiles, sx, sy, mask)) return 1;
  }
  return -1;
};

const pos = new Int32Array(2);
const box = new Int32Array(4);

/**
 * The target's position (sub) at `tick` from the ring, or at the first step after it that the ring holds
 * (a room that was not stepping at `tick`); false when the ring does not have the target.
 */
const targetAt = (room: Room, id: number, tick: number, out: Int32Array): boolean => {
  if (ringAt(room, id, tick, out)) return true;
  let best = -1;
  for (let i = 0; i < RING_TICKS; i += 1) {
    const t = room.ringTick[i] as number;
    if (t > tick && (best < 0 || t < best)) best = t;
  }
  return best >= 0 && ringAt(room, id, best, out);
};

/**
 * Is `seen` not in the future, and has the room stepped fewer than 16 times since (the ring still
 * covers it)? A room that was not stepping, say while its only hero was in a slide, kept its entities
 * where the client saw them. (The plan also bounds `seen` by the hero's last heroTick; a hero standing
 * still sends no UPs, so the server's tick is the bound used.)
 */
export const seenOk = (room: Room, now: number, seen: number): boolean => {
  if (seen > now) return false;
  let steps = 0;
  for (let i = 0; i < RING_TICKS; i += 1) if ((room.ringTick[i] as number) > seen) steps += 1;
  return steps < RING_TICKS;
};

/** `claimReaches` results. */
export const REACH = { no: 0, yes: 1, gone: 2 } as const;

/**
 * Could the hero's attack have reached target `t` (an entity id < 128, or 128 + tile index)? The
 * attack box comes from the hero's validated position; an entity's position from the ring at `seen`.
 * `gone`: no such target any more (killed or collected by a claim that arrived first).
 */
export const claimReaches = (room: Room, h: HeroRec, attack: number, dir: number, t: number, seen: number): number => {
  const hit = reaches(room, h, attack, dir, t, seen);
  return hit < 0 ? REACH.gone : hit > 0 ? REACH.yes : REACH.no;
};

const reaches = (room: Room, h: HeroRec, attack: number, dir: number, t: number, seen: number): number => {
  const s = CHECK.slack;
  let tx: number;
  let ty: number;
  let hw: number;
  let hh: number;
  if (t >= 128) {
    const tile = t - 128;
    if (tile >= 108) return -1;
    if (((TILE_FLAGS[room.tiles[tile] as number] ?? 0) & (F.CUT | F.HITTABLE)) === 0) return -1;
    tx = (tile % 12) * 256 + 128;
    ty = Math.floor(tile / 12) * 256 + 128;
    hw = 128;
    hh = 128;
  } else {
    const e = enemyById(room, t);
    if (e) {
      if (!targetAt(room, t, seen, pos)) {
        pos[0] = e.x;
        pos[1] = e.y;
      }
      tx = pos[0] as number;
      ty = pos[1] as number;
      hw = entHalf(e.kind);
      hh = entHalfY(e.kind);
    } else {
      // A pickup the hook drags in.
      if (attack !== Attack.Hook) return -1;
      let found = false;
      tx = 0;
      ty = 0;
      for (let i = 0; i < CAP.pickups; i += 1) {
        const k = room.pk[i]!;
        if (k.on === 0 || k.id !== t) continue;
        tx = k.x;
        ty = k.y;
        found = true;
      }
      if (!found) return -1;
      hw = 96;
      hh = 96;
    }
  }
  if (attack === Attack.Slash) {
    slashBox(h.x, h.y, dir & 3, box);
    return Math.abs(tx - (box[0] as number)) < (box[2] as number) + hw + s && Math.abs(ty - (box[1] as number)) < (box[3] as number) + hh + s ? 1 : 0;
  }
  const cx = h.x;
  const cy = h.y - 64;
  if (attack === Attack.Spin) {
    const r = HERO_RULES.spinRadius + Math.max(hw, hh) + s;
    const dx = tx - cx;
    const dy = ty - cy;
    return dx * dx + dy * dy <= r * r ? 1 : 0;
  }
  if (attack === Attack.Hook) {
    const fx = DX4[dir & 3] as number;
    const fy = DY4[dir & 3] as number;
    const along = (tx - cx) * fx + (ty - cy) * fy;
    const across = Math.abs((tx - cx) * fy - (ty - cy) * fx);
    return along >= -s && along <= HERO_RULES.hookRange + Math.max(hw, hh) + s && across <= Math.max(hw, hh) + s ? 1 : 0;
  }
  return 0;
};

/**
 * Could `source` have hurt the hero (bellwick.md §3.5, Damage)? An enemy is checked where the ring had
 * it at `seen`. Projectiles and slam rings are drawn at the client's current tick, which is later than
 * `seen` by about a round trip, so their paths are checked from `seen` to `now`. A repel shot (no damage)
 * ignores invincibility; real hurts allow 3 ticks of it for jitter between the two clocks.
 */
export const hurtPossible = (room: Room, h: HeroRec, source: number, seen: number, now: number, repel: boolean): boolean => {
  if (h.status !== Status.Active || h.transitT > 0 || (!repel && h.iframes > 3)) return false;
  const cx = h.x;
  const cy = h.y - 64;
  const r = CHECK.hurtRange + CHECK.slack;
  if (source === 0xfe) {
    // A pit under the feet box (expanded by the slack).
    const e = HERO_RULES.feetHW + CHECK.slack;
    return wallAt(room.tiles, h.x - e, h.y, F.PIT) || wallAt(room.tiles, h.x + e, h.y, F.PIT) || wallAt(room.tiles, h.x, h.y - e, F.PIT) || wallAt(room.tiles, h.x, h.y + e, F.PIT) || wallAt(room.tiles, h.x, h.y, F.PIT);
  }
  if (source >= 0xf0) {
    // A slam ring: its band must have been near the hero.
    for (let i = 0; i < CAP.shocks; i += 1) {
      const sh = room.sh[i]!;
      if (sh.on === 0) continue;
      const d = Math.sqrt((sh.x - cx) * (sh.x - cx) + (sh.y - cy) * (sh.y - cy));
      const r0 = BOSS_RULES.ringSpeed * Math.max(0, seen - sh.t0);
      const r1 = BOSS_RULES.ringSpeed * Math.max(0, now - sh.t0);
      if (d >= r0 - BOSS_RULES.ringBand - r && d <= r1 + BOSS_RULES.ringBand + r) return true;
    }
    return false;
  }
  for (let i = 0; i < CAP.projectiles; i += 1) {
    const p = room.pr[i]!;
    if (p.on === 0 || p.id !== source) continue;
    return pathNear(p.x0, p.y0, p.dir, p.kind, Math.max(0, seen - p.t0), Math.max(0, now - p.t0), cx, cy, r);
  }
  const e = enemyById(room, source);
  if (!e) return false;
  if (!targetAt(room, source, seen, pos)) {
    pos[0] = e.x;
    pos[1] = e.y;
  }
  const rx = r + entHalf(e.kind);
  const ry = r + entHalfY(e.kind);
  return Math.abs((pos[0] as number) - cx) <= rx && Math.abs((pos[1] as number) - cy) <= ry;
};

/** Did a projectile's path between ticks t0 and t1 (since it was thrown) pass within `r` of (cx, cy)? */
const pathNear = (x0: number, y0: number, dir: number, kind: number, t0: number, t1: number, cx: number, cy: number, r: number): boolean => {
  for (let t = t0; t <= t1; t += 1) {
    if (Math.abs(projX(x0, dir, kind, t) - cx) <= r && Math.abs(projY(y0, dir, kind, t) - cy) <= r) return true;
  }
  return false;
};

/** Could the hero's Buckler have stopped projectile `id` between `seen` and `now`, in front of the hero? */
export const blockPossible = (room: Room, h: HeroRec, id: number, seen: number, now: number, buckler: boolean): boolean => {
  if (!buckler || h.status !== Status.Active) return false;
  const r = CHECK.blockRange + CHECK.slack;
  for (let i = 0; i < CAP.projectiles; i += 1) {
    const p = room.pr[i]!;
    if (p.on === 0 || p.id !== id) continue;
    for (let t = Math.max(0, seen - p.t0); t <= Math.max(0, now - p.t0); t += 1) {
      const dx = projX(p.x0, p.dir, p.kind, t) - h.x;
      const dy = projY(p.y0, p.dir, p.kind, t) - (h.y - 64);
      // In front: not behind the hero's facing by more than the slack.
      if (Math.abs(dx) <= r && Math.abs(dy) <= r && dx * (DX4[h.facing] as number) + dy * (DY4[h.facing] as number) >= -CHECK.slack) return true;
    }
    return false;
  }
  return false;
};
