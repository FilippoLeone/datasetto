/**
 * Fuseyard's public world model (fuseyard.md §3.3): what a client knows, built from KEYFRAMEs,
 * FRAME events and snapshots. The client renders from it; tests compare it with the server's own
 * public view. It never sees block contents.
 *
 * Timers are stored as end times so that nothing ticks per frame: flames, fuses, warnings, pad
 * cooldowns and shields end at a *round tick* (R, which only advances while the round is playing),
 * countdowns, result cards and holds at a core tick. Three things are derived instead of received
 * (§3.3): fuse ends from BombPlaced, flame cells and their expiry from Explode, and Clicker bombs
 * dropping to fuse 45 when their holder dies or turns ghost.
 */
import type { ByteReader } from '../bytes.js';
import * as __events from '../net/events.js';
import type { PlatformEvent } from '../net/events.js';
import type { EventBlock } from '../net/lane.js';
import * as __arenas from './arenas.js';
import type { Arena } from './arenas.js';
import * as __rules from './rules.js';

// Local copies of imported values: hot loops read them without a module-binding lookup.
const { PEV, forEachEvent } = __events;
const { ARENAS } = __arenas;
const { CELLS, COUNTDOWN, Cell, EV, FLAME, FUSE, KICK_BELT, KICK_SPEED, BELT_SPEED, MAX_BOMBS, ORPHAN_FUSE, PAD_COOLDOWN, Phase, RESULT_CARD, RESUME_COUNT, SHIELD, Seat, EV_SIZE, TELE_BOMB, TELE_FIGHTER, W, WARN_TICKS, cellAt } = __rules;

/** A Clicker bomb's fuse end. */
export const NO_END = 0x7fffffff;

export interface WFighter {
  slot: number;
  /** Wire seat state: 0 live, 1 ghost, 2 bot, 3 left. */
  seat: number;
  x: number;
  y: number;
  facing: number;
  moving: boolean;
  alive: boolean;
  /** Sliding on ice (from the snapshot). */
  ice: boolean;
  bombsMax: number;
  range: number;
  speedLvl: number;
  glove: boolean;
  clicker: boolean;
  /** Round tick at which the pad cooldown ends. */
  padEnd: number;
  /** Round tick at which the shield ends. */
  shieldEnd: number;
  /** Core tick of the last death (for the animation). */
  diedAt: number;
}

export interface WBomb {
  id: number;
  owner: number;
  cell: number;
  x: number;
  y: number;
  /** Round tick at which it goes off, NO_END for a Clicker bomb. */
  fuseEnd: number;
  range: number;
  slideDir: number;
  slideSpeed: number;
  /** Not derivable from events; keyframes carry it, events leave it 0. */
  passers: number;
  /** Core tick it was placed (for the spark animation), 0 when unknown. */
  placedAt: number;
}

export interface World {
  /** A keyframe has been applied. */
  ready: boolean;
  fighters: number;
  /** Core tick of the newest applied state. */
  tick: number;
  /** Core tick of the last keyframe: events at or before it are already in it. */
  keyTick: number;
  /** Playing ticks completed in this round. */
  roundTick: number;
  phase: number;
  /** Core tick at which a countdown, resume or result card ends. */
  phaseEnd: number;
  /** Core tick at which the current hold started (frozen rounds). */
  holdStart: number;
  holdWinner: number;
  winner: number;
  round: number;
  arena: number;
  scores: Uint8Array;
  spiralIndex: number;
  cells: Uint8Array;
  items: Uint8Array;
  pending: Uint8Array;
  /** Round tick at which each cell's flame ends (flame while > roundTick). */
  flameEnd: Int32Array;
  /** Round tick at which each cell's flame started, for the animation. */
  flameStart: Int32Array;
  /** Round tick at which a warned cell drops (warned while > roundTick). */
  warnEnd: Int32Array;
  /** Round tick until which a broken block is drawn crumbling (cosmetic, not in keyframes). */
  crumbleEnd: Int32Array;
  fight: WFighter[];
  bombs: WBomb[];
  bombCount: number;
  /** Bumped whenever cells change (the renderer redraws its static layer). */
  cellsVersion: number;
  /** Cells whose tile changed since the renderer last looked (1 = dirty). */
  dirty: Uint8Array;
  /** Events of the last applied frame, for sounds and effects: kind, a, b, tick. */
  fx: Int32Array;
  fxLen: number;
}

const newFighter = (slot: number): WFighter => ({
  slot,
  seat: Seat.Bot,
  x: 0,
  y: 0,
  facing: 3,
  moving: false,
  alive: false,
  ice: false,
  bombsMax: 1,
  range: 2,
  speedLvl: 0,
  glove: false,
  clicker: false,
  padEnd: 0,
  shieldEnd: 0,
  diedAt: 0,
});

const newBomb = (): WBomb => ({ id: 0, owner: 0, cell: 0, x: 0, y: 0, fuseEnd: 0, range: 0, slideDir: 0, slideSpeed: 0, passers: 0, placedAt: 0 });

export const FX_MAX = 64;

export const createWorld = (fighters: number): World => {
  const bombs: WBomb[] = [];
  for (let i = 0; i < MAX_BOMBS; i += 1) bombs.push(newBomb());
  return {
    ready: false,
    fighters,
    tick: 0,
    keyTick: -1,
    roundTick: 0,
    phase: Phase.Countdown,
    phaseEnd: 0,
    holdStart: 0,
    holdWinner: -1,
    winner: -1,
    round: 0,
    arena: 0,
    scores: new Uint8Array(4),
    spiralIndex: 0,
    cells: new Uint8Array(CELLS),
    items: new Uint8Array(CELLS),
    pending: new Uint8Array(CELLS),
    flameEnd: new Int32Array(CELLS),
    flameStart: new Int32Array(CELLS),
    warnEnd: new Int32Array(CELLS),
    crumbleEnd: new Int32Array(CELLS),
    fight: [newFighter(0), newFighter(1), newFighter(2), newFighter(3)],
    bombs,
    bombCount: 0,
    cellsVersion: 0,
    dirty: new Uint8Array(CELLS),
    fx: new Int32Array(FX_MAX * 4),
    fxLen: 0,
  };
};

export const arenaOfWorld = (w: World): Arena => ARENAS[w.arena] ?? (ARENAS[0] as Arena);

const touch = (w: World, c: number): void => {
  w.dirty[c] = 1;
  w.cellsVersion += 1;
};

const fx = (w: World, kind: number, a: number, b: number, tick: number): void => {
  if (w.fxLen >= FX_MAX) return;
  const o = w.fxLen * 4;
  w.fx[o] = kind;
  w.fx[o + 1] = a;
  w.fx[o + 2] = b;
  w.fx[o + 3] = tick;
  w.fxLen += 1;
};

/** Reveal items whose flame has burned out. */
const settle = (w: World): void => {
  for (let c = 0; c < CELLS; c += 1) {
    if ((w.pending[c] as number) !== 0 && (w.flameEnd[c] as number) <= w.roundTick) {
      w.items[c] = w.pending[c] as number;
      w.pending[c] = 0;
      touch(w, c);
    }
  }
};

/** Moves the world to core tick `t`: the round tick advances by the playing steps in between. */
export const advanceTo = (w: World, t: number): void => {
  if (t <= w.tick) return;
  if (w.phase === Phase.Playing) {
    w.roundTick += t - w.tick;
    w.tick = t;
    settle(w);
  } else {
    w.tick = t;
  }
};

const findBomb = (w: World, id: number): number => {
  for (let i = 0; i < w.bombCount; i += 1) if ((w.bombs[i] as WBomb).id === id) return i;
  return -1;
};

const removeBomb = (w: World, i: number): void => {
  const b = w.bombs[i] as WBomb;
  for (let j = i; j < w.bombCount - 1; j += 1) w.bombs[j] = w.bombs[j + 1] as WBomb;
  w.bombs[w.bombCount - 1] = b;
  w.bombCount -= 1;
};

const orphan = (w: World, slot: number): void => {
  for (let i = 0; i < w.bombCount; i += 1) {
    const b = w.bombs[i] as WBomb;
    if (b.owner === slot && b.fuseEnd === NO_END) b.fuseEnd = w.roundTick + ORPHAN_FUSE;
  }
};

const burn = (w: World, c: number, end: number): void => {
  if (c < 0 || c >= CELLS) return;
  if ((w.flameEnd[c] as number) <= w.roundTick) w.flameStart[c] = w.roundTick;
  if (end > (w.flameEnd[c] as number)) w.flameEnd[c] = end;
};

const centreOf = (c: number): number => ((c % W) << 6) + 32;
const centreYOf = (c: number): number => (((c / W) | 0) << 6) + 32;

/** One game event (kind already read) at core tick `t`. Returns false on a bad event. */
const applyGame = (w: World, kind: number, r: ByteReader, t: number): boolean => {
  switch (kind) {
    case EV.BombPlaced: {
      const id = r.u16();
      const slot = r.u8();
      const cell = r.u8();
      const range = r.u8();
      const remote = r.u8();
      if (!r.ok || slot > 3 || cell >= CELLS) return false;
      if (w.bombCount >= MAX_BOMBS) return true;
      const b = w.bombs[w.bombCount] as WBomb;
      w.bombCount += 1;
      b.id = id;
      b.owner = slot;
      b.cell = cell;
      b.x = centreOf(cell);
      b.y = centreYOf(cell);
      b.fuseEnd = remote ? NO_END : w.roundTick + FUSE - 1;
      b.range = range;
      b.slideDir = 0;
      b.slideSpeed = 0;
      b.passers = 0;
      b.placedAt = t;
      fx(w, kind, slot, cell, t);
      return true;
    }
    case EV.BombKicked: {
      const id = r.u16();
      const d = r.u8();
      if (!r.ok) return false;
      const i = findBomb(w, id);
      if (i >= 0) {
        const b = w.bombs[i] as WBomb;
        b.slideDir = d & 7;
        b.slideSpeed = d & KICK_BELT ? BELT_SPEED : KICK_SPEED;
        if (!(d & KICK_BELT)) fx(w, kind, b.owner, b.cell, t);
      }
      return true;
    }
    case EV.BombStopped: {
      const id = r.u16();
      const cell = r.u8();
      if (!r.ok || cell >= CELLS) return false;
      const i = findBomb(w, id);
      if (i >= 0) {
        const b = w.bombs[i] as WBomb;
        b.slideDir = 0;
        b.slideSpeed = 0;
        b.cell = cell;
        b.x = centreOf(cell);
        b.y = centreYOf(cell);
      }
      return true;
    }
    case EV.Explode: {
      const id = r.u16();
      const cell = r.u8();
      const a0 = r.u8();
      const a1 = r.u8();
      const a2 = r.u8();
      const a3 = r.u8();
      if (!r.ok || cell >= CELLS) return false;
      const i = findBomb(w, id);
      const owner = i >= 0 ? (w.bombs[i] as WBomb).owner : 0;
      if (i >= 0) removeBomb(w, i);
      const end = w.roundTick + FLAME - 1;
      burn(w, cell, end);
      for (let d = 0; d < 4; d += 1) {
        const len = (d === 0 ? a0 : d === 1 ? a1 : d === 2 ? a2 : a3) & 0x7f;
        const step = d === 0 ? -W : d === 1 ? 1 : d === 2 ? W : -1;
        for (let k = 1; k <= len && k <= 15; k += 1) burn(w, cell + step * k, end);
      }
      fx(w, kind, owner, cell, t);
      return true;
    }
    case EV.BlockBroken: {
      const cell = r.u8();
      const item = r.u8();
      if (!r.ok || cell >= CELLS || item > 5) return false;
      w.cells[cell] = Cell.Floor;
      if (item !== 0) w.pending[cell] = item;
      w.crumbleEnd[cell] = w.roundTick + FLAME - 1;
      touch(w, cell);
      fx(w, kind, item, cell, t);
      return true;
    }
    case EV.ItemTaken: {
      const cell = r.u8();
      const slot = r.u8();
      const item = r.u8();
      if (!r.ok || cell >= CELLS) return false;
      w.items[cell] = 0;
      touch(w, cell);
      fx(w, kind, slot, item, t);
      return true;
    }
    case EV.ItemBurned: {
      const cell = r.u8();
      if (!r.ok || cell >= CELLS) return false;
      w.items[cell] = 0;
      touch(w, cell);
      return true;
    }
    case EV.SteelWarn: {
      const cell = r.u8();
      if (!r.ok || cell >= CELLS) return false;
      w.warnEnd[cell] = w.roundTick + WARN_TICKS;
      w.spiralIndex += 1;
      fx(w, kind, 0, cell, t);
      return true;
    }
    case EV.SteelDrop: {
      const cell = r.u8();
      if (!r.ok || cell >= CELLS) return false;
      w.cells[cell] = Cell.Steel;
      w.items[cell] = 0;
      w.pending[cell] = 0;
      w.flameEnd[cell] = 0;
      w.warnEnd[cell] = 0;
      for (let i = w.bombCount - 1; i >= 0; i -= 1) if ((w.bombs[i] as WBomb).cell === cell) removeBomb(w, i);
      touch(w, cell);
      fx(w, kind, 0, cell, t);
      return true;
    }
    case EV.ItemDropped: {
      const cell = r.u8();
      const item = r.u8();
      if (!r.ok || cell >= CELLS || item > 5) return false;
      w.items[cell] = item;
      touch(w, cell);
      return true;
    }
    case EV.Died: {
      const slot = r.u8();
      const killer = r.u8();
      const cause = r.u8();
      if (!r.ok || slot > 3) return false;
      const f = w.fight[slot] as WFighter;
      f.alive = false;
      f.moving = false;
      f.diedAt = t;
      orphan(w, slot);
      fx(w, kind, slot, killer | (cause << 8), t);
      return true;
    }
    case EV.Stats: {
      const slot = r.u8();
      const a = r.u8();
      const b = r.u8();
      if (!r.ok || slot > 3) return false;
      const f = w.fight[slot] as WFighter;
      f.bombsMax = a & 15;
      f.range = a >> 4;
      f.speedLvl = b & 7;
      f.glove = (b & 8) !== 0;
      f.clicker = (b & 16) !== 0;
      return true;
    }
    case EV.Teleport: {
      const k = r.u8();
      const who = r.u16();
      const to = r.u8();
      if (!r.ok || to >= CELLS || k > 2) return false;
      if (k === TELE_BOMB) {
        const i = findBomb(w, who);
        if (i >= 0) {
          const b = w.bombs[i] as WBomb;
          b.cell = to;
          b.x = centreOf(to);
          b.y = centreYOf(to);
        }
      } else if (who < 4) {
        const f = w.fight[who] as WFighter;
        f.x = centreOf(to);
        f.y = centreYOf(to);
        if (k === TELE_FIGHTER) f.padEnd = w.roundTick + PAD_COOLDOWN;
        fx(w, kind, who, to, t);
      }
      return true;
    }
    case EV.Round: {
      const phase = r.u8();
      const round = r.u8();
      const who = r.i8();
      const s0 = r.u8();
      const s1 = r.u8();
      const s2 = r.u8();
      const s3 = r.u8();
      if (!r.ok || phase > Phase.MatchEnd) return false;
      w.phase = phase;
      w.round = round;
      w.scores[0] = s0;
      w.scores[1] = s1;
      w.scores[2] = s2;
      w.scores[3] = s3;
      if (phase === Phase.Countdown) w.phaseEnd = t + COUNTDOWN;
      else if (phase === Phase.Resuming) w.phaseEnd = t + RESUME_COUNT;
      else if (phase === Phase.RoundEnd) {
        w.phaseEnd = t + RESULT_CARD;
        w.winner = who;
      } else if (phase === Phase.Frozen) {
        w.holdWinner = who;
        w.holdStart = t;
      } else if (phase === Phase.MatchEnd) w.winner = who;
      if (phase !== Phase.Frozen) w.holdWinner = -1;
      fx(w, kind, phase, who, t);
      return true;
    }
    default:
      return false;
  }
};

const applyPlatform = (w: World, e: PlatformEvent, t: number): void => {
  if (e.k !== 'seat' || e.slot > 3) return;
  const f = w.fight[e.slot] as WFighter;
  const was = f.seat;
  f.seat = e.state;
  if (e.state === Seat.Ghost) {
    f.moving = false;
    orphan(w, e.slot);
  } else if (f.alive && ((e.state === Seat.Live && was === Seat.Ghost) || e.state === Seat.Bot || (e.state === Seat.Left && was === Seat.Ghost))) {
    f.shieldEnd = w.roundTick + SHIELD;
  }
  fx(w, PEV.SeatState, e.slot, e.state | (was << 8), t);
};

/**
 * Applies a FRAME's events (in order, each at its own tick) and then its snapshot. Returns false
 * when an event block is malformed (the client then asks for a resync).
 */
/** The world the event walkers below apply to (module scratch: no closures per frame). */
let target: World | null = null;

/** A bad event: leave the reader past its end, so the host's decode check asks for a resync. */
const bad = (r: ByteReader): boolean => {
  r.skip(r.remaining + 1);
  return false;
};

const onGame = (kind: number, r: ByteReader, t: number): boolean => {
  const w = target as World;
  if (t <= w.keyTick) {
    // Already in the keyframe: skip its bytes.
    const size = (EV_SIZE[kind] as number | undefined) ?? 0;
    if (size === 0) return bad(r);
    r.skip(size - 1);
    return r.ok;
  }
  advanceTo(w, t);
  return applyGame(w, kind, r, t) || bad(r);
};

const onPlatform = (e: PlatformEvent, t: number): void => {
  const w = target as World;
  if (t <= w.keyTick) return;
  advanceTo(w, t);
  applyPlatform(w, e, t);
};

export const applyFrame = (w: World, frameTick: number, events: EventBlock | null, snapshot: ByteReader | null): boolean => {
  w.fxLen = 0;
  if (!w.ready) return true;
  let ok = true;
  if (events) {
    target = w;
    ok = forEachEvent(events, onGame, onPlatform);
    target = null;
  }
  advanceTo(w, frameTick);
  if (snapshot && frameTick > w.keyTick) {
    if (!applySnapshot(w, snapshot)) ok = false;
  }
  return ok;
};

/** Snapshot body (§3.3): fighters' positions and flags, then sliding bombs' positions. */
export const applySnapshot = (w: World, r: ByteReader): boolean => {
  const n = r.u8();
  if (n > 4) return false;
  for (let i = 0; i < n; i += 1) {
    const a = r.u8();
    const x = r.u16();
    const y = r.u16();
    if (!r.ok) return false;
    const f = w.fight[a & 3] as WFighter;
    f.facing = (a >> 2) & 7;
    f.moving = (a & 0x20) !== 0;
    f.alive = (a & 0x40) !== 0;
    f.ice = (a & 0x80) !== 0;
    f.x = x;
    f.y = y;
  }
  const m = r.u8();
  if (m > MAX_BOMBS) return false;
  for (let i = 0; i < m; i += 1) {
    const id = r.u16();
    const x = r.u16();
    const y = r.u16();
    if (!r.ok) return false;
    const bi = findBomb(w, id);
    if (bi >= 0) {
      const b = w.bombs[bi] as WBomb;
      b.x = x;
      b.y = y;
      b.cell = cellAt(x, y);
    }
  }
  return r.ok;
};

/** Ticks of flame left on `c` (0 when none). */
export const flameLeft = (w: World, c: number): number => {
  const e = (w.flameEnd[c] as number) - w.roundTick;
  return e > 0 ? e : 0;
};

/** The round tick, phase and cell kind views a renderer needs, without reaching into internals. */
export const fuseLeft = (w: World, b: WBomb): number => (b.fuseEnd === NO_END ? -1 : Math.max(0, b.fuseEnd - w.roundTick));

export { arenaOfWorld as arenaOf };
export type { PlatformEvent };
