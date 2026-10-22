/**
 * Fuseyard's simulation (fuseyard.md §1, §2.3): createMatch, step, movement, round setup, Closing
 * Time, and the ghost, shield and freeze rules. Pure, deterministic and integer-only; `step` never
 * allocates. Events are written straight into `m.events` in wire format (§3.3).
 *
 * Tick order (slots ascending, bombs by id): 0 seat commands and ghost locks; 1 frozen or resuming
 * rounds skip the rest; 2 inputs; 3 detonations, then placements; 4 movement (kicks, belts, ice,
 * pads); 5 bomb slides; 6 passer masks; 7 pickups; 8 fuses and the explosion queue; 9 deaths;
 * 10 Closing Time; 11 flame decay and item reveals; 12 death scatter; 13 the round-end check.
 * Shields count down at the start of a playing step, so a fresh shield always reads 45 after it.
 */
import { MULBERRY_INC, mulberry32Out } from '../rng.js';
import { ARENAS, SPIRAL, arenaIndex, spawnOf, type Arena } from './arenas.js';
import { decideBot, resetBrain } from './bots.js';
import { buildDanger, footprintHas } from './danger.js';
import {
  ARM_BLOCK,
  BELT_PUSH,
  BELT_SPEED,
  BOMBS_CAP,
  BotLevel,
  CELLS,
  CLOSE_EVERY,
  COUNTDOWN,
  Cell,
  Control,
  DEATH_FLAME,
  DEATH_STEEL,
  DX,
  DY,
  Dir,
  EV,
  EV_SIZE,
  FLAME,
  FUSE,
  GHOST_LOCK_FUSE,
  GHOST_LOCK_MAX,
  HIT_HALF,
  HOLD_WIN,
  IN_BOMB,
  IN_DETONATE,
  Item,
  KICK_BELT,
  KICK_SPEED,
  MAX_BOMBS,
  NO_SLOT,
  ORPHAN_FUSE,
  PAD_COOLDOWN,
  Phase,
  RANGE_CAP,
  REMOTE,
  RESULT_CARD,
  RESUME_COUNT,
  SCATTER_MAX,
  SCATTER_ORDER,
  SHIELD,
  SPEEDS,
  SPEED_CAP,
  SPIRAL_CELLS,
  Seat,
  SeatCmd,
  Special,
  TELE_BOMB,
  TELE_FIGHTER,
  TELE_GHOST,
  W,
  WARN_TICKS,
  cellAt,
  closeStart,
  inDir1,
  inDir2,
  itemCount,
  maxRounds,
  roundLimit,
  type BotBrain,
  type Bomb,
  type Fighter,
  type Match,
  type MatchConfig,
  type Round,
  type StepIn,
} from './rules.js';

// ------------------------------------------------------------------ movement (shared with the client's predictor)

/** What movement reads: the board, the bomb map and passer masks. */
export interface MoveBoard {
  cells: Uint8Array;
  special: Uint8Array;
  /** Bomb pool index per cell, -1 for none. */
  bombAt: Int8Array;
  /** Passer slot mask per bomb pool index. */
  bombPass: Uint8Array;
  padPartner: Int16Array;
  beltDir: Uint8Array;
}

/** The fields of a fighter that movement reads and writes. */
export type Mover = Pick<Fighter, 'slot' | 'x' | 'y' | 'facing' | 'moving' | 'speedLvl' | 'glove' | 'padCooldown'>;

export interface MoveOut {
  /** Pool index of a bomb this fighter kicks, or -1. */
  kickBomb: number;
  kickDir: number;
  /** Pad partner cell the fighter jumped to, or -1. */
  teleTo: number;
  /** The direction actually moved, 0 when it stood still. */
  moveDir: number;
}

export const newMoveOut = (): MoveOut => ({ kickBomb: -1, kickDir: 0, teleTo: -1, moveDir: 0 });

const isOpen = (b: MoveBoard, slot: number, c: number): boolean => {
  if (b.cells[c] !== Cell.Floor) return false;
  const bi = b.bombAt[c] as number;
  return bi < 0 || (((b.bombPass[bi] as number) >> slot) & 1) === 1;
};

/** A pad crossing after an advance along one axis (perpendicular offset already 0). */
const padCross = (b: MoveBoard, f: Mover, horizontal: boolean, before: number, out: MoveOut): boolean => {
  if (f.padCooldown > 0) return false;
  const c = cellAt(f.x, f.y);
  const sp = b.special[c] as number;
  if (sp < Special.PadA) return false;
  const after = horizontal ? f.x : f.y;
  const pc = ((horizontal ? c % W : (c / W) | 0) << 6) + 32;
  const crossed = before < after ? before < pc && after >= pc : before > pc && after <= pc;
  if (!crossed) return false;
  const partner = b.padPartner[c] as number;
  if (partner < 0 || (b.bombAt[partner] as number) >= 0) return false;
  f.x = ((partner % W) << 6) + 32;
  f.y = (((partner / W) | 0) << 6) + 32;
  f.padCooldown = PAD_COOLDOWN;
  out.teleTo = partner;
  return true;
};

/**
 * One movement attempt (fuseyard.md §1.2). Returns the units moved; 0 means the move failed. A pad
 * jump sets `out.teleTo` and uses up the budget; a kick sets `out.kickBomb`.
 */
export const tryMove = (b: MoveBoard, f: Mover, dir: number, budget: number, out: MoveOut): number => {
  const cx = f.x >> 6;
  const cy = f.y >> 6;
  const c = cy * W + cx;
  const dx = DX[dir] as number;
  const dy = DY[dir] as number;
  const horizontal = dx !== 0;
  const ox = f.x - ((cx << 6) + 32);
  const oy = f.y - ((cy << 6) + 32);
  const along = horizontal ? ox * dx : oy * dy;
  const perp = horizontal ? oy : ox;
  const step = dx + dy * W;
  const n1 = c + step;
  const open1 = isOpen(b, f.slot, n1);
  if (open1 || along < 0) {
    const ap = perp < 0 ? -perp : perp;
    const pm = budget < ap ? budget : ap;
    const rest = budget - pm;
    let adv: number;
    if (open1) adv = isOpen(b, f.slot, n1 + step) ? rest : Math.min(rest, 64 - along);
    else adv = Math.min(rest, -along);
    if (adv < 0) adv = 0;
    if (pm + adv === 0) return 0;
    if (pm > 0) {
      const s = perp > 0 ? -pm : pm;
      if (horizontal) f.y += s;
      else f.x += s;
    }
    if (adv > 0) {
      const before = horizontal ? f.x : f.y;
      if (horizontal) f.x += adv * dx;
      else f.y += adv * dy;
      if (pm === ap && padCross(b, f, horizontal, before, out)) return budget;
    }
    return pm + adv;
  }
  if (perp !== 0) {
    const side = perp > 0 ? 1 : -1;
    const c2 = c + (horizontal ? side * W : side);
    if (isOpen(b, f.slot, c2) && isOpen(b, f.slot, c2 + step)) {
      const ap = perp < 0 ? -perp : perp;
      const amt = Math.min(budget, 64 - ap);
      if (horizontal) f.y += side * amt;
      else f.x += side * amt;
      return amt;
    }
    return 0;
  }
  if (along === 0 && f.glove && b.cells[n1] === Cell.Floor) {
    const bi = b.bombAt[n1] as number;
    if (bi >= 0 && (((b.bombPass[bi] as number) >> f.slot) & 1) === 0) {
      out.kickBomb = bi;
      out.kickDir = dir;
    }
  }
  return 0;
};

const perpendicular = (a: number, b: number): boolean => (a === Dir.N || a === Dir.S) !== (b === Dir.N || b === Dir.S);

/** Step 4 for one fighter: input, ice, belts and pads. Kicks are only requested (`out.kickBomb`). */
export const moveFighter = (b: MoveBoard, f: Mover, input: number, out: MoveOut): void => {
  out.kickBomb = -1;
  out.kickDir = 0;
  out.teleTo = -1;
  out.moveDir = 0;
  const d1 = inDir1(input);
  const d2 = inDir2(input);
  const budget = SPEEDS[f.speedLvl] ?? 8;
  const c = cellAt(f.x, f.y);
  let moved = 0;
  let dir = 0;
  if (b.special[c] === Special.Ice) {
    const atCentre = (f.x & 63) === 32 && (f.y & 63) === 32;
    if (atCentre && d1 !== 0 && isOpen(b, f.slot, c + (DX[d1] as number) + (DY[d1] as number) * W)) dir = d1;
    else if (atCentre && d2 !== 0 && isOpen(b, f.slot, c + (DX[d2] as number) + (DY[d2] as number) * W)) dir = d2;
    else if (f.moving && f.facing !== Dir.None) dir = f.facing;
    else dir = d1;
    if (dir !== 0) moved = tryMove(b, f, dir, budget, out);
    if (moved === 0 && out.teleTo < 0 && out.kickBomb < 0 && d1 !== 0 && d1 !== dir) {
      moved = tryMove(b, f, d1, budget, out);
      if (moved > 0 || out.kickBomb >= 0) dir = d1;
    }
  } else if (d1 !== 0) {
    dir = d1;
    moved = tryMove(b, f, d1, budget, out);
    if (moved === 0 && out.kickBomb < 0 && out.teleTo < 0 && d2 !== 0) {
      moved = tryMove(b, f, d2, budget, out);
      if (moved > 0) dir = d2;
    }
  }
  if (moved > 0) {
    f.facing = dir as Dir;
    f.moving = true;
    out.moveDir = dir;
  } else {
    f.moving = false;
    if (out.kickBomb >= 0) f.facing = out.kickDir as Dir;
  }
  if (out.teleTo >= 0) return;
  const bd = b.beltDir[cellAt(f.x, f.y)] as number;
  if (bd !== 0 && !(moved > 0 && perpendicular(dir, bd))) {
    const k = out.kickBomb;
    tryMove(b, f, bd, BELT_PUSH, out);
    out.kickBomb = k;
  }
};

// ------------------------------------------------------------------ scratch (not state; rebuilt every step)

const bombAt = new Int8Array(CELLS);
const bombPass = new Uint8Array(MAX_BOMBS);
const queue = new Int16Array(MAX_BOMBS);
const queued = new Uint8Array(MAX_BOMBS);
const inputNow = new Uint8Array(4);
const fighterCell = new Int16Array(4);
const scratchList = new Int16Array(CELLS);
const bfsQueue = new Int16Array(CELLS);
const bfsDist = new Int16Array(CELLS);
const moveOut = newMoveOut();
const board: MoveBoard = { cells: new Uint8Array(0), special: new Uint8Array(0), bombAt, bombPass, padPartner: new Int16Array(0), beltDir: new Uint8Array(0) };

const arenaOf = (r: Round): Arena => ARENAS[r.arena] as Arena;

const syncBoard = (r: Round): void => {
  const a = arenaOf(r);
  board.cells = r.cells;
  board.special = r.special;
  board.padPartner = a.padPartner;
  board.beltDir = a.beltDir;
  rebuildBombs(r);
};

const rebuildBombs = (r: Round): void => {
  bombAt.fill(-1);
  for (let i = 0; i < r.bombCount; i += 1) {
    const bomb = r.bombs[i] as Bomb;
    bombAt[cellAt(bomb.x, bomb.y)] = i;
    bombPass[i] = bomb.passers;
  }
};

// ------------------------------------------------------------------ PRNG and events

const nextU32 = (r: Round): number => {
  r.rng = (r.rng + MULBERRY_INC) | 0;
  return mulberry32Out(r.rng);
};
/** A uniform-enough integer in [0, n) from the round stream (deterministic, integer-exact). */
const rint = (r: Round, n: number): number => Math.floor((nextU32(r) * n) / 4294967296);

/** Reserves one event; returns the offset of its payload, or -1 if the buffer is full. */
const ev = (m: Match, kind: number): number => {
  const at = m.eventsLen;
  const size = EV_SIZE[kind] as number;
  if (at + size > m.events.length) return -1;
  m.events[at] = kind;
  m.eventsLen = at + size;
  m.eventCount += 1;
  return at + 1;
};
const put16 = (b: Uint8Array, at: number, v: number): void => {
  b[at] = v & 0xff;
  b[at + 1] = (v >> 8) & 0xff;
};

const evRound = (m: Match): void => {
  const r = m.current;
  const p = ev(m, EV.Round);
  if (p < 0) return;
  const e = m.events;
  e[p] = r.phase;
  e[p + 1] = m.round & 0xff;
  e[p + 2] = (r.phase === Phase.Frozen ? r.holdWinner : r.winner) & 0xff;
  for (let s = 0; s < 4; s += 1) e[p + 3 + s] = m.scores[s] as number;
};

const evStats = (m: Match, f: Fighter): void => {
  const p = ev(m, EV.Stats);
  if (p < 0) return;
  m.events[p] = f.slot;
  m.events[p + 1] = (f.bombsMax & 15) | ((f.range & 15) << 4);
  m.events[p + 2] = (f.speedLvl & 7) | (f.glove ? 8 : 0) | (f.clicker ? 16 : 0);
};

const evTeleport = (m: Match, kind: number, who: number, to: number): void => {
  const p = ev(m, EV.Teleport);
  if (p < 0) return;
  m.events[p] = kind;
  put16(m.events, p + 1, who);
  m.events[p + 3] = to;
};

const seatOut = (m: Match, slot: number, state: number): void => {
  if (m.seatOutLen >= 8) return;
  m.seatOut[m.seatOutLen * 2] = slot;
  m.seatOut[m.seatOutLen * 2 + 1] = state;
  m.seatOutLen += 1;
};

/** Wire seat state of a fighter. */
export const seatState = (f: Fighter): number => (f.control === Control.Ghost ? Seat.Ghost : f.control === Control.Bot ? (f.left ? Seat.Left : Seat.Bot) : Seat.Live);

// ------------------------------------------------------------------ creation and round setup

const newFighter = (slot: number): Fighter => ({
  slot,
  seated: false,
  control: Control.Bot,
  left: false,
  botLevel: BotLevel.Scrapper,
  x: 0,
  y: 0,
  facing: Dir.S,
  moving: false,
  alive: false,
  diedAt: 0,
  bombsMax: 1,
  bombsOut: 0,
  range: 2,
  speedLvl: 0,
  glove: false,
  clicker: false,
  collected: new Uint8Array(6),
  padCooldown: 0,
  dodgeGrace: 0,
  doomedTicks: 0,
  shield: 0,
  ghostLock: 0xff,
  reclaim: false,
  lastInput: 0,
  kills: 0,
  blocksBroken: 0,
  deaths: 0,
});

const newBomb = (): Bomb => ({ id: 0, owner: 0, x: 0, y: 0, fuse: 0, range: 0, slideDir: Dir.None, slideSpeed: 0, passers: 0 });

export const newBrain = (): BotBrain => ({ rule: 0, target: -1, replanIn: 0, lineBombs: 0, pathLen: 0, pathPos: 0, path: new Int16Array(64), action: 0, lastDir: 0, lastCell: -1, stillTicks: 0 });

export const newRound = (): Round => {
  const bombs: Bomb[] = [];
  for (let i = 0; i < MAX_BOMBS; i += 1) bombs.push(newBomb());
  const fighters: Fighter[] = [];
  for (let s = 0; s < 4; s += 1) fighters.push(newFighter(s));
  return {
    tick: 0,
    phase: Phase.Countdown,
    phaseTicks: COUNTDOWN,
    arena: 0,
    cells: new Uint8Array(CELLS),
    special: new Uint8Array(CELLS),
    hidden: new Uint8Array(CELLS),
    items: new Uint8Array(CELLS),
    pendingItem: new Uint8Array(CELLS),
    flame: new Uint8Array(CELLS),
    flameOwner: new Uint8Array(CELLS),
    warn: new Uint8Array(CELLS),
    fighters,
    bombs,
    bombCount: 0,
    nextBombId: 1,
    spiralIndex: 0,
    nextDropTick: 0,
    rng: 0,
    winner: -1,
    holdTicks: 0,
    holdWinner: -1,
  };
};

export interface SeatSetup {
  slot: number;
  human: boolean;
  botLevel: number;
}

/** The match for `config` with the given seats (slots 0..fighters-1; missing slots are bots). */
export const createMatch = (config: MatchConfig, seats: readonly SeatSetup[]): Match => {
  const m: Match = {
    config,
    tick: 0,
    round: 0,
    scores: new Uint8Array(4),
    draws: 0,
    current: newRound(),
    botRng: new Uint32Array(4),
    brains: [newBrain(), newBrain(), newBrain(), newBrain()],
    arenasPlayed: new Uint8Array(16),
    events: new Uint8Array(4096),
    eventsLen: 0,
    eventCount: 0,
    seatOut: new Uint8Array(16),
    seatOutLen: 0,
    roundStarted: false,
    roundEnded: false,
    matchEnded: false,
  };
  for (let s = 0; s < 4; s += 1) {
    m.botRng[s] = (config.seed ^ Math.imul(s + 1, 0x85ebca6b)) >>> 0;
    const f = m.current.fighters[s] as Fighter;
    f.seated = s < config.fighters;
    f.control = Control.Bot;
    f.botLevel = config.botLevel;
  }
  for (const seat of seats) {
    const f = m.current.fighters[seat.slot];
    if (!f || !f.seated) continue;
    f.control = seat.human ? Control.Human : Control.Bot;
    f.botLevel = (seat.human ? config.botLevel : seat.botLevel) as BotLevel;
  }
  setupRound(m, null);
  m.eventsLen = 0;
  m.eventCount = 0;
  m.seatOutLen = 0;
  return m;
};

const startStats = (f: Fighter, quick: boolean): void => {
  f.bombsMax = quick ? 3 : 1;
  f.range = quick ? 3 : 2;
  f.speedLvl = quick ? 1 : 0;
  f.glove = false;
  f.clicker = false;
  f.collected.fill(0);
};

const setupRound = (m: Match, input: StepIn | null): void => {
  const r = m.current;
  const c = m.config;
  const ai = c.arena === 'rotation' ? m.round % ARENAS.length : arenaIndex(c.arena);
  const a = ARENAS[ai] as Arena;
  r.arena = ai;
  if (m.round < m.arenasPlayed.length) m.arenasPlayed[m.round] = ai;
  r.rng = (c.seed ^ Math.imul(m.round + 1, 0x9e3779b9)) | 0;
  r.cells.set(a.cells);
  r.special.set(a.special);
  r.hidden.fill(0);
  r.items.fill(0);
  r.pendingItem.fill(0);
  r.flame.fill(0);
  r.flameOwner.fill(0);
  r.warn.fill(0);
  let blocks = 0;
  for (let i = 0; i < CELLS; i += 1) {
    if (a.fillable[i] === 1 && rint(r, 100) < a.density) r.cells[i] = Cell.Block;
    if (r.cells[i] === Cell.Block) {
      scratchList[blocks] = i;
      blocks += 1;
    }
  }
  // Items for this many fighters; Spare Fuses go first when there are more items than blocks.
  let total = 0;
  const counts = [0, 0, 0, 0, 0, 0];
  for (let it = 1; it <= 5; it += 1) {
    counts[it] = itemCount(it, c.fighters);
    total += counts[it] as number;
  }
  for (let it = 1; it <= 5 && total > blocks; it += 1) {
    const cut = Math.min(counts[it] as number, total - blocks);
    counts[it] = (counts[it] as number) - cut;
    total -= cut;
  }
  // Seeded shuffle of the block cells, then the first `total` get the items in item order.
  for (let i = blocks - 1; i > 0; i -= 1) {
    const j = rint(r, i + 1);
    const t = scratchList[i] as number;
    scratchList[i] = scratchList[j] as number;
    scratchList[j] = t;
  }
  let k = 0;
  for (let it = 1; it <= 5; it += 1) {
    for (let n = 0; n < (counts[it] as number); n += 1) {
      r.hidden[scratchList[k] as number] = it;
      k += 1;
    }
  }
  const quick = c.mode === 'quickfire';
  for (let s = 0; s < 4; s += 1) {
    const f = r.fighters[s] as Fighter;
    f.alive = f.seated;
    const sc = spawnOf(s, c.fighters);
    f.x = ((sc % W) << 6) + 32;
    f.y = (((sc / W) | 0) << 6) + 32;
    f.facing = Dir.S;
    f.moving = false;
    f.diedAt = 0;
    f.bombsOut = 0;
    startStats(f, quick);
    f.padCooldown = 0;
    f.doomedTicks = 0;
    f.shield = 0;
    f.ghostLock = 0xff;
    f.lastInput = 0;
    if (f.reclaim) {
      f.reclaim = false;
      f.control = Control.Human;
      f.left = false;
      seatOut(m, s, Seat.Live);
    }
    f.dodgeGrace = f.control === Control.Human && input ? (input.grace[s] as number) : 0;
    resetBrain(m.brains[s] as BotBrain);
  }
  r.bombCount = 0;
  r.nextBombId = 1;
  r.spiralIndex = 0;
  r.nextDropTick = closeStart(c.mode) + CLOSE_EVERY;
  r.tick = 0;
  r.phase = Phase.Countdown;
  r.phaseTicks = COUNTDOWN;
  r.winner = -1;
  r.holdTicks = 0;
  r.holdWinner = -1;
  m.roundStarted = true;
  evRound(m);
};

// ------------------------------------------------------------------ helpers

const overlapsCell = (f: Fighter, c: number): boolean => {
  const left = (c % W) << 6;
  const top = ((c / W) | 0) << 6;
  return f.x + HIT_HALF > left && f.x - HIT_HALF < left + 64 && f.y + HIT_HALF > top && f.y - HIT_HALF < top + 64;
};

const removeBomb = (r: Round, i: number): void => {
  const b = r.bombs[i] as Bomb;
  const owner = r.fighters[b.owner] as Fighter;
  if (owner.bombsOut > 0) owner.bombsOut -= 1;
  for (let j = i; j < r.bombCount - 1; j += 1) r.bombs[j] = r.bombs[j + 1] as Bomb;
  r.bombs[r.bombCount - 1] = b;
  r.bombCount -= 1;
};

/** Is cell `c` inside the footprint of a bomb with a fuse of at most 30, or on fire? */
const inDangerNow = (r: Round, c: number): boolean => {
  if ((r.flame[c] as number) > 0) return true;
  for (let i = 0; i < r.bombCount; i += 1) {
    const b = r.bombs[i] as Bomb;
    if (b.fuse > GHOST_LOCK_FUSE) continue;
    if (footprintHas(r.cells, bombAt, r.items, cellAt(b.x, b.y), b.range, c)) return true;
  }
  return false;
};

const die = (m: Match, f: Fighter, killer: number, cause: number): void => {
  f.alive = false;
  f.moving = false;
  f.diedAt = m.tick;
  f.deaths += 1;
  f.doomedTicks = 0;
  f.ghostLock = 0xff;
  if (killer !== NO_SLOT && killer !== f.slot && killer < 4) (m.current.fighters[killer] as Fighter).kills += 1;
  const p = ev(m, EV.Died);
  if (p < 0) return;
  m.events[p] = f.slot;
  m.events[p + 1] = killer;
  m.events[p + 2] = cause;
};

const counts = { h: 0, b: 0, g: 0, lastH: -1, lastAlive: -1 };
const census = (r: Round): void => {
  counts.h = 0;
  counts.b = 0;
  counts.g = 0;
  counts.lastH = -1;
  counts.lastAlive = -1;
  for (let s = 0; s < 4; s += 1) {
    const f = r.fighters[s] as Fighter;
    if (!f.alive) continue;
    if (f.control === Control.Ghost) counts.g += 1;
    else if (f.control === Control.Human) {
      counts.h += 1;
      counts.lastH = s;
      counts.lastAlive = s;
    } else {
      counts.b += 1;
      counts.lastAlive = s;
    }
  }
};

// ------------------------------------------------------------------ step 0: seats

const ghostNow = (m: Match, f: Fighter): void => {
  f.control = Control.Ghost;
  f.moving = false;
  f.ghostLock = 0xff;
  f.doomedTicks = 0;
  seatOut(m, f.slot, Seat.Ghost);
};

const passersFor = (r: Round, f: Fighter): void => {
  for (let i = 0; i < r.bombCount; i += 1) {
    const b = r.bombs[i] as Bomb;
    if (overlapsCell(f, cellAt(b.x, b.y))) b.passers |= 1 << f.slot;
  }
};

const applySeats = (m: Match, input: StepIn): void => {
  const r = m.current;
  for (let s = 0; s < 4; s += 1) {
    const cmd = input.seats[s] as number;
    if (cmd === SeatCmd.None) continue;
    const f = r.fighters[s] as Fighter;
    if (!f.seated) continue;
    if (cmd === SeatCmd.Return) {
      if (f.control === Control.Ghost) {
        f.control = Control.Human;
        f.shield = f.alive ? SHIELD : 0;
        f.lastInput = 0;
        if (f.alive) passersFor(r, f);
        seatOut(m, s, Seat.Live);
      } else if (f.ghostLock !== 0xff) {
        f.ghostLock = 0xff;
      }
    } else if (cmd === SeatCmd.Ghost) {
      if (f.control === Control.Human && f.ghostLock === 0xff) {
        if (!f.alive) ghostNow(m, f);
        else f.ghostLock = 0;
      }
    } else if (cmd === SeatCmd.BotTakeover) {
      if (f.control !== Control.Bot) {
        f.shield = f.alive ? SHIELD : 0;
        f.control = Control.Bot;
        f.botLevel = BotLevel.Scrapper;
        f.ghostLock = 0xff;
        f.left = false;
        resetBrain(m.brains[s] as BotBrain);
        seatOut(m, s, Seat.Bot);
      }
    } else if (cmd === SeatCmd.Left) {
      if (!(f.control === Control.Bot && f.left)) {
        if (f.control === Control.Ghost && f.alive) f.shield = SHIELD;
        f.control = Control.Bot;
        f.left = true;
        f.reclaim = false;
        f.botLevel = m.config.botLevel;
        f.ghostLock = 0xff;
        resetBrain(m.brains[s] as BotBrain);
        seatOut(m, s, Seat.Left);
      }
    } else if (cmd === SeatCmd.Reclaim) {
      if (f.control === Control.Bot && !f.left) f.reclaim = true;
    }
  }
  // Pending ghost requests: the danger lock (§1.7).
  for (let s = 0; s < 4; s += 1) {
    const f = r.fighters[s] as Fighter;
    if (f.ghostLock === 0xff) continue;
    if (!f.alive || r.phase !== Phase.Playing || f.ghostLock >= GHOST_LOCK_MAX || !inDangerNow(r, cellAt(f.x, f.y))) ghostNow(m, f);
    else f.ghostLock += 1;
  }
};

// ------------------------------------------------------------------ steps 2–12

const placeBomb = (m: Match, f: Fighter): void => {
  const r = m.current;
  if (f.bombsOut >= f.bombsMax || r.bombCount >= MAX_BOMBS) return;
  const c = cellAt(f.x, f.y);
  if (r.cells[c] !== Cell.Floor || (bombAt[c] as number) >= 0) return;
  const i = r.bombCount;
  const b = r.bombs[i] as Bomb;
  b.id = r.nextBombId & 0xffff;
  r.nextBombId = (r.nextBombId + 1) & 0xffff;
  if (r.nextBombId === 0) r.nextBombId = 1;
  b.owner = f.slot;
  b.x = ((c % W) << 6) + 32;
  b.y = (((c / W) | 0) << 6) + 32;
  b.fuse = f.clicker ? REMOTE : FUSE;
  b.range = f.range;
  b.slideDir = Dir.None;
  b.slideSpeed = 0;
  let passers = 0;
  for (let s = 0; s < 4; s += 1) {
    const o = r.fighters[s] as Fighter;
    if (o.alive && overlapsCell(o, c)) passers |= 1 << s;
  }
  b.passers = passers;
  r.bombCount += 1;
  f.bombsOut += 1;
  bombAt[c] = i;
  bombPass[i] = passers;
  const p = ev(m, EV.BombPlaced);
  if (p < 0) return;
  put16(m.events, p, b.id);
  m.events[p + 2] = f.slot;
  m.events[p + 3] = c;
  m.events[p + 4] = b.range;
  m.events[p + 5] = b.fuse === REMOTE ? 1 : 0;
};

const detonate = (r: Round, f: Fighter): void => {
  for (let i = 0; i < r.bombCount; i += 1) {
    const b = r.bombs[i] as Bomb;
    if (b.owner === f.slot && b.fuse === REMOTE) {
      b.fuse = 1;
      return;
    }
  }
};

/** Cells a sliding bomb cannot enter: not floor, a bomb, an item, or a live fighter (ghosts are passed). */
const bombBlocked = (r: Round, c: number, self: number): boolean => {
  if (r.cells[c] !== Cell.Floor) return true;
  const bi = bombAt[c] as number;
  if (bi >= 0 && bi !== self) return true;
  if ((r.items[c] as number) !== 0 || (r.pendingItem[c] as number) !== 0) return true;
  for (let s = 0; s < 4; s += 1) if ((fighterCell[s] as number) === c) return true;
  return false;
};

const evBombDir = (m: Match, b: Bomb, dir: number): void => {
  const p = ev(m, EV.BombKicked);
  if (p < 0) return;
  put16(m.events, p, b.id);
  m.events[p + 2] = dir;
};

const stopBomb = (m: Match, b: Bomb, c: number): void => {
  b.slideDir = Dir.None;
  b.slideSpeed = 0;
  const p = ev(m, EV.BombStopped);
  if (p < 0) return;
  put16(m.events, p, b.id);
  m.events[p + 2] = c;
};

const slideBombs = (m: Match): void => {
  const r = m.current;
  const a = arenaOf(r);
  for (let i = 0; i < r.bombCount; i += 1) {
    const b = r.bombs[i] as Bomb;
    const c = cellAt(b.x, b.y);
    const atCentre = (b.x & 63) === 32 && (b.y & 63) === 32;
    if (b.slideDir === Dir.None) {
      const bd = a.beltDir[c] as number;
      if (bd === 0 || !atCentre || bombBlocked(r, c + (DX[bd] as number) + (DY[bd] as number) * W, i)) continue;
      b.slideDir = bd as Dir;
      b.slideSpeed = BELT_SPEED;
      evBombDir(m, b, bd | KICK_BELT);
    } else if (atCentre) {
      if (b.slideSpeed === BELT_SPEED) {
        const bd = a.beltDir[c] as number;
        if (bd === 0) {
          stopBomb(m, b, c);
          continue;
        }
        if (bd !== b.slideDir) {
          b.slideDir = bd as Dir;
          evBombDir(m, b, bd | KICK_BELT);
        }
      }
      if (bombBlocked(r, c + (DX[b.slideDir] as number) + (DY[b.slideDir] as number) * W, i)) {
        stopBomb(m, b, c);
        continue;
      }
    }
    const ox = b.x;
    const oy = b.y;
    b.x += (DX[b.slideDir] as number) * b.slideSpeed;
    b.y += (DY[b.slideDir] as number) * b.slideSpeed;
    const c2 = cellAt(b.x, b.y);
    if (c2 !== c) {
      const other = bombAt[c2] as number;
      if (r.cells[c2] !== Cell.Floor || (other >= 0 && other !== i)) {
        b.x = ((c % W) << 6) + 32;
        b.y = (((c / W) | 0) << 6) + 32;
        stopBomb(m, b, c);
        continue;
      }
      bombAt[c] = -1;
      bombAt[c2] = i;
    }
    if ((b.x & 63) === 32 && (b.y & 63) === 32 && (b.x !== ox || b.y !== oy) && (r.special[c2] as number) >= Special.PadA) {
      const partner = a.padPartner[c2] as number;
      if (partner >= 0 && (bombAt[partner] as number) < 0) {
        bombAt[c2] = -1;
        bombAt[partner] = i;
        b.x = ((partner % W) << 6) + 32;
        b.y = (((partner / W) | 0) << 6) + 32;
        evTeleport(m, TELE_BOMB, b.id, partner);
      }
    }
  }
};

const updatePassers = (r: Round): void => {
  for (let i = 0; i < r.bombCount; i += 1) {
    const b = r.bombs[i] as Bomb;
    const c = cellAt(b.x, b.y);
    let mask = b.passers;
    for (let s = 0; s < 4; s += 1) {
      const f = r.fighters[s] as Fighter;
      const bit = 1 << s;
      if (mask & bit) {
        if (!f.alive || !overlapsCell(f, c)) mask &= ~bit;
      } else if (b.slideDir !== Dir.None && f.alive && f.control !== Control.Ghost && overlapsCell(f, c)) {
        mask |= bit;
      }
    }
    b.passers = mask;
    bombPass[i] = mask;
  }
};

const pickups = (m: Match): void => {
  const r = m.current;
  for (let s = 0; s < 4; s += 1) {
    const f = r.fighters[s] as Fighter;
    if (!f.alive || f.control === Control.Ghost) continue;
    const c = cellAt(f.x, f.y);
    const it = r.items[c] as number;
    if (it === 0) continue;
    r.items[c] = 0;
    f.collected[it] = ((f.collected[it] as number) + 1) & 0xff;
    if (it === Item.SpareFuse && f.bombsMax < BOMBS_CAP) f.bombsMax += 1;
    else if (it === Item.WideSpark && f.range < RANGE_CAP) f.range += 1;
    else if (it === Item.QuickBoots && f.speedLvl < SPEED_CAP) f.speedLvl += 1;
    else if (it === Item.ShoveGlove) f.glove = true;
    else if (it === Item.Clicker) f.clicker = true;
    const p = ev(m, EV.ItemTaken);
    if (p >= 0) {
      m.events[p] = c;
      m.events[p + 1] = s;
      m.events[p + 2] = it;
    }
    evStats(m, f);
  }
};

const writeFlame = (r: Round, c: number, owner: number): void => {
  r.flame[c] = FLAME;
  r.flameOwner[c] = owner;
};

const explodeOne = (m: Match, i: number, qLen: number): number => {
  const r = m.current;
  const b = r.bombs[i] as Bomb;
  const c = cellAt(b.x, b.y);
  bombAt[c] = -1;
  writeFlame(r, c, b.owner);
  const p = ev(m, EV.Explode);
  if (p >= 0) {
    put16(m.events, p, b.id);
    m.events[p + 2] = c;
  }
  const owner = r.fighters[b.owner] as Fighter;
  for (let d = 1; d <= 4; d += 1) {
    const step = (DX[d] as number) + (DY[d] as number) * W;
    let len = 0;
    let flag = 0;
    for (let k = 1; k <= b.range; k += 1) {
      const cc = c + step * k;
      const cell = r.cells[cc] as number;
      if (cell === Cell.Wall || cell === Cell.Pillar || cell === Cell.Steel) break;
      len = k;
      writeFlame(r, cc, b.owner);
      if (cell === Cell.Block) {
        r.cells[cc] = Cell.Floor;
        const it = r.hidden[cc] as number;
        r.hidden[cc] = 0;
        r.pendingItem[cc] = it;
        owner.blocksBroken += 1;
        flag = ARM_BLOCK;
        const q = ev(m, EV.BlockBroken);
        if (q >= 0) {
          m.events[q] = cc;
          m.events[q + 1] = it;
        }
        break;
      }
      const bi = bombAt[cc] as number;
      if (bi >= 0) {
        if (queued[bi] === 0 && qLen < MAX_BOMBS) {
          queued[bi] = 1;
          queue[qLen] = bi;
          qLen += 1;
        }
        break;
      }
      if ((r.items[cc] as number) !== 0) {
        r.items[cc] = 0;
        const q = ev(m, EV.ItemBurned);
        if (q >= 0) m.events[q] = cc;
        break;
      }
    }
    if (p >= 0) m.events[p + 2 + d] = len | flag;
  }
  return qLen;
};

const fusesAndBlasts = (m: Match): void => {
  const r = m.current;
  let qLen = 0;
  queued.fill(0);
  for (let i = 0; i < r.bombCount; i += 1) {
    const b = r.bombs[i] as Bomb;
    if (b.fuse === REMOTE) continue;
    b.fuse -= 1;
    if (b.fuse <= 0 && qLen < MAX_BOMBS) {
      queued[i] = 1;
      queue[qLen] = i;
      qLen += 1;
    }
  }
  for (let q = 0; q < qLen && q < MAX_BOMBS; q += 1) qLen = explodeOne(m, queue[q] as number, qLen);
  if (qLen === 0) return;
  // Remove the exploded bombs, keeping the pool sorted by id.
  for (let i = r.bombCount - 1; i >= 0; i -= 1) if (queued[i] === 1) removeBomb(r, i);
  rebuildBombs(r);
};

const deaths = (m: Match): void => {
  const r = m.current;
  for (let s = 0; s < 4; s += 1) {
    const f = r.fighters[s] as Fighter;
    if (!f.alive || f.control === Control.Ghost) continue;
    const c = cellAt(f.x, f.y);
    if ((r.flame[c] as number) === 0) {
      f.doomedTicks = 0;
      continue;
    }
    if (f.shield > 0) {
      f.doomedTicks = 0;
      continue;
    }
    f.doomedTicks += 1;
    if (f.doomedTicks > f.dodgeGrace) die(m, f, r.flameOwner[c] as number, DEATH_FLAME);
  }
};

/** Nearest floor cell without steel, bomb or flame (BFS; lowest index among the nearest). */
const nearestSafe = (r: Round, from: number): number => {
  bfsDist.fill(-1);
  bfsDist[from] = 0;
  bfsQueue[0] = from;
  let tail = 1;
  let best = -1;
  let bestD = 0x7fff;
  for (let h = 0; h < tail; h += 1) {
    const c = bfsQueue[h] as number;
    const d = bfsDist[c] as number;
    if (d > bestD) break;
    if (c !== from && r.cells[c] === Cell.Floor && (bombAt[c] as number) < 0 && (r.flame[c] as number) === 0) {
      if (d < bestD || c < best) {
        best = c;
        bestD = d;
      }
    }
    for (let dir = 1; dir <= 4; dir += 1) {
      const n = c + (DX[dir] as number) + (DY[dir] as number) * W;
      if (n < 0 || n >= CELLS || (bfsDist[n] as number) >= 0) continue;
      const cell = r.cells[n] as number;
      if (cell === Cell.Wall || cell === Cell.Pillar) continue;
      bfsDist[n] = d + 1;
      bfsQueue[tail] = n;
      tail += 1;
    }
  }
  return best;
};

const dropSteel = (m: Match, c: number): void => {
  const r = m.current;
  r.cells[c] = Cell.Steel;
  r.flame[c] = 0;
  r.items[c] = 0;
  r.pendingItem[c] = 0;
  r.hidden[c] = 0;
  const bi = bombAt[c] as number;
  if (bi >= 0) {
    removeBomb(r, bi);
    rebuildBombs(r);
  }
  const p = ev(m, EV.SteelDrop);
  if (p >= 0) m.events[p] = c;
  for (let s = 0; s < 4; s += 1) {
    const f = r.fighters[s] as Fighter;
    if (!f.alive || cellAt(f.x, f.y) !== c) continue;
    if (f.control === Control.Ghost || f.shield > 0) {
      const to = nearestSafe(r, c);
      if (to < 0) continue;
      f.x = ((to % W) << 6) + 32;
      f.y = (((to / W) | 0) << 6) + 32;
      evTeleport(m, TELE_GHOST, s, to);
    } else {
      die(m, f, NO_SLOT, DEATH_STEEL);
    }
  }
};

const closingTime = (m: Match): void => {
  const r = m.current;
  const k = r.tick;
  if (k < closeStart(m.config.mode)) return;
  for (let i = 0; i < r.spiralIndex; i += 1) {
    const c = SPIRAL[i] as number;
    const w = r.warn[c] as number;
    if (w === 0) continue;
    r.warn[c] = w - 1;
    if (w === 1) dropSteel(m, c);
  }
  if (r.spiralIndex < SPIRAL_CELLS && k === r.nextDropTick) {
    const c = SPIRAL[r.spiralIndex] as number;
    r.warn[c] = WARN_TICKS;
    r.spiralIndex += 1;
    r.nextDropTick += CLOSE_EVERY;
    const p = ev(m, EV.SteelWarn);
    if (p >= 0) m.events[p] = c;
  }
};

const decay = (r: Round): void => {
  for (let c = 0; c < CELLS; c += 1) {
    const fl = r.flame[c] as number;
    if (fl === 0) continue;
    r.flame[c] = fl - 1;
    if (fl === 1 && (r.pendingItem[c] as number) !== 0) {
      r.items[c] = r.pendingItem[c] as number;
      r.pendingItem[c] = 0;
    }
  }
};

const scatter = (m: Match): void => {
  const r = m.current;
  for (let s = 0; s < 4; s += 1) {
    const f = r.fighters[s] as Fighter;
    if (f.alive || f.diedAt !== m.tick || !f.seated) continue;
    let n = 0;
    for (let it = 1; it <= 5; it += 1) n += f.collected[it] as number;
    let k = n >> 1;
    if (k > SCATTER_MAX) k = SCATTER_MAX;
    if (k === 0) continue;
    let cand = 0;
    for (let c = 0; c < CELLS; c += 1) {
      if (r.cells[c] !== Cell.Floor || (bombAt[c] as number) >= 0 || (r.items[c] as number) !== 0 || (r.pendingItem[c] as number) !== 0) continue;
      if ((r.flame[c] as number) !== 0 || (r.warn[c] as number) !== 0) continue;
      let taken = false;
      for (let o = 0; o < 4; o += 1) {
        const g = r.fighters[o] as Fighter;
        if (g.alive && cellAt(g.x, g.y) === c) taken = true;
      }
      if (taken) continue;
      scratchList[cand] = c;
      cand += 1;
    }
    for (let oi = 0; oi < SCATTER_ORDER.length && k > 0; oi += 1) {
      const it = SCATTER_ORDER[oi] as number;
      for (let have = f.collected[it] as number; have > 0 && k > 0 && cand > 0; have -= 1) {
        const j = rint(r, cand);
        const c = scratchList[j] as number;
        scratchList[j] = scratchList[cand - 1] as number;
        cand -= 1;
        k -= 1;
        r.items[c] = it;
        const p = ev(m, EV.ItemDropped);
        if (p >= 0) {
          m.events[p] = c;
          m.events[p + 1] = it;
        }
      }
    }
  }
};

const endRound = (m: Match, winner: number): void => {
  const r = m.current;
  r.winner = winner;
  if (winner >= 0) m.scores[winner] = Math.min(255, (m.scores[winner] as number) + 1);
  else m.draws += 1;
  r.phase = Phase.RoundEnd;
  r.phaseTicks = RESULT_CARD;
  m.roundEnded = true;
  evRound(m);
};

const freeze = (m: Match, holdWinner: number): void => {
  const r = m.current;
  r.phase = Phase.Frozen;
  r.holdWinner = holdWinner;
  r.holdTicks = 0;
  evRound(m);
};

/** Step 13: last one standing, with the ghost rules of §1.7. */
const roundCheck = (m: Match): void => {
  const r = m.current;
  census(r);
  const limit = r.tick >= roundLimit(m.config.mode);
  if (counts.g === 0) {
    const alive = counts.h + counts.b;
    if (alive === 1) endRound(m, counts.lastAlive);
    else if (alive === 0 || limit) endRound(m, -1);
    return;
  }
  if (counts.h === 0) freeze(m, -1);
  else if (counts.h === 1 && counts.b === 0) freeze(m, counts.lastH);
  else if (limit) endRound(m, -1);
};

const frozenStep = (m: Match): void => {
  const r = m.current;
  census(r);
  const frozen = counts.g > 0 && (counts.h === 0 || (counts.h === 1 && counts.b === 0));
  if (!frozen) {
    r.phase = Phase.Resuming;
    r.phaseTicks = RESUME_COUNT;
    r.holdWinner = -1;
    r.holdTicks = 0;
    evRound(m);
    return;
  }
  const hw = counts.h === 1 && counts.b === 0 ? counts.lastH : -1;
  if (hw !== r.holdWinner) {
    r.holdWinner = hw;
    r.holdTicks = 0;
    evRound(m);
    return;
  }
  if (hw < 0) return;
  r.holdTicks += 1;
  if (r.holdTicks >= HOLD_WIN) {
    r.holdWinner = -1;
    r.holdTicks = 0;
    endRound(m, hw);
  }
};

const nextRoundOrEnd = (m: Match, input: StepIn): void => {
  const c = m.config;
  let top = 0;
  for (let s = 0; s < 4; s += 1) if ((m.scores[s] as number) > top) top = m.scores[s] as number;
  const played = m.round + 1;
  if (c.mode === 'quickfire' || top >= c.winsNeeded || played >= maxRounds(c)) {
    const r = m.current;
    r.phase = Phase.MatchEnd;
    r.phaseTicks = 0;
    m.matchEnded = true;
    evRound(m);
    return;
  }
  m.round = played;
  setupRound(m, input);
};

/** Fills `inputNow` for step 2. */
const gatherInputs = (m: Match, input: StepIn, dangerBuilt: { v: boolean }): void => {
  const r = m.current;
  for (let s = 0; s < 4; s += 1) {
    const f = r.fighters[s] as Fighter;
    let v = 0;
    if (f.alive && f.seated) {
      if (f.control === Control.Human) v = f.ghostLock === 0xff ? (input.inputs[s] as number) : 0;
      else if (f.control === Control.Bot) {
        if (!dangerBuilt.v) {
          buildDanger(r, bombAt);
          dangerBuilt.v = true;
        }
        v = decideBot(r, s, m.brains[s] as BotBrain, m.botRng, f.botLevel, bombAt);
      }
    }
    inputNow[s] = v;
    f.lastInput = v;
  }
};

const built = { v: false };

const playStep = (m: Match, input: StepIn): void => {
  const r = m.current;
  // 2. inputs
  built.v = false;
  for (let s = 0; s < 4; s += 1) {
    const f = r.fighters[s] as Fighter;
    fighterCell[s] = f.alive && f.control !== Control.Ghost ? cellAt(f.x, f.y) : -1;
  }
  gatherInputs(m, input, built);
  // 3. detonations, then placements
  for (let s = 0; s < 4; s += 1) {
    const f = r.fighters[s] as Fighter;
    if (!f.alive || f.control === Control.Ghost) continue;
    if ((inputNow[s] as number) & IN_DETONATE && f.clicker) detonate(r, f);
  }
  for (let s = 0; s < 4; s += 1) {
    const f = r.fighters[s] as Fighter;
    if (!f.alive || f.control === Control.Ghost) continue;
    if ((inputNow[s] as number) & IN_BOMB) placeBomb(m, f);
  }
  // 4. movement
  for (let s = 0; s < 4; s += 1) {
    const f = r.fighters[s] as Fighter;
    if (!f.alive || f.control === Control.Ghost) continue;
    moveFighter(board, f, inputNow[s] as number, moveOut);
    if (moveOut.teleTo >= 0) evTeleport(m, TELE_FIGHTER, s, moveOut.teleTo);
    if (moveOut.kickBomb >= 0) {
      const b = r.bombs[moveOut.kickBomb] as Bomb;
      const d = moveOut.kickDir;
      const bc = cellAt(b.x, b.y);
      if (b.slideDir === Dir.None && !bombBlocked(r, bc + (DX[d] as number) + (DY[d] as number) * W, moveOut.kickBomb)) {
        b.slideDir = d as Dir;
        b.slideSpeed = KICK_SPEED;
        evBombDir(m, b, d);
      }
    }
  }
  for (let s = 0; s < 4; s += 1) {
    const f = r.fighters[s] as Fighter;
    fighterCell[s] = f.alive && f.control !== Control.Ghost ? cellAt(f.x, f.y) : -1;
  }
  // 5–12
  slideBombs(m);
  updatePassers(r);
  pickups(m);
  fusesAndBlasts(m);
  deaths(m);
  closingTime(m);
  decay(r);
  scatter(m);
  // 13
  r.tick += 1;
  roundCheck(m);
};

/** Clicker bombs of a dead or ghost holder get fuse 45 (checked after every step). */
const orphanRemotes = (r: Round): void => {
  for (let i = 0; i < r.bombCount; i += 1) {
    const b = r.bombs[i] as Bomb;
    if (b.fuse !== REMOTE) continue;
    const f = r.fighters[b.owner] as Fighter;
    if (!f.alive || f.control === Control.Ghost) b.fuse = ORPHAN_FUSE;
  }
};

/** One 30 Hz tick. No allocation; events land in `m.events`, applied seat changes in `m.seatOut`. */
export const step = (m: Match, input: StepIn): void => {
  m.eventsLen = 0;
  m.eventCount = 0;
  m.seatOutLen = 0;
  m.roundStarted = false;
  m.roundEnded = false;
  m.tick = (m.tick + 1) >>> 0;
  const r = m.current;
  syncBoard(r);
  if (r.phase === Phase.Playing) {
    // Timers that count playing ticks start each playing step, so a fresh value reads full after it.
    for (let s = 0; s < 4; s += 1) {
      const f = r.fighters[s] as Fighter;
      if (f.shield > 0) f.shield -= 1;
      if (f.padCooldown > 0) f.padCooldown -= 1;
    }
  }
  // 0. seat commands and ghost locks
  applySeats(m, input);
  // 1–13 by phase
  switch (r.phase) {
    case Phase.Countdown:
      r.phaseTicks -= 1;
      if (r.phaseTicks <= 0) {
        r.phaseTicks = 0;
        r.phase = Phase.Playing;
        evRound(m);
      }
      break;
    case Phase.Playing:
      playStep(m, input);
      break;
    case Phase.Frozen:
      frozenStep(m);
      break;
    case Phase.Resuming:
      r.phaseTicks -= 1;
      if (r.phaseTicks <= 0) {
        r.phaseTicks = 0;
        r.phase = Phase.Playing;
        evRound(m);
      }
      break;
    case Phase.RoundEnd:
      r.phaseTicks -= 1;
      if (r.phaseTicks <= 0) nextRoundOrEnd(m, input);
      break;
    default:
      break;
  }
  orphanRemotes(m.current);
};

/** The board view of a round, for tests and the danger map's callers (bomb map rebuilt). */
export const boardOf = (r: Round): MoveBoard => {
  syncBoard(r);
  return board;
};

/** True once the match is over. */
export const matchOver = (m: Match): boolean => m.current.phase === Phase.MatchEnd;
