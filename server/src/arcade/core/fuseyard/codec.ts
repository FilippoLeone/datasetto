/**
 * Fuseyard's wire formats (fuseyard.md §3.3), little-endian: the UP payload, the WELCOME cfg, the
 * snapshot body, the KEYFRAME body and the PHASE 4 result body. Events are written by the sim in
 * wire format; `view.ts` reads them. Block contents never appear in any of these: the keyframe is
 * encoded from the public `World`, which has no field for them.
 *
 * Decoders return false / null on malformed input and never throw.
 */
import { ByteReader, ByteWriter } from '../bytes.js';
import { ARENA_IDS, CELLS, Cell, Control, IN_BOMB, IN_DETONATE, MAX_BOMBS, Mode, Phase, REMOTE, ROTATION, Special, W, cellAt, type BotLevel, type Fighter, type Match, type MatchConfig } from './rules.js';
import { NO_END, createWorld, type WBomb, type WFighter, type World } from './view.js';
import { seatState } from './sim.js';

// ------------------------------------------------------------------ UP

/** Most inputs in one UP (a stall of 6 ticks). */
export const UP_MAX_INPUTS = 6;

/** `u8 n, n × u8 input`, oldest first; `upSeq` (the envelope's) is the newest input's seq. */
export const encodeUp = (inputs: Uint8Array, n: number, out?: Uint8Array): Uint8Array => {
  const k = n < 1 ? 1 : n > UP_MAX_INPUTS ? UP_MAX_INPUTS : n;
  const buf = out && out.length >= k + 1 ? out.subarray(0, k + 1) : new Uint8Array(k + 1);
  buf[0] = k;
  for (let i = 0; i < k; i += 1) buf[i + 1] = (inputs[inputs.length - k + i] as number) & 0xff;
  return buf;
};

/** The inputs of an UP, or null when malformed (n outside 1–6 or a wrong length). Bad directions read as 0. */
export const decodeUp = (payload: Uint8Array): Uint8Array | null => {
  if (payload.length < 2) return null;
  const n = payload[0] as number;
  if (n < 1 || n > UP_MAX_INPUTS || payload.length !== n + 1) return null;
  const out = payload.subarray(1, n + 1);
  return out;
};

/** A raw input byte with out-of-range directions cleared (a value above 4 reads as 0). */
export const sanitizeInput = (v: number): number => {
  let d1 = v & 7;
  let d2 = (v >> 3) & 7;
  if (d1 > 4) d1 = 0;
  if (d2 > 4) d2 = 0;
  return d1 | (d2 << 3) | (v & (IN_BOMB | IN_DETONATE));
};

// ------------------------------------------------------------------ cfg (WELCOME)

export interface WireConfig {
  mode: 'brawl' | 'quickfire';
  arena: MatchConfig['arena'];
  fighters: 2 | 3 | 4;
  winsNeeded: 2 | 3 | 5;
  botLevel: BotLevel;
}

export const CFG_BYTES = 5;

export const encodeCfg = (c: WireConfig): Uint8Array => {
  const arena = c.arena === 'rotation' ? ROTATION : ARENA_IDS.indexOf(c.arena);
  return new Uint8Array([c.mode === 'quickfire' ? Mode.Quickfire : Mode.Brawl, arena < 0 ? ROTATION : arena, c.fighters, c.winsNeeded, c.botLevel]);
};

export const decodeCfg = (b: Uint8Array): WireConfig | null => {
  if (b.length < CFG_BYTES) return null;
  const mode = b[0] as number;
  const arena = b[1] as number;
  const fighters = b[2] as number;
  const wins = b[3] as number;
  const level = b[4] as number;
  if (mode > 1 || (arena !== ROTATION && arena >= ARENA_IDS.length)) return null;
  if (fighters < 2 || fighters > 4 || (wins !== 2 && wins !== 3 && wins !== 5) || level > 2) return null;
  return {
    mode: mode === Mode.Quickfire ? 'quickfire' : 'brawl',
    arena: arena === ROTATION ? 'rotation' : (ARENA_IDS[arena] as MatchConfig['arena']),
    fighters: fighters as 2 | 3 | 4,
    winsNeeded: wins as 2 | 3 | 5,
    botLevel: level as BotLevel,
  };
};

// ------------------------------------------------------------------ snapshot

/** 1 + 5 per fighter + 1 + 6 per sliding bomb. */
export const SNAPSHOT_MAX = 1 + 5 * 4 + 1 + 6 * MAX_BOMBS;

const onIce = (m: Match, f: Fighter): boolean => f.moving && m.current.special[cellAt(f.x, f.y)] === Special.Ice;

export const encodeSnapshot = (m: Match, w: ByteWriter): ByteWriter => {
  const r = m.current;
  const n = m.config.fighters;
  w.u8(n);
  for (let s = 0; s < n; s += 1) {
    const f = r.fighters[s] as Fighter;
    w.u8((s & 3) | ((f.facing & 7) << 2) | (f.moving ? 0x20 : 0) | (f.alive ? 0x40 : 0) | (onIce(m, f) ? 0x80 : 0));
    w.u16(f.x);
    w.u16(f.y);
  }
  let sliding = 0;
  for (let i = 0; i < r.bombCount; i += 1) if ((r.bombs[i] as Match['current']['bombs'][number]).slideDir !== 0) sliding += 1;
  w.u8(sliding);
  for (let i = 0; i < r.bombCount; i += 1) {
    const b = r.bombs[i] as Match['current']['bombs'][number];
    if (b.slideDir === 0) continue;
    w.u16(b.id);
    w.u16(b.x);
    w.u16(b.y);
  }
  return w;
};

// ------------------------------------------------------------------ keyframe

export const KEYFRAME_MAX = 512;
/** Above this many flames the keyframe carries a 4-bit map instead of a list. */
const FLAME_LIST_MAX = 49;

/** The server's public view of a match, in the same shape the client builds (no block contents). */
export const worldFromMatch = (m: Match, w: World): World => {
  const r = m.current;
  const R = r.tick;
  w.ready = true;
  w.fighters = m.config.fighters;
  w.tick = m.tick;
  w.keyTick = m.tick;
  w.roundTick = R;
  w.phase = r.phase;
  w.phaseEnd = m.tick + r.phaseTicks;
  w.holdStart = m.tick - r.holdTicks;
  w.holdWinner = r.holdWinner;
  w.winner = r.winner;
  w.round = m.round;
  w.arena = r.arena;
  w.scores.set(m.scores);
  w.spiralIndex = r.spiralIndex;
  w.cells.set(r.cells);
  w.items.set(r.items);
  w.pending.set(r.pendingItem);
  for (let c = 0; c < CELLS; c += 1) {
    const fl = r.flame[c] as number;
    w.flameEnd[c] = fl > 0 ? R + fl : 0;
    w.flameStart[c] = fl > 0 ? R + fl - 15 : 0;
    const wn = r.warn[c] as number;
    w.warnEnd[c] = wn > 0 ? R + wn : 0;
  }
  for (let s = 0; s < 4; s += 1) {
    const f = r.fighters[s] as Fighter;
    const o = w.fight[s] as WFighter;
    o.seat = seatState(f);
    o.x = f.x;
    o.y = f.y;
    o.facing = f.facing;
    o.moving = f.moving;
    o.alive = f.alive;
    o.ice = onIce(m, f);
    o.bombsMax = f.bombsMax;
    o.range = f.range;
    o.speedLvl = f.speedLvl;
    o.glove = f.glove;
    o.clicker = f.clicker;
    o.padEnd = R + f.padCooldown;
    o.shieldEnd = R + f.shield;
    o.diedAt = f.diedAt;
  }
  w.bombCount = r.bombCount;
  for (let i = 0; i < r.bombCount; i += 1) {
    const b = r.bombs[i] as Match['current']['bombs'][number];
    const o = w.bombs[i] as WBomb;
    o.id = b.id;
    o.owner = b.owner;
    o.cell = cellAt(b.x, b.y);
    o.x = b.x;
    o.y = b.y;
    o.fuseEnd = b.fuse === REMOTE ? NO_END : R + b.fuse;
    o.range = b.range;
    o.slideDir = b.slideDir;
    o.slideSpeed = b.slideSpeed;
    o.passers = b.passers;
    o.placedAt = 0;
  }
  return w;
};

const clamp8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** KEYFRAME body from a world (§3.3). `passers` false writes 0 for the passer masks (for comparisons). */
export const encodeKeyframe = (w: World, out: ByteWriter, passers = true): ByteWriter => {
  const R = w.roundTick;
  const frozen = w.phase === Phase.Frozen;
  out.u8(w.arena);
  out.u8(w.round & 0xff);
  out.u8(w.phase);
  out.u16(R);
  for (let s = 0; s < 4; s += 1) out.u8(w.scores[s] as number);
  out.u8(w.spiralIndex);
  // Frozen: the hold's ticks (0 while no lone human holds); else the countdown or card left.
  out.u8(clamp8(frozen ? (w.holdWinner >= 0 ? w.tick - w.holdStart : 0) : w.phase === Phase.Playing ? 0 : w.phaseEnd - w.tick));
  out.u8(((w.winner + 1) & 7) | (((frozen ? w.holdWinner : -1) + 1) & 7) << 3);
  for (let i = 0; i < CELLS; i += 2) out.u8(((w.cells[i] as number) & 15) | (i + 1 < CELLS ? ((w.cells[i + 1] as number) & 15) << 4 : 0));
  let items = 0;
  for (let c = 0; c < CELLS; c += 1) if ((w.items[c] as number) !== 0 || (w.pending[c] as number) !== 0) items += 1;
  out.u8(items);
  for (let c = 0; c < CELLS; c += 1) {
    const it = w.items[c] as number;
    const pend = w.pending[c] as number;
    if (it === 0 && pend === 0) continue;
    out.u8(c);
    out.u8(it !== 0 ? it : pend | 0x80);
  }
  out.u8(w.bombCount);
  for (let i = 0; i < w.bombCount; i += 1) {
    const b = w.bombs[i] as WBomb;
    out.u16(b.id);
    out.u8(b.cell);
    out.u8(b.fuseEnd === NO_END ? 0xff : clamp8(b.fuseEnd - R));
    out.u8((b.owner & 3) | ((b.range & 15) << 2) | (b.slideDir !== 0 ? 0x40 : 0));
    out.u8((passers ? b.passers & 15 : 0) | ((b.slideDir & 7) << 4) | (b.slideSpeed === 4 ? 0x80 : 0));
  }
  let flames = 0;
  for (let c = 0; c < CELLS; c += 1) if ((w.flameEnd[c] as number) > R) flames += 1;
  if (flames <= FLAME_LIST_MAX) {
    out.u8(flames);
    for (let c = 0; c < CELLS; c += 1) {
      const left = (w.flameEnd[c] as number) - R;
      if (left <= 0) continue;
      out.u8(c);
      out.u8(clamp8(left));
    }
  } else {
    out.u8(0xff);
    for (let i = 0; i < CELLS; i += 2) {
      const a = Math.max(0, Math.min(15, (w.flameEnd[i] as number) - R));
      const b = i + 1 < CELLS ? Math.max(0, Math.min(15, (w.flameEnd[i + 1] as number) - R)) : 0;
      out.u8(a | (b << 4));
    }
  }
  let warns = 0;
  for (let c = 0; c < CELLS; c += 1) if ((w.warnEnd[c] as number) > R) warns += 1;
  out.u8(warns);
  for (let c = 0; c < CELLS; c += 1) {
    const left = (w.warnEnd[c] as number) - R;
    if (left <= 0) continue;
    out.u8(c);
    out.u8(clamp8(left));
  }
  for (let s = 0; s < w.fighters; s += 1) {
    const f = w.fight[s] as WFighter;
    out.u8((s & 3) | ((f.seat & 3) << 2) | ((f.facing & 7) << 4) | (f.alive ? 0x80 : 0));
    out.u16(f.x);
    out.u16(f.y);
    out.u8((f.bombsMax & 15) | ((f.range & 15) << 4));
    out.u8((f.speedLvl & 7) | (f.glove ? 8 : 0) | (f.clicker ? 16 : 0) | (f.moving ? 32 : 0) | (f.ice ? 64 : 0));
    out.u8(clamp8(f.padEnd - R));
    out.u8(clamp8(f.shieldEnd - R));
  }
  return out;
};

/** Applies a KEYFRAME body at core tick `tick` to `w`. False (and `w` not ready) on a malformed body. */
export const decodeKeyframe = (r: ByteReader, tick: number, w: World): boolean => {
  const arena = r.u8();
  const round = r.u8();
  const phase = r.u8();
  const R = r.u16();
  if (!r.ok || arena >= 5 || phase > Phase.MatchEnd) return false;
  w.arena = arena;
  w.round = round;
  w.phase = phase;
  w.roundTick = R;
  w.tick = tick;
  w.keyTick = tick;
  for (let s = 0; s < 4; s += 1) w.scores[s] = r.u8();
  w.spiralIndex = r.u8();
  const pt = r.u8();
  const flags = r.u8();
  w.winner = (flags & 7) - 1;
  w.holdWinner = ((flags >> 3) & 7) - 1;
  w.phaseEnd = phase === Phase.Frozen || phase === Phase.Playing ? 0 : tick + pt;
  w.holdStart = phase === Phase.Frozen ? tick - pt : 0;
  for (let i = 0; i < CELLS; i += 2) {
    const v = r.u8();
    const a = v & 15;
    const b = v >> 4;
    if (a > Cell.Steel || b > Cell.Steel) return false;
    w.cells[i] = a;
    if (i + 1 < CELLS) w.cells[i + 1] = b;
  }
  w.items.fill(0);
  w.pending.fill(0);
  const items = r.u8();
  if (items > 64) return false;
  for (let k = 0; k < items; k += 1) {
    const c = r.u8();
    const v = r.u8();
    if (c >= CELLS || (v & 0x7f) > 5) return false;
    if (v & 0x80) w.pending[c] = v & 0x7f;
    else w.items[c] = v;
  }
  const nb = r.u8();
  if (nb > MAX_BOMBS) return false;
  w.bombCount = nb;
  for (let i = 0; i < nb; i += 1) {
    const b = w.bombs[i] as WBomb;
    b.id = r.u16();
    b.cell = r.u8();
    const fuse = r.u8();
    const a = r.u8();
    const p = r.u8();
    if (b.cell >= CELLS) return false;
    b.fuseEnd = fuse === 0xff ? NO_END : R + fuse;
    b.owner = a & 3;
    b.range = (a >> 2) & 15;
    b.slideDir = (p >> 4) & 7;
    b.slideSpeed = b.slideDir === 0 ? 0 : p & 0x80 ? 4 : 16;
    b.passers = p & 15;
    b.x = ((b.cell % W) << 6) + 32;
    b.y = (((b.cell / W) | 0) << 6) + 32;
    b.placedAt = 0;
    if (b.slideDir > 4) return false;
  }
  w.flameEnd.fill(0);
  w.flameStart.fill(0);
  const nf = r.u8();
  if (nf === 0xff) {
    for (let i = 0; i < CELLS; i += 2) {
      const v = r.u8();
      if ((v & 15) > 0) {
        w.flameEnd[i] = R + (v & 15);
        w.flameStart[i] = R + (v & 15) - 15;
      }
      if (i + 1 < CELLS && v >> 4 > 0) {
        w.flameEnd[i + 1] = R + (v >> 4);
        w.flameStart[i + 1] = R + (v >> 4) - 15;
      }
    }
  } else {
    if (nf > FLAME_LIST_MAX) return false;
    for (let k = 0; k < nf; k += 1) {
      const c = r.u8();
      const left = r.u8();
      if (c >= CELLS) return false;
      w.flameEnd[c] = R + left;
      w.flameStart[c] = R + left - 15;
    }
  }
  w.warnEnd.fill(0);
  const nw = r.u8();
  if (nw > 32) return false;
  for (let k = 0; k < nw; k += 1) {
    const c = r.u8();
    const left = r.u8();
    if (c >= CELLS) return false;
    w.warnEnd[c] = R + left;
  }
  for (let s = 0; s < 4; s += 1) (w.fight[s] as WFighter).alive = false;
  for (let s = 0; s < w.fighters; s += 1) {
    const a = r.u8();
    const f = w.fight[a & 3] as WFighter;
    f.seat = (a >> 2) & 3;
    f.facing = (a >> 4) & 7;
    f.alive = (a & 0x80) !== 0;
    f.x = r.u16();
    f.y = r.u16();
    const st = r.u8();
    f.bombsMax = st & 15;
    f.range = st >> 4;
    const fl = r.u8();
    f.speedLvl = fl & 7;
    f.glove = (fl & 8) !== 0;
    f.clicker = (fl & 16) !== 0;
    f.moving = (fl & 32) !== 0;
    f.ice = (fl & 64) !== 0;
    f.padEnd = R + r.u8();
    f.shieldEnd = R + r.u8();
    if (f.facing > 4) return false;
  }
  if (!r.ok) return false;
  w.ready = true;
  w.dirty.fill(1);
  w.cellsVersion += 1;
  return true;
};

/** A world for a match's config, with a keyframe already applied (tests, LocalHost restore). */
export const worldOf = (m: Match): World => worldFromMatch(m, createWorld(m.config.fighters));

// ------------------------------------------------------------------ PHASE 4 result body

export interface SlotResult {
  roundWins: number;
  kills: number;
  blocks: number;
  deaths: number;
}

/** 4 × {u8 roundWins, u8 kills, u8 blocks, u8 deaths} = 16 B. */
export const encodeResult = (m: Match): Uint8Array => {
  const out = new Uint8Array(16);
  for (let s = 0; s < 4; s += 1) {
    const f = m.current.fighters[s] as Fighter;
    out[s * 4] = m.scores[s] as number;
    out[s * 4 + 1] = clamp8(f.kills);
    out[s * 4 + 2] = clamp8(f.blocksBroken);
    out[s * 4 + 3] = clamp8(f.deaths);
  }
  return out;
};

export const decodeResult = (r: ByteReader): SlotResult[] | null => {
  const out: SlotResult[] = [];
  for (let s = 0; s < 4; s += 1) out.push({ roundWins: r.u8(), kills: r.u8(), blocks: r.u8(), deaths: r.u8() });
  return r.ok ? out : null;
};

/** Is `slot` a seat a human currently plays (for the client's seat list)? */
export const humanControl = (f: Fighter): boolean => f.control === Control.Human;

export { ByteReader, ByteWriter };
