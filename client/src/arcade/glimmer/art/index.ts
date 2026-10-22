/**
 * Glimmerhall's art at run time (glimmerhall.md §16): each machine's 24 × 24 symbol grids are baked
 * once, at first open, into one atlas per machine with two palettes (normal and lit, +25 % value,
 * for win highlights), plus a spin variant per symbol averaged from four vertical offsets. The
 * cabinet is drawn from a few flat colours per machine.
 */
import type { MachineIdx } from '@arcade/core/glimmer/machines';
import { bakeAtlas, type Atlas } from '@/arcade/runtime/sprites';
import { PALETTE as EMBER, SYMBOLS as EMBER_SYMBOLS } from './embervault';
import { PALETTE as ORCHARD, SYMBOLS as ORCHARD_SYMBOLS } from './orchard';
import { PALETTE as TIDE, SYMBOLS as TIDE_SYMBOLS } from './tidepool';
import { UI_PALETTE, UI_SPRITES, type UiSprite } from './ui';

export const SYM = 24;

export interface Cabinet {
  /** Outer frame, its light edge, its dark edge. */
  frame: number;
  light: number;
  dark: number;
  /** Behind the symbols. */
  reel: number;
  /** Between reels. */
  gap: number;
  /** Win lines and highlight boxes. */
  line: number;
  /** Palette index of the canvas text colour (the 5 × 7 font). */
  ink: number;
  /** CSS accent for the hall chrome. */
  accent: string;
}

export const CABINETS: readonly Cabinet[] = [
  { frame: 0x6a4428, light: 0xa8743e, dark: 0x3a2414, reel: 0xf6ead0, gap: 0x4a2e1a, line: 0xd0402a, ink: 10, accent: '#e8a23a' },
  { frame: 0x145a66, light: 0x3fa6a6, dark: 0x0a2a34, reel: 0xdff4f0, gap: 0x0c3a46, line: 0xff9a2a, ink: 10, accent: '#4fd0c8' },
  { frame: 0x3a3230, light: 0x6a5e58, dark: 0x161010, reel: 0x262020, gap: 0x120c0c, line: 0xffa030, ink: 7, accent: '#ff8a3a' },
];

const ART: readonly { palette: readonly number[]; symbols: readonly (readonly string[])[] }[] = [
  { palette: ORCHARD, symbols: ORCHARD_SYMBOLS },
  { palette: TIDE, symbols: TIDE_SYMBOLS },
  { palette: EMBER, symbols: EMBER_SYMBOLS },
];

/** +25 % value in HSV, per channel scaled to keep the hue. */
export const lighten = (c: number): number => {
  const r = (c >> 16) & 255;
  const g = (c >> 8) & 255;
  const b = c & 255;
  const max = Math.max(r, g, b, 1);
  const k = Math.min(1.25, 255 / max);
  return (Math.round(r * k) << 16) | (Math.round(g * k) << 8) | Math.round(b * k);
};

export interface MachineArt {
  atlas: Atlas;
  /** The spin variant of every symbol, side by side (24 px each). */
  blur: HTMLCanvasElement;
  palette: readonly number[];
  dispose(): void;
}

/** Bakes one machine's atlas and spin variants (about a millisecond each on a desktop). */
export const bakeMachine = async (m: MachineIdx): Promise<MachineArt> => {
  const art = ART[m] as (typeof ART)[number];
  const palette = art.palette;
  const atlas = await bakeAtlas([{ id: 's', w: SYM, h: SYM, frames: art.symbols }], [palette, palette.map(lighten)]);
  const blur = document.createElement('canvas');
  blur.width = SYM * art.symbols.length;
  blur.height = SYM;
  const ctx = blur.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingEnabled = false;
    for (let s = 0; s < art.symbols.length; s += 1) {
      const r = atlas.rect('s', s, 0);
      if (!r) continue;
      for (const dy of [-5, -2, 2, 5]) {
        ctx.globalAlpha = 0.28;
        ctx.drawImage(atlas.image, r.x, r.y, r.w, r.h, s * SYM, dy, SYM, SYM);
      }
    }
    ctx.globalAlpha = 1;
  }
  return {
    atlas,
    blur,
    palette,
    dispose() {
      atlas.dispose();
      blur.width = blur.height = 0;
    },
  };
};

const hex = (c: number): string => '#' + c.toString(16).padStart(6, '0');

/**
 * One UI sprite (or a machine symbol) as a data URL at `scale`, for the DOM chrome (emotes, the coin,
 * the leaf, paytable icons). Cached per page.
 */
const urls = new Map<string, string>();
const gridUrl = (key: string, rows: readonly string[], palette: readonly number[], scale: number): string => {
  const cached = urls.get(key);
  if (cached) return cached;
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const c = document.createElement('canvas');
  c.width = w * scale;
  c.height = h * scale;
  const ctx = c.getContext('2d');
  let url = '';
  if (ctx) {
    for (let y = 0; y < h; y += 1) {
      const row = rows[y] as string;
      for (let x = 0; x < w; x += 1) {
        const ch = row.charCodeAt(x);
        const i = ch > 47 && ch < 58 ? ch - 48 : ch > 96 && ch < 123 ? ch - 87 : -1;
        if (i < 0 || i >= palette.length) continue;
        ctx.fillStyle = hex(palette[i] as number);
        ctx.fillRect(x * scale, y * scale, scale, scale);
      }
    }
    try {
      url = c.toDataURL('image/png');
    } catch {
      url = '';
    }
  }
  c.width = c.height = 0;
  urls.set(key, url);
  return url;
};

export const uiSpriteUrl = (id: UiSprite, scale = 3): string => gridUrl('ui:' + id + ':' + scale, UI_SPRITES[id], UI_PALETTE, scale);

export const symbolUrl = (m: MachineIdx, sym: number, scale = 2): string => {
  const art = ART[m] as (typeof ART)[number];
  return gridUrl('s:' + m + ':' + sym + ':' + scale, art.symbols[sym] ?? [], art.palette, scale);
};

export const cssColor = hex;
