/**
 * Fuseyard's renderer (fuseyard.md §8.2): a static layer of tiles redrawn only where events change
 * cells, then sprites and the HUD, all into the 240 × 224 canvas (15 × 13 tiles of 16 px under a
 * 16 px HUD strip). Nothing allocates per frame.
 */
import type { Atlas } from '@/arcade/runtime/sprites';
import { drawText, textWidth } from '@/arcade/runtime/font';
import { CELLS, Cell, Phase, Seat, Special, W } from '@arcade/core/fuseyard/rules';
import { NO_END, type WBomb, type WFighter, type World } from '@arcade/core/fuseyard/view';
import { ARENAS } from '@arcade/core/fuseyard/arenas';
import { FLAME_SHAPE, PAL_FLASH, PAL_GHOST, SLOT_TEXT, THEMES, TILE, UI, WF, beltFrame, makeTile } from './art';

export const LOGICAL_W = 240;
export const LOGICAL_H = 224;
export const HUD_H = 16;
export const WICK_NAMES = ['Ember', 'Tide', 'Fern', 'Dusk'];

/**
 * A player name for the board's 5 × 7 font, which has only printable ASCII (anything else draws '?'):
 * '' when the name has other characters (the caller falls back to the Wick's name), shortened to
 * `max` characters.
 */
export const fontSafe = (name: string, max: number): string => {
  for (let i = 0; i < name.length; i += 1) {
    const c = name.charCodeAt(i);
    if (c < 32 || c > 126) return '';
  }
  return name.length > max ? name.slice(0, max - 2) + '..' : name;
};

/** What a frame shows beyond the world itself. */
export interface DrawState {
  w: World;
  me: number;
  nowMs: number;
  /** Render positions per slot, in sub-units (interpolated or predicted). */
  px: Float64Array;
  py: Float64Array;
  /** The core tick being shown, with a fraction (countdowns, result card, death animations). */
  tick: number;
  /** The round tick being shown, with a fraction (fuses, flames, shields). */
  roundTick: number;
  /** A bomb the player just pressed for, drawn faintly until the server confirms it (-1: none). */
  ghostBomb: number;
  /** 1 where a known bomb burns within a second (blast lanes), or null when off. */
  lanes: Uint8Array | null;
  /** Ticks since the round started playing (the "you" marker shows for 3 s). */
  playTicks: number;
  lag: boolean;
  names: readonly string[];
  reducedMotion: boolean;
  /** Screen shake left, in frames. */
  shake: number;
  /** Seconds the round has left (null when there is no clock to show). */
  clockSeconds: number | null;
  closing: boolean;
  /** Ghost seat whose return the round waits for (freeze banner). */
  waitingFor: string | null;
  holdSeconds: number | null;
}

export interface Renderer {
  draw(s: DrawState): void;
  /** Redraw every tile next frame (a new arena or a keyframe). */
  invalidate(): void;
  dispose(): void;
}

const FACING_FRAME: readonly number[] = [WF.down, WF.up, WF.side, WF.down, WF.side];
const WALK: readonly number[] = [0, 1, 0, 2];
const DIGITS: readonly string[] = Array.from({ length: 100 }, (_, i) => String(i));
const flameOn = (w: World, k: number, R: number): boolean => k >= 0 && k < CELLS && (w.flameEnd[k] as number) > R;
/** "bombs/range" labels, made once. */
const STATS: readonly string[] = Array.from({ length: 256 }, (_, i) => (i & 15) + '/' + (i >> 4));
/** "m:ss" labels for 0–10 minutes, made once. */
const CLOCK: readonly string[] = Array.from({ length: 601 }, (_, t) => Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'));

export const createRenderer = (ctx: CanvasRenderingContext2D, ui: Atlas, wick: Atlas): Renderer => {
  const layer = document.createElement('canvas');
  layer.width = LOGICAL_W;
  layer.height = LOGICAL_H - HUD_H;
  const lctx = layer.getContext('2d') as CanvasRenderingContext2D;
  // Tile images per theme, made on first use.
  const tiles: (ImageData | null)[][] = THEMES.map(() => []);
  let theme = -1;
  let allDirty = true;
  // A small canvas for big text (drawn at 1×, blitted scaled).
  const big = document.createElement('canvas');
  big.width = 96;
  big.height = 9;
  const bctx = big.getContext('2d') as CanvasRenderingContext2D;

  const tileImage = (t: number, kind: number, variant: number): ImageData | null => {
    const key = kind * 4 + variant;
    const list = tiles[t] as (ImageData | null)[];
    let img = list[key] ?? null;
    if (!img && lctx.createImageData) {
      img = lctx.createImageData(16, 16);
      img.data.set(makeTile(THEMES[t]!, kind, variant));
      list[key] = img;
    }
    return img;
  };

  const tileKind = (w: World, c: number): number => {
    const cell = w.cells[c] as number;
    if (cell === Cell.Wall) return TILE.wall;
    if (cell === Cell.Pillar) return TILE.pillar;
    if (cell === Cell.Block) return TILE.block;
    if (cell === Cell.Steel) return TILE.steel;
    const sp = (ARENAS[w.arena]?.special[c] ?? 0) as number;
    if (sp >= Special.BeltN && sp <= Special.BeltW) return TILE.belt;
    if (sp === Special.Ice) return TILE.ice;
    if (sp >= Special.PadA) return TILE.pad;
    return ((c % W) + ((c / W) | 0)) % 3 === 0 ? TILE.floorB : TILE.floor;
  };

  const drawTile = (w: World, c: number): void => {
    const img = tileImage(w.arena, tileKind(w, c), c % 4);
    if (img) lctx.putImageData(img, (c % W) * 16, ((c / W) | 0) * 16);
  };

  const refreshLayer = (w: World): void => {
    if (w.arena !== theme) {
      theme = w.arena;
      allDirty = true;
    }
    for (let c = 0; c < CELLS; c += 1) {
      if (allDirty || w.dirty[c] === 1) {
        drawTile(w, c);
        w.dirty[c] = 0;
      }
    }
    allDirty = false;
  };

  const bigText = (text: string, color: number, cx: number, cy: number, scale: number): void => {
    bctx.clearRect(0, 0, big.width, big.height);
    drawText(bctx, ui, text, 1, 1, color);
    const tw = textWidth(text) + 2;
    ctx.drawImage(big, 0, 0, tw, 9, Math.round(cx - (tw * scale) / 2), Math.round(cy - (9 * scale) / 2), tw * scale, 9 * scale);
  };

  const centreText = (text: string, color: number, y: number): void => {
    drawText(ctx, ui, text, Math.round((LOGICAL_W - textWidth(text)) / 2), y, color);
  };

  const panel = (x: number, y: number, w: number, h: number): void => {
    ctx.fillStyle = 'rgba(11,11,18,0.82)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(244,240,232,0.25)';
    ctx.fillRect(x, y, w, 1);
    ctx.fillRect(x, y + h - 1, w, 1);
  };

  const flameShape = (w: World, c: number, R: number): number => {
    const n = flameOn(w, c - W, R);
    const s = flameOn(w, c + W, R);
    const e = flameOn(w, c + 1, R);
    const wv = flameOn(w, c - 1, R);
    if ((e || wv) && (n || s)) return FLAME_SHAPE.centre;
    if (e && wv) return FLAME_SHAPE.h;
    if (n && s) return FLAME_SHAPE.v;
    if (e) return FLAME_SHAPE.endW;
    if (wv) return FLAME_SHAPE.endE;
    if (s) return FLAME_SHAPE.endN;
    if (n) return FLAME_SHAPE.endS;
    return FLAME_SHAPE.centre;
  };

  const drawFighter = (s: DrawState, f: WFighter, slot: number, ox: number, oy: number): void => {
    const w = s.w;
    const x = Math.round(s.px[slot]! / 4) - 8 + ox;
    const y = Math.round(s.py[slot]! / 4) - 11 + oy;
    let frame: number;
    let flip = false;
    if (!f.alive) {
      const since = s.tick - f.diedAt;
      if (since < 0 || since >= 32) return;
      frame = WF.death + Math.min(3, Math.floor(since / 8));
    } else {
      const base = FACING_FRAME[f.facing] ?? WF.down;
      flip = f.facing === 4;
      const cheering = w.phase === Phase.RoundEnd && w.winner === slot;
      if (cheering) frame = WF.cheer + (Math.floor(s.nowMs / 250) & 1);
      else if (f.moving && f.seat !== Seat.Ghost) {
        const step = WALK[Math.floor(s.nowMs / 110) & 3] as number;
        frame = base + step;
      } else if (base === WF.down) frame = WF.idle + (Math.floor(s.nowMs / 1900) % 6 === 0 ? 1 : 0);
      else frame = base;
    }
    let pal = slot;
    let alpha = 1;
    if (f.seat === Seat.Ghost) {
      pal = PAL_GHOST;
      alpha = 0.45;
    } else if (f.alive && f.shieldEnd > s.roundTick) {
      if (s.reducedMotion) alpha = 0.75;
      else if (Math.floor(s.nowMs / 80) & 1) pal = PAL_FLASH;
    }
    if (f.alive) {
      ctx.globalAlpha = 0.35;
      ui.draw(ctx, 'shadow', x, y + 3);
    }
    ctx.globalAlpha = alpha;
    wick.draw(ctx, 'wick', x, y, { frame, palette: pal, flipX: flip });
    if (f.alive && frame < WF.death) wick.draw(ctx, 'hat', x, y + (frame === WF.down + 1 || frame === WF.down + 2 || frame === WF.up + 1 || frame === WF.up + 2 ? -1 : 0), { frame: slot, palette: pal, flipX: flip });
    ctx.globalAlpha = 1;
    if (f.seat === Seat.Ghost && f.alive) ui.draw(ctx, 'signal', x + 11, y - 1);
    if (slot === s.me && f.alive) {
      if (s.playTicks < 90 && f.seat !== Seat.Ghost) {
        const bob = s.reducedMotion ? 0 : Math.round(Math.sin(s.nowMs / 120) * 1.5);
        ui.draw(ctx, 'you', x + 4, y - 9 + bob);
      }
      if (s.lag) ui.draw(ctx, 'lag', x + 12, y - 4);
    }
  };

  const order = new Int8Array(4);

  const drawBoard = (s: DrawState, ox: number, oy: number): void => {
    const w = s.w;
    const R = Math.floor(s.roundTick);
    const by = HUD_H + oy;
    ctx.drawImage(layer, ox, by);
    const arena = ARENAS[w.arena];
    const anim = Math.floor(s.nowMs / 160);
    // Belts and pads.
    if (arena && (arena.hasBelts || arena.hasPads)) {
      for (let c = 0; c < CELLS; c += 1) {
        if (w.cells[c] !== Cell.Floor) continue;
        const sp = arena.special[c] as number;
        const x = (c % W) * 16 + ox;
        const y = ((c / W) | 0) * 16 + by;
        if (sp >= Special.BeltN && sp <= Special.BeltW) ui.draw(ctx, 'belt', x, y, { frame: beltFrame(sp, s.reducedMotion ? 0 : anim) });
        else if (sp >= Special.PadA) ui.draw(ctx, 'pad', x, y, { frame: s.reducedMotion ? 0 : (anim >> 1) & 1 });
      }
    }
    // Blast lanes.
    if (s.lanes) {
      ctx.fillStyle = 'rgba(232,52,42,0.28)';
      for (let c = 0; c < CELLS; c += 1) if (s.lanes[c] === 1) ctx.fillRect((c % W) * 16 + ox, ((c / W) | 0) * 16 + by, 16, 16);
    }
    // Warnings, items, breaking blocks.
    for (let c = 0; c < CELLS; c += 1) {
      const x = (c % W) * 16 + ox;
      const y = ((c / W) | 0) * 16 + by;
      if ((w.warnEnd[c] as number) > R) ui.draw(ctx, 'warn', x, y, { frame: s.reducedMotion ? 0 : (Math.floor(s.nowMs / 150) & 1) });
      const it = w.items[c] as number;
      if (it > 0) ui.draw(ctx, 'item', x, y + (s.reducedMotion ? 0 : (Math.floor(s.nowMs / 300 + c) & 1)), { frame: it - 1 });
      const crumble = (w.crumbleEnd[c] as number) - s.roundTick;
      if (crumble > 0) ui.draw(ctx, 'crumble', x, y, { frame: crumble > 10 ? 0 : crumble > 5 ? 1 : 2 });
    }
    // Bombs, then the faint bomb of a press the server has not confirmed yet.
    for (let i = 0; i < w.bombCount; i += 1) {
      const b = w.bombs[i] as WBomb;
      const x = Math.round(b.x / 4) - 8 + ox;
      const y = Math.round(b.y / 4) - 8 + by;
      const left = b.fuseEnd === NO_END ? 999 : b.fuseEnd - s.roundTick;
      const rate = left < 30 ? 70 : 160;
      const pulse = s.reducedMotion ? 0 : Math.floor(s.nowMs / rate) % 3;
      ui.draw(ctx, 'bomb', x, y, { frame: pulse });
      if (left < 15 && !s.reducedMotion && (Math.floor(s.nowMs / 60) & 1)) {
        ctx.strokeStyle = 'rgba(232,52,42,0.9)';
        ctx.strokeRect(x + 1.5, y + 1.5, 13, 13);
      }
      if (b.fuseEnd === NO_END) {
        ctx.fillStyle = 'rgba(232,52,42,0.95)';
        ctx.fillRect(x + 7, y + 9, 2, 2);
      }
    }
    if (s.ghostBomb >= 0) {
      ctx.globalAlpha = 0.5;
      ui.draw(ctx, 'bomb', (s.ghostBomb % W) * 16 + ox, ((s.ghostBomb / W) | 0) * 16 + by, { frame: 0 });
      ctx.globalAlpha = 1;
    }
    // Flames.
    for (let c = 0; c < CELLS; c += 1) {
      const left = (w.flameEnd[c] as number) - s.roundTick;
      if (left <= 0) continue;
      const level = left > 10 ? 2 : left > 4 ? 1 : 0;
      ui.draw(ctx, 'flame', (c % W) * 16 + ox, ((c / W) | 0) * 16 + by, { frame: level * 7 + flameShape(w, c, R) });
    }
    // Fighters, back to front.
    let n = 0;
    for (let k = 0; k < w.fighters; k += 1) order[n++] = k;
    for (let i = 1; i < n; i += 1) {
      const k = order[i] as number;
      let j = i - 1;
      for (; j >= 0 && s.py[order[j] as number]! > s.py[k]!; j -= 1) order[j + 1] = order[j] as number;
      order[j + 1] = k;
    }
    for (let i = 0; i < n; i += 1) {
      const slot = order[i] as number;
      drawFighter(s, w.fight[slot] as WFighter, slot, ox, by);
    }
  };

  const drawHud = (s: DrawState): void => {
    const w = s.w;
    ctx.fillStyle = '#14141e';
    ctx.fillRect(0, 0, LOGICAL_W, HUD_H);
    const xs = [2, 50, 146, 194];
    for (let slot = 0; slot < w.fighters; slot += 1) {
      const f = w.fight[slot] as WFighter;
      const x = xs[slot] as number;
      ctx.fillStyle = slot === s.me ? '#3a3a52' : '#2a2a3a';
      ctx.fillRect(x, 2, 44, 12);
      wick.draw(ctx, 'face', x + 2, 4, { palette: f.alive && f.seat !== Seat.Ghost ? slot : PAL_GHOST });
      drawText(ctx, ui, DIGITS[w.scores[slot] ?? 0] ?? '?', x + 13, 5, SLOT_TEXT[slot] as number);
      if (f.alive) drawText(ctx, ui, STATS[(f.bombsMax & 15) | ((f.range & 15) << 4)] as string, x + 23, 5, UI.light);
      if (f.seat === Seat.Ghost) ui.draw(ctx, 'signal', x + 37, 4);
    }
    if (s.clockSeconds !== null) {
      const t = Math.max(0, Math.min(600, Math.ceil(s.clockSeconds)));
      const text = CLOCK[t] as string;
      const blink = s.closing && !s.reducedMotion && Math.floor(s.nowMs / 400) & 1;
      const color = s.closing ? (blink ? UI.yellow : UI.red) : UI.white;
      if (s.closing) ui.draw(ctx, 'clock', 104, 4);
      drawText(ctx, ui, text, 113, 5, color);
    }
  };

  const drawOverlays = (s: DrawState): void => {
    const w = s.w;
    const mid = HUD_H + 104;
    if (w.phase === Phase.Countdown || w.phase === Phase.Resuming) {
      const left = (w.phaseEnd - s.tick) / 30;
      const n = Math.ceil(left);
      if (n >= 1 && n <= 3) bigText(DIGITS[n] as string, UI.yellow, 120, mid, 5);
      if (w.phase === Phase.Countdown && left > 2.2) centreText('Round ' + (w.round + 1), UI.white, mid - 34);
    } else if (w.phase === Phase.Playing && s.playTicks < 24) {
      bigText('GO!', UI.yellow, 120, mid, 4);
    } else if (w.phase === Phase.RoundEnd || w.phase === Phase.MatchEnd) {
      panel(40, mid - 26, 160, 52);
      const who = w.winner >= 0 ? WICK_NAMES[w.winner] + ' wins' : 'Draw';
      const name = w.winner >= 0 ? fontSafe(s.names[w.winner] ?? '', 24) : '';
      bigText(who, w.winner >= 0 ? (SLOT_TEXT[w.winner] as number) : UI.light, 120, mid - 12, 2);
      if (name) centreText(name, UI.light, mid + 2);
      centreText(w.phase === Phase.MatchEnd ? 'Match over' : 'Round ' + (w.round + 1), UI.grey, mid + 12);
    } else if (w.phase === Phase.Frozen) {
      panel(20, mid - 14, 200, 28);
      centreText(s.waitingFor ? 'Waiting for ' + s.waitingFor : 'Waiting for players', UI.white, mid - 8);
      if (s.holdSeconds !== null) centreText(DIGITS[Math.max(0, Math.min(99, Math.ceil(s.holdSeconds)))] as string, UI.yellow, mid + 2);
    }
  };

  return {
    draw(s) {
      const w = s.w;
      ctx.fillStyle = '#0b0b12';
      ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
      if (!w.ready) {
        centreText('Loading the yard...', UI.light, 110);
        return;
      }
      refreshLayer(w);
      const shake = s.shake > 0 && !s.reducedMotion ? (s.shake & 1 ? 1 : -1) : 0;
      drawBoard(s, shake, 0);
      drawHud(s);
      drawOverlays(s);
    },
    invalidate() {
      allDirty = true;
    },
    dispose() {
      layer.width = layer.height = 0;
      big.width = big.height = 0;
      for (const t of tiles) t.length = 0;
    },
  };
};
