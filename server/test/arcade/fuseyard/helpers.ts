/**
 * Scenario builders for Fuseyard's rule tests: a match on a cleared board with fighters and bombs
 * placed by hand, plus small drivers that steer a fighter along cells.
 */
import { ARENAS, arenaIndex } from '../../../src/arcade/core/fuseyard/arenas.js';
import {
  CELLS,
  Cell,
  Control,
  DX,
  DY,
  Dir,
  FUSE,
  Phase,
  REMOTE,
  SeatCmd,
  W,
  cellAt,
  inputByte,
  newStepIn,
  type ArenaId,
  type Bomb,
  type Fighter,
  type Match,
  type MatchConfig,
  type StepIn,
} from '../../../src/arcade/core/fuseyard/rules.js';
import { createMatch, step } from '../../../src/arcade/core/fuseyard/sim.js';

export const xy = (x: number, y: number): number => y * W + x;
export const cx = (c: number): number => ((c % W) << 6) + 32;
export const cy = (c: number): number => (((c / W) | 0) << 6) + 32;

export interface ScenarioOpts {
  arena?: ArenaId;
  fighters?: 2 | 3 | 4;
  mode?: 'brawl' | 'quickfire';
  /** Slots that are humans (inputs from the test); the rest are bots unless `idleBots`. */
  humans?: readonly number[];
  seed?: number;
  /** Keep the random blocks and items (default: a cleared board). */
  keepBlocks?: boolean;
  winsNeeded?: 2 | 3 | 5;
}

/**
 * A match in the playing phase on the arena's fixed cells (random blocks removed unless
 * `keepBlocks`). All seated fighters are humans by default, standing still.
 */
export const scenario = (o: ScenarioOpts = {}): Match => {
  const fighters = o.fighters ?? 2;
  const config: MatchConfig = {
    mode: o.mode ?? 'brawl',
    arena: o.arena ?? 'yard',
    fighters,
    winsNeeded: o.winsNeeded ?? 3,
    botLevel: 1,
    seed: o.seed ?? 12345,
  };
  const humans = o.humans ?? [0, 1, 2, 3].slice(0, fighters);
  const m = createMatch(
    config,
    [0, 1, 2, 3].slice(0, fighters).map((slot) => ({ slot, human: humans.includes(slot), botLevel: 1 })),
  );
  const r = m.current;
  if (!o.keepBlocks) {
    const a = ARENAS[arenaIndex(config.arena as ArenaId)]!;
    r.cells.set(a.cells);
    r.hidden.fill(0);
    r.items.fill(0);
  }
  r.phase = Phase.Playing;
  r.phaseTicks = 0;
  return m;
};

export const fighter = (m: Match, slot: number): Fighter => m.current.fighters[slot]!;

/** Puts a fighter at a cell's centre. */
export const place = (m: Match, slot: number, cell: number): Fighter => {
  const f = fighter(m, slot);
  f.x = cx(cell);
  f.y = cy(cell);
  f.alive = true;
  return f;
};

/** Adds a bomb directly into the pool. */
export const addBomb = (m: Match, owner: number, cell: number, o: { fuse?: number; range?: number; passers?: number } = {}): Bomb => {
  const r = m.current;
  const b = r.bombs[r.bombCount]!;
  b.id = r.nextBombId++;
  b.owner = owner;
  b.x = cx(cell);
  b.y = cy(cell);
  b.fuse = o.fuse ?? FUSE;
  b.range = o.range ?? 2;
  b.slideDir = Dir.None;
  b.slideSpeed = 0;
  b.passers = o.passers ?? 0;
  r.bombCount += 1;
  fighter(m, owner).bombsOut += 1;
  return b;
};

export const removeAllBombs = (m: Match): void => {
  m.current.bombCount = 0;
  for (const f of m.current.fighters) f.bombsOut = 0;
};

export const setCell = (m: Match, cell: number, kind: number): void => {
  m.current.cells[cell] = kind;
};

/** Steps with the given per-slot inputs (default 0) `n` times; returns the events of every tick. */
export const run = (m: Match, n: number, inputs: Partial<Record<number, number>> = {}, input: StepIn = newStepIn()): Uint8Array[] => {
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i += 1) {
    for (let s = 0; s < 4; s += 1) input.inputs[s] = inputs[s] ?? 0;
    step(m, input);
    input.seats.fill(SeatCmd.None);
    out.push(m.events.slice(0, m.eventsLen));
  }
  return out;
};

/** One step with seat commands. */
export const seatStep = (m: Match, seats: Partial<Record<number, number>>, inputs: Partial<Record<number, number>> = {}): Uint8Array => {
  const input = newStepIn();
  for (const [s, v] of Object.entries(seats)) input.seats[Number(s)] = v as number;
  for (let s = 0; s < 4; s += 1) input.inputs[s] = inputs[s] ?? 0;
  step(m, input);
  return m.events.slice(0, m.eventsLen);
};

const SIZES = [0, 7, 4, 4, 8, 3, 4, 2, 2, 2, 3, 4, 4, 5, 8];

/** Decoded events of one tick: [kind, payload bytes]. */
export const events = (bytes: Uint8Array): { kind: number; p: Uint8Array }[] => {
  const out: { kind: number; p: Uint8Array }[] = [];
  for (let i = 0; i < bytes.length; ) {
    const k = bytes[i]!;
    const size = SIZES[k] ?? 0;
    if (!size) throw new Error('unknown event kind ' + k);
    out.push({ kind: k, p: bytes.slice(i + 1, i + size) });
    i += size;
  }
  return out;
};

export const allEvents = (ticks: Uint8Array[]): { tick: number; kind: number; p: Uint8Array }[] =>
  ticks.flatMap((b, tick) => events(b).map((e) => ({ tick, ...e })));

/** The direction from cell `a` to its neighbour `b`. */
export const dirTo = (a: number, b: number): number => {
  for (let d = 1; d <= 4; d += 1) if (a + DX[d]! + DY[d]! * W === b) return d;
  throw new Error('cells ' + a + ' and ' + b + ' are not neighbours');
};

/**
 * Walks `slot` along a path of neighbouring cells (the first is where it stands), one input per
 * tick, until it is centred on the last cell or `maxTicks` pass. Returns the ticks used.
 */
export const walk = (m: Match, slot: number, path: readonly number[], maxTicks = 400, extra: Partial<Record<number, number>> = {}): number => {
  const input = newStepIn();
  let i = 1;
  for (let t = 0; t < maxTicks; t += 1) {
    const f = fighter(m, slot);
    const c = cellAt(f.x, f.y);
    while (i < path.length && c === path[i]) i += 1;
    const last = path[path.length - 1]!;
    if (i >= path.length && c === last && f.x === cx(last) && f.y === cy(last)) return t;
    const target = i < path.length ? path[i]! : last;
    let d: number;
    if (target === c) {
      // Settle onto the centre.
      d = f.x < cx(c) ? Dir.E : f.x > cx(c) ? Dir.W : f.y < cy(c) ? Dir.S : Dir.N;
    } else d = dirTo(i > 0 ? path[i - 1]! : c, target);
    for (let s = 0; s < 4; s += 1) input.inputs[s] = s === slot ? inputByte(d, 0, false, false) : (extra[s] ?? 0);
    step(m, input);
    if (!f.alive) return -1;
  }
  return maxTicks;
};

export const isFloorFree = (m: Match, c: number): boolean => m.current.cells[c] === Cell.Floor;

export { CELLS, Cell, Control, Dir, Phase, REMOTE, SeatCmd, cellAt, inputByte };
