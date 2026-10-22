/**
 * The walkthrough hero bot, "Pip" (bellwick.md §9). Deterministic: it reads only what a client sees
 * (`ClientWorld`) and answers plain `Buttons`, the same path a player's input takes. It follows
 * content/walkthrough.ts, finds its way with a BFS over every screen's tiles (doors, edges and ledges
 * included; fixed-capacity queues, no `while`), fights what comes near (spins at Shellbacks, sidesteps
 * charges), drinks a Hearthbrew when low, and fights Old Clapper only in his windows.
 */
import type { ClientWorld, CEnt } from '../client.js';
import { T } from '../content/legend.js';
import { content, flaggedTile, screen, type ScreenDef } from '../content/parse.js';
import walkthrough from '../content/walkthrough.js';
import { edgeOpen, F, TILE_FLAGS, walkable } from '../rules.js';
import { Act, Btn, DX8, DY8, ItemBit, Item, Kind, Pick, Status } from '../types.js';

export interface BotActions {
  buy(item: number): void;
  brew(): void;
  respawn(): void;
}

type Step =
  | { k: 'go'; room: number; tile: number }
  | { k: 'use'; dir: number }
  | { k: 'push'; dir: number }
  | { k: 'hook'; dir: number }
  | { k: 'item'; item: number }
  | { k: 'shield'; room: number; tile: number; dir: number }
  | { k: 'buy'; item: number }
  | { k: 'clear' }
  | { k: 'boss' };

const DIRS: Readonly<Record<string, number>> = { d: 0, u: 1, l: 2, r: 3 };
const BTN_OF: readonly number[] = [Btn.down, Btn.up, Btn.left, Btn.right];
const DX: readonly number[] = [0, 0, -1, 1];
const DY: readonly number[] = [1, -1, 0, 0];
const ITEMS: Readonly<Record<string, number>> = { buckler: Item.Buckler, brew: Item.Brew, shard: Item.Shard, hook: Item.Hook };

export const parseWalkthrough = (lines: readonly string[]): Step[] => {
  const steps: Step[] = [];
  for (const line of lines) {
    const w = line.split(' ');
    const at = (key: string | undefined, pos: string | undefined): { room: number; tile: number } => {
      const def = content().byKey[key ?? ''];
      const m = /^(\d+),(\d+)$/.exec(pos ?? '');
      if (!def || !m) throw new Error('walkthrough: bad step "' + line + '"');
      return { room: def.id, tile: Number(m[2]) * 12 + Number(m[1]) };
    };
    switch (w[0]) {
      case 'go':
        steps.push({ k: 'go', ...at(w[1], w[2]) });
        break;
      case 'use':
      case 'push':
      case 'hook':
        steps.push({ k: w[0], dir: DIRS[w[1] ?? ''] ?? 0 });
        break;
      case 'item':
        steps.push({ k: 'item', item: w[1] === 'hook' ? 1 : 0 });
        break;
      case 'shield':
        steps.push({ k: 'shield', ...at(w[1], w[2]), dir: DIRS[w[3] ?? ''] ?? 1 });
        break;
      case 'buy':
        steps.push({ k: 'buy', item: ITEMS[w[1] ?? ''] ?? 0 });
        break;
      case 'clear':
        steps.push({ k: 'clear' });
        break;
      case 'boss':
        steps.push({ k: 'boss' });
        break;
      default:
        throw new Error('walkthrough: unknown step "' + line + '"');
    }
  }
  return steps;
};

// ------------------------------------------------------------------ the map graph

const NODES = 36 * 108;
/** Room id → compact index (0–35), and back. */
const roomIdx = new Int8Array(64).fill(-1);
const idxRoom = new Int8Array(36);
let graphReady = false;
const ensureGraph = (): void => {
  if (graphReady) return;
  let n = 0;
  for (const d of content().screens) {
    if (!d) continue;
    roomIdx[d.id] = n;
    idxRoom[n] = d.id;
    n += 1;
  }
  graphReady = true;
};

const flagOn = (c: ClientWorld, id: number): boolean => id >= 0 && ((c.flags[id >> 3] as number) & (1 << (id & 7))) !== 0;

/** A tile as the bot believes it is: live in the hero's room, else the definition with the party's flags. */
const codeAt = (c: ClientWorld, room: number, tile: number): number => {
  if (room === c.room && c.hasRoom) return c.tiles[tile] as number;
  return flaggedTile(screen(room), tile, (id) => flagOn(c, id));
};

/** May the bot walk onto this tile (cutting it first if needed)? */
const passable = (code: number): boolean => {
  if (code === T.BLOCK || code === T.POT) return false;
  const f = TILE_FLAGS[code] ?? 1;
  return walkable(code) || (f & F.WARP) !== 0 || ((f & F.CUT) !== 0 && (f & (F.WATER | F.PIT)) === 0);
};

const queue = new Int16Array(NODES);
const prev = new Int16Array(NODES);
const pathBuf = new Int16Array(NODES);

const warpOf = (def: ScreenDef, tile: number): { to: number; tile2: number } | null => {
  for (const w of def.warps) if (w.tile === tile) return w;
  return null;
};

/** BFS from the hero to (room, tile); fills `pathBuf` and returns its length (0: unreachable). */
const plan = (c: ClientWorld, goalRoom: number, goalTile: number): number => {
  ensureGraph();
  const me = c.me;
  const sr = roomIdx[me.room] as number;
  const gr = roomIdx[goalRoom] as number;
  if (sr < 0 || gr < 0) return 0;
  const startTile = Math.max(0, Math.min(8, me.y >> 8)) * 12 + Math.max(0, Math.min(11, me.x >> 8));
  const start = sr * 108 + startTile;
  const goal = gr * 108 + goalTile;
  prev.fill(-1);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  prev[start] = start;
  let found = false;
  for (let iter = 0; iter < NODES && head < tail; iter += 1) {
    const node = queue[head++] as number;
    if (node === goal) {
      found = true;
      break;
    }
    const ri = Math.floor(node / 108);
    const t = node - ri * 108;
    const room = idxRoom[ri] as number;
    const def = screen(room);
    const visit = (r2: number, t2: number): void => {
      const i2 = roomIdx[r2] as number;
      if (i2 < 0) return;
      const n2 = i2 * 108 + t2;
      if (prev[n2] !== -1) return;
      prev[n2] = node;
      queue[tail++] = n2;
    };
    // A door: stepping on it goes through.
    if (node !== start && ((TILE_FLAGS[codeAt(c, room, t)] ?? 0) & F.WARP) !== 0) {
      const w = warpOf(def, t);
      if (w) visit(w.to, w.tile2);
      continue;
    }
    const tx = t % 12;
    const ty = Math.floor(t / 12);
    for (let d = 0; d < 4; d += 1) {
      const nx = tx + (DX[d] as number);
      const ny = ty + (DY[d] as number);
      if (nx >= 0 && ny >= 0 && nx < 12 && ny < 9) {
        const t2 = ny * 12 + nx;
        const code = codeAt(c, room, t2);
        if (code === T.LEDGE) {
          // One way, south: over the ledge onto the tile below it.
          if (d === 0 && ny + 1 < 9 && walkable(codeAt(c, room, t2 + 12))) visit(room, t2 + 12);
          continue;
        }
        if (passable(code)) visit(room, t2);
        continue;
      }
      // Off the screen: an edge exit.
      const edge = d;
      const pos = edge < 2 ? tx : ty;
      const ex = def.exits[edge];
      if (ex) {
        visit(ex.to, ex.tile2);
        continue;
      }
      const to = def.near[edge] as number;
      if (to < 0) continue;
      const t2 = edge === 0 ? pos : edge === 1 ? 96 + pos : edge === 2 ? pos * 12 + 11 : pos * 12;
      const code = codeAt(c, to, t2);
      if (edgeOpen(code) && passable(code)) visit(to, t2);
    }
  }
  if (!found) return 0;
  let n = 0;
  let cur = goal;
  for (let i = 0; i < NODES; i += 1) {
    pathBuf[n++] = cur;
    if (cur === start) break;
    cur = prev[cur] as number;
  }
  pathBuf.subarray(0, n).reverse();
  return n;
};

// ------------------------------------------------------------------ the bot

export interface HeroBot {
  readonly steps: number;
  step: number;
  stepT: number;
  done: boolean;
  /** Ticks the bot has been alive. */
  t: number;
  tick(c: ClientWorld, act: BotActions): number;
}

const cx = (tile: number): number => (tile % 12) * 256 + 128;
const cy = (tile: number): number => Math.floor(tile / 12) * 256 + 128;

export const createHeroBot = (lines: readonly string[] = walkthrough): HeroBot => {
  const steps = parseWalkthrough(lines);
  const path = new Int16Array(NODES);
  let pathLen = 0;
  let pathI = 0;
  let planGoal = -1;
  let planT = 0;
  let lastX = 0;
  let lastY = 0;
  let stuckT = 0;
  let aPhase = 0;
  let bPhase = 0;
  let sent = false;
  let pushTile = -1;
  let hookStarted = false;
  /** Plans in a row that found no way (after a respawn, a hook-only spot): rewind the walkthrough. */
  let unreachable = 0;
  /** The way we dodge the current hop (kept for the whole hop). */
  let dodge = 0;
  let dodgeX = 0;
  let dodgeY = 0;

  const bot: HeroBot = {
    steps: steps.length,
    step: 0,
    stepT: 0,
    done: false,
    t: 0,
    tick: (c, act) => tick(c, act),
  };

  const next = (): void => {
    bot.step += 1;
    bot.stepT = 0;
    sent = false;
    hookStarted = false;
    pushTile = -1;
    planGoal = -1;
    if (bot.step >= steps.length) bot.done = true;
  };

  /** A press: on every other tick (edges matter to the hero). */
  const tapA = (): number => {
    aPhase ^= 1;
    return aPhase ? Btn.a : 0;
  };
  const tapB = (): number => {
    bPhase ^= 1;
    return bPhase ? Btn.b : 0;
  };

  const towards = (c: ClientWorld, x: number, y: number, tol: number): number => {
    const me = c.me;
    const dx = x - me.x;
    const dy = y - me.y;
    let b = 0;
    if (dx > tol) b |= Btn.right;
    else if (dx < -tol) b |= Btn.left;
    if (dy > tol) b |= Btn.down;
    else if (dy < -tol) b |= Btn.up;
    return b;
  };

  /** Is moving that way about to step into a pit or water, or off the screen (fights stay in the room)? */
  const unsafe = (c: ClientWorld, b: number): boolean => {
    const me = c.me;
    const x = me.x + (b & Btn.right ? 200 : b & Btn.left ? -200 : 0);
    const y = me.y + (b & Btn.down ? 160 : b & Btn.up ? -160 : 0);
    if (x < 160 || y < 160 || x >= 2912 || y >= 2144) return true;
    const f = TILE_FLAGS[c.tiles[(y >> 8) * 12 + (x >> 8)] as number] ?? 0;
    return (f & (F.PIT | F.WATER)) !== 0;
  };

  const DIR8 = [Btn.up, Btn.down, Btn.left, Btn.right, Btn.up | Btn.left, Btn.up | Btn.right, Btn.down | Btn.left, Btn.down | Btn.right];

  /** The open direction that ends furthest from (fx, fy), then from (gx, gy) as a tie-breaker. */
  const flee = (c: ClientWorld, fx: number, fy: number, gx = fx, gy = fy): number => {
    const me = c.me;
    let best = 0;
    let bestD = -1;
    for (const b of DIR8) {
      const x = me.x + (b & Btn.right ? 384 : b & Btn.left ? -384 : 0);
      const y = me.y + (b & Btn.down ? 384 : b & Btn.up ? -384 : 0);
      if (x < 160 || y < 160 || x >= 2912 || y >= 2144) continue;
      const code = c.tiles[(y >> 8) * 12 + (x >> 8)] as number;
      const near = c.tiles[((me.y + (b & Btn.down ? 160 : b & Btn.up ? -160 : 0)) >> 8) * 12 + ((me.x + (b & Btn.right ? 200 : b & Btn.left ? -200 : 0)) >> 8)] as number;
      if (!walkable(code) || !walkable(near) || unsafe(c, b)) continue;
      const d = Math.sqrt((x - fx) * (x - fx) + (y - fy) * (y - fy)) * 4 + Math.sqrt((x - gx) * (x - gx) + (y - gy) * (y - gy));
      if (d > bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  };

  /** Follows a planned path to (room, tile); true once there. */
  const goTo = (c: ClientWorld, room: number, tile: number, out: { b: number }): boolean => {
    const me = c.me;
    if (me.room === room && Math.abs(me.x - cx(tile)) <= 40 && Math.abs(me.y - cy(tile)) <= 40) return true;
    const goal = room * 108 + tile;
    planT += 1;
    if (planGoal !== goal || planT >= 15 || (pathLen === 0 && planT >= 15)) {
      pathLen = plan(c, room, tile);
      path.set(pathBuf.subarray(0, pathLen));
      pathI = 0;
      planGoal = goal;
      planT = 0;
    }
    if (pathLen === 0) {
      unreachable += 1;
      out.b = 0;
      return false;
    }
    unreachable = 0;
    const ri = roomIdx[me.room] as number;
    const here = ri * 108 + Math.max(0, Math.min(8, me.y >> 8)) * 12 + Math.max(0, Math.min(11, me.x >> 8));
    for (let i = pathI; i < pathLen && i < pathI + 8; i += 1) {
      if (path[i] === here) {
        pathI = i;
        break;
      }
    }
    if (path[pathI] !== here) {
      // Off the path (knocked back): plan again next tick.
      planT = 15;
    }
    const nextNode = path[Math.min(pathLen - 1, pathI + 1)] as number;
    const nr = idxRoom[Math.floor(nextNode / 108)] as number;
    const nt = nextNode % 108;
    if (nr !== me.room) {
      // Leave through the edge in the direction of travel (a door was the previous node).
      const tx = me.x >> 8;
      const ty = me.y >> 8;
      let d = -1;
      if (ty === 8 && nt < 12) d = 0;
      else if (ty === 0 && nt >= 96) d = 1;
      else if (tx === 0 && nt % 12 === 11) d = 2;
      else if (tx === 11 && nt % 12 === 0) d = 3;
      if (d < 0) d = ty === 8 ? 0 : ty === 0 ? 1 : tx === 0 ? 2 : 3;
      const along = d < 2 ? towards(c, cx(ty * 12 + tx), me.y, 24) & (Btn.left | Btn.right) : towards(c, me.x, cy(ty * 12 + tx), 24) & (Btn.up | Btn.down);
      out.b = (BTN_OF[d] as number) | along;
      return false;
    }
    const code = c.tiles[nt] as number;
    const f = TILE_FLAGS[code] ?? 0;
    if ((f & F.SOLID) !== 0 && (f & F.CUT) !== 0) {
      // A bush in the way: face it and cut.
      const d = nt === here % 108 + 1 ? 3 : nt === here % 108 - 1 ? 2 : nt > here % 108 ? 0 : 1;
      if (me.facing !== d) {
        out.b = BTN_OF[d] as number;
        return false;
      }
      out.b = tapA();
      return false;
    }
    const tx = cx(nt);
    const ty = cy(nt);
    const curT = here % 108;
    const horizontal = nt % 12 !== curT % 12;
    let b = 0;
    if (horizontal) {
      b = towards(c, tx, ty, 32);
      if (Math.abs(ty - me.y) <= 48) b &= ~(Btn.up | Btn.down);
    } else {
      b = towards(c, tx, ty, 32);
      if (Math.abs(tx - me.x) <= 48) b &= ~(Btn.left | Btn.right);
    }
    if (b === 0) b = towards(c, tx, ty, 8);
    out.b = b;
    return false;
  };

  /** No wall between us and (x, y) (sub)? Cuttable things do not count. */
  const sight = (c: ClientWorld, x: number, y: number): boolean => {
    const me = c.me;
    for (let k = 1; k < 8; k += 1) {
      const sx = me.x + (((x - me.x) * k) >> 3);
      const sy = me.y - 64 + (((y - (me.y - 64)) * k) >> 3);
      if (sx < 0 || sy < 0 || sx >= 3072 || sy >= 2304) return false;
      const f = TILE_FLAGS[c.tiles[(sy >> 8) * 12 + (sx >> 8)] as number] ?? 1;
      if ((f & F.SOLID) !== 0 && (f & F.CUT) === 0) return false;
    }
    return true;
  };

  /** Enemies the bot should deal with now. */
  const threat = (c: ClientWorld, range: number, all: boolean): CEnt | null => {
    let best: CEnt | null = null;
    let bestD = range;
    const me = c.me;
    for (const e of c.ents) {
      if (!e.on || e.hiddenAt >= 0 || e.kind === Kind.Sentinel || e.kind === Kind.Block || e.kind === Kind.Boss) continue;
      const dx = (e.x << 4) - me.x;
      const dy = (e.y << 4) - (me.y - 64);
      const d = Math.abs(dx) + Math.abs(dy);
      if (e.kind === Kind.Rootling && e.pose < 2 && !all) continue;
      if (e.kind === Kind.Bat && e.pose === 0 && !all && d > 900) continue;
      if (!all && !sight(c, e.x << 4, e.y << 4)) continue;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  };

  /** Would a slash facing `f` hit an entity at pixel (ex, ey)? */
  const slashHits = (c: ClientWorld, f: number, ex: number, ey: number, half: number): boolean => {
    const x = c.me.x >> 4;
    const y = c.me.y >> 4;
    const h = half >> 4;
    if (f === 3) return x + 6 < ex + h && ex - h < x + 16 && y - 10 < ey + h && ey - h < y + 4;
    if (f === 2) return x - 16 < ex + h && ex - h < x - 6 && y - 10 < ey + h && ey - h < y + 4;
    if (f === 0) return x - 7 < ex + h && ex - h < x + 7 && y + 4 < ey + h && ey - h < y + 14;
    return x - 7 < ex + h && ex - h < x + 7 && y - 20 < ey + h && ey - h < y - 10;
  };

  const fight = (c: ClientWorld, e: CEnt): number => {
    const me = c.me;
    const half = e.kind === Kind.Shellback ? 104 : e.kind === Kind.Wisp || e.kind === Kind.Bat ? 80 : 96;
    // Shellbacks: spin attacks get round the shell (or flip it with the hook first).
    if (e.kind === Kind.Shellback && e.pose !== 2) {
      if ((c.items & ItemBit.hook) !== 0 && me.item === 1 && me.hookCd === 0 && me.act !== Act.Hook) {
        const ax = Math.abs((e.x << 4) - me.x);
        const ay = Math.abs((e.y << 4) - (me.y - 64));
        if ((ax < 96 && ay < 900) || (ay < 96 && ax < 900)) {
          const f = ax < 96 ? ((e.y << 4) < me.y - 64 ? 1 : 0) : (e.x << 4) < me.x ? 2 : 3;
          if (me.facing !== f) return BTN_OF[f] as number;
          return tapB();
        }
      }
      const dx = (e.x << 4) - me.x;
      const dy = (e.y << 4) - (me.y - 64);
      const d2 = dx * dx + dy * dy;
      if (me.act === Act.Spin) return 0;
      // The nearest shell of all decides when to back off.
      let nx = dx;
      let ny = dy;
      let nd2 = d2;
      for (const o of c.ents) {
        if (!o.on || o.kind !== Kind.Shellback || o === e) continue;
        const ox = (o.x << 4) - me.x;
        const oy = (o.y << 4) - (me.y - 64);
        if (ox * ox + oy * oy < nd2) {
          nx = ox;
          ny = oy;
          nd2 = ox * ox + oy * oy;
        }
      }
      if (!me.charged) {
        // Hold A to charge, keeping out of reach.
        let b = me.act === Act.Charge || me.act === Act.Slash ? Btn.a : tapA();
        if (nd2 < 800 * 800) b |= flee(c, me.x + nx, me.y - 64 + ny);
        return b;
      }
      if (nd2 <= 380 * 380) return 0;
      return Btn.a | towards(c, e.x << 4, (e.y << 4) + 64, 32);
    }
    // Snapjaws: out of their row and column unless stunned; strike while they are dizzy.
    if (e.kind === Kind.Snapjaw && e.pose !== 3) {
      const ex = e.x << 4;
      const ey = e.y << 4;
      const sameRow = Math.abs(ey - me.y) < 320;
      const sameCol = Math.abs(ex - me.x) < 320;
      if (sameRow || sameCol || e.pose === 2) {
        let b = sameRow ? (me.y > ey ? Btn.down : Btn.up) : me.x > ex ? Btn.right : Btn.left;
        if (unsafe(c, b) || stuckT > 6) b = sameRow ? (b === Btn.down ? Btn.up : Btn.down) : b === Btn.right ? Btn.left : Btn.right;
        return unsafe(c, b) ? 0 : b;
      }
      // Diagonal from it: wait, it will patrol into reach or charge a wall.
      const d = Math.abs(ex - me.x) + Math.abs(ey - me.y);
      if (d > 700) return 0;
      const b = towards(c, me.x - (ex - me.x), me.y - (ey - me.y), 32);
      return unsafe(c, b) ? 0 : b;
    }
    for (let f = 0; f < 4; f += 1) {
      if (!slashHits(c, f, e.x, e.y, half)) continue;
      if (me.act === Act.Slash) return 0;
      if (me.facing !== f) return BTN_OF[f] as number;
      return tapA();
    }
    // Move to the nearest attack spot (beside it on an axis).
    const ex = e.x << 4;
    const ey = e.y << 4;
    let bestX = ex;
    let bestY = ey - 144;
    let bestD = 0x7fffffff;
    const spots = [ex - 224, ey + 48, ex + 224, ey + 48, ex, ey - 144, ex, ey + 240];
    for (let i = 0; i < 4; i += 1) {
      const sx = spots[i * 2] as number;
      const sy = spots[i * 2 + 1] as number;
      if (sx < 96 || sy < 96 || sx > 2976 || sy > 2208) continue;
      const code = c.tiles[(sy >> 8) * 12 + (sx >> 8)] as number;
      if (!walkable(code)) continue;
      const d = Math.abs(sx - me.x) + Math.abs(sy - me.y);
      if (d < bestD) {
        bestD = d;
        bestX = sx;
        bestY = sy;
      }
    }
    const b = towards(c, bestX, bestY, 24);
    return unsafe(c, b) ? 0 : b;
  };

  /** Picks up glints, and hearts while hurt; breaks a pot when hurt. −1: nothing to loot. */
  const loot = (c: ClientWorld): number => {
    const me = c.me;
    let best = -1;
    let bestD = 1400;
    for (let i = 0; i < c.picks.length; i += 1) {
      const p = c.picks[i]!;
      if (!p.on || p.kind === Pick.Vessel) continue;
      if (p.kind === Pick.Heart && me.hp >= c.maxHp) continue;
      const tile = (p.y >> 4) * 12 + (p.x >> 4);
      if (!walkable(c.tiles[tile] as number)) continue;
      const d = Math.abs((p.x << 4) - me.x) + Math.abs((p.y << 4) - me.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      const p = c.picks[best]!;
      const b = towards(c, p.x << 4, (p.y << 4) + 32, 24);
      return unsafe(c, b) ? -1 : b;
    }
    if (me.hp < c.maxHp - 1) {
      // A pot nearby: break it.
      for (let t = 0; t < 108; t += 1) {
        if (c.tiles[t] !== T.POT) continue;
        const tx = cx(t);
        const ty = cy(t);
        if (Math.abs(tx - me.x) + Math.abs(ty - me.y) > 1600) continue;
        let bf = -1;
        let bd = 0x7fffffff;
        for (let f = 0; f < 4; f += 1) {
          const sx = tx - (DX[f] as number) * 256;
          const sy = ty - (DY[f] as number) * 256;
          if (sx < 0 || sy < 0 || sx >= 3072 || sy >= 2304 || !walkable(c.tiles[(sy >> 8) * 12 + (sx >> 8)] as number)) continue;
          const d = Math.abs(sx - me.x) + Math.abs(sy - me.y);
          if (d < bd) {
            bd = d;
            bf = f;
          }
        }
        if (bf >= 0) {
          const sx = tx - (DX[bf] as number) * 256;
          const sy = ty - (DY[bf] as number) * 256;
          if (Math.abs(sx - me.x) <= 48 && Math.abs(sy - me.y) <= 48) {
            if (me.facing !== bf) return BTN_OF[bf] as number;
            return me.act === Act.Slash ? 0 : tapA();
          }
          return towards(c, sx, sy, 24);
        }
      }
    }
    return -1;
  };

  const BELFRY = 44;
  const boss = (c: ClientWorld): number => {
    if (c.me.room !== BELFRY) {
      const out = { b: 0 };
      if (goTo(c, BELFRY, 6 * 12 + 5, out)) return 0;
      return out.b;
    }
    const b = bossFight(c);
    // Never leave the belfry by accident.
    return unsafe(c, b) ? b & ~(Btn.up | Btn.down | Btn.left | Btn.right) : b;
  };

  /** Raise the Buckler towards facing `f` (lowering it first to turn). */
  const shieldTo = (c: ClientWorld, f: number): number => {
    const me = c.me;
    if (me.item !== 0) {
      aPhase ^= 1;
      return aPhase ? Btn.swap : 0;
    }
    if (me.act === Act.Shield) return me.facing === f ? Btn.b : 0;
    if (me.act !== Act.Idle && me.act !== Act.Walk) return 0;
    return me.facing !== f ? (BTN_OF[f] as number) : Btn.b;
  };

  const bossFight = (c: ClientWorld): number => {
    const me = c.me;
    let bossEnt: CEnt | null = null;
    for (const e of c.ents) if (e.on && e.kind === Kind.Boss) bossEnt = e;
    if (!bossEnt) {
      // Take the Heart Vessel.
      for (const p of c.picks) if (p.on && p.kind === Pick.Vessel) return towards(c, p.x << 4, (p.y << 4) + 32, 24);
      if (c.vessels > 0 || flagOn(c, 32)) next();
      return 0;
    }
    const bx = bossEnt.x << 4;
    const by = bossEnt.y << 4;
    const hx = me.x;
    const hy = me.y - 48;
    const dx = bx - hx;
    const dy = by - hy;
    const dist2 = dx * dx + dy * dy;
    const faceBoss = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 2 : 3) : dy < 0 ? 1 : 0;
    const pose = bossEnt.pose;
    if (pose !== 1) dodge = 0;
    // A shock ring on its way: Buckler towards its centre.
    for (const sh of c.shocks) {
      if (!sh.on) continue;
      const r = (c.tick - sh.t0) * 48;
      const sx = sh.x - me.x;
      const sy = sh.y - me.y;
      const d = Math.sqrt(sx * sx + sy * sy);
      if (r < 1536 && r < d + 160) return shieldTo(c, Math.abs(sx) >= Math.abs(sy) ? (sx < 0 ? 2 : 3) : sy < 0 ? 1 : 0);
    }
    // Notes or pebbles about to reach us: the soonest one decides; keep a Buckler that already stops it.
    let soon = 99;
    let soonDir = -1;
    for (const p of c.projs) {
      if (!p.on || p.kind === 3) continue;
      const t = c.tick - p.t0;
      const sp = p.kind === 1 ? 40 : 48;
      for (let k = 0; k <= 24 && k < soon; k += 2) {
        const qx = p.x0 + (((DX8[p.dir] as number) * sp * (t + k)) >> 4);
        const qy = p.y0 + (((DY8[p.dir] as number) * sp * (t + k)) >> 4);
        if (Math.abs(qx - hx) < 208 && Math.abs(qy - hy) < 224) {
          soon = k;
          soonDir = p.dir;
          break;
        }
      }
    }
    if (soonDir >= 0) {
      const blocks = (f: number): boolean => (DX8[soonDir] as number) * (DX[f] as number) + (DY8[soonDir] as number) * (DY[f] as number) < 0;
      if (me.act === Act.Shield && blocks(me.facing)) return Btn.b;
      let f = me.facing;
      for (let k = 0; k < 4 && !blocks(f); k += 1) f = k;
      if (blocks(f)) return shieldTo(c, f);
    }
    // Too close to a boss that can hurt and cannot be hurt: get away first.
    // Phase 3 starts: the Vinehook first.
    if ((pose === 5 || pose === 6) && (c.items & ItemBit.hook) !== 0 && me.item !== 1 && dist2 > 420 * 420 && me.act !== Act.Shield && me.act !== Act.Hook && me.act !== Act.Slash) {
      aPhase ^= 1;
      return aPhase ? Btn.swap : 0;
    }
    const lined = (Math.abs(dy) < 192 && Math.abs(dx) < 1000) || (Math.abs(dx) < 176 && Math.abs(dy) < 1000);
    if ((pose === 0 && dist2 < 760 * 760) || (pose === 5 && dist2 < (lined && me.item === 1 ? 300 : 480) * (lined && me.item === 1 ? 300 : 480)) || (pose === 3 && dist2 < 520 * 520)) {
      if (me.act === Act.Shield) return 0;
      return flee(c, bx, by);
    }
    if (pose === 1) {
      // It comes down where we stood when it jumped: get away from that spot (and from it).
      if (me.act === Act.Shield) return 0;
      if (dodge === 0) {
        dodge = 1;
        dodgeX = me.x;
        dodgeY = me.y;
      }
      return flee(c, dodgeX, dodgeY, bx, by);
    }
    // A swooping bat close by comes first; then any heart lying about.
    const bat = threat(c, 700, false);
    if (bat && bat.kind === Kind.Bat && bat.pose !== 0 && pose !== 2 && pose !== 4 && pose !== 6) {
      if (me.act === Act.Shield) return 0;
      return fight(c, bat);
    }
    if (pose === 3 || pose === 0) {
      for (const p of c.picks) {
        if (!p.on || p.kind !== Pick.Heart || me.hp >= c.maxHp) continue;
        if (me.act === Act.Shield) return 0;
        const pb = towards(c, p.x << 4, (p.y << 4) + 32, 24);
        if (dist2 > 600 * 600) return pb;
      }
    }
    const wantItem = pose === 5 || pose === 6 ? 1 : 0;
    if ((c.items & ItemBit.hook) !== 0 && me.item !== wantItem && me.act !== Act.Shield && me.act !== Act.Hook && me.act !== Act.Slash) {
      aPhase ^= 1;
      return aPhase ? Btn.swap : 0;
    }
    /** Attack from its left or right, whichever side is nearer and inside the room, out of contact reach. */
    const attack = (): number => {
      for (let f = 2; f < 4; f += 1) {
        if (!slashHits(c, f, bossEnt.x, bossEnt.y, 192)) continue;
        if (me.act === Act.Slash) return 0;
        if (me.facing !== f) return BTN_OF[f] as number;
        return tapA();
      }
      let side = me.x < bx ? -1 : 1;
      if (bx + side * 368 < 352 || bx + side * 368 > 2720) side = -side;
      const sx = bx + side * 368;
      const sy = by + 32;
      // On the wrong side: go round above or below it, not through it.
      if (Math.sign(me.x - bx) !== side && Math.abs(me.y - 48 - by) < 420) return towards(c, me.x, by + (me.y - 48 > by ? 520 : -460), 24);
      return towards(c, sx, sy, 24);
    };
    const keepAway = (min: number): number => (dist2 < min * min ? flee(c, bx, by + 48) : 0);
    switch (pose) {
      case 7:
        return towards(c, 1536, 1216, 32);
      case 0:
        if (me.act === Act.Shield) return 0;
        if (dist2 < 900 * 900) return flee(c, bx, by);
        // Out of the doorway and off the walls while it gathers itself.
        if (me.y > 1900 || me.y < 500 || me.x < 600 || me.x > 2470) return towards(c, Math.max(640, Math.min(2430, me.x)), Math.max(560, Math.min(1860, me.y)), 32);
        return 0;
      case 1:
        // It is coming down where we were: get out from under it.
        if (me.act === Act.Shield) return 0;
        return flee(c, bx, by);
      case 2:
      case 4:
      case 6:
        if (me.act === Act.Shield) return 0;
        return attack();
      case 3: {
        // Rolling along the walls: stand in the middle, Buckler up against its notes.
        const mid = towards(c, 1536, 1216, 48);
        if (mid !== 0 && me.act !== Act.Shield && dist2 > 700 * 700) return mid;
        return shieldTo(c, faceBoss);
      }
      case 5: {
        // Line up and hook the clapper out.
        if (me.item !== 1 || me.act === Act.Hook) return 0;
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        if ((ay < 192 && ax < 1000) || (ax < 176 && ay < 1000)) {
          if (me.facing !== faceBoss) return BTN_OF[faceBoss] as number;
          return me.hookCd > 0 ? 0 : tapB();
        }
        return ay < ax ? towards(c, me.x, by + 48, 16) & (Btn.up | Btn.down) : towards(c, bx, me.y, 16) & (Btn.left | Btn.right);
      }
      default:
        return keepAway(700);
    }
  };

  const tick = (c: ClientWorld, act: BotActions): number => {
    bot.t += 1;
    bot.stepT += 1;
    const me = c.me;
    if (bot.done) return 0;
    if (me.status === Status.Downed) {
      if (!sent) {
        act.respawn();
        sent = true;
      }
      return 0;
    }
    sent = sent && me.status !== Status.Active ? sent : sent;
    if (!c.hasRoom || c.awaitingKey || me.act === Act.Transit || me.act === Act.Got || me.act === Act.Fall || me.act === Act.Pulled || me.act === Act.Ledge) return 0;
    if (me.hp <= 2 && me.brew) act.brew();
    const step = steps[bot.step] as Step;
    // Stuck detection: jiggle sideways.
    if (Math.abs(me.x - lastX) + Math.abs(me.y - lastY) < 8) stuckT += 1;
    else stuckT = 0;
    lastX = me.x;
    lastY = me.y;
    const out = { b: 0 };
    // Fighting comes first, except while shielding through Gloam Gate or fighting the boss.
    if (step.k !== 'shield' && step.k !== 'boss' && step.k !== 'hook' && step.k !== 'push') {
      const e = threat(c, step.k === 'clear' ? 0x7fffffff : 1100, step.k === 'clear');
      if (e) {
        if (e.kind === Kind.Rootling && e.pose < 2) {
          // Wake it from a safe angle, then wait beside its line.
          const dx = (e.x << 4) - me.x;
          const dy = (e.y << 4) - (me.y - 64);
          if (Math.abs(dx) + Math.abs(dy) > 700) return towards(c, e.x << 4, (e.y << 4) + 64, 32);
          return towards(c, me.x + (Math.abs(dx) < Math.abs(dy) ? (dx > 0 ? -300 : 300) : 0), me.y + (Math.abs(dx) >= Math.abs(dy) ? (dy > 0 ? -300 : 300) : 0), 32);
        }
        const b = fight(c, e);
        if (stuckT > 40) {
          stuckT = 0;
          return Btn.up;
        }
        return b;
      }
    }
    if (me.act === Act.Charge && step.k !== 'boss') return 0;
    if (step.k === 'go' || step.k === 'clear') {
      const l = loot(c);
      if (l >= 0) return l;
    }
    switch (step.k) {
      case 'go': {
        if (goTo(c, step.room, step.tile, out)) {
          next();
          return 0;
        }
        if (unreachable > 0) {
          // Back to the last place we can walk to (a hook or a block brought us here before).
          for (let j = bot.step - 1; j >= 0; j -= 1) {
            const s2 = steps[j] as Step;
            if (s2.k !== 'go') continue;
            if (plan(c, s2.room, s2.tile) > 0) {
              bot.step = j;
              bot.stepT = 0;
              planGoal = -1;
              unreachable = 0;
              break;
            }
          }
          return 0;
        }
        if (stuckT > 30) {
          stuckT = 0;
          planT = 15;
          return out.b & (Btn.up | Btn.down) ? Btn.left : Btn.up;
        }
        return out.b;
      }
      case 'use': {
        if (!sent) {
          if (me.facing !== step.dir || me.act !== Act.Idle) return me.facing !== step.dir ? (BTN_OF[step.dir] as number) : 0;
          sent = true;
          bot.stepT = 0;
          return Btn.a;
        }
        if (bot.stepT > 3) next();
        return 0;
      }
      case 'push': {
        const t = ((me.y >> 8) + (DY[step.dir] as number)) * 12 + (me.x >> 8) + (DX[step.dir] as number);
        if (pushTile < 0) pushTile = t;
        if (c.tiles[pushTile] !== T.BLOCK) {
          next();
          return 0;
        }
        if (bot.stepT > 120) {
          next();
          return 0;
        }
        // Centre on the tile across the push, then lean on the block.
        const tileX = (me.x >> 8) * 256 + 128;
        const tileY = (me.y >> 8) * 256 + 128;
        const centre = step.dir < 2 ? towards(c, tileX, me.y, 16) & (Btn.left | Btn.right) : towards(c, me.x, tileY, 16) & (Btn.up | Btn.down);
        return (BTN_OF[step.dir] as number) | centre;
      }
      case 'hook': {
        if (me.item !== 1) {
          aPhase ^= 1;
          return aPhase ? Btn.swap : 0;
        }
        if (hookStarted && me.act === Act.Idle && bot.stepT > 4) {
          next();
          return 0;
        }
        if (me.facing !== step.dir && !hookStarted) {
          // Turn without walking off the tile: one tick.
          return BTN_OF[step.dir] as number;
        }
        if (me.act === Act.Hook) {
          hookStarted = true;
          return 0;
        }
        if (bot.stepT > 200) {
          next();
          return 0;
        }
        if (me.hookCd > 0) return 0;
        hookStarted = hookStarted || bot.stepT > 3;
        return tapB();
      }
      case 'item': {
        if (me.item === step.item || (c.items & (step.item === 1 ? ItemBit.hook : ItemBit.buckler)) === 0) {
          next();
          return 0;
        }
        aPhase ^= 1;
        return aPhase ? Btn.swap : 0;
      }
      case 'shield': {
        if (me.room === step.room && Math.abs(me.x - cx(step.tile)) <= 40 && Math.abs(me.y - cy(step.tile)) <= 40) {
          next();
          return 0;
        }
        if (me.item !== 0) {
          aPhase ^= 1;
          return aPhase ? Btn.swap : 0;
        }
        if (me.act !== Act.Shield) {
          if (me.facing !== step.dir) return BTN_OF[step.dir] as number;
          return Btn.b;
        }
        goTo(c, step.room, step.tile, out);
        return out.b | Btn.b;
      }
      case 'buy': {
        if (!sent) {
          act.buy(step.item);
          sent = true;
        }
        if (bot.stepT > 6) next();
        return 0;
      }
      case 'clear': {
        let left = 0;
        for (const e of c.ents) if (e.on && e.kind !== Kind.Sentinel && e.kind !== Kind.Block) left += 1;
        if (left === 0 && bot.stepT > 10) next();
        return 0;
      }
      case 'boss':
        return boss(c);
      default:
        return 0;
    }
  };

  return bot;
};
