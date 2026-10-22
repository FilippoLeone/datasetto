/**
 * A map-level reachability search for the content test and the soft-lock solver: which (room, tile)
 * a hero can stand on with a given set of abilities and opened doors. Walking, ledges (south only),
 * doors, screen edges, and Vinehook pulls (a post within 4 tiles in a straight line, nothing solid in
 * between, firm ground in front of it). Gloam Gate's corridor needs the Buckler. Block puzzles and
 * switch shutters count as solvable once their room is reached (the bot proves them by play).
 */
import { T } from '../../../src/arcade/core/bellwick/content/legend.js';
import { content, flaggedTile, screen, type ScreenDef } from '../../../src/arcade/core/bellwick/content/parse.js';
import { edgeOpen, F, TILE_FLAGS, walkable } from '../../../src/arcade/core/bellwick/rules.js';

export interface Abilities {
  sword: boolean;
  buckler: boolean;
  hook: boolean;
  /** Flags set (locks opened, shutters, the crystal bridge). */
  flags: ReadonlySet<number>;
}

const DX = [0, 0, -1, 1];
const DY = [1, -1, 0, 0];

const GATE = content().byKey.gate as ScreenDef;
const corridor = (room: number, t: number): boolean => room === GATE.id && (t % 12 === 5 || t % 12 === 6) && Math.floor(t / 12) >= 2 && Math.floor(t / 12) <= 4;

export const stand = (code: number): boolean => walkable(code) || ((TILE_FLAGS[code] ?? 0) & F.WARP) !== 0;

/** Tiles a hero can stand on, as a set of room × 108 + tile. */
export const reach = (a: Abilities): Set<number> => {
  const seen = new Set<number>();
  const shutterOpen = new Set<number>();
  // Two passes: a shutter opens once its room is reached (its switches are inside).
  for (let pass = 0; pass < 3; pass += 1) {
    const c = content();
    const code = (room: number, t: number): number => {
      const def = screen(room);
      let v = flaggedTile(def, t, (id) => a.flags.has(id));
      if (v === T.SHUTTER && shutterOpen.has(room)) v = T.SHUTTER_OPEN;
      if (v === T.BRIDGE_OFF && a.hook && shutterOpen.has(room)) v = T.BRIDGE_ON;
      if (v === T.BLOCK) v = T.FLOOR;
      if (a.sword && ((TILE_FLAGS[v] ?? 0) & F.CUT) !== 0 && v !== T.POT) v = T.STUBBLE;
      return v;
    };
    const ok = (room: number, t: number): boolean => stand(code(room, t)) && (!corridor(room, t) || a.buckler);
    const queue: number[] = [c.startRoom * 108 + c.startTile];
    seen.clear();
    seen.add(queue[0] as number);
    for (let head = 0; head < queue.length; head += 1) {
      const node = queue[head] as number;
      const room = Math.floor(node / 108);
      const t = node % 108;
      const def = screen(room);
      if (def.shutterFlag >= 0) shutterOpen.add(room);
      if (def.crystal) shutterOpen.add(room);
      const push = (r2: number, t2: number): void => {
        const n = r2 * 108 + t2;
        if (seen.has(n)) return;
        seen.add(n);
        queue.push(n);
      };
      if (((TILE_FLAGS[code(room, t)] ?? 0) & F.WARP) !== 0 && head > 0) {
        const w = def.warps.find((x) => x.tile === t);
        if (w) push(w.to, w.tile2);
        continue;
      }
      const tx = t % 12;
      const ty = Math.floor(t / 12);
      for (let d = 0; d < 4; d += 1) {
        const nx = tx + (DX[d] as number);
        const ny = ty + (DY[d] as number);
        if (nx >= 0 && ny >= 0 && nx < 12 && ny < 9) {
          const t2 = ny * 12 + nx;
          if (code(room, t2) === T.LEDGE) {
            if (d === 0 && ny + 1 < 9 && ok(room, t2 + 12)) push(room, t2 + 12);
            continue;
          }
          if (ok(room, t2)) push(room, t2);
          // A Vinehook pull to the tile in front of a post up to 4 tiles away.
          if (a.hook) {
            for (let k = 1; k <= 4; k += 1) {
              const px = tx + (DX[d] as number) * k;
              const py = ty + (DY[d] as number) * k;
              if (px < 0 || py < 0 || px >= 12 || py >= 9) break;
              const pc = code(room, py * 12 + px);
              if (pc === T.POST && k >= 2) {
                const land = (py - (DY[d] as number)) * 12 + (px - (DX[d] as number));
                if (ok(room, land)) push(room, land);
                break;
              }
              if (((TILE_FLAGS[pc] ?? 1) & F.SOLID) !== 0) break;
            }
          }
          continue;
        }
        const pos = d < 2 ? tx : ty;
        const ex = def.exits[d];
        if (ex) {
          push(ex.to, ex.tile2);
          continue;
        }
        const to = def.near[d] as number;
        if (to < 0) continue;
        const t2 = d === 0 ? pos : d === 1 ? 96 + pos : d === 2 ? pos * 12 + 11 : pos * 12;
        if (edgeOpen(code(to, t2)) && ok(to, t2)) push(to, t2);
      }
    }
  }
  return seen;
};

/** Can a hero stand next to `tile` in `room` (to open, read or talk to it)? */
export const besideReachable = (seen: ReadonlySet<number>, room: number, tile: number): boolean => {
  const tx = tile % 12;
  const ty = Math.floor(tile / 12);
  for (let d = 0; d < 4; d += 1) {
    const nx = tx + (DX[d] as number);
    const ny = ty + (DY[d] as number);
    if (nx >= 0 && ny >= 0 && nx < 12 && ny < 9 && seen.has(room * 108 + ny * 12 + nx)) return true;
  }
  return false;
};
