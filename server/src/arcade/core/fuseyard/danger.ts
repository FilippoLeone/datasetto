/**
 * The danger map (fuseyard.md §7): for every cell the window, in ticks from now, during which it
 * will hold flame. Shared by the bots (inside `step`) and the client's blast lanes, so it reads only
 * public state. Preallocated; one build is a few microseconds even with 32 bombs.
 *
 * Time 1 is the current step's death check: a flame with L ticks left covers [0, L]; a bomb whose
 * fuse reads f covers its footprint during [f, f + 15]. A bomb in another's footprint takes the
 * shorter time (chains, at most 32 passes, stopping once stable). A warned steel cell is dangerous
 * from its drop on, for good, and so are the next spiral cells due within 5 s (Closing Time is
 * fully predictable).
 *
 * A remote bomb has no time: its holder may press at any moment. Its footprint, and that of every
 * bomb it would set off, is flagged in `dRemote` with the holder's slot bit instead: never safe to
 * stand in; a bot crosses another holder's footprint only on its way out of one.
 */
import { SPIRAL } from './arenas.js';
import { CELLS, CLOSE_EVERY, Cell, DX, DY, FLAME, MAX_BOMBS, REMOTE, SPIRAL_CELLS, W, WARN_TICKS, cellAt } from './rules.js';

export const NEVER = 0xffff;
/** Time of a bomb that only goes off when its holder presses. */
const UNTIMED = NEVER - 32;
/** Longest footprint: the bomb cell plus 4 arms of range 8. */
const FOOT = 33;

/** What the map reads (a bot's round view or the client's world). */
export interface DangerInput {
  cells: Uint8Array;
  items: Uint8Array;
  /** Flame ticks left per cell. */
  flame: Uint8Array;
  /** Ticks until a warned cell drops as steel, 0 when not warned. */
  warn: Uint8Array;
  bombCount: number;
  bombs: readonly { x: number; y: number; fuse: number; range: number; owner: number }[];
  /** Closing Time, for drops not yet warned: the round tick, the next warning's tick and its spiral index. */
  tick?: number;
  nextDropTick?: number;
  spiralIndex?: number;
}

/** Steel drops that far ahead (ticks) are part of the map. */
const STEEL_HORIZON = 150;

export const dFrom = new Uint16Array(CELLS);
export const dTo = new Uint16Array(CELLS);
/** Slot bits of the holders whose remote bombs (or bombs those set off) could burn a cell at any moment. */
export const dRemote = new Uint8Array(CELLS);
/** Effective explosion time of each bomb (pool index), chains applied; UNTIMED for remote ones. */
export const bombTime = new Uint16Array(MAX_BOMBS);
/** Holder slot bits of a remote bomb, or of the remote bombs that would set it off. */
export const bombRemote = new Uint8Array(MAX_BOMBS);
/** Footprint cells of each bomb: `footLen[i]` cells from `i * 33`. */
export const footCells = new Int16Array(MAX_BOMBS * FOOT);
export const footLen = new Uint8Array(MAX_BOMBS);
/** Pool index of the bomb at the end of each arm (4 per bomb), -1 for none. */
const chainTo = new Int8Array(MAX_BOMBS * 4);

/** Is `c` free of every known danger, timed or remote? */
export const isSafe = (c: number): boolean => (dFrom[c] as number) === NEVER && dRemote[c] === 0;

/**
 * Walks a blast from `from` with `range` into `out` (at `at`); returns the cell count. Arms stop
 * before walls, pillars and steel, and on blocks, bombs and items. `hit` (if given) receives the
 * pool index of the bomb ending each arm.
 */
export const walkBlast = (
  cells: Uint8Array,
  bombAt: Int8Array,
  items: Uint8Array,
  from: number,
  range: number,
  out: Int16Array,
  at: number,
  hit: Int8Array | null,
  hitAt: number,
): number => {
  out[at] = from;
  let n = 1;
  for (let d = 1; d <= 4; d += 1) {
    const step = (DX[d] as number) + (DY[d] as number) * W;
    if (hit) hit[hitAt + d - 1] = -1;
    for (let k = 1; k <= range; k += 1) {
      const c = from + step * k;
      const cell = cells[c] as number;
      if (cell === Cell.Wall || cell === Cell.Pillar || cell === Cell.Steel) break;
      out[at + n] = c;
      n += 1;
      if (cell === Cell.Block) break;
      const bi = bombAt[c] as number;
      if (bi >= 0) {
        if (hit) hit[hitAt + d - 1] = bi;
        break;
      }
      if ((items[c] as number) !== 0) break;
    }
  }
  return n;
};

/** Is `target` inside the blast of a bomb at `from` with `range`? */
export const footprintHas = (cells: Uint8Array, bombAt: Int8Array, items: Uint8Array, from: number, range: number, target: number): boolean => {
  if (from === target) return true;
  const fx = from % W;
  const fy = (from / W) | 0;
  const tx = target % W;
  const ty = (target / W) | 0;
  if (fx !== tx && fy !== ty) return false;
  const dist = fx === tx ? Math.abs(fy - ty) : Math.abs(fx - tx);
  if (dist > range) return false;
  const step = fx === tx ? (ty > fy ? W : -W) : tx > fx ? 1 : -1;
  for (let k = 1; k <= dist; k += 1) {
    const c = from + step * k;
    const cell = cells[c] as number;
    if (cell === Cell.Wall || cell === Cell.Pillar || cell === Cell.Steel) return false;
    if (c === target) return true;
    if (cell === Cell.Block || (bombAt[c] as number) >= 0 || (items[c] as number) !== 0) return false;
  }
  return false;
};

const mark = (c: number, from: number, to: number): void => {
  if (from < (dFrom[c] as number)) dFrom[c] = from;
  if (to > (dTo[c] as number)) dTo[c] = to;
};

/** Rebuilds the map, `bombTime` and the footprints. `bombAt` maps cells to pool indices. */
export const buildDanger = (d: DangerInput, bombAt: Int8Array): void => {
  dFrom.fill(NEVER);
  dTo.fill(0);
  dRemote.fill(0);
  for (let c = 0; c < CELLS; c += 1) {
    const fl = d.flame[c] as number;
    if (fl > 0) mark(c, 0, fl);
    const w = d.warn[c] as number;
    if (w > 0) mark(c, w, NEVER - 1);
  }
  if (d.tick !== undefined && d.nextDropTick !== undefined && d.spiralIndex !== undefined) {
    for (let k = d.spiralIndex; k < SPIRAL_CELLS; k += 1) {
      const t = d.nextDropTick + CLOSE_EVERY * (k - d.spiralIndex) + WARN_TICKS - d.tick;
      if (t > STEEL_HORIZON) break;
      if (t >= 0) mark(SPIRAL[k] as number, t, NEVER - 1);
    }
  }
  const n = d.bombCount < MAX_BOMBS ? d.bombCount : MAX_BOMBS;
  for (let i = 0; i < n; i += 1) {
    const b = d.bombs[i] as DangerInput['bombs'][number];
    const remote = b.fuse === REMOTE;
    bombRemote[i] = remote ? 1 << (b.owner & 3) : 0;
    bombTime[i] = remote ? UNTIMED : b.fuse < 0 ? 0 : b.fuse > UNTIMED ? UNTIMED : b.fuse;
    footLen[i] = walkBlast(d.cells, bombAt, d.items, cellAt(b.x, b.y), b.range, footCells, i * FOOT, chainTo, i * 4);
  }
  for (let pass = 0; pass < 32; pass += 1) {
    let changed = false;
    for (let i = 0; i < n; i += 1) {
      const t = bombTime[i] as number;
      const r = bombRemote[i] as number;
      for (let k = 0; k < 4; k += 1) {
        const j = chainTo[i * 4 + k] as number;
        if (j < 0 || j >= n) continue;
        if ((bombTime[j] as number) > t) {
          bombTime[j] = t;
          changed = true;
        }
        if ((r & ~(bombRemote[j] as number)) !== 0) {
          bombRemote[j] = (bombRemote[j] as number) | r;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  for (let i = 0; i < n; i += 1) {
    const t = bombTime[i] as number;
    const base = i * FOOT;
    const len = footLen[i] as number;
    const timed = t < UNTIMED;
    const remote = bombRemote[i] as number;
    for (let k = 0; k < len; k += 1) {
      const c = footCells[base + k] as number;
      if (timed) mark(c, t, t + FLAME);
      if (remote !== 0) dRemote[c] = (dRemote[c] as number) | remote;
    }
  }
};

/** Does bomb `i`'s last-built footprint contain `c`? */
export const footContains = (i: number, c: number): boolean => {
  const base = i * FOOT;
  const len = footLen[i] as number;
  for (let k = 0; k < len; k += 1) if ((footCells[base + k] as number) === c) return true;
  return false;
};

/** Pool index of the bomb ending arm `k` (0–3) of bomb `i` in the last build, or -1. */
export const chainOf = (i: number, k: number): number => chainTo[i * 4 + k] as number;

export const FOOTPRINT_MAX = FOOT;
