/**
 * The hero step (bellwick.md §1.2, §3.2, §3.5). Each client owns its own hero: `stepHero` runs on the
 * device, online and offline, against the client's view of its room (`HeroEnv`), and writes what the hero
 * did into `HeroOut` (hits, damage taken, blocks, interactions, pushes, room changes). The client turns
 * those into EVTs; the authority checks and applies them. Integer state only; no allocation.
 */
import { T } from '../content/legend.js';
import { BOSS_RULES, ENEMY_RULES, ENEMY_STATS, F, HERO_RULES as R, TILE_FLAGS } from '../rules.js';
import { Act, Attack, Btn, DX4, DX8, DY4, DY8, ItemBit, Kind, Proj, ROOM_H_SUB, ROOM_W_SUB, Status } from '../types.js';
import { contactHurts } from './ai.js';
import { boxBlocked, cornerNudge, flagsAt, moveBox, overlap, SOLID_FLIER, SOLID_HERO, type EdgeMask } from './collide.js';

export interface Hero {
  slot: number;
  tunic: number;
  room: number;
  x: number;
  y: number;
  facing: number;
  act: number;
  actT: number;
  hp: number;
  maxHp: number;
  /** Selected B item: 0 Buckler, 1 Vinehook. */
  item: number;
  brew: boolean;
  status: number;
  iframes: number;
  kbDx: number;
  kbDy: number;
  kbT: number;
  heroTick: number;
  /** Buttons held on the previous step. */
  btn: number;
  pushT: number;
  charged: boolean;
  hookCd: number;
  /** Hook extension (sub) and phase (0 out, 1 back). */
  hookLen: number;
  hookBack: boolean;
  /** Pull target (sub). */
  pullX: number;
  pullY: number;
  /** Transit: edge (0–3) or 4 for a warp, and its length. */
  transitDir: number;
  transitDur: number;
  entryX: number;
  entryY: number;
  /** Tick the current attack started (the swing key) and the ids it already hit. */
  swing: number;
  hitMask: Uint32Array;
  moving: boolean;
}

export const newHeroState = (slot: number): Hero => ({
  slot,
  tunic: slot,
  room: 0,
  x: 0,
  y: 0,
  facing: 0,
  act: Act.Idle,
  actT: 0,
  hp: 6,
  maxHp: 6,
  item: 0,
  brew: false,
  status: Status.Active,
  iframes: 0,
  kbDx: 0,
  kbDy: 0,
  kbT: 0,
  heroTick: 0,
  btn: 0,
  pushT: 0,
  charged: false,
  hookCd: 0,
  hookLen: 0,
  hookBack: false,
  pullX: 0,
  pullY: 0,
  transitDir: 0,
  transitDur: 0,
  entryX: 0,
  entryY: 0,
  swing: -1,
  hitMask: new Uint32Array(8),
  moving: false,
});

export const ENV_ENTS = 16;
export const ENV_PROJ = 12;
export const ENV_PICK = 12;
export const ENV_SHOCK = 2;

/** The room as the client sees it, at the tick being stepped. Entity positions in sub. */
export interface HeroEnv {
  tick: number;
  tiles: Uint8Array;
  /** Open screen edges (collide.ts EdgeMask). */
  edges: EdgeMask;
  items: number;
  nEnt: number;
  entId: Uint8Array;
  entKind: Uint8Array;
  entX: Int32Array;
  entY: Int32Array;
  /** Pose nibble, stunned and boss mode for contact rules. */
  entPose: Uint8Array;
  entStunned: Uint8Array;
  nProj: number;
  projId: Uint8Array;
  projKind: Uint8Array;
  projDir: Uint8Array;
  projX: Int32Array;
  projY: Int32Array;
  nPick: number;
  pickId: Uint8Array;
  pickX: Int32Array;
  pickY: Int32Array;
  nShock: number;
  shockX: Int32Array;
  shockY: Int32Array;
  shockR: Int32Array;
}

export const newHeroEnv = (): HeroEnv => ({
  tick: 0,
  tiles: new Uint8Array(108),
  edges: new Int32Array(4),
  items: 0,
  nEnt: 0,
  entId: new Uint8Array(ENV_ENTS),
  entKind: new Uint8Array(ENV_ENTS),
  entX: new Int32Array(ENV_ENTS),
  entY: new Int32Array(ENV_ENTS),
  entPose: new Uint8Array(ENV_ENTS),
  entStunned: new Uint8Array(ENV_ENTS),
  nProj: 0,
  projId: new Uint8Array(ENV_PROJ),
  projKind: new Uint8Array(ENV_PROJ),
  projDir: new Uint8Array(ENV_PROJ),
  projX: new Int32Array(ENV_PROJ),
  projY: new Int32Array(ENV_PROJ),
  nPick: 0,
  pickId: new Uint8Array(ENV_PICK),
  pickX: new Int32Array(ENV_PICK),
  pickY: new Int32Array(ENV_PICK),
  nShock: 0,
  shockX: new Int32Array(ENV_SHOCK),
  shockY: new Int32Array(ENV_SHOCK),
  shockR: new Int32Array(ENV_SHOCK),
});

/** Local feedback cues for the client (sound and particles), one bit each. */
export const CUE = {
  swish: 1,
  spin: 2,
  hookThrow: 4,
  hookLatch: 8,
  push: 16,
  hurt: 32,
  block: 64,
  fall: 128,
  ledge: 256,
  clinkWall: 512,
  charged: 1024,
} as const;

/** What one step did. Reset by `stepHero`. */
export interface HeroOut {
  /** New hit targets this tick (entity ids < 128, or 128 + tile index), their attack and direction. */
  hitN: number;
  hitTargets: Uint8Array;
  hitAttack: number;
  hitDir: number;
  /** Damage taken: source entity id (0xFE pit, 0xFD repel source projectile is in `dmgSource`), amount (0 = repel). */
  dmgSource: number;
  dmgAmount: number;
  blockedId: number;
  interact: number;
  push: number;
  pushDir: number;
  /** 0–3 a screen edge, 4 a warp tile; −1 none. */
  enter: number;
  enterPos: number;
  cues: number;
}

export const newHeroOut = (): HeroOut => ({
  hitN: 0,
  hitTargets: new Uint8Array(24),
  hitAttack: 0,
  hitDir: 0,
  dmgSource: -1,
  dmgAmount: 0,
  blockedId: -1,
  interact: -1,
  push: -1,
  pushDir: 0,
  enter: -1,
  enterPos: 0,
  cues: 0,
});

export const PIT_SOURCE = 0xfe;

const pos = new Int32Array(2);

const entHalf = (kind: number): number => (kind === Kind.Boss ? BOSS_RULES.halfW : (ENEMY_STATS[kind]?.half ?? 96));
const entHalfY = (kind: number): number => (kind === Kind.Boss ? BOSS_RULES.halfH : (ENEMY_STATS[kind]?.half ?? 96));

const resetOut = (o: HeroOut): void => {
  o.hitN = 0;
  o.dmgSource = -1;
  o.dmgAmount = 0;
  o.blockedId = -1;
  o.interact = -1;
  o.push = -1;
  o.enter = -1;
  o.cues = 0;
};

const startSwing = (h: Hero, tick: number): void => {
  h.swing = tick;
  for (let i = 0; i < h.hitMask.length; i += 1) h.hitMask[i] = 0;
};

/** Records a new target for this swing (ids 0–255 through the mask). */
const addHit = (h: Hero, o: HeroOut, target: number): void => {
  const word = target >> 5;
  const bit = 1 << (target & 31);
  if (((h.hitMask[word] as number) & bit) !== 0) return;
  h.hitMask[word] = (h.hitMask[word] as number) | bit;
  if (o.hitN < o.hitTargets.length) o.hitTargets[o.hitN++] = target;
};

/** The slash box (centre and half sizes) for the facing; writes [cx, cy, hw, hh] into `box`. */
export const slashBox = (x: number, y: number, facing: number, box: Int32Array): void => {
  if (facing === 0 || facing === 1) {
    box[0] = x;
    box[1] = y + (facing === 0 ? R.slashDownY : R.slashUpY);
    box[2] = R.slashLong >> 1;
    box[3] = R.slashShort >> 1;
  } else {
    box[0] = x + (facing === 2 ? -R.slashSideX : R.slashSideX);
    box[1] = y + R.slashSideY;
    box[2] = R.slashShort >> 1;
    box[3] = R.slashLong >> 1;
  }
};

const box = new Int32Array(4);

/** Hits the entities and tiles overlapping a box this tick. */
const hitBox = (h: Hero, env: HeroEnv, o: HeroOut, attack: number): void => {
  const cx = box[0] as number;
  const cy = box[1] as number;
  const hw = box[2] as number;
  const hh = box[3] as number;
  for (let i = 0; i < env.nEnt; i += 1) {
    const k = env.entKind[i] as number;
    if (k === Kind.Block) continue;
    if (overlap(cx, cy, hw, hh, env.entX[i] as number, env.entY[i] as number, entHalf(k), entHalfY(k))) addHit(h, o, env.entId[i] as number);
  }
  const x0 = Math.max(0, (cx - hw) >> 8);
  const x1 = Math.min(11, (cx + hw - 1) >> 8);
  const y0 = Math.max(0, (cy - hh) >> 8);
  const y1 = Math.min(8, (cy + hh - 1) >> 8);
  for (let ty = y0; ty <= y1; ty += 1) {
    for (let tx = x0; tx <= x1; tx += 1) {
      const t = ty * 12 + tx;
      if (((TILE_FLAGS[env.tiles[t] as number] ?? 0) & (F.CUT | F.HITTABLE)) !== 0) addHit(h, o, 128 + t);
    }
  }
  if (o.hitN > 0) {
    o.hitAttack = attack;
    o.hitDir = h.facing;
  }
};

const hitSpin = (h: Hero, env: HeroEnv, o: HeroOut): void => {
  const cx = h.x;
  const cy = h.y - 64;
  for (let i = 0; i < env.nEnt; i += 1) {
    const k = env.entKind[i] as number;
    if (k === Kind.Block) continue;
    const dx = (env.entX[i] as number) - cx;
    const dy = (env.entY[i] as number) - cy;
    const r = R.spinRadius + entHalf(k);
    if (dx * dx + dy * dy <= r * r) addHit(h, o, env.entId[i] as number);
  }
  for (let t = 0; t < 108; t += 1) {
    if (((TILE_FLAGS[env.tiles[t] as number] ?? 0) & (F.CUT | F.HITTABLE)) === 0) continue;
    const dx = (t % 12) * 256 + 128 - cx;
    const dy = Math.floor(t / 12) * 256 + 128 - cy;
    const r = R.spinRadius + 64;
    if (dx * dx + dy * dy <= r * r) addHit(h, o, 128 + t);
  }
  if (o.hitN > 0) {
    o.hitAttack = Attack.Spin;
    o.hitDir = h.facing;
  }
};

/** Facing from the stick, keeping the current facing on diagonals when it is one of the two. */
const faceFrom = (h: Hero, ix: number, iy: number): void => {
  if (ix !== 0 && iy !== 0) {
    const fx = ix < 0 ? 2 : 3;
    const fy = iy < 0 ? 1 : 0;
    if (h.facing !== fx && h.facing !== fy) h.facing = fy;
  } else if (ix !== 0) h.facing = ix < 0 ? 2 : 3;
  else if (iy !== 0) h.facing = iy < 0 ? 1 : 0;
};

const knock = (h: Hero, fromX: number, fromY: number, speed: number, ticks: number): void => {
  const dx = h.x - fromX;
  const dy = h.y - 64 - fromY;
  if (Math.abs(dx) >= Math.abs(dy)) {
    h.kbDx = dx >= 0 ? speed : -speed;
    h.kbDy = 0;
  } else {
    h.kbDx = 0;
    h.kbDy = dy >= 0 ? speed : -speed;
  }
  h.kbT = ticks;
  h.act = Act.Hurt;
  h.actT = 0;
};

/** Is (px, py) in front of the hero's facing? */
const inFront = (h: Hero, px0: number, py0: number): boolean => {
  const dx = px0 - h.x;
  const dy = py0 - (h.y - 64);
  return (DX4[h.facing] as number) * dx + (DY4[h.facing] as number) * dy > 0;
};

/** Damage from contact, projectiles and shock rings (victim-decided, §3.5). */
const takeHits = (h: Hero, env: HeroEnv, o: HeroOut): void => {
  const shielding = h.act === Act.Shield;
  const hx = h.x;
  const hy = h.y - ((R.hurtUp - R.hurtDown) >> 1);
  const hhh = (R.hurtUp + R.hurtDown) >> 1;
  // Projectiles first: a repel shot ignores invincibility.
  for (let i = 0; i < env.nProj; i += 1) {
    const k = env.projKind[i] as number;
    if (k === Proj.Bounce) continue;
    const px0 = env.projX[i] as number;
    const py0 = env.projY[i] as number;
    if (!overlap(hx, hy, R.hurtHW, hhh, px0, py0, ENEMY_RULES.projHalf, ENEMY_RULES.projHalf)) continue;
    const d = env.projDir[i] as number;
    // The Buckler stops what flies at the hero's face: travel against the facing.
    if (shielding && (DX8[d] as number) * (DX4[h.facing] as number) + (DY8[d] as number) * (DY4[h.facing] as number) < 0) {
      o.blockedId = env.projId[i] as number;
      o.cues |= CUE.block;
      return;
    }
    if (k === Proj.Repel) {
      o.dmgSource = env.projId[i] as number;
      o.dmgAmount = 0;
      knock(h, px0 - (DX8[d] as number) * 16, py0 + 64 - (DY8[d] as number) * 16, R.repelSpeed, R.repelTicks);
      o.cues |= CUE.hurt;
      return;
    }
    if (h.iframes > 0) continue;
    o.dmgSource = env.projId[i] as number;
    o.dmgAmount = 1;
    knock(h, px0 - (DX8[d] as number) * 16, py0 + 64 - (DY8[d] as number) * 16, R.hurtSpeed, R.hurtTicks);
    h.iframes = R.iframes;
    o.cues |= CUE.hurt;
    return;
  }
  if (h.iframes > 0) return;
  for (let i = 0; i < env.nShock; i += 1) {
    const dx = hx - (env.shockX[i] as number);
    const dy = h.y - (env.shockY[i] as number);
    const r = env.shockR[i] as number;
    const d2 = dx * dx + dy * dy;
    const lo = Math.max(0, r - BOSS_RULES.ringBand);
    const hi = r + BOSS_RULES.ringBand;
    if (d2 < lo * lo || d2 > hi * hi) continue;
    if (shielding && inFront(h, env.shockX[i] as number, env.shockY[i] as number)) {
      o.cues |= CUE.block;
      continue;
    }
    o.dmgSource = 0xfd - i;
    o.dmgAmount = BOSS_RULES.ringDamage;
    knock(h, env.shockX[i] as number, env.shockY[i] as number, R.hurtSpeed, R.hurtTicks);
    h.iframes = R.iframes;
    o.cues |= CUE.hurt;
    return;
  }
  for (let i = 0; i < env.nEnt; i += 1) {
    const k = env.entKind[i] as number;
    if (env.entStunned[i]) continue;
    const pose = env.entPose[i] as number;
    if (k === Kind.Boss) {
      if (pose === 1 || pose === 7) continue;
    } else if (!contactHurts(k, 0, pose)) continue;
    const ex = env.entX[i] as number;
    const ey = env.entY[i] as number;
    if (!overlap(hx, hy, R.hurtHW, hhh, ex, ey, entHalf(k) - 16, entHalfY(k) - 16)) continue;
    o.dmgSource = env.entId[i] as number;
    o.dmgAmount = k === Kind.Boss ? BOSS_RULES.contact : (ENEMY_STATS[k]?.hit ?? 1);
    knock(h, ex, ey, R.hurtSpeed, R.hurtTicks);
    h.iframes = R.iframes;
    o.cues |= CUE.hurt;
    return;
  }
};

/** Leaves the screen? Sets the room-change intent and the transit act. */
const checkEdges = (h: Hero, o: HeroOut): boolean => {
  let edge = -1;
  if (h.x - R.feetHW < 0) edge = 2;
  else if (h.x + R.feetHW > ROOM_W_SUB) edge = 3;
  else if (h.y - R.feetHH < 0) edge = 1;
  else if (h.y + R.feetHH > ROOM_H_SUB) edge = 0;
  if (edge < 0) return false;
  o.enter = edge;
  o.enterPos = edge >= 2 ? Math.max(0, Math.min(8, h.y >> 8)) : Math.max(0, Math.min(11, h.x >> 8));
  h.act = Act.Transit;
  h.actT = 0;
  h.transitDir = edge;
  h.transitDur = edge >= 2 ? R.transitH : R.transitV;
  return true;
};

/** Walks with collision, corner nudges, pushes, ledge hops, warps and screen edges. */
const walk = (h: Hero, env: HeroEnv, o: HeroOut, ix: number, iy: number, slow: boolean): void => {
  const straight = slow ? R.slowSpeed : R.speed;
  const diag = slow ? R.slowDiag : R.diag;
  const s = ix !== 0 && iy !== 0 ? diag : straight;
  const dx = ix * s;
  const dy = iy * s;
  // Ledge hop: moving south onto a row of ledge tiles with walkable ground below.
  if (iy > 0 && ix === 0 && !slow) {
    const below = (h.y + R.feetHH + dy - 1) >> 8;
    const lx0 = (h.x - R.feetHW) >> 8;
    const lx1 = (h.x + R.feetHW - 1) >> 8;
    let ledge = below !== (h.y + R.feetHH - 1) >> 8;
    for (let tx = lx0; tx <= lx1; tx += 1) if ((flagsAt(env.tiles, tx, below) & F.LEDGE_S) === 0) ledge = false;
    if (ledge && boxBlocked(env.tiles, h.x, h.y + dy, R.feetHW, R.feetHH, SOLID_HERO, env.edges)) {
      const landTop = (below + 1) * 256;
      if (!boxBlocked(env.tiles, h.x, landTop + 192, R.feetHW, R.feetHH, SOLID_HERO | F.PIT, env.edges)) {
        h.act = Act.Ledge;
        h.actT = 0;
        h.pullY = landTop + 192;
        o.cues |= CUE.ledge;
        return;
      }
    }
  }
  pos[0] = h.x;
  pos[1] = h.y;
  const blocked = moveBox(env.tiles, pos, dx, dy, R.feetHW, R.feetHH, SOLID_HERO, env.edges);
  let nx = pos[0] as number;
  let ny = pos[1] as number;
  h.moving = nx !== h.x || ny !== h.y;
  // One axis only and blocked: nudge around corners, or push a block.
  if (blocked !== 0 && (ix === 0) !== (iy === 0)) {
    const axisX = ix !== 0;
    const n = cornerNudge(env.tiles, nx, ny, axisX, axisX ? ix : iy, R.feetHW, R.feetHH, SOLID_HERO, env.edges, R.nudge, R.nudgeSpeed);
    if (n !== 0) {
      if (axisX) ny += n;
      else nx += n;
      h.moving = true;
      h.pushT = 0;
    } else {
      const tx = axisX ? (nx + ix * (R.feetHW + 16)) >> 8 : nx >> 8;
      const ty = axisX ? ny >> 8 : (ny + iy * (R.feetHH + 16)) >> 8;
      const tile = tx >= 0 && ty >= 0 && tx < 12 && ty < 9 ? ty * 12 + tx : -1;
      if (tile >= 0 && env.tiles[tile] === T.BLOCK) {
        h.pushT += 1;
        if (h.act === Act.Walk || h.act === Act.Idle) h.act = Act.Push;
        if (h.pushT === R.pushTicks) {
          o.push = tile;
          o.pushDir = h.facing;
          o.cues |= CUE.push;
        }
      } else h.pushT = 0;
    }
  } else h.pushT = 0;
  h.x = nx;
  h.y = ny;
  if (h.act !== Act.Push || h.pushT === 0) {
    if (h.act === Act.Push || h.act === Act.Idle || h.act === Act.Walk) h.act = h.moving ? Act.Walk : Act.Idle;
  }
  // A warp tile under the feet centre.
  const under = h.y >= 0 && h.x >= 0 && h.x < ROOM_W_SUB && h.y < ROOM_H_SUB ? env.tiles[(h.y >> 8) * 12 + (h.x >> 8)] as number : 0;
  if (((TILE_FLAGS[under] ?? 0) & F.WARP) !== 0) {
    o.enter = 4;
    o.enterPos = (h.y >> 8) * 12 + (h.x >> 8);
    h.act = Act.Transit;
    h.actT = 0;
    h.transitDir = 4;
    h.transitDur = R.transitWarp;
    return;
  }
  checkEdges(h, o);
};

/** The tile 6 px in front of the feet box, if it can be interacted with; else −1. */
export const interactTile = (h: Hero, tiles: Uint8Array): number => {
  const reach = R.interactReach;
  const px0 = h.facing === 2 ? h.x - R.feetHW - reach : h.facing === 3 ? h.x + R.feetHW + reach - 1 : h.x;
  const py0 = h.facing === 1 ? h.y - R.feetHH - reach : h.facing === 0 ? h.y + R.feetHH + reach - 1 : h.y;
  if (px0 < 0 || py0 < 0 || px0 >= ROOM_W_SUB || py0 >= ROOM_H_SUB) return -1;
  const t = (py0 >> 8) * 12 + (px0 >> 8);
  return ((TILE_FLAGS[tiles[t] as number] ?? 0) & F.INTERACT) !== 0 ? t : -1;
};

/** The hook tip (sub) for the current extension. */
export const hookTipX = (h: Hero): number => h.x + (DX4[h.facing] as number) * h.hookLen;
export const hookTipY = (h: Hero): number => h.y - 64 + (DY4[h.facing] as number) * h.hookLen;

const stepHook = (h: Hero, env: HeroEnv, o: HeroOut): void => {
  if (h.hookBack) {
    h.hookLen -= R.hookSpeed;
    if (h.hookLen <= 0) {
      h.hookLen = 0;
      h.act = Act.Idle;
      h.hookCd = R.hookCooldown;
    }
    return;
  }
  h.hookLen = Math.min(R.hookRange, h.hookLen + R.hookSpeed);
  const tx = hookTipX(h);
  const ty = hookTipY(h);
  // Entities and pickups at the tip, once it has left the hero (a Rootling underground lets it pass).
  for (let i = 0; i < env.nEnt && h.hookLen > 128; i += 1) {
    const k = env.entKind[i] as number;
    if (k === Kind.Block || (k === Kind.Rootling && (env.entPose[i] as number) < 2)) continue;
    if (overlap(tx, ty, 64, 64, env.entX[i] as number, env.entY[i] as number, entHalf(k), entHalfY(k))) {
      addHit(h, o, env.entId[i] as number);
      o.hitAttack = Attack.Hook;
      o.hitDir = h.facing;
      h.hookBack = true;
      o.cues |= CUE.hookLatch;
      return;
    }
  }
  for (let i = 0; i < env.nPick; i += 1) {
    if (overlap(tx, ty, 64, 64, env.pickX[i] as number, env.pickY[i] as number, ENEMY_RULES.pickupHalf, ENEMY_RULES.pickupHalf)) {
      addHit(h, o, env.pickId[i] as number);
      o.hitAttack = Attack.Hook;
      o.hitDir = h.facing;
      h.hookBack = true;
      return;
    }
  }
  if (tx < 0 || ty < 0 || tx >= ROOM_W_SUB || ty >= ROOM_H_SUB) {
    h.hookBack = true;
    return;
  }
  const t = (ty >> 8) * 12 + (tx >> 8);
  const code = env.tiles[t] as number;
  const flags = TILE_FLAGS[code] ?? 0;
  if ((flags & F.HOOKABLE) !== 0) {
    o.cues |= CUE.hookLatch;
    if (code === T.POST) {
      // Pulled to the tile in front of the post, over pits and water.
      h.act = Act.Pulled;
      h.actT = 0;
      h.pullX = (t % 12) * 256 + 128 - (DX4[h.facing] as number) * 256;
      h.pullY = Math.floor(t / 12) * 256 + 128 - (DY4[h.facing] as number) * 256;
      h.hookBack = false;
      return;
    }
    addHit(h, o, 128 + t);
    o.hitAttack = Attack.Hook;
    o.hitDir = h.facing;
    h.hookBack = true;
    return;
  }
  if ((flags & SOLID_FLIER) !== 0) {
    h.hookBack = true;
    o.cues |= CUE.clinkWall;
    return;
  }
  if (h.hookLen >= R.hookRange) h.hookBack = true;
};

/**
 * One tick of the own hero. `buttons` are the held bits for this tick (taps latched by the input layer).
 * Writes intents into `o` (reset first). The caller sends them and applies room changes.
 */
export const stepHero = (h: Hero, buttons: number, env: HeroEnv, o: HeroOut): void => {
  resetOut(o);
  h.heroTick = env.tick;
  h.moving = false;
  const pressed = buttons & ~h.btn;
  h.btn = buttons;
  if (h.status !== Status.Active) return;
  if (h.iframes > 0) h.iframes -= 1;
  if (h.hookCd > 0) h.hookCd -= 1;
  const ix = (buttons & Btn.right ? 1 : 0) - (buttons & Btn.left ? 1 : 0);
  const iy = (buttons & Btn.down ? 1 : 0) - (buttons & Btn.up ? 1 : 0);
  const hasSword = (env.items & ItemBit.sword) !== 0;
  const hasBuckler = (env.items & ItemBit.buckler) !== 0;
  const hasHook = (env.items & ItemBit.hook) !== 0;
  if (h.item === 0 && !hasBuckler && hasHook) h.item = 1;
  if (h.item === 1 && !hasHook && hasBuckler) h.item = 0;

  switch (h.act) {
    case Act.Transit:
      h.actT += 1;
      if (h.actT >= h.transitDur) h.act = Act.Idle;
      return;
    case Act.Got:
      h.actT += 1;
      if (h.actT >= R.gotTicks) h.act = Act.Idle;
      return;
    case Act.Fall:
      h.actT += 1;
      if (h.actT >= R.fallTicks) {
        h.x = h.entryX;
        h.y = h.entryY;
        h.act = Act.Idle;
        h.iframes = R.iframes;
        o.dmgSource = PIT_SOURCE;
        o.dmgAmount = R.pitDamage;
      }
      return;
    case Act.Pulled: {
      h.actT += 1;
      const dx = Math.max(-R.pullSpeed, Math.min(R.pullSpeed, h.pullX - h.x));
      const dy = Math.max(-R.pullSpeed, Math.min(R.pullSpeed, h.pullY - h.y));
      pos[0] = h.x;
      pos[1] = h.y;
      moveBox(env.tiles, pos, dx, dy, R.feetHW, R.feetHH, SOLID_FLIER, null);
      const stuck = pos[0] === h.x && pos[1] === h.y;
      h.x = pos[0] as number;
      h.y = pos[1] as number;
      if ((h.x === h.pullX && h.y === h.pullY) || stuck || h.actT > 40) {
        h.act = Act.Idle;
        h.hookLen = 0;
        h.hookCd = R.hookCooldown;
      }
      return;
    }
    case Act.Ledge:
      h.actT += 1;
      h.y = Math.min(h.pullY, h.y + R.ledgeSpeed);
      if (h.actT >= R.ledgeTicks || h.y >= h.pullY) {
        h.act = Act.Idle;
        h.entryX = h.x;
        h.entryY = h.y;
      }
      return;
    case Act.Hurt:
      pos[0] = h.x;
      pos[1] = h.y;
      // Knockback never carries you through an exit: screen edges are walls for it.
      moveBox(env.tiles, pos, h.kbDx, h.kbDy, R.feetHW, R.feetHH, SOLID_HERO, null);
      h.x = pos[0] as number;
      h.y = pos[1] as number;
      h.actT += 1;
      if (h.actT >= h.kbT) h.act = Act.Idle;
      break;
    case Act.Hook:
      h.actT += 1;
      stepHook(h, env, o);
      if (h.act === Act.Hook) break;
      if (h.act === Act.Pulled) return;
      break;
    case Act.Slash:
      h.actT += 1;
      if (h.actT >= R.slashFrom && h.actT <= R.slashTo) {
        slashBox(h.x, h.y, h.facing, box);
        hitBox(h, env, o, Attack.Slash);
      }
      if (h.actT >= R.slashLock && h.actT < R.slashTicks && (ix !== 0 || iy !== 0)) walk(h, env, o, ix, iy, false);
      if ((h.act as number) === Act.Transit) return;
      if (h.actT >= R.slashTicks) {
        h.act = buttons & Btn.a ? Act.Charge : Act.Idle;
        h.actT = 0;
        h.charged = false;
      }
      break;
    case Act.Charge:
      if (!(buttons & Btn.a)) {
        if (h.charged) {
          h.act = Act.Spin;
          h.actT = 0;
          h.charged = false;
          startSwing(h, env.tick);
          o.cues |= CUE.spin;
        } else h.act = Act.Idle;
        break;
      }
      h.actT += 1;
      if (h.actT === R.chargeTicks) {
        h.charged = true;
        o.cues |= CUE.charged;
      }
      if (ix !== 0 || iy !== 0) {
        const facing = h.facing;
        walk(h, env, o, ix, iy, true);
        if ((h.act as number) === Act.Transit) return;
        h.facing = facing;
        h.act = Act.Charge;
      }
      break;
    case Act.Spin:
      h.actT += 1;
      hitSpin(h, env, o);
      if (h.actT >= R.spinTicks) h.act = Act.Idle;
      break;
    case Act.Shield:
      if (!(buttons & Btn.b) || h.item !== 0 || !hasBuckler) {
        h.act = Act.Idle;
        break;
      }
      if (ix !== 0 || iy !== 0) {
        const facing = h.facing;
        walk(h, env, o, ix, iy, true);
        if ((h.act as number) === Act.Transit) return;
        h.facing = facing;
        h.act = Act.Shield;
      }
      break;
    default: {
      // Idle, Walk, Push: new actions or walking.
      if (pressed & Btn.swap && hasBuckler && hasHook) h.item = h.item === 0 ? 1 : 0;
      if (pressed & Btn.a) {
        const t = interactTile(h, env.tiles);
        if (t >= 0) {
          o.interact = t;
          h.act = Act.Idle;
          break;
        }
        if (hasSword) {
          h.act = Act.Slash;
          h.actT = 0;
          startSwing(h, env.tick);
          o.cues |= CUE.swish;
          break;
        }
      }
      if (buttons & Btn.b) {
        if (h.item === 0 && hasBuckler) {
          h.act = Act.Shield;
          h.actT = 0;
          break;
        }
        if (h.item === 1 && hasHook && pressed & Btn.b && h.hookCd === 0) {
          h.act = Act.Hook;
          h.actT = 0;
          h.hookLen = 0;
          h.hookBack = false;
          startSwing(h, env.tick);
          o.cues |= CUE.hookThrow;
          break;
        }
      }
      if (ix !== 0 || iy !== 0) {
        faceFrom(h, ix, iy);
        if (h.act !== Act.Push) h.act = Act.Walk;
        walk(h, env, o, ix, iy, false);
        if ((h.act as number) === Act.Transit || (h.act as number) === Act.Ledge) return;
      } else {
        h.act = Act.Idle;
        h.pushT = 0;
      }
    }
  }
  // Falling into a pit (not while pulled, hopping or sliding).
  if (h.act !== Act.Pulled && h.act !== Act.Ledge && h.act !== Act.Transit && h.x >= 0 && h.y >= 0 && h.x < ROOM_W_SUB && h.y < ROOM_H_SUB) {
    const code = env.tiles[(h.y >> 8) * 12 + (h.x >> 8)] as number;
    if (((TILE_FLAGS[code] ?? 0) & F.PIT) !== 0) {
      h.act = Act.Fall;
      h.actT = 0;
      o.cues |= CUE.fall;
      return;
    }
  }
  takeHits(h, env, o);
};
