/**
 * Own-fighter prediction and reconciliation (fuseyard.md §3.6), online only. The predicted position
 * is the server's position replayed through the shared movement step (tryMove, belts, ice, pads) with
 * every sent input the server has not applied yet (seq > ackUp). Kicks are not predicted: a bomb
 * blocks until BombKicked arrives. Errors under 32 units blend out at 25 % per frame; larger ones snap.
 */
import { seqNewer } from '@arcade/core/bytes';
import { ARENAS } from '@arcade/core/fuseyard/arenas';
import { CELLS, HIT_HALF, MAX_BOMBS, Phase, W, cellAt, type Dir } from '@arcade/core/fuseyard/rules';
import { moveFighter, newMoveOut, type MoveBoard, type Mover } from '@arcade/core/fuseyard/sim';
import type { WBomb, World } from '@arcade/core/fuseyard/view';

const RING = 64;
const SNAP = 32;

export interface Predictor {
  /** An input this client sent (one per tick, with its seq). */
  sent(seq: number, input: number): void;
  /** Re-run from the server's position after a FRAME or KEYFRAME was applied. */
  reconcile(w: World, slot: number, ackUp: number): void;
  /** Called once per rendered frame: blends the correction out. */
  frame(): void;
  readonly x: number;
  readonly y: number;
  readonly rawX: number;
  readonly rawY: number;
  /** Pending inputs (for tests). */
  readonly pending: number;
  reset(): void;
}

export const createPredictor = (): Predictor => {
  const seqs = new Uint16Array(RING);
  const inputs = new Uint8Array(RING);
  let count = 0;
  let head = 0;
  let px = 0;
  let py = 0;
  let ex = 0;
  let ey = 0;
  let have = false;
  const board: MoveBoard = {
    cells: new Uint8Array(CELLS),
    special: new Uint8Array(CELLS),
    bombAt: new Int8Array(CELLS),
    bombPass: new Uint8Array(MAX_BOMBS),
    padPartner: new Int16Array(CELLS),
    beltDir: new Uint8Array(CELLS),
  };
  const out = newMoveOut();
  const mover: Mover = { slot: 0, x: 0, y: 0, facing: 3 as Dir, moving: false, speedLvl: 0, glove: false, padCooldown: 0 };
  let lastWorld: World | null = null;
  let lastSlot = 0;

  const overlaps = (x: number, y: number, c: number): boolean => {
    const left = (c % W) << 6;
    const top = ((c / W) | 0) << 6;
    return x + HIT_HALF > left && x - HIT_HALF < left + 64 && y + HIT_HALF > top && y - HIT_HALF < top + 64;
  };

  /** `correct`: a new server state for the same inputs, so the change is a correction to blend out. */
  const replay = (w: World, slot: number, correct: boolean): void => {
    const f = w.fight[slot];
    if (!f) return;
    const arena = ARENAS[w.arena];
    if (!arena) return;
    board.cells.set(w.cells);
    board.special = arena.special;
    board.padPartner = arena.padPartner;
    board.beltDir = arena.beltDir;
    board.bombAt.fill(-1);
    for (let i = 0; i < w.bombCount; i += 1) {
      const b = w.bombs[i] as WBomb;
      const c = cellAt(b.x, b.y);
      board.bombAt[c] = i;
      // The fighter may walk off a bomb it stands on, as it did when the bomb appeared under it.
      board.bombPass[i] = overlaps(f.x, f.y, c) ? 1 << slot : 0;
    }
    mover.slot = slot;
    mover.x = f.x;
    mover.y = f.y;
    mover.facing = f.facing as Dir;
    mover.moving = f.moving;
    mover.speedLvl = f.speedLvl;
    mover.padCooldown = Math.max(0, f.padEnd - w.roundTick);
    if (f.alive && f.seat === 0 && w.phase === Phase.Playing) {
      for (let k = 0; k < count; k += 1) {
        const i = (head - count + k + RING) % RING;
        if (mover.padCooldown > 0) mover.padCooldown -= 1;
        moveFighter(board, mover, inputs[i] as number, out);
      }
    }
    const nx = mover.x;
    const ny = mover.y;
    if (have && correct) {
      const dx = px + ex - nx;
      const dy = py + ey - ny;
      if (Math.abs(dx) < SNAP && Math.abs(dy) < SNAP) {
        ex = dx;
        ey = dy;
      } else {
        ex = 0;
        ey = 0;
      }
    }
    px = nx;
    py = ny;
    have = true;
  };

  return {
    sent(seq, input) {
      seqs[head] = seq;
      inputs[head] = input;
      head = (head + 1) % RING;
      if (count < RING) count += 1;
      if (lastWorld) replay(lastWorld, lastSlot, false);
    },
    reconcile(w, slot, ackUp) {
      // Drop what the server has applied.
      let keep = 0;
      for (let k = 0; k < count; k += 1) {
        const i = (head - count + k + RING) % RING;
        if (seqNewer(seqs[i] as number, ackUp)) {
          keep = count - k;
          break;
        }
      }
      count = keep;
      lastWorld = w;
      lastSlot = slot;
      replay(w, slot, true);
    },
    frame() {
      ex *= 0.75;
      ey *= 0.75;
      if (Math.abs(ex) < 0.5) ex = 0;
      if (Math.abs(ey) < 0.5) ey = 0;
    },
    get x() {
      return px + ex;
    },
    get y() {
      return py + ey;
    },
    /** The prediction without the blended correction (tests). */
    get rawX() {
      return px;
    },
    get rawY() {
      return py;
    },
    get pending() {
      return count;
    },
    reset() {
      count = 0;
      have = false;
      ex = ey = 0;
      lastWorld = null;
    },
  };
};
