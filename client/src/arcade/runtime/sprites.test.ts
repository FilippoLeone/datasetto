import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADVANCE, FONT_ID, GLYPH_H, GLYPH_W, LINE, drawText, fontGlyphs, textWidth } from './font';
import {
  CLEAR,
  PIXEL_CHARS,
  bakeAtlas,
  parsePixelRows,
  type Palette,
  type SpriteSheet,
} from './sprites';

// jsdom has no 2D canvas: a fake context that records what the atlas does with it.
interface FakeImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

class Fake2D {
  puts: { img: FakeImageData; x: number; y: number }[] = [];
  draws: unknown[][] = [];
  ops: string[] = [];
  createImageData(width: number, height: number): FakeImageData {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
  }
  putImageData(img: FakeImageData, x: number, y: number): void {
    this.puts.push({ img, x, y });
  }
  drawImage(...args: unknown[]): void {
    this.draws.push(args);
    this.ops.push('drawImage');
  }
  save(): void {
    this.ops.push('save');
  }
  restore(): void {
    this.ops.push('restore');
  }
  scale(x: number, y: number): void {
    this.ops.push(`scale(${x},${y})`);
  }
}

interface FakeBitmap {
  width: number;
  height: number;
  close: ReturnType<typeof vi.fn>;
}

let baked: Fake2D[];
let canvases: HTMLCanvasElement[];
let bitmaps: FakeBitmap[];

const pal = (k: number): Palette =>
  Array.from(
    { length: 36 },
    (_, i) => (((i * 7 + k) & 255) << 16) | (((i * 13 + k) & 255) << 8) | ((i * 29 + k) & 255)
  );
// Every entry is an opaque colour, the first one (black) included.
const UI: Palette = [0x000000, 0xffffff, 0x101010, 0xff8800];
const PALS: readonly Palette[] = [UI, pal(1), pal(2)];

const hero: SpriteSheet = {
  id: 'hero',
  w: 4,
  h: 3,
  frames: [
    ['.12.', '3ab ', 'z..9'],
    ['1111', '#0..', '2222'],
  ],
};
const tile: SpriteSheet = {
  id: 'tile',
  w: 8,
  h: 8,
  frames: [Array.from({ length: 8 }, () => '12121212')],
};
const wide: SpriteSheet = { id: 'wide', w: 70, h: 2, frames: [['5'.repeat(70), '.'.repeat(70)]] };

const target = (): [Fake2D, CanvasRenderingContext2D] => {
  const f = new Fake2D();
  return [f, f as unknown as CanvasRenderingContext2D];
};

/** RGBA of the baked atlas at (x, y). */
const pixel = (x: number, y: number): number[] => {
  const { img } = baked[0].puts[0];
  const o = (y * img.width + x) * 4;
  return Array.from(img.data.subarray(o, o + 4));
};
const rgba = (c: number): number[] => [(c >> 16) & 255, (c >> 8) & 255, c & 255, 255];

beforeEach(() => {
  baked = [];
  canvases = [];
  bitmaps = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement
  ) {
    const f = new Fake2D();
    baked.push(f);
    canvases.push(this);
    return f;
  } as never);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async (c: HTMLCanvasElement) => {
      const b = { width: c.width, height: c.height, close: vi.fn() };
      bitmaps.push(b);
      return b;
    })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('parsePixelRows', () => {
  it('maps pixel chars to palette indices and anything else to transparent', () => {
    const C = CLEAR;
    expect(Array.from(parsePixelRows(['.1 9', 'az0Z', '#-x!']))).toEqual([
      C,
      1,
      C,
      9,
      10,
      35,
      0,
      C,
      C,
      C,
      33,
      C,
    ]);
    expect(PIXEL_CHARS).toHaveLength(36);
    expect(Array.from(parsePixelRows([PIXEL_CHARS]))).toEqual(
      Array.from({ length: 36 }, (_, i) => i)
    );
  });
});

describe('bakeAtlas', () => {
  it('rejects bad sheets by id', async () => {
    const short: SpriteSheet = { id: 'short', w: 2, h: 2, frames: [['11']] };
    const ragged: SpriteSheet = { id: 'ragged', w: 2, h: 2, frames: [['11', '1']] };
    await expect(bakeAtlas([short], PALS)).rejects.toThrow(/"short".*1 rows, expected 2/);
    await expect(bakeAtlas([ragged], PALS)).rejects.toThrow(
      /"ragged".*row 1 is 1 wide, expected 2/
    );
    await expect(bakeAtlas([{ ...hero, w: 0 }], PALS)).rejects.toThrow(/"hero"/);
    await expect(bakeAtlas([hero, hero], PALS)).rejects.toThrow(/"hero": duplicate/);
    await expect(bakeAtlas([{ ...hero, id: FONT_ID }], PALS)).rejects.toThrow(/duplicate/);
    await expect(bakeAtlas([hero], [])).rejects.toThrow(/palettes\[0\]/);
  });

  it('gives every frame of every sheet, palette and font colour its own rect inside the image', async () => {
    const atlas = await bakeAtlas([hero, tile, wide], PALS);
    const { img } = baked[0].puts[0];
    const all: { x: number; y: number; w: number; h: number }[] = [];
    for (const s of [hero, tile, wide]) {
      for (let p = 0; p < PALS.length; p++) {
        s.frames.forEach((_, f) => {
          const r = atlas.rect(s.id, f, p);
          expect(r).toMatchObject({ w: s.w, h: s.h });
          all.push(r!);
        });
      }
    }
    for (let g = 0; g < 95; g++) {
      for (let c = 0; c < UI.length; c++) {
        const r = atlas.rect(FONT_ID, g, c);
        expect(r).toMatchObject({ w: GLYPH_W, h: GLYPH_H });
        all.push(r!);
      }
    }
    expect(all).toHaveLength((2 + 1 + 1) * 3 + 95 * 4);
    for (const r of all) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(img.width);
      expect(r.y + r.h).toBeLessThanOrEqual(img.height);
    }
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i];
        const b = all[j];
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        if (overlap) throw new Error(`rects ${i} and ${j} overlap`);
      }
    }
    expect(atlas.palettes).toBe(3);
    expect(atlas.rect('hero', 2)).toBeNull();
    expect(atlas.rect('hero', -1)).toBeNull();
    expect(atlas.rect('hero', 0.5)).toBeNull();
    expect(atlas.rect('hero', 0, 3)).toBeNull();
    expect(atlas.rect('nope')).toBeNull();
    expect(atlas.rect(FONT_ID, 0, -1)).toBeNull();
    expect(atlas.rect(FONT_ID, 95, 0)).toBeNull();
    expect(atlas.rect(FONT_ID, 0, UI.length)).toBeNull();
    expect(atlas.rect('hero')).toBe(atlas.rect('hero', 0, 0)); // cached: no allocation per draw
  });

  it('bakes each sheet once per palette with one ImageData write', async () => {
    const atlas = await bakeAtlas([hero, tile], PALS);
    expect(baked).toHaveLength(1);
    expect(baked[0].puts).toHaveLength(1);
    for (let p = 0; p < PALS.length; p++) {
      hero.frames.forEach((rows, f) => {
        const r = atlas.rect('hero', f, p)!;
        const idx = parsePixelRows(rows);
        for (let i = 0; i < idx.length; i++) {
          const k = idx[i];
          const got = pixel(r.x + (i % hero.w), r.y + Math.floor(i / hero.w));
          // UI has 4 entries: indices past its end are transparent too.
          if (k === CLEAR || k >= PALS[p].length) expect(got[3]).toBe(0);
          else expect(got).toEqual(rgba(PALS[p][k]));
        }
      });
    }
    // '0' is a real colour now: hero frame 1, row 1, column 1.
    const zero = atlas.rect('hero', 1, 0)!;
    expect(pixel(zero.x + 1, zero.y + 1)).toEqual([0, 0, 0, 255]);
    expect(pixel(zero.x, zero.y + 1)[3]).toBe(0); // the unknown '#'
    const t = atlas.rect('tile', 0, 2)!;
    expect(pixel(t.x, t.y)).toEqual(rgba(PALS[2][1]));
    expect(pixel(t.x + 1, t.y)).toEqual(rgba(PALS[2][2]));
  });

  it('bakes the font in every colour of the UI palette', async () => {
    const atlas = await bakeAtlas([], PALS);
    const A = fontGlyphs()['A'.charCodeAt(0) - 32];
    for (let c = 0; c < UI.length; c++) {
      const r = atlas.rect(FONT_ID, 'A'.charCodeAt(0) - 32, c)!;
      for (let i = 0; i < A.length; i++) {
        const got = pixel(r.x + (i % GLYPH_W), r.y + Math.floor(i / GLYPH_W));
        if (A[i]) expect(got).toEqual(rgba(UI[c]));
        else expect(got[3]).toBe(0);
      }
    }
  });

  it('hands out one ImageBitmap and frees the canvas', async () => {
    const atlas = await bakeAtlas([hero], PALS);
    expect(bitmaps).toHaveLength(1);
    expect(atlas.image).toBe(bitmaps[0]);
    expect(bitmaps[0].width).toBeGreaterThan(0);
    expect(canvases).toHaveLength(1);
    expect([canvases[0].width, canvases[0].height]).toEqual([0, 0]);
    atlas.dispose();
    expect(bitmaps[0].close).toHaveBeenCalledTimes(1);
    const [f, ctx] = target();
    atlas.draw(ctx, 'hero', 0, 0);
    drawText(ctx, atlas, 'HI', 0, 0, 1);
    expect(f.draws).toHaveLength(0);
  });

  it('keeps the canvas where createImageBitmap is missing', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    const atlas = await bakeAtlas([hero], PALS);
    expect(atlas.image).toBeInstanceOf(HTMLCanvasElement);
    const canvas = atlas.image as HTMLCanvasElement;
    expect(canvas.width).toBeGreaterThan(0);
    atlas.dispose();
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
  });
});

describe('Atlas.draw', () => {
  it('draws the source rect at (x, y), and mirrors in place with flipX', async () => {
    const atlas = await bakeAtlas([hero], PALS);
    const [f, ctx] = target();
    const r = atlas.rect('hero', 1, 2)!;
    atlas.draw(ctx, 'hero', 10, 20, { frame: 1, palette: 2 });
    expect(f.draws[0]).toEqual([atlas.image, r.x, r.y, 4, 3, 10, 20, 4, 3]);
    expect(f.ops).toEqual(['drawImage']);

    f.ops = [];
    atlas.draw(ctx, 'hero', 10, 20, { frame: 1, palette: 2, flipX: true });
    expect(f.ops).toEqual(['save', 'scale(-1,1)', 'drawImage', 'restore']);
    // Under scale(-1, 1) the sprite lands on x ∈ [10, 14) again.
    expect(f.draws[1]).toEqual([atlas.image, r.x, r.y, 4, 3, -14, 20, 4, 3]);

    atlas.draw(ctx, 'missing', 0, 0);
    atlas.draw(ctx, 'hero', 0, 0, { frame: 9 });
    expect(f.draws).toHaveLength(2);
  });
});

describe('font', () => {
  it('has 95 distinct glyphs, all inked except the space', () => {
    const g = fontGlyphs();
    expect(g).toHaveLength(95);
    expect(g[0].every((v) => v === 0)).toBe(true);
    const keys = new Set<string>();
    for (let i = 1; i < 95; i++) {
      expect(g[i]).toHaveLength(GLYPH_W * GLYPH_H);
      expect(g[i].some((v) => v === 1)).toBe(true);
      keys.add(g[i].join(''));
    }
    expect(keys.size).toBe(94);
  });

  it('drawText draws one image per visible character, 6 px apart, 8 px per line', async () => {
    const atlas = await bakeAtlas([], PALS);
    const [f, ctx] = target();
    drawText(ctx, atlas, 'Hi !\nA€', 3, 4, 2);
    const src = (ch: string) => {
      const r = atlas.rect(FONT_ID, ch.charCodeAt(0) - 32, 2)!;
      return [r.x, r.y, r.w, r.h];
    };
    expect(f.draws).toEqual([
      [atlas.image, ...src('H'), 3, 4, 5, 7],
      [atlas.image, ...src('i'), 3 + ADVANCE, 4, 5, 7],
      [atlas.image, ...src('!'), 3 + 3 * ADVANCE, 4, 5, 7],
      [atlas.image, ...src('A'), 3, 4 + LINE, 5, 7],
      [atlas.image, ...src('?'), 3 + ADVANCE, 4 + LINE, 5, 7], // unknown characters draw '?'
    ]);
    f.draws = [];
    drawText(ctx, atlas, 'AB', 0, 0, 0); // colour 0 is a colour like any other
    expect(f.draws).toHaveLength(2);
    expect(f.draws[0].slice(1, 5)).toEqual(Object.values(atlas.rect(FONT_ID, 33, 0)!));
    f.draws = [];
    drawText(ctx, atlas, 'AB', 0, 0, UI.length); // past the UI palette
    drawText(ctx, atlas, 'AB', 0, 0, -1);
    expect(f.draws).toHaveLength(0);
  });

  it('textWidth measures the longest line without a trailing gap', () => {
    expect(textWidth('')).toBe(0);
    expect(textWidth('A')).toBe(5);
    expect(textWidth('abc')).toBe(17);
    expect(textWidth('ab\nlonger')).toBe(35);
    expect(textWidth('wide line\nx')).toBe(53);
    expect(textWidth('\n\n')).toBe(0);
    expect(textWidth('a\u{1f600}')).toBe(11);
  });
});
