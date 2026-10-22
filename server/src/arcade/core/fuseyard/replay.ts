/**
 * The canonical dump (fuseyard.md §2.5): every field of a `Match` in a fixed order, block contents
 * and RNG states included. One function serves the golden hash, HANDOVER (deflated by the server)
 * and replay dumps; `restore` turns it back into a match that steps identically.
 *
 * The replay ring keeps a dump every 900 ticks (the last two) plus, since the older one, every
 * tick's input bytes and the seat and grace values, so `replayRun` reproduces a bug in a test even
 * though seats change mid-match.
 */
import { ByteReader, ByteWriter } from '../bytes.js';
import { fnv1a32 } from '../hash.js';
import { createMatch } from './sim.js';
import { ARENA_IDS, CELLS, MAX_BOMBS, SeatCmd, newStepIn, type BotBrain, type Bomb, type Fighter, type Match, type MatchConfig, type StepIn } from './rules.js';

const DUMP_VERSION = 1;
const DUMP_MAX = 6144;

const arenaCode = (a: MatchConfig['arena']): number => (a === 'rotation' ? 0xff : ARENA_IDS.indexOf(a));

const writeFighter = (w: ByteWriter, f: Fighter): void => {
  w.u8((f.seated ? 1 : 0) | (f.left ? 2 : 0) | (f.moving ? 4 : 0) | (f.alive ? 8 : 0) | (f.glove ? 16 : 0) | (f.clicker ? 32 : 0) | (f.reclaim ? 64 : 0));
  w.u8(f.control);
  w.u8(f.botLevel);
  w.u16(f.x);
  w.u16(f.y);
  w.u8(f.facing);
  w.u32(f.diedAt);
  w.u8(f.bombsMax);
  w.u8(f.bombsOut);
  w.u8(f.range);
  w.u8(f.speedLvl);
  w.bytes(f.collected);
  w.u8(f.padCooldown);
  w.u8(f.dodgeGrace);
  w.u8(f.doomedTicks);
  w.u8(f.shield);
  w.u8(f.ghostLock);
  w.u8(f.lastInput);
  w.u16(f.kills);
  w.u16(f.blocksBroken);
  w.u16(f.deaths);
};

const readFighter = (r: ByteReader, f: Fighter): void => {
  const flags = r.u8();
  f.seated = (flags & 1) !== 0;
  f.left = (flags & 2) !== 0;
  f.moving = (flags & 4) !== 0;
  f.alive = (flags & 8) !== 0;
  f.glove = (flags & 16) !== 0;
  f.clicker = (flags & 32) !== 0;
  f.reclaim = (flags & 64) !== 0;
  f.control = r.u8() as Fighter['control'];
  f.botLevel = r.u8() as Fighter['botLevel'];
  f.x = r.u16();
  f.y = r.u16();
  f.facing = r.u8() as Fighter['facing'];
  f.diedAt = r.u32();
  f.bombsMax = r.u8();
  f.bombsOut = r.u8();
  f.range = r.u8();
  f.speedLvl = r.u8();
  f.collected.set(r.bytes(6));
  f.padCooldown = r.u8();
  f.dodgeGrace = r.u8();
  f.doomedTicks = r.u8();
  f.shield = r.u8();
  f.ghostLock = r.u8();
  f.lastInput = r.u8();
  f.kills = r.u16();
  f.blocksBroken = r.u16();
  f.deaths = r.u16();
};

const writeBrain = (w: ByteWriter, b: BotBrain): void => {
  w.u8(b.rule);
  w.i16(b.target);
  w.i16(b.replanIn);
  w.u8(b.lineBombs);
  w.u8(b.pathLen);
  w.u8(b.pathPos);
  w.u8(b.action);
  w.u8(b.lastDir);
  w.u32(b.lastCell >>> 0);
  w.u16(b.stillTicks);
  for (let i = 0; i < b.pathLen; i += 1) w.u8(b.path[i] as number);
};

const readBrain = (r: ByteReader, b: BotBrain): void => {
  b.rule = r.u8();
  b.target = r.i16();
  b.replanIn = r.i16();
  b.lineBombs = r.u8();
  b.pathLen = Math.min(r.u8(), b.path.length);
  b.pathPos = r.u8();
  b.action = r.u8();
  b.lastDir = r.u8();
  b.lastCell = r.u32() | 0;
  b.stillTicks = r.u16();
  for (let i = 0; i < b.pathLen; i += 1) b.path[i] = r.u8();
};

/** The canonical dump of a match (about 2.2 KB). */
export const dumpMatch = (m: Match, w: ByteWriter = new ByteWriter(DUMP_MAX)): Uint8Array => {
  const c = m.config;
  const r = m.current;
  w.reset();
  w.u8(DUMP_VERSION);
  w.u8(c.mode === 'quickfire' ? 1 : 0);
  w.u8(arenaCode(c.arena));
  w.u8(c.fighters);
  w.u8(c.winsNeeded);
  w.u8(c.botLevel);
  w.u32(c.seed);
  w.u32(m.tick);
  w.u8(m.round);
  w.bytes(m.scores);
  w.u8(m.draws);
  w.bytes(m.arenasPlayed);
  w.u8(m.matchEnded ? 1 : 0);
  w.u16(r.tick);
  w.u8(r.phase);
  w.u8(r.phaseTicks);
  w.u8(r.arena);
  w.bytes(r.cells);
  w.bytes(r.special);
  w.bytes(r.hidden);
  w.bytes(r.items);
  w.bytes(r.pendingItem);
  w.bytes(r.flame);
  w.bytes(r.flameOwner);
  w.bytes(r.warn);
  for (let s = 0; s < 4; s += 1) writeFighter(w, r.fighters[s] as Fighter);
  w.u8(r.bombCount);
  for (let i = 0; i < r.bombCount; i += 1) {
    const b = r.bombs[i] as Bomb;
    w.u16(b.id);
    w.u8(b.owner);
    w.u16(b.x);
    w.u16(b.y);
    w.u16(b.fuse);
    w.u8(b.range);
    w.u8(b.slideDir);
    w.u8(b.slideSpeed);
    w.u8(b.passers);
  }
  w.u16(r.nextBombId);
  w.u8(r.spiralIndex);
  w.u16(r.nextDropTick);
  w.u32(r.rng >>> 0);
  w.i8(r.winner);
  w.u8(r.holdTicks);
  w.i8(r.holdWinner);
  for (let s = 0; s < 4; s += 1) w.u32(m.botRng[s] as number);
  for (let s = 0; s < 4; s += 1) writeBrain(w, m.brains[s] as BotBrain);
  return w.copy();
};

/** The golden hash: FNV-1a 32 of the canonical dump. */
export const hashMatch = (m: Match): number => fnv1a32(dumpMatch(m, scratch));
const scratch = new ByteWriter(DUMP_MAX);

/** A match from its canonical dump, or null when malformed. */
export const restoreMatch = (bytes: Uint8Array): Match | null => {
  const r = new ByteReader(bytes);
  if (r.u8() !== DUMP_VERSION) return null;
  const mode = r.u8();
  const arena = r.u8();
  const fighters = r.u8();
  const wins = r.u8();
  const level = r.u8();
  const seed = r.u32();
  if (!r.ok || mode > 1 || (arena !== 0xff && arena >= ARENA_IDS.length) || fighters < 2 || fighters > 4 || level > 2) return null;
  const config: MatchConfig = {
    mode: mode === 1 ? 'quickfire' : 'brawl',
    arena: arena === 0xff ? 'rotation' : (ARENA_IDS[arena] as MatchConfig['arena']),
    fighters: fighters as 2 | 3 | 4,
    winsNeeded: (wins === 2 || wins === 5 ? wins : 3) as 2 | 3 | 5,
    botLevel: level as MatchConfig['botLevel'],
    seed,
  };
  const m = createMatch(config, []);
  m.tick = r.u32();
  m.round = r.u8();
  m.scores.set(r.bytes(4));
  m.draws = r.u8();
  m.arenasPlayed.set(r.bytes(m.arenasPlayed.length));
  m.matchEnded = r.u8() === 1;
  const rd = m.current;
  rd.tick = r.u16();
  rd.phase = r.u8() as Match['current']['phase'];
  rd.phaseTicks = r.u8();
  rd.arena = r.u8();
  rd.cells.set(r.bytes(CELLS));
  rd.special.set(r.bytes(CELLS));
  rd.hidden.set(r.bytes(CELLS));
  rd.items.set(r.bytes(CELLS));
  rd.pendingItem.set(r.bytes(CELLS));
  rd.flame.set(r.bytes(CELLS));
  rd.flameOwner.set(r.bytes(CELLS));
  rd.warn.set(r.bytes(CELLS));
  for (let s = 0; s < 4; s += 1) readFighter(r, rd.fighters[s] as Fighter);
  rd.bombCount = Math.min(r.u8(), MAX_BOMBS);
  for (let i = 0; i < rd.bombCount; i += 1) {
    const b = rd.bombs[i] as Bomb;
    b.id = r.u16();
    b.owner = r.u8() & 3;
    b.x = r.u16();
    b.y = r.u16();
    b.fuse = r.u16();
    b.range = r.u8();
    b.slideDir = (r.u8() & 7) as Bomb['slideDir'];
    b.slideSpeed = r.u8();
    b.passers = r.u8();
  }
  rd.nextBombId = r.u16();
  rd.spiralIndex = r.u8();
  rd.nextDropTick = r.u16();
  rd.rng = r.u32() | 0;
  rd.winner = r.i8();
  rd.holdTicks = r.u8();
  rd.holdWinner = r.i8();
  for (let s = 0; s < 4; s += 1) m.botRng[s] = r.u32();
  for (let s = 0; s < 4; s += 1) readBrain(r, m.brains[s] as BotBrain);
  if (!r.ok || rd.arena >= ARENA_IDS.length) return null;
  m.eventsLen = 0;
  m.eventCount = 0;
  m.seatOutLen = 0;
  m.roundStarted = false;
  return m;
};

// ------------------------------------------------------------------ replay ring

/** A dump every this many ticks; the last two are kept. */
export const RING_EVERY = 900;
const RING_TICKS = RING_EVERY * 2;

/**
 * Inputs and seat/grace values since the older of the two kept dumps. Records are written in step
 * order, so `replayRun` feeds them back exactly.
 */
export interface ReplayRing {
  /** Call before each `step(m, input)`. */
  record(m: Match, input: StepIn): void;
  /** Older dump + records, raw (the server deflates it). */
  bytes(): Uint8Array;
}

export const createReplayRing = (): ReplayRing => {
  let dumpA: Uint8Array | null = null;
  let dumpB: Uint8Array | null = null;
  let startA = 0;
  let startB = 0;
  // Per tick: 4 input bytes; plus sparse records (tick offset, slot, kind, value).
  const inputs = new Uint8Array(RING_TICKS * 4);
  let ticks = 0;
  const recs = new Uint8Array(4096 * 5);
  let recLen = 0;
  const lastGrace = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
  const dumper = new ByteWriter(DUMP_MAX);
  const rec = (off: number, slot: number, kind: number, value: number): void => {
    if (recLen + 5 > recs.length) return;
    recs[recLen] = off & 0xff;
    recs[recLen + 1] = off >> 8;
    recs[recLen + 2] = slot;
    recs[recLen + 3] = kind;
    recs[recLen + 4] = value;
    recLen += 5;
  };
  return {
    record(m, input) {
      if (dumpA === null) {
        dumpA = dumpB = dumpMatch(m, dumper);
        startA = startB = m.tick;
      } else if (m.tick - startB >= RING_EVERY) {
        // Rotate: the newer dump becomes the older one; everything before it is dropped.
        const drop = startB - startA;
        inputs.copyWithin(0, drop * 4, ticks * 4);
        ticks -= drop;
        let keep = 0;
        for (let i = 0; i < recLen; i += 5) {
          const t = (recs[i] as number) | ((recs[i + 1] as number) << 8);
          if (t < drop) continue;
          recs[keep] = (t - drop) & 0xff;
          recs[keep + 1] = (t - drop) >> 8;
          recs[keep + 2] = recs[i + 2] as number;
          recs[keep + 3] = recs[i + 3] as number;
          recs[keep + 4] = recs[i + 4] as number;
          keep += 5;
        }
        recLen = keep;
        dumpA = dumpB;
        startA = startB;
        dumpB = dumpMatch(m, dumper);
        startB = m.tick;
        // Grace is read only at round setup: record the values again from the new start.
        lastGrace.fill(0xff);
      }
      const off = ticks;
      if (ticks < RING_TICKS) {
        inputs.set(input.inputs, ticks * 4);
        ticks += 1;
      }
      for (let s = 0; s < 4; s += 1) {
        const seat = input.seats[s] as number;
        if (seat !== SeatCmd.None) rec(off, s, 0, seat);
        const g = input.grace[s] as number;
        if (g !== lastGrace[s]) {
          lastGrace[s] = g;
          rec(off, s, 1, g);
        }
      }
    },
    bytes() {
      if (!dumpA) return new Uint8Array(0);
      const w = new ByteWriter(4 + dumpA.length + 4 + ticks * 4 + 4 + recLen);
      w.u32(dumpA.length).bytes(dumpA);
      w.u32(ticks).bytes(inputs.subarray(0, ticks * 4));
      w.u32(recLen / 5).bytes(recs.subarray(0, recLen));
      return w.copy();
    },
  };
};

/**
 * Restores a replay's dump and steps it through its records with `step` (injected, so tests can
 * use the real sim). Returns the match after the last recorded tick, or null when malformed.
 */
export const replayRun = (bytes: Uint8Array, stepFn: (m: Match, input: StepIn) => void, onTick?: (m: Match, i: number) => void): Match | null => {
  const r = new ByteReader(bytes);
  const dl = r.u32();
  const dump = r.bytes(dl);
  const ticks = r.u32();
  const inputs = r.bytes(ticks * 4);
  const nrec = r.u32();
  const recs = r.bytes(nrec * 5);
  if (!r.ok) return null;
  const m = restoreMatch(dump);
  if (!m) return null;
  const input = newStepIn();
  let ri = 0;
  for (let t = 0; t < ticks; t += 1) {
    input.inputs.set(inputs.subarray(t * 4, t * 4 + 4));
    input.seats.fill(SeatCmd.None);
    for (; ri < nrec; ri += 1) {
      const o = ri * 5;
      const rt = (recs[o] as number) | ((recs[o + 1] as number) << 8);
      if (rt !== t) break;
      const slot = (recs[o + 2] as number) & 3;
      if (recs[o + 3] === 0) input.seats[slot] = recs[o + 4] as number;
      else input.grace[slot] = recs[o + 4] as number;
    }
    stepFn(m, input);
    onTick?.(m, t);
  }
  return m;
};
