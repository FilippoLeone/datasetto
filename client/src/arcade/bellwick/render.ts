/**
 * Drawing Bellwick (bellwick.md §8.2): three atlases baked once at mount (tiles in the six area
 * palettes, the hero in four tunics, everything else), a 192 × 144 bake of the room's static tiles
 * redrawn only when a tile changes, then per frame the animated tiles, the actors sorted by y and the
 * effects, into the 192 × 160 canvas below the 16 px HUD. Floats only here, never in the core.
 */
import { ACTOR_PALETTES, ACTOR_SHEETS, HERO_PALETTES, HERO_SHEETS, TILE_PALETTES, TILE_SHEETS } from '@arcade/core/bellwick/content/art';
import { T } from '@arcade/core/bellwick/content/legend';
import { AREA, screen, type ScreenDef } from '@arcade/core/bellwick/content/parse';
import type { ClientWorld, CEnt, COther } from '@arcade/core/bellwick/client';
import { hookTipX, hookTipY } from '@arcade/core/bellwick/sim/hero';
import { projX, projY } from '@arcade/core/bellwick/sim/room';
import { Act, Kind, Pick, Proj, Status } from '@arcade/core/bellwick/types';
import { bakeAtlas, type Atlas } from '@/arcade/runtime/sprites';

export const HUD_H = 16;
export const W = 192;
export const H = 160;

export interface Art {
  tiles: Atlas;
  hero: Atlas;
  actors: Atlas;
}

export const bakeArt = async (): Promise<Art> => {
  const [tiles, hero, actors] = await Promise.all([
    bakeAtlas(TILE_SHEETS, TILE_PALETTES),
    bakeAtlas(HERO_SHEETS, HERO_PALETTES),
    bakeAtlas(ACTOR_SHEETS, ACTOR_PALETTES),
  ]);
  return { tiles, hero, actors };
};

export const disposeArt = (a: Art): void => {
  a.tiles.dispose();
  a.hero.dispose();
  a.actors.dispose();
};

const ANIM: Readonly<Record<number, number>> = { [T.WATER]: 0, [T.SHALLOW]: 1, [T.LANTERN_LIT]: 2, [T.CRYSTAL_ON]: 3 };

/** A room's static tiles, drawn once into an offscreen canvas. */
export interface RoomBake {
  readonly canvas: HTMLCanvasElement;
  room: number;
  /** Tiles that animate (water, lit lanterns, lit crystals). */
  anim: number[];
  bake(c: ClientWorld): void;
  cell(c: ClientWorld, tile: number): void;
  dispose(): void;
}

const groundCode = (def: ScreenDef): number => (def.area === AREA.home ? T.WOOD : def.area === AREA.dungeon || def.area === AREA.cave ? T.FLOOR : T.GRASS);

export const createRoomBake = (art: Art): RoomBake => {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H - HUD_H;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const drawCell = (c: ClientWorld, def: ScreenDef, t: number): void => {
    const code = c.tiles[t] as number;
    const x = (t % 12) * 16;
    const y = Math.floor(t / 12) * 16;
    // Objects sit on the area's ground; under an NPC, the mat tile.
    if (code === T.NPC) {
      art.tiles.draw(ctx, 'tiles', x, y, { frame: groundCode(def), palette: def.area });
      art.tiles.draw(ctx, 'tiles', x, y, { frame: T.NPC, palette: def.area });
      for (const n of def.npcs) if (n.tile === t) art.actors.draw(ctx, 'npc', x, y - 2, { frame: n.who });
      return;
    }
    art.tiles.draw(ctx, 'tiles', x, y, { frame: code, palette: def.area });
  };
  const bake: RoomBake = {
    canvas,
    room: -1,
    anim: [],
    bake(c) {
      bake.room = c.room;
      bake.anim.length = 0;
      const def = screen(c.room);
      for (let t = 0; t < 108; t += 1) {
        drawCell(c, def, t);
        if (ANIM[c.tiles[t] as number] !== undefined) bake.anim.push(t);
      }
    },
    cell(c, t) {
      if (bake.room !== c.room) return;
      drawCell(c, screen(c.room), t);
      const i = bake.anim.indexOf(t);
      const animates = ANIM[c.tiles[t] as number] !== undefined;
      if (animates && i < 0) bake.anim.push(t);
      if (!animates && i >= 0) bake.anim.splice(i, 1);
    },
    dispose() {
      canvas.width = canvas.height = 0;
    },
  };
  return bake;
};

/** Short visual effects: poofs, hit stars, clinks, leaves, sparkles. */
export const FX = { poof: 0, hit: 1, clink: 2, leaf: 3, sparkle: 4, splash: 5, dust: 6 } as const;
interface Fx { on: boolean; kind: number; x: number; y: number; t: number }
export interface Effects {
  add(kind: number, x: number, y: number): void;
  readonly busy: boolean;
  step(): void;
  draw(ctx: CanvasRenderingContext2D, art: Art, ox: number, oy: number): void;
}

const FX_LEN: readonly number[] = [12, 6, 6, 12, 12, 10, 8];

export const createEffects = (): Effects => {
  const pool: Fx[] = [];
  for (let i = 0; i < 24; i += 1) pool.push({ on: false, kind: 0, x: 0, y: 0, t: 0 });
  let live = 0;
  return {
    add(kind, x, y) {
      for (const f of pool) {
        if (f.on) continue;
        f.on = true;
        f.kind = kind;
        f.x = x;
        f.y = y;
        f.t = 0;
        live += 1;
        return;
      }
    },
    get busy() {
      return live > 0;
    },
    step() {
      for (const f of pool) {
        if (!f.on) continue;
        f.t += 1;
        if (f.t >= (FX_LEN[f.kind] ?? 8)) {
          f.on = false;
          live -= 1;
        }
      }
    },
    draw(ctx, art, ox, oy) {
      for (const f of pool) {
        if (!f.on) continue;
        const x = Math.round(f.x + ox);
        const y = Math.round(f.y + oy);
        switch (f.kind) {
          case FX.poof:
            art.actors.draw(ctx, 'fx16', x - 8, y - 8, { frame: Math.min(2, (f.t / 4) | 0) });
            break;
          case FX.hit:
            art.actors.draw(ctx, 'fx16', x - 8, y - 8, { frame: 3 });
            break;
          case FX.clink:
            art.actors.draw(ctx, 'fx16', x - 8, y - 8, { frame: 5 });
            break;
          case FX.splash:
            art.actors.draw(ctx, 'fx16', x - 8, y - 8, { frame: 4 });
            break;
          case FX.leaf:
            for (let k = 0; k < 3; k += 1) art.actors.draw(ctx, 'fx8', x - 4 + (k - 1) * (2 + f.t), y - 4 - f.t + k * 2, { frame: 5 });
            break;
          case FX.sparkle:
            art.actors.draw(ctx, 'fx8', x - 4, y - 4 - (f.t >> 1), { frame: 3 + ((f.t >> 2) & 1) });
            break;
          default:
            art.actors.draw(ctx, 'fx8', x - 4, y - 4, { frame: 6 });
        }
      }
    },
  };
};

const ENEMY_SHEET: Readonly<Record<number, string>> = {
  [Kind.Burrlet]: 'burrlet',
  [Kind.Snapjaw]: 'snapjaw',
  [Kind.Slingkin]: 'slingkin',
  [Kind.Shellback]: 'shellback',
  [Kind.Wisp]: 'wisp',
  [Kind.Rootling]: 'rootling',
  [Kind.Bat]: 'bat',
  [Kind.Sentinel]: 'sentinel',
};
const ENEMY_FRAMES: Readonly<Record<number, number>> = {
  [Kind.Burrlet]: 2,
  [Kind.Snapjaw]: 4,
  [Kind.Slingkin]: 3,
  [Kind.Shellback]: 3,
  [Kind.Wisp]: 2,
  [Kind.Rootling]: 4,
  [Kind.Bat]: 3,
  [Kind.Sentinel]: 2,
};
const BOSS_FRAME: readonly number[] = [0, 1, 2, 4, 3, 0, 5, 0];
const PICK_FRAME: readonly number[] = [10, 11, 12, 13, 8];

/** The hero sprite frame for an act and facing (hero sheet order, see art.ts). */
export const heroFrame = (act: number, facing: number, moving: boolean, tick: number): number => {
  const base = facing === 0 ? 0 : facing === 1 ? 6 : 12;
  switch (act) {
    case Act.Slash:
      return base + 2;
    case Act.Shield:
      return base + 3;
    case Act.Hook:
    case Act.Pulled:
      return base + 4;
    case Act.Hurt:
      return base + 5;
    case Act.Spin:
      return 18;
    case Act.Downed:
      return 19 + ((tick >> 3) & 1);
    case Act.Resting:
      return 21;
    case Act.Got:
      return 22;
    case Act.Fall:
      return 23;
    default:
      return base + (moving ? (tick >> 3) & 1 : 0);
  }
};

interface Drawable { y: number; draw: () => void }

/** One hero as drawn: sprite, sword, shield and hook. Positions in pixels (feet centre). */
const drawHero = (
  ctx: CanvasRenderingContext2D,
  art: Art,
  tunic: number,
  x: number,
  y: number,
  act: number,
  actT: number,
  facing: number,
  moving: boolean,
  tick: number,
  flash: boolean,
  hookLen: number,
): void => {
  const sx = Math.round(x) - 8;
  const sy = Math.round(y) - 14;
  if (flash && (tick & 2) !== 0) return;
  const frame = heroFrame(act, facing, moving, tick);
  const left = facing === 2 && frame < 18;
  if (act === Act.Fall) {
    art.hero.draw(ctx, 'hero', sx, sy + Math.min(4, actT >> 2), { frame, palette: tunic });
    return;
  }
  const sword = (): void => {
    if (act === Act.Slash && actT < 8) {
      if (facing === 0) art.hero.draw(ctx, 'sword', sx + 2, sy + 11, { frame: 0 });
      else if (facing === 1) art.hero.draw(ctx, 'sword', sx + 4, sy - 11, { frame: 1 });
      else art.hero.draw(ctx, 'sword', facing === 3 ? sx + 11 : sx - 11, sy + 4, { frame: 2, flipX: facing === 2 });
    } else if (act === Act.Spin) {
      const q = (actT >> 2) & 3;
      art.hero.draw(ctx, 'sword', sx + (q === 0 || q === 3 ? 9 : -9), sy + (q < 2 ? 8 : -6), { frame: 3, flipX: q === 1 || q === 2 });
    }
  };
  // The blade behind the hero when swinging up.
  if (facing === 1) sword();
  art.hero.draw(ctx, 'hero', sx, sy, { frame, palette: tunic, flipX: left });
  if (facing !== 1) sword();
  if ((act === Act.Hook || act === Act.Pulled) && hookLen > 0) {
    const cx = Math.round(x);
    const cy = Math.round(y) - 4;
    const dx = facing === 2 ? -1 : facing === 3 ? 1 : 0;
    const dy = facing === 1 ? -1 : facing === 0 ? 1 : 0;
    const len = hookLen >> 4;
    for (let d = 6; d < len - 2; d += 6) art.hero.draw(ctx, 'hook', cx + dx * d - 4, cy + dy * d - 4, { frame: dx !== 0 ? 3 : 2 });
    const tx = cx + dx * len - 4;
    const ty = cy + dy * len - 4;
    if (dy > 0) {
      ctx.save();
      ctx.translate(0, ty * 2 + 8);
      ctx.scale(1, -1);
      art.hero.draw(ctx, 'hook', tx, ty, { frame: 0 });
      ctx.restore();
    } else art.hero.draw(ctx, 'hook', tx, ty, { frame: dx !== 0 ? 1 : 0, flipX: dx < 0 });
  }
};

const drawEnemy = (ctx: CanvasRenderingContext2D, art: Art, e: CEnt, x: number, y: number, tick: number): void => {
  if (e.hurt && (tick & 2) !== 0) return;
  if (e.kind === Kind.Boss) {
    const frame = BOSS_FRAME[e.pose] ?? 0;
    if (e.pose === 1) {
      ctx.globalAlpha = 0.35;
      art.actors.draw(ctx, 'bossShadow', Math.round(x) - 16, Math.round(y) + 10, {});
      ctx.globalAlpha = 1;
      art.actors.draw(ctx, 'boss', Math.round(x) - 16, Math.round(y) - 28, { frame });
      return;
    }
    art.actors.draw(ctx, 'boss', Math.round(x) - 16, Math.round(y) - 18, { frame, flipX: e.pose === 3 && e.facing === 2 });
    return;
  }
  const sheet = ENEMY_SHEET[e.kind];
  if (!sheet) return;
  const n = ENEMY_FRAMES[e.kind] ?? 1;
  let frame = Math.min(n - 1, e.pose);
  if (e.kind === Kind.Wisp) frame = (tick >> 3) & 1;
  if (e.stunned && e.kind === Kind.Snapjaw) frame = 3;
  const flip = e.facing === 2 && e.kind !== Kind.Sentinel;
  art.actors.draw(ctx, sheet, Math.round(x) - 8, Math.round(y) - 9, { frame, flipX: flip });
};

const queue: Drawable[] = [];

export interface View {
  /** Interpolation: 0..1 between the previous and the newest snapshot, and for the own hero. */
  alphaEnt: number;
  alphaMe: number;
  /** Own hero's previous position (sub), for interpolation. */
  meX0: number;
  meY0: number;
  tick: number;
  /** Render tick for projectiles and rings (the present). */
  projTick: number;
}

/** Draws the world (bake, animated tiles, actors) with the world origin at (ox, oy). */
export const drawWorld = (ctx: CanvasRenderingContext2D, art: Art, c: ClientWorld, bake: RoomBake, v: View, ox: number, oy: number, actors: boolean): void => {
  ctx.drawImage(bake.canvas, ox, oy);
  if (bake.room !== c.room) return;
  const def = screen(c.room);
  const animFrame = (v.tick >> 4) & 1;
  for (const t of bake.anim) {
    if (!animFrame) continue;
    const code = c.tiles[t] as number;
    const f = ANIM[code];
    if (f !== undefined) art.tiles.draw(ctx, 'tileanim', ox + (t % 12) * 16, oy + Math.floor(t / 12) * 16, { frame: f, palette: def.area });
  }
  if (!actors) return;
  queue.length = 0;
  // Pickups (blinking near the end) and projectiles lie low.
  for (const p of c.picks) {
    if (!p.on) continue;
    if (p.ttl >= 0 && p.ttl < 60 && (v.tick & 4) !== 0) continue;
    const frame = PICK_FRAME[p.kind] ?? 10;
    const px = p.x;
    const py = p.y;
    queue.push({ y: py - 4, draw: () => art.actors.draw(ctx, 'items', ox + px - 8, oy + py - 12 + (p.kind === Pick.Heart ? 0 : (v.tick >> 4) & 1), { frame }) });
  }
  for (const e of c.ents) {
    if (!e.on || e.hiddenAt >= 0) continue;
    const ent = e;
    const x = e.px + (e.x - e.px) * v.alphaEnt;
    const y = e.py + (e.y - e.py) * v.alphaEnt;
    queue.push({ y: e.kind === Kind.Boss ? y + 8 : y, draw: () => drawEnemy(ctx, art, ent, ox + x, oy + y, v.tick) });
  }
  for (const o of c.others) {
    if (!o.on) continue;
    const other: COther = o;
    const x = o.px + (o.x - o.px) * v.alphaEnt;
    const y = o.py + (o.y - o.py) * v.alphaEnt;
    queue.push({
      y,
      draw: () => {
        const tunic = c.roster.rows.find((r) => r.slot === other.slot)?.tunic ?? other.slot;
        const act = other.status === Status.Downed ? Act.Downed : other.act;
        drawHero(ctx, art, tunic & 3, ox + x, oy + y, act, other.actT, other.facing, other.moving, v.tick, other.hurt, 0);
      },
    });
  }
  const me = c.me;
  if (me.room === c.room && !c.awaitingKey) {
    const mx = (v.meX0 + (me.x - v.meX0) * v.alphaMe) / 16;
    const my = (v.meY0 + (me.y - v.meY0) * v.alphaMe) / 16;
    const act = me.status === Status.Downed ? Act.Downed : me.act;
    queue.push({ y: my, draw: () => drawHero(ctx, art, me.tunic & 3, ox + mx, oy + my, act, me.actT, me.facing, me.moving, v.tick, me.iframes > 0 && act !== Act.Downed, me.hookLen) });
    if (me.act === Act.Got) queue.push({ y: my + 1, draw: () => drawGot(ctx, art, ox + mx, oy + my) });
  }
  queue.sort((a, b) => a.y - b.y);
  for (const d of queue) d.draw();
  // Projectiles fly at the present tick; rings spread from the slam.
  for (const p of c.projs) {
    if (!p.on) continue;
    const t = v.projTick - p.t0;
    if (t < 0) continue;
    const x = projX(p.x0, p.dir, p.kind, t) / 16;
    const y = projY(p.y0, p.dir, p.kind, t) / 16;
    art.actors.draw(ctx, 'fx8', Math.round(ox + x) - 4, Math.round(oy + y) - 4, { frame: p.kind === Proj.Note ? 1 : p.kind === Proj.Repel ? 2 : 0 });
  }
  for (const s of c.shocks) {
    if (!s.on) continue;
    const r = ((v.projTick - s.t0) * 48) / 16;
    if (r <= 0 || r > 96) continue;
    ctx.strokeStyle = '#fff0c8';
    ctx.globalAlpha = Math.max(0.2, 1 - r / 96);
    ctx.beginPath();
    ctx.ellipse(ox + s.x / 16, oy + s.y / 16, r, r * 0.6, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
};

let gotItem = 0;
export const setGotItem = (frame: number): void => {
  gotItem = frame;
};

const drawGot = (ctx: CanvasRenderingContext2D, art: Art, x: number, y: number): void => {
  art.actors.draw(ctx, 'items', Math.round(x) - 8, Math.round(y) - 30, { frame: gotItem });
};

/** Hook tip in pixels for effects. */
export const hookTip = (c: ClientWorld): [number, number] => [hookTipX(c.me) / 16, hookTipY(c.me) / 16];
