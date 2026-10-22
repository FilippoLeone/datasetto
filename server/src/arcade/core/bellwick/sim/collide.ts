/**
 * Tile collision for heroes and enemies (bellwick.md §3.2). Integer sub units; boxes are given by
 * their centre and half sizes. Movement resolves X first, then Y; a hero blocked by a corner it
 * overlaps by 5 px or less is nudged 1 px per tick around it.
 *
 * Outside the 12 × 9 grid a tile is solid, except past an open screen edge: `edges` tells which
 * edge positions lead somewhere (the hero may then step off the screen and the caller starts a
 * room change).
 */
import { F, TILE_FLAGS } from '../rules.js';
import { ROOM_H_SUB, ROOM_W_SUB, SCREEN_H, SCREEN_W, TILE_SUB } from '../types.js';

/** Edge exits, one bit per tile position along each edge: [south (x), north (x), west (y), east (y)]. */
export type EdgeMask = Int32Array;

export const SOLID_WALKER = F.SOLID | F.WATER | F.PIT | F.LEDGE_S;
export const SOLID_HERO = F.SOLID | F.WATER | F.LEDGE_S;
export const SOLID_FLIER = F.SOLID;

export const flagsAt = (tiles: Uint8Array, tx: number, ty: number): number => {
  if (tx < 0 || ty < 0 || tx >= SCREEN_W || ty >= SCREEN_H) return F.SOLID;
  return TILE_FLAGS[tiles[ty * SCREEN_W + tx] as number] ?? F.SOLID;
};

/** Flags of the tile under a sub position (off-grid: solid). */
export const flagsAtSub = (tiles: Uint8Array, x: number, y: number): number => flagsAt(tiles, x >> 8, y >> 8);

/** Is tile (tx, ty) blocked for `mask`, counting open screen edges as free? */
const blockedTile = (tiles: Uint8Array, tx: number, ty: number, mask: number, edges: EdgeMask | null): boolean => {
  if (tx >= 0 && ty >= 0 && tx < SCREEN_W && ty < SCREEN_H) return ((TILE_FLAGS[tiles[ty * SCREEN_W + tx] as number] ?? 1) & mask) !== 0;
  if (!edges) return true;
  // One step outside an edge, in line with an open position.
  if (ty === SCREEN_H && tx >= 0 && tx < SCREEN_W) return ((edges[0] as number) & (1 << tx)) === 0;
  if (ty === -1 && tx >= 0 && tx < SCREEN_W) return ((edges[1] as number) & (1 << tx)) === 0;
  if (tx === -1 && ty >= 0 && ty < SCREEN_H) return ((edges[2] as number) & (1 << ty)) === 0;
  if (tx === SCREEN_W && ty >= 0 && ty < SCREEN_H) return ((edges[3] as number) & (1 << ty)) === 0;
  return true;
};

/** Does the box overlap any tile blocked for `mask`? Box edges are half-open: [x − hw, x + hw). */
export const boxBlocked = (tiles: Uint8Array, x: number, y: number, hw: number, hh: number, mask: number, edges: EdgeMask | null): boolean => {
  const x0 = (x - hw) >> 8;
  const x1 = (x + hw - 1) >> 8;
  const y0 = (y - hh) >> 8;
  const y1 = (y + hh - 1) >> 8;
  for (let ty = y0; ty <= y1; ty += 1) {
    for (let tx = x0; tx <= x1; tx += 1) {
      if (blockedTile(tiles, tx, ty, mask, edges)) return true;
    }
  }
  return false;
};

/** Result of a move: the blocked axes. */
export const MOVE = { x: 1, y: 2 } as const;

/**
 * Moves a box by (dx, dy), X first then Y, stopping at the last free sub on each axis. Returns the
 * blocked-axis bits. Writes the new position into `pos` ([x, y]).
 */
export const moveBox = (
  tiles: Uint8Array,
  pos: Int32Array,
  dx: number,
  dy: number,
  hw: number,
  hh: number,
  mask: number,
  edges: EdgeMask | null,
): number => {
  let blocked = 0;
  let x = pos[0] as number;
  let y = pos[1] as number;
  if (dx !== 0) {
    const step = dx > 0 ? 1 : -1;
    // Try the whole move; on a hit, back off to the tile boundary (at most 2 tiles per tick).
    if (!boxBlocked(tiles, x + dx, y, hw, hh, mask, edges)) x += dx;
    else {
      blocked |= MOVE.x;
      let lo = 0;
      let hi = dx * step;
      for (let i = 0; i < 12 && hi - lo > 1; i += 1) {
        const mid = (lo + hi) >> 1;
        if (boxBlocked(tiles, x + mid * step, y, hw, hh, mask, edges)) hi = mid;
        else lo = mid;
      }
      x += lo * step;
    }
  }
  if (dy !== 0) {
    const step = dy > 0 ? 1 : -1;
    if (!boxBlocked(tiles, x, y + dy, hw, hh, mask, edges)) y += dy;
    else {
      blocked |= MOVE.y;
      let lo = 0;
      let hi = dy * step;
      for (let i = 0; i < 12 && hi - lo > 1; i += 1) {
        const mid = (lo + hi) >> 1;
        if (boxBlocked(tiles, x, y + mid * step, hw, hh, mask, edges)) hi = mid;
        else lo = mid;
      }
      y += lo * step;
    }
  }
  pos[0] = x;
  pos[1] = y;
  return blocked;
};

/**
 * Corner nudge (bellwick.md §3.2): moving along one axis and blocked, if sliding by at most `nudge` sub
 * sideways frees the way, step `speed` sub towards it. Returns the sideways step taken (0 if none).
 */
export const cornerNudge = (
  tiles: Uint8Array,
  x: number,
  y: number,
  axisX: boolean,
  dir: number,
  hw: number,
  hh: number,
  mask: number,
  edges: EdgeMask | null,
  nudge: number,
  speed: number,
): number => {
  for (let side = -1; side <= 1; side += 2) {
    for (let off = 16; off <= nudge; off += 16) {
      const nx = axisX ? x : x + side * off;
      const ny = axisX ? y + side * off : y;
      if (boxBlocked(tiles, nx, ny, hw, hh, mask, edges)) break;
      const fx = axisX ? nx + dir * 16 : nx;
      const fy = axisX ? ny : ny + dir * 16;
      if (!boxBlocked(tiles, fx, fy, hw, hh, mask, edges)) return side * speed;
    }
  }
  return 0;
};

/** Ray along a row or column (bellwick.md §1.5 line of sight): every tile strictly between is free for `mask`. */
export const clearLine = (tiles: Uint8Array, tx0: number, ty0: number, tx1: number, ty1: number, mask: number): boolean => {
  if (tx0 !== tx1 && ty0 !== ty1) return false;
  const n = Math.abs(tx1 - tx0) + Math.abs(ty1 - ty0);
  const sx = Math.sign(tx1 - tx0);
  const sy = Math.sign(ty1 - ty0);
  for (let i = 1; i < n && i <= 12; i += 1) {
    if ((flagsAt(tiles, tx0 + sx * i, ty0 + sy * i) & mask) !== 0) return false;
  }
  return true;
};

export const inRoom = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < ROOM_W_SUB && y < ROOM_H_SUB;
export const tileOf = (x: number, y: number): number => (y >> 8) * SCREEN_W + (x >> 8);
export const tileCenterX = (tile: number): number => (tile % SCREEN_W) * TILE_SUB + 128;
export const tileCenterY = (tile: number): number => Math.floor(tile / SCREEN_W) * TILE_SUB + 128;

/** Axis-aligned boxes overlap (centres and half sizes). */
export const overlap = (ax: number, ay: number, ahw: number, ahh: number, bx: number, by: number, bhw: number, bhh: number): boolean =>
  ax - ahw < bx + bhw && bx - bhw < ax + ahw && ay - ahh < by + bhh && by - bhh < ay + ahh;
