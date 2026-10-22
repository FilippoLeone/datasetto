/**
 * Palette-indexed sprites (docs/arcade/platform.md §10.5): text grids rasterized once, per palette,
 * into one atlas `ImageBitmap` per game. The 5 × 7 font (font.ts) is always baked in as well.
 *
 * Each frame is `h` strings of `w` pixel chars: '.' or ' ' is transparent, '0'–'9' are palette
 * indices 0–9 and 'a'–'z' are 10–35 (`PIXEL_CHARS[i]` is the char for index i). Every palette
 * index is an opaque colour; an index past the end of a palette, or an unknown char, is
 * transparent. Every sheet is baked in every palette; palette swaps (team colours, tunics, ghosts)
 * cost no extra frames in the source.
 */
import { FONT_ID, GLYPH_H, GLYPH_W, fontGlyphs } from './font';

/** 0xRRGGBB per index, every one opaque ('.' and ' ' are the transparent pixels). */
export type Palette = readonly number[];

export interface SpriteSheet {
  id: string;
  w: number;
  h: number;
  /** Each frame: `h` strings of `w` pixel chars. */
  frames: readonly (readonly string[])[];
}

/** The pixel char for each palette index; '.' and ' ' are transparent. */
export const PIXEL_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

/** What `parsePixelRows` returns for a transparent pixel ('.', ' ' or an unknown char). */
export const CLEAR = 255;

export interface Atlas {
  /** One ImageBitmap, or the canvas where createImageBitmap is missing. */
  readonly image: CanvasImageSource;
  readonly palettes: number;
  /** Source rect of a frame in a palette (for the font: glyph, colour index); null when out of range. */
  rect(
    id: string,
    frame?: number,
    palette?: number
  ): { x: number; y: number; w: number; h: number } | null;
  /** Draws a frame with its top-left corner at (x, y); `flipX` mirrors it in place. */
  draw(
    ctx: CanvasRenderingContext2D,
    id: string,
    x: number,
    y: number,
    o?: { frame?: number; palette?: number; flipX?: boolean }
  ): void;
  /** Closes the ImageBitmap and frees the canvas (0 × 0); draw is a no-op afterwards. */
  dispose(): void;
}

type Rect = { x: number; y: number; w: number; h: number };

interface Entry {
  w: number;
  h: number;
  frames: readonly Uint8Array[];
  /** One variant per palette (the font: one per UI colour). */
  pals: readonly Palette[];
  /** Index of the entry's first rect. */
  base: number;
}

/** Transparent gutter between frames, so scaled or sub-pixel draws never bleed a neighbour in. */
const PAD = 1;

/** Pixel chars → palette indices, row after row; transparent pixels are `CLEAR`. */
export function parsePixelRows(rows: readonly string[]): Uint8Array {
  const s = rows.join('');
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c > 47 && c < 58 ? c - 48 : c > 96 && c < 123 ? c - 87 : CLEAR;
  }
  return out;
}

export async function bakeAtlas(
  sheets: readonly SpriteSheet[],
  palettes: readonly Palette[]
): Promise<Atlas> {
  if (!palettes.length) throw new Error('bakeAtlas: palettes[0] (the UI palette) is required');
  const entries = new Map<string, Entry>();
  const add = (id: string, e: Entry): void => {
    if (entries.has(id)) throw new Error(`sprite sheet "${id}": duplicate id`);
    entries.set(id, e);
  };
  for (const s of sheets) {
    const bad = (why: string): Error => new Error(`sprite sheet "${s.id}": ${why}`);
    if (!(Number.isInteger(s.w) && Number.isInteger(s.h) && s.w > 0 && s.h > 0)) {
      throw bad(`bad size ${s.w} × ${s.h}`);
    }
    const frames = s.frames.map((rows, f) => {
      if (rows.length !== s.h) throw bad(`frame ${f} has ${rows.length} rows, expected ${s.h}`);
      rows.forEach((r, y) => {
        if (r.length !== s.w) throw bad(`frame ${f} row ${y} is ${r.length} wide, expected ${s.w}`);
      });
      return parsePixelRows(rows);
    });
    add(s.id, { w: s.w, h: s.h, frames, pals: palettes, base: 0 });
  }
  // The font: ink is index 0 of a one-colour palette per UI colour, so variant c draws colour c.
  add(FONT_ID, {
    w: GLYPH_W,
    h: GLYPH_H,
    frames: fontGlyphs().map((g) => g.map((v) => (v ? 0 : CLEAR))),
    pals: palettes[0].map((c) => [c]),
    base: 0,
  });

  // Shelf packing, tallest entries first, into a power-of-two-wide atlas about as tall as it is wide.
  const list = [...entries.values()];
  let area = 0;
  let W = 64;
  for (const e of list) {
    area += e.frames.length * e.pals.length * (e.w + PAD) * (e.h + PAD);
    while (W < e.w) W *= 2;
  }
  while (W * W < area) W *= 2;
  const rects: Rect[] = [];
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const e of list.sort((a, b) => b.h - a.h)) {
    e.base = rects.length;
    for (let n = e.frames.length * e.pals.length; n > 0; n--) {
      if (x + e.w > W) {
        x = 0;
        y += shelf + PAD;
        shelf = 0;
      }
      rects.push(Object.freeze({ x, y, w: e.w, h: e.h }));
      x += e.w + PAD;
      if (e.h > shelf) shelf = e.h;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = Math.max(1, y + shelf);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('bakeAtlas: no 2D canvas');
  const img = ctx.createImageData(canvas.width, canvas.height);
  const d = img.data;
  for (const e of list) {
    e.pals.forEach((pal, v) =>
      e.frames.forEach((px, f) => {
        const r = rects[e.base + v * e.frames.length + f];
        for (let i = 0; i < px.length; i++) {
          const k = px[i];
          const c = pal[k];
          if (k === CLEAR || c === undefined) continue;
          const o = ((r.y + ((i / e.w) | 0)) * W + r.x + (i % e.w)) * 4;
          // Uint8ClampedArray clamps instead of wrapping: mask every channel.
          d[o] = (c >> 16) & 255;
          d[o + 1] = (c >> 8) & 255;
          d[o + 2] = c & 255;
          d[o + 3] = 255;
        }
      })
    );
  }
  ctx.putImageData(img, 0, 0);

  let image: CanvasImageSource = canvas;
  let bitmap: ImageBitmap | null = null;
  if (typeof createImageBitmap === 'function') {
    try {
      image = bitmap = await createImageBitmap(canvas);
      canvas.width = canvas.height = 0;
    } catch {
      // Keep drawing from the canvas.
    }
  }

  const rect = (id: string, frame = 0, palette = 0): Rect | null => {
    const e = entries.get(id);
    if (!e || frame < 0 || frame >= e.frames.length || palette < 0 || palette >= e.pals.length) {
      return null;
    }
    return rects[e.base + palette * e.frames.length + frame] ?? null;
  };

  return {
    image,
    palettes: palettes.length,
    rect,
    draw(c, id, dx, dy, o) {
      const r = rect(id, o?.frame, o?.palette);
      if (!r) return;
      if (o?.flipX) {
        c.save();
        c.scale(-1, 1);
        c.drawImage(image, r.x, r.y, r.w, r.h, -dx - r.w, dy, r.w, r.h);
        c.restore();
      } else {
        c.drawImage(image, r.x, r.y, r.w, r.h, dx, dy, r.w, r.h);
      }
    },
    dispose() {
      entries.clear();
      bitmap?.close();
      bitmap = null;
      canvas.width = canvas.height = 0;
    },
  };
}
