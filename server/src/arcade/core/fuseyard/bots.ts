/**
 * Fuseyard's bots (fuseyard.md §7). They run inside `step()`, so they are deterministic and behave
 * the same on the server and offline. They read a `BotView` (no block contents) and the danger map
 * the sim builds once per tick, and return one input byte.
 *
 * Rules, first that applies: Flee (danger at its cell or next path cell within 30 ticks), Trap,
 * Loot, Clear, Hunt, Wait. A bot never places a bomb unless `canEscape` holds. Paths are followed
 * with d1 at the next cell and d2 at the one after it.
 */
import * as __rng from '../rng.js';
import * as __arenas from './arenas.js';
import type { Arena } from './arenas.js';
import * as __danger from './danger.js';
import * as __rules from './rules.js';
import type { BotBrain, BotView, Bomb, Fighter } from './rules.js';

// Local copies of imported values: hot loops read them without a module-binding lookup.
const { MULBERRY_INC, mulberry32Out } = __rng;
const { ARENAS } = __arenas;
const { NEVER, bombTime, chainOf, dFrom, dRemote, dRest, dTo, footContains, footprintHas, isSafe, walkBlast } = __danger;
const { BotLevel, CELLS, Cell, Control, DX, DY, FLAME, FUSE, IN_BOMB, IN_DETONATE, Item, MAX_BOMBS, REMOTE, Special, W, cellAt, inputByte, ticksPerTile } = __rules;

export const BotRule = { Wait: 0, Flee: 1, Trap: 2, Loot: 3, Clear: 4, Hunt: 5, Kick: 6 } as const;
export type BotRule = (typeof BotRule)[keyof typeof BotRule];

const REPLAN: readonly number[] = [9, 3, 1];
const MARGIN: readonly number[] = [10, 6, 3];
/** Chance in % of fleeing to the second-best cell, and of skipping items. */
const MISTAKE: readonly number[] = [6, 1, 0];
const SKIP_ITEMS: readonly number[] = [25, 1, 0];
const FLEE_WITHIN = 30;
/**
 * Walking about (not fleeing), a bot keeps out of cells that burn within 30 ticks of passing them,
 * the same horizon that makes it flee: otherwise it plans through a cell, flees out of it, plans
 * through it again, and dithers on the edge.
 */
const PLAN_MARGIN = FLEE_WITHIN;
/** Before dropping a bomb, its way out keeps at least this many ticks to spare. */
const ESCAPE_SLACK = 10;
/** Score per opponent a bomb spot would catch (Sprout only clears blocks). */
const PRESSURE: readonly number[] = [0, 6, 10];
const LOOT_RANGE = 8;
const CLEAR_RANGE = 10;
const ACT_NONE = 0;
const ACT_BOMB = 1;
/** Ticks without moving (outside Wait) before a bot drops its plan. */
const STILL_LIMIT = 40;

export const resetBrain = (b: BotBrain): void => {
  b.rule = BotRule.Wait;
  b.target = -1;
  b.replanIn = 0;
  b.lineBombs = 0;
  b.pathLen = 0;
  b.pathPos = 0;
  b.action = ACT_NONE;
  b.lastDir = 0;
  b.lastCell = -1;
  b.stillTicks = 0;
};

// ------------------------------------------------------------------ scratch

const dist = new Int16Array(CELLS);
const par = new Int16Array(CELLS);
const order = new Int16Array(CELLS);
const aFrom = new Uint16Array(CELLS);
const aTo = new Uint16Array(CELLS);
const foot = new Int16Array(40);
const hitScratch = new Int8Array(4);
const tried = new Uint8Array(CELLS);

const rand = (rngs: Uint32Array, slot: number): number => {
  const s = ((rngs[slot] as number) + MULBERRY_INC) | 0;
  rngs[slot] = s >>> 0;
  return mulberry32Out(s);
};
const chance = (rngs: Uint32Array, slot: number, pct: number): boolean => pct > 0 && Math.floor((rand(rngs, slot) * 100) / 4294967296) < pct;

const walkable = (v: BotView, bombAt: Int8Array, self: number, c: number): boolean => {
  if (v.cells[c] !== Cell.Floor || dRest[c] === 1) return false;
  const bi = bombAt[c] as number;
  return bi < 0 || ((((v.bombs[bi] as Bomb).passers >> self) & 1) === 1);
};

/** A search that starts inside another holder's remote footprint may cross those on its way out. */
let crossRemote = false;
/** Slot bit of the searching fighter: its own remote footprints never block it. */
let selfBit = 0;

/**
 * Free of flame during [enter, leave] with margin `m` before the danger and 2 ticks after it. A
 * remote footprint can burn at any moment: it is crossed only to get out of one.
 */
const passable = (from: Uint16Array, to: Uint16Array, c: number, enter: number, leave: number, m: number): boolean => {
  if (((dRemote[c] as number) & ~selfBit) !== 0 && !crossRemote) return false;
  const f = from[c] as number;
  if (f === NEVER) return true;
  return leave < f - m || enter > (to[c] as number) + 2;
};

/** How long a cell stays clear: 0 in a remote footprint, else the start of its danger. */
const clearFor = (c: number): number => (dRemote[c] !== 0 ? 0 : (dFrom[c] as number));

/** Pad cooldown of the searching fighter (pads only jump once it has run out). */
let searchCooldown = 0;
/** A fighter sliding on ice between centres can only go on the way it slides: its first step. */
let searchSlide = 0;

/** The direction a fighter is committed to by ice, or 0. */
const slideOf = (v: BotView, f: Fighter): number => {
  if (!f.moving || v.special[cellAt(f.x, f.y)] !== Special.Ice) return 0;
  return (f.x & 63) === 32 && (f.y & 63) === 32 ? 0 : f.facing;
};

/**
 * Time-aware BFS from `start` (time `t0`) over walkable cells passable at their arrival. Fills
 * `dist`, `par` and `order`; returns the number of cells reached (in nondecreasing distance).
 * Walking onto a pad whose partner is free jumps: the partner is reached through the pad cell.
 */
const bfs = (v: BotView, bombAt: Int8Array, self: number, start: number, t0: number, tpt: number, m: number, from: Uint16Array, to: Uint16Array, maxDepth: number): number => {
  dist.fill(-1);
  dist[start] = 0;
  par[start] = -1;
  order[0] = start;
  selfBit = 1 << self;
  crossRemote = ((dRemote[start] as number) & ~selfBit) !== 0;
  let tail = 1;
  const half = (tpt >> 1) + 1;
  const partner = (ARENAS[v.arena] as Arena).padPartner;
  for (let h = 0; h < tail; h += 1) {
    const c = order[h] as number;
    const d = dist[c] as number;
    if (d >= maxDepth) continue;
    for (let dir = 1; dir <= 4; dir += 1) {
      if (h === 0 && searchSlide !== 0 && dir !== searchSlide) continue;
      const n = c + (DX[dir] as number) + (DY[dir] as number) * W;
      if (n < 0 || n >= CELLS || (dist[n] as number) >= 0) continue;
      if (!walkable(v, bombAt, self, n)) continue;
      const t = t0 + (d + 1) * tpt;
      if (!passable(from, to, n, t - half, t + half, m)) continue;
      dist[n] = d + 1;
      par[n] = c;
      const p = partner[n] as number;
      if (p >= 0 && searchCooldown <= t && (bombAt[p] as number) < 0) {
        // The pad cell itself is only passed through: the search continues from its partner.
        if ((dist[p] as number) >= 0 || !passable(from, to, p, t - half, t + half, m)) continue;
        dist[p] = d + 1;
        par[p] = n;
        order[tail] = p;
        tail += 1;
        continue;
      }
      order[tail] = n;
      tail += 1;
    }
  }
  return tail;
};

const setPath = (b: BotBrain, target: number, rule: number, action: number): void => {
  let len = 0;
  for (let c = target; c >= 0 && (par[c] as number) >= 0 && len < 64; c = par[c] as number) len += 1;
  if (len > b.path.length) len = b.path.length;
  let i = len - 1;
  for (let c = target; i >= 0; c = par[c] as number) {
    b.path[i] = c;
    i -= 1;
  }
  b.pathLen = len;
  b.pathPos = 0;
  b.target = target;
  b.rule = rule;
  b.action = action;
};

const dirTo = (a: number, b: number): number => {
  const d = b - a;
  return d === -W ? 1 : d === 1 ? 2 : d === W ? 3 : d === -1 ? 4 : 0;
};

/** Number of blocks a bomb at `c` with `range` would break. */
const blocksHit = (v: BotView, bombAt: Int8Array, c: number, range: number): number => {
  const n = walkBlast(v.cells, bombAt, v.items, c, range, foot, 0, null, 0);
  let hits = 0;
  for (let k = 1; k < n; k += 1) if (v.cells[foot[k] as number] === Cell.Block) hits += 1;
  return hits;
};

/**
 * The danger map plus a hypothetical bomb at `c` placed at time `t0` with `range`, into
 * `aFrom`/`aTo`. Chains one level deep: an existing bomb whose footprint holds `c` sets it off
 * earlier, and bombs in its footprint go off with it.
 */
const augment = (v: BotView, bombAt: Int8Array, c: number, t0: number, range: number): void => {
  aFrom.set(dFrom);
  aTo.set(dTo);
  let t = t0 + FUSE;
  const nb = v.bombCount < MAX_BOMBS ? v.bombCount : MAX_BOMBS;
  for (let j = 0; j < nb; j += 1) if ((bombTime[j] as number) < t && footContains(j, c)) t = bombTime[j] as number;
  const n = walkBlast(v.cells, bombAt, v.items, c, range, foot, 0, hitScratch, 0);
  const end = t + FLAME;
  for (let k = 0; k < n; k += 1) {
    const x = foot[k] as number;
    if (t < (aFrom[x] as number)) aFrom[x] = t;
    if (end > (aTo[x] as number)) aTo[x] = end;
  }
  for (let k = 0; k < 4; k += 1) {
    const j = hitScratch[k] as number;
    if (j < 0 || j >= nb || (bombTime[j] as number) <= t) continue;
    const bj = v.bombs[j] as Bomb;
    const m = walkBlast(v.cells, bombAt, v.items, cellAt(bj.x, bj.y), bj.range, foot, 0, null, 0);
    for (let q = 0; q < m; q += 1) {
      const x = foot[q] as number;
      if (t < (aFrom[x] as number)) aFrom[x] = t;
      if (end > (aTo[x] as number)) aTo[x] = end;
    }
  }
};

/** With a bomb at `c` at time `t0`, can the bot standing there reach a cell that is never dangerous? */
const canEscape = (v: BotView, bombAt: Int8Array, self: number, f: Fighter, c: number, t0: number, m: number): boolean => {
  augment(v, bombAt, c, t0, f.range);
  const tpt = ticksPerTile(f.speedLvl);
  // The bot stands on its own new bomb: the start cell is walkable for it.
  const slide = searchSlide;
  searchSlide = 0;
  const reached = bfs(v, bombAt, self, c, t0, tpt, Math.max(m, ESCAPE_SLACK), aFrom, aTo, 24);
  searchSlide = slide;
  for (let k = 1; k < reached; k += 1) {
    const x = order[k] as number;
    if ((aFrom[x] as number) === NEVER && dRemote[x] === 0) return true;
  }
  return false;
};

/**
 * Bombs go down only on cells that are safe now (no stacking inside a live blast), never on ice,
 * where a sliding fighter cannot turn away from its own bomb, and never on a belt, which would
 * carry the bomb off into other blasts.
 */
const bombSpot = (v: BotView, bombAt: Int8Array, c: number): boolean => {
  const sp = v.special[c] as number;
  return (bombAt[c] as number) < 0 && isSafe(c) && (sp === Special.None || sp >= Special.PadA);
};

const isTarget = (f: Fighter, self: number): boolean => f.slot !== self && f.alive && f.seated && f.control !== Control.Ghost && f.shield === 0;

/** Safe cells an opponent could still reach after a bomb at `c` (augmented map already built). */
const opponentRefuges = (v: BotView, bombAt: Int8Array, o: Fighter): number => {
  const own = searchCooldown;
  const ownSlide = searchSlide;
  searchCooldown = o.padCooldown;
  searchSlide = slideOf(v, o);
  const reached = bfs(v, bombAt, o.slot, cellAt(o.x, o.y), 0, ticksPerTile(o.speedLvl), 0, aFrom, aTo, 20);
  searchCooldown = own;
  searchSlide = ownSlide;
  let safe = 0;
  for (let k = 0; k < reached && safe < 2; k += 1) {
    const x = order[k] as number;
    if ((aFrom[x] as number) === NEVER && dRemote[x] === 0) safe += 1;
  }
  return safe;
};

/**
 * Opponents standing in the blast of a bomb at `c`. One standing on `c` itself does not count: it
 * would flee the same way as the bomber.
 */
const foesHit = (v: BotView, bombAt: Int8Array, self: number, c: number, range: number): number => {
  let n = 0;
  for (let s = 0; s < 4; s += 1) {
    const o = v.fighters[s] as Fighter;
    if (!isTarget(o, self)) continue;
    const oc = cellAt(o.x, o.y);
    if (oc !== c && footprintHas(v.cells, bombAt, v.items, c, range, oc)) n += 1;
  }
  return n;
};

/**
 * Rule 2: would a bomb at `c`, placed at time `t0`, leave an opponent in its blast with at most one
 * refuge while the bot itself can still get away?
 */
const trapAt = (v: BotView, bombAt: Int8Array, self: number, f: Fighter, c: number, t0: number, m: number): boolean => {
  if (f.bombsOut >= f.bombsMax || !bombSpot(v, bombAt, c) || foesHit(v, bombAt, self, c, f.range) === 0) return false;
  augment(v, bombAt, c, t0, f.range);
  let trapped = false;
  for (let s = 0; s < 4 && !trapped; s += 1) {
    const o = v.fighters[s] as Fighter;
    if (!isTarget(o, self)) continue;
    const oc = cellAt(o.x, o.y);
    if (oc === c || !footprintHas(v.cells, bombAt, v.items, c, f.range, oc)) continue;
    if (opponentRefuges(v, bombAt, o) <= 1) trapped = true;
  }
  return trapped && canEscape(v, bombAt, self, f, c, t0, m);
};

const tryTrap = (v: BotView, bombAt: Int8Array, self: number, f: Fighter, c: number, m: number): boolean => trapAt(v, bombAt, self, f, c, 0, m);

/** How far (cells) a bot walks to a trap spot, by level. */
const TRAP_REACH: readonly number[] = [0, 4, 7];
const TRAP_TRIES = 5;
const trapCand = new Int16Array(64);

/** The nearest cell within reach where a bomb would corner an opponent (`trapAt`), or -1. */
const findTrapSpot = (v: BotView, bombAt: Int8Array, self: number, f: Fighter, c: number, m: number, level: number): number => {
  const reach = TRAP_REACH[level] as number;
  if (reach === 0 || f.bombsOut >= f.bombsMax) return -1;
  const tpt = ticksPerTile(f.speedLvl);
  const reached = bfs(v, bombAt, self, c, 0, tpt, PLAN_MARGIN, dFrom, dTo, reach);
  let n = 0;
  for (let k = 1; k < reached && n < trapCand.length; k += 1) {
    const x = order[k] as number;
    if (bombSpot(v, bombAt, x) && foesHit(v, bombAt, self, x, f.range) > 0) {
      trapCand[n] = x;
      n += 1;
    }
  }
  if (n === 0) return -1;
  // `trapAt` reuses the search scratch, so the route search is redone before each candidate.
  let found = -1;
  for (let i = 0; i < n && i < TRAP_TRIES && found < 0; i += 1) {
    const x = trapCand[i] as number;
    bfs(v, bombAt, self, c, 0, tpt, PLAN_MARGIN, dFrom, dTo, reach);
    const t0 = (dist[x] as number) * tpt;
    if (trapAt(v, bombAt, self, f, x, t0, m)) found = x;
  }
  if (found >= 0) bfs(v, bombAt, self, c, 0, tpt, PLAN_MARGIN, dFrom, dTo, reach);
  return found;
};

/** Menace with the glove: kick an adjacent bomb when an opponent stands in line beyond it. */
const tryKick = (v: BotView, bombAt: Int8Array, self: number, f: Fighter, c: number): number => {
  if (!f.glove || (f.x & 63) !== 32 || (f.y & 63) !== 32) return 0;
  for (let d = 1; d <= 4; d += 1) {
    const step = (DX[d] as number) + (DY[d] as number) * W;
    const bi = bombAt[c + step] as number;
    if (bi < 0 || ((((v.bombs[bi] as Bomb).passers >> self) & 1) === 1)) continue;
    for (let k = 2; k <= 7; k += 1) {
      const x = c + step * k;
      if (v.cells[x] !== Cell.Floor || (bombAt[x] as number) >= 0 || (v.items[x] as number) !== 0) break;
      for (let s = 0; s < 4; s += 1) {
        const o = v.fighters[s] as Fighter;
        if (isTarget(o, self) && cellAt(o.x, o.y) === x) return d;
      }
    }
  }
  return 0;
};

const itemWeight = (f: Fighter, it: number): number => {
  if (it === Item.Clicker) return 5;
  if (it === Item.ShoveGlove) return f.glove ? 0 : 4;
  if (it === Item.SpareFuse) return f.bombsMax >= 8 ? 0 : f.bombsMax >= 5 ? 2 : 3;
  if (it === Item.WideSpark) return f.range >= 8 ? 0 : f.range >= 5 ? 1 : 3;
  if (it === Item.QuickBoots) return f.speedLvl >= 3 ? 0 : 3;
  return 0;
};

const bombsInLine = (v: BotView, c: number): number => {
  const cx = c % W;
  const cy = (c / W) | 0;
  let n = 0;
  for (let i = 0; i < v.bombCount; i += 1) {
    const b = v.bombs[i] as Bomb;
    if (b.x >> 6 === cx || b.y >> 6 === cy) n += 1;
  }
  return n;
};

/** Plans rules 1 and 3–6 (Trap is checked by the caller first). */
const plan = (v: BotView, bombAt: Int8Array, self: number, f: Fighter, b: BotBrain, rngs: Uint32Array, level: number, flee: boolean): void => {
  const c = cellAt(f.x, f.y);
  const m = MARGIN[level] as number;
  const tpt = ticksPerTile(f.speedLvl);
  if (flee) {
    let reached = bfs(v, bombAt, self, c, 0, tpt, m, dFrom, dTo, 30);
    let anySafe = false;
    for (let k = 1; k < reached && !anySafe; k += 1) if (isSafe(order[k] as number)) anySafe = true;
    // The margin keeps a bot out of trouble; when it is already in trouble, it must not trap it.
    if (!anySafe) reached = bfs(v, bombAt, self, c, 0, tpt, 0, dFrom, dTo, 30);
    let first = -1;
    let second = -1;
    for (let k = 1; k < reached; k += 1) {
      const x = order[k] as number;
      if (!isSafe(x) || v.special[x] === Special.Ice) continue;
      if (first < 0) first = x;
      else {
        second = x;
        break;
      }
    }
    let pick = first;
    if (second >= 0 && chance(rngs, self, MISTAKE[level] as number)) pick = second;
    if (pick < 0) {
      // Nowhere safe: the reachable cell whose danger starts latest.
      let best = -1;
      for (let k = 0; k < reached; k += 1) {
        const x = order[k] as number;
        if (best < 0 || clearFor(x) > clearFor(best)) best = x;
      }
      pick = best;
    }
    if (pick >= 0 && pick !== c) setPath(b, pick, BotRule.Flee, ACT_NONE);
    else {
      // Nowhere better to go: it waits where it is.
      b.pathLen = 0;
      b.rule = BotRule.Wait;
      b.action = ACT_NONE;
      b.target = c;
    }
    return;
  }
  const reached = bfs(v, bombAt, self, c, 0, tpt, PLAN_MARGIN, dFrom, dTo, CLEAR_RANGE);
  // 3. Loot
  if (!chance(rngs, self, SKIP_ITEMS[level] as number)) {
    let best = -1;
    let bestScore = 0;
    for (let k = 1; k < reached; k += 1) {
      const x = order[k] as number;
      const d = dist[x] as number;
      if (d > LOOT_RANGE) break;
      const it = v.items[x] as number;
      if (it === 0 || !isSafe(x) || v.special[x] === Special.Ice) continue;
      const w = itemWeight(f, it);
      if (w === 0) continue;
      const score = w * 8 - d;
      if (score > bestScore) {
        bestScore = score;
        best = x;
      }
    }
    if (best >= 0) {
      setPath(b, best, BotRule.Loot, ACT_NONE);
      return;
    }
  }
  // 4. Clear
  if (f.bombsOut < f.bombsMax) {
    tried.fill(0);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let best = -1;
      let bestScore = 0;
      for (let k = 0; k < reached; k += 1) {
        const x = order[k] as number;
        // Bombs go down only on cells that are safe now: no stacking inside a live blast.
        if ((tried[x] as number) === 1 || !bombSpot(v, bombAt, x)) continue;
        const hits = blocksHit(v, bombAt, x, f.range);
        const foes = PRESSURE[level] ? foesHit(v, bombAt, self, x, f.range) : 0;
        if (hits === 0 && foes === 0) continue;
        const score = hits * 4 + foes * (PRESSURE[level] as number) - (dist[x] as number) + 20;
        if (score > bestScore) {
          bestScore = score;
          best = x;
        }
      }
      if (best < 0) break;
      tried[best] = 1;
      if (canEscape(v, bombAt, self, f, best, (dist[best] as number) * tpt, m)) {
        if (best === c) {
          b.pathLen = 0;
          b.target = c;
          b.rule = BotRule.Clear;
          b.action = ACT_BOMB;
        } else {
          // `canEscape` reused the BFS scratch: rebuild the route to the chosen cell.
          bfs(v, bombAt, self, c, 0, tpt, PLAN_MARGIN, dFrom, dTo, CLEAR_RANGE);
          if ((dist[best] as number) < 0) break;
          setPath(b, best, BotRule.Clear, ACT_BOMB);
        }
        return;
      }
      bfs(v, bombAt, self, c, 0, tpt, PLAN_MARGIN, dFrom, dTo, CLEAR_RANGE);
    }
  }
  // 5. Hunt: toward the nearest opponent reachable on open floor, stopping 2–4 cells short.
  const far = bfs(v, bombAt, self, c, 0, tpt, PLAN_MARGIN, dFrom, dTo, 40);
  let prey = -1;
  for (let k = 1; k < far && prey < 0; k += 1) {
    const x = order[k] as number;
    for (let s = 0; s < 4; s += 1) {
      const o = v.fighters[s] as Fighter;
      if (isTarget(o, self) && cellAt(o.x, o.y) === x) prey = x;
    }
  }
  if (prey >= 0 && (dist[prey] as number) > 3) {
    let stop = prey;
    const keep = level === BotLevel.Menace ? 2 : 3;
    for (let k = 0; k < keep && (par[stop] as number) >= 0 && par[stop] !== c; k += 1) stop = par[stop] as number;
    if (isSafe(stop) && v.special[stop] !== Special.Ice) {
      setPath(b, stop, BotRule.Hunt, ACT_NONE);
      return;
    }
  }
  // 6. Wait on the safest cell close by.
  let best = c;
  for (let k = 0; k < far; k += 1) {
    const x = order[k] as number;
    if ((dist[x] as number) > 3) break;
    if (v.special[x] === Special.Ice) continue;
    if (clearFor(x) > clearFor(best)) best = x;
  }
  if (best !== c) setPath(b, best, BotRule.Wait, ACT_NONE);
  else {
    b.pathLen = 0;
    b.pathPos = 0;
    b.target = c;
    b.rule = BotRule.Wait;
    b.action = ACT_NONE;
  }
};

/** The bot's own remote bombs: should it press detonate now? */
const wantsDetonate = (v: BotView, bombAt: Int8Array, self: number, f: Fighter, level: number): boolean => {
  if (!f.clicker) return false;
  const c = cellAt(f.x, f.y);
  // Never inside its own remote footprints (chains included: they carry its bit).
  if (((dRemote[c] as number) >> self) & 1) return false;
  // The press fires the oldest of its remote bombs.
  let oldest = -1;
  for (let i = 0; i < v.bombCount && oldest < 0; i += 1) {
    const bomb = v.bombs[i] as Bomb;
    if (bomb.owner === self && bomb.fuse === REMOTE) oldest = i;
  }
  if (oldest < 0) return false;
  const bomb = v.bombs[oldest] as Bomb;
  const bc = cellAt(bomb.x, bomb.y);
  // Setting off someone else's bomb early is a trap for its owner: only Menace does it, on purpose.
  let polite = true;
  for (let k = 0; k < 4; k += 1) {
    const j = chainOf(oldest, k);
    if (j >= 0 && (v.bombs[j] as Bomb).owner !== self) polite = false;
  }
  if (level === BotLevel.Menace) {
    for (let s = 0; s < 4; s += 1) {
      const o = v.fighters[s] as Fighter;
      if (isTarget(o, self) && footprintHas(v.cells, bombAt, v.items, bc, bomb.range, cellAt(o.x, o.y))) return true;
    }
    return polite && (blocksHit(v, bombAt, bc, bomb.range) > 0 || f.bombsOut >= f.bombsMax);
  }
  return polite;
};

/** One bot's input for this tick. The danger map must be built for this tick. */
export const decideBot = (v: BotView, self: number, b: BotBrain, rngs: Uint32Array, levelIn: number, bombAt: Int8Array): number => {
  const level = levelIn < 0 ? 0 : levelIn > 2 ? 2 : levelIn;
  const f = v.fighters[self] as Fighter;
  const c = cellAt(f.x, f.y);
  const m = MARGIN[level] as number;
  searchCooldown = f.padCooldown;
  searchSlide = slideOf(v, f);
  const pads = (ARENAS[v.arena] as Arena).padPartner;
  // Stuck tracking (position, not cell).
  const pos = f.y * 1024 + f.x;
  if (pos === b.lastCell && b.rule !== BotRule.Wait) b.stillTicks += 1;
  else b.stillTicks = 0;
  b.lastCell = pos;
  // `urgent`: something changed that invalidates any plan; the interval only refreshes plans.
  let urgent = false;
  const due = b.replanIn <= 0;
  b.replanIn -= 1;
  const line = bombsInLine(v, c);
  if (line !== b.lineBombs) {
    b.lineBombs = line;
    if (line > 0) urgent = true;
  }
  if (b.stillTicks > STILL_LIMIT) {
    b.stillTicks = 0;
    urgent = true;
  }
  // Off the path (pushed, teleported): re-plan. Standing on a pad before its partner is not off it.
  if (b.pathPos < b.pathLen) {
    const next = b.path[b.pathPos] as number;
    if (next !== c && dirTo(c, next) === 0 && (pads[c] as number) !== next) {
      let found = false;
      for (let k = b.pathPos; k < b.pathLen; k += 1) {
        if ((b.path[k] as number) === c) {
          b.pathPos = k + 1;
          found = true;
          break;
        }
      }
      if (!found) urgent = true;
    }
  }
  if (b.pathPos < b.pathLen && (b.path[b.pathPos] as number) === c) b.pathPos += 1;
  const next = b.pathPos < b.pathLen ? (b.path[b.pathPos] as number) : c;
  // Any blast that will reach the bot's cell sends it away at once (a bot that lingers in its own
  // footprint gets boxed in by the next blast); the next path cell counts within 30 ticks.
  const danger = !isSafe(c) || (next !== c && (dFrom[next] as number) <= FLEE_WITHIN);
  if (danger) {
    const goal = b.rule === BotRule.Flee && b.target >= 0 ? b.target : -1;
    const goalSafe = goal >= 0 && goal !== c && isSafe(goal) && b.pathPos < b.pathLen;
    // A flight keeps its goal while it stays safe and the way on stays open: re-planning every tick
    // from whichever cell the bot straddles makes it flip between two equally near refuges.
    selfBit = 1 << self;
    crossRemote = ((dRemote[c] as number) & ~selfBit) !== 0;
    const tpt = ticksPerTile(f.speedLvl);
    const nextOk = next === c || (walkable(v, bombAt, self, next) && passable(dFrom, dTo, next, 0, tpt + 2, 0));
    if (!goalSafe || urgent || !nextOk) {
      plan(v, bombAt, self, f, b, rngs, level, true);
      b.replanIn = REPLAN[level] as number;
    }
  } else if (due || urgent || (b.pathPos >= b.pathLen && b.action === ACT_NONE)) {
    b.replanIn = REPLAN[level] as number;
    if (level >= BotLevel.Scrapper && tryTrap(v, bombAt, self, f, c, m)) {
      b.pathLen = 0;
      b.pathPos = 0;
      b.target = c;
      b.rule = BotRule.Trap;
      b.action = ACT_NONE;
      b.replanIn = 0;
      return IN_BOMB;
    }
    if (level === BotLevel.Menace) {
      const kd = tryKick(v, bombAt, self, f, c);
      if (kd !== 0) {
        b.pathLen = 0;
        b.rule = BotRule.Kick;
        b.replanIn = 0;
        return inputByte(kd, 0, false, false);
      }
    }
    const spot = level >= BotLevel.Scrapper ? findTrapSpot(v, bombAt, self, f, c, m, level) : -1;
    if (spot >= 0) setPath(b, spot, BotRule.Trap, ACT_BOMB);
    else plan(v, bombAt, self, f, b, rngs, level, false);
  }
  // Detonating: stand still this tick, so the bot never walks into its own blast.
  if (wantsDetonate(v, bombAt, self, f, level)) {
    b.replanIn = 0;
    return IN_DETONATE;
  }
  const input = 0;
  // At the target with a bomb to place.
  if (b.pathPos >= b.pathLen && b.action === ACT_BOMB) {
    b.action = ACT_NONE;
    b.replanIn = 0;
    if (f.bombsOut < f.bombsMax && bombSpot(v, bombAt, c) && canEscape(v, bombAt, self, f, c, 0, m)) return input | IN_BOMB;
    return input;
  }
  if (b.pathPos < b.pathLen) {
    const n1 = b.path[b.pathPos] as number;
    // On a pad heading for its partner: keep going the same way to cross the pad's centre.
    const d1 = (pads[c] as number) === n1 ? b.lastDir : dirTo(c, n1);
    const n2 = b.pathPos + 1 < b.pathLen ? (b.path[b.pathPos + 1] as number) : -1;
    const d2 = n2 >= 0 ? dirTo(n1, n2) : 0;
    if (d1 === 0) {
      b.pathLen = 0;
      b.replanIn = 0;
      return input;
    }
    b.lastDir = d1;
    return input | inputByte(d1, d2 === d1 ? 0 : d2, false, false);
  }
  // On the target cell but off its centre: settle so the bot is not left straddling two cells.
  const ox = (f.x & 63) - 32;
  const oy = (f.y & 63) - 32;
  if (b.rule === BotRule.Flee || b.rule === BotRule.Wait) {
    if (ox > 4) return input | inputByte(4, 0, false, false);
    if (ox < -4) return input | inputByte(2, 0, false, false);
    if (oy > 4) return input | inputByte(1, 0, false, false);
    if (oy < -4) return input | inputByte(3, 0, false, false);
  }
  return input;
};
