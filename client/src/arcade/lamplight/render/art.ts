/**
 * Lamplight's art (lamplight.md §15), drawn in code for this project: 22 × 31 card faces built from
 * 5 × 7 rank and 7 × 7 suit bitmaps, a mirrored lantern card back, a seeded felt tile, symmetric
 * 8 × 8 "lantern spirit" avatars and striped chips. The 52 faces and the back are baked once per deck
 * palette (four-colour by default, two-colour as a palette swap) into one atlas with the 5 × 7 font.
 */
import { bakeAtlas, PIXEL_CHARS, type Atlas, type Palette } from '../../runtime/sprites';

export const CARD_W = 22;
export const CARD_H = 31;
export const BACK = 52;

/** Palette indices (palettes[0] is also the text colour table for drawText). */
export const C = {
  cream: 0,
  ink: 1,
  red: 2,
  blue: 3,
  green: 4,
  edge: 5,
  backDark: 6,
  brass: 7,
  amber: 8,
  felt: 9,
  white: 10,
  grey: 11,
  dark: 12,
  glow: 13,
} as const;

const FOUR: Palette = [0xf4ead5, 0x1b1b24, 0xc8323c, 0x2f6bd0, 0x2e8b4e, 0xc9b98f, 0x16302e, 0xb08d57, 0xf2b84b, 0x1f4d4a, 0xffffff, 0x9aa3a0, 0x0e1514, 0xffe7a3];
/** Two-colour deck: diamonds red, clubs ink. */
const TWO: Palette = FOUR.map((c, i) => (i === C.blue ? FOUR[C.red] : i === C.green ? FOUR[C.ink] : c));

export const PALETTE = FOUR;
export const css = (i: number): string => '#' + (FOUR[i] ?? 0).toString(16).padStart(6, '0');

const RANK_ROWS: readonly string[][] = [
  ['.###.', '#...#', '....#', '..##.', '.#...', '#....', '#####'],
  ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  ['#..#.', '#.#.#', '#.#.#', '#.#.#', '#.#.#', '#.#.#', '#..#.'],
  ['..###', '...#.', '...#.', '...#.', '#..#.', '#..#.', '.##..'],
  ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
];

/** Clubs, diamonds, hearts, spades (the card order of `suit = c & 3`). */
const SUIT_ROWS: readonly string[][] = [
  ['..###..', '..###..', '##.#.##', '#######', '##.#.##', '...#...', '.#####.'],
  ['...#...', '..###..', '.#####.', '#######', '.#####.', '..###..', '...#...'],
  ['.##.##.', '#######', '#######', '#######', '.#####.', '..###..', '...#...'],
  ['...#...', '..###..', '.#####.', '#######', '#######', '...#...', '..###..'],
];
const SUIT_COLOUR = [C.green, C.blue, C.red, C.ink];

type Grid = number[][];
const grid = (w: number, h: number, fill: number): Grid => Array.from({ length: h }, () => new Array<number>(w).fill(fill));
const stamp = (g: Grid, rows: readonly string[], x: number, y: number, colour: number, scale = 1): void => {
  rows.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      if (row[rx] !== '#') continue;
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) if (g[y + ry * scale + sy]?.[x + rx * scale + sx] !== undefined) g[y + ry * scale + sy][x + rx * scale + sx] = colour;
    }
  });
};
const toRows = (g: Grid): string[] => g.map((row) => row.map((v) => (v < 0 ? '.' : PIXEL_CHARS[v])).join(''));

const frame = (g: Grid, edge: number): void => {
  const w = g[0].length;
  const h = g.length;
  for (let x = 1; x < w - 1; x++) {
    g[0][x] = edge;
    g[h - 1][x] = edge;
  }
  for (let y = 1; y < h - 1; y++) {
    g[y][0] = edge;
    g[y][w - 1] = edge;
  }
  g[0][0] = g[0][w - 1] = g[h - 1][0] = g[h - 1][w - 1] = -1;
};

const face = (card: number): string[] => {
  const g = grid(CARD_W, CARD_H, C.cream);
  frame(g, C.edge);
  const colour = SUIT_COLOUR[card & 3];
  stamp(g, RANK_ROWS[card >> 2], 2, 2, colour);
  stamp(g, SUIT_ROWS[card & 3], 2, 10, colour);
  stamp(g, SUIT_ROWS[card & 3], 7, 15, colour, 2);
  return toRows(g);
};

/** The back: brass border, a lattice, and a lantern mirrored about the middle. */
const back = (): string[] => {
  const g = grid(CARD_W, CARD_H, C.backDark);
  frame(g, C.brass);
  for (let y = 2; y < CARD_H - 2; y++) for (let x = 2; x < CARD_W - 2; x++) if ((x + y) % 4 === 0 || (x - y + 64) % 4 === 0) g[y][x] = C.felt;
  for (let x = 2; x < CARD_W - 2; x++) {
    g[2][x] = C.brass;
    g[CARD_H - 3][x] = C.brass;
  }
  for (let y = 2; y < CARD_H - 2; y++) {
    g[y][2] = C.brass;
    g[y][CARD_W - 3] = C.brass;
  }
  const lantern = ['...###...', '..#...#..', '.#######.', '.#.###.#.', '.#.#8#.#.', '.#.888.#.', '.#.#8#.#.', '.#.###.#.', '.#######.', '...###...'];
  const top = 10;
  const left = Math.floor((CARD_W - 9) / 2);
  lantern.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      const ch = row[rx];
      if (ch === '.') continue;
      const v = ch === '8' ? C.amber : C.brass;
      g[top + ry][left + rx] = v;
      // Mirrored copy below the middle, upside down.
      g[CARD_H - 1 - top - ry][left + rx] = ch === '8' ? C.glow : v;
    }
  });
  return toRows(g);
};

/** The six emotes, 8 × 8: a amber, k ink, r red, b blue, '.' clear. */
export const EMOTES: readonly (readonly string[])[] = [
  ['..aaaa..', '.aaaaaa.', 'aakaakaa', 'aaaaaaaa', 'akaaaaka', 'aakkkkaa', '.aaaaaa.', '..aaaa..'],
  ['..aaaa..', '.aaaaaa.', 'akkaakka', 'aaaaaaaa', 'akkkkkka', 'aakrrkaa', '.aakkaa.', '..aaaa..'],
  ['..aaaa..', '.aaaaaa.', 'aakaakaa', 'aakaakaa', 'aaaaaaaa', 'aaakkaaa', '.aakkaa.', '..aaaa..'],
  ['..aaaa.b', '.aaaaabb', 'aakaakbb', 'aaaaaaaa', 'aaaaaaaa', 'aakkkkaa', '.aaaaaa.', '..aaaa..'],
  ['...a....', '...aa...', '...aa...', 'aaaaaaa.', 'kaaaaaa.', 'kaaaaaa.', 'kaaaaaa.', '.aaaaa..'],
  ['..kkkk..', '.k....k.', 'kkkkkkkk', '.kaaaak.', '.kaaaak.', '.kaaaak.', 'kkkkkkkk', '..kkkk..'],
];
export const EMOTE_NAMES = ['Smile', 'Laugh', 'Wow', 'Phew', 'Nice hand', 'Good luck'] as const;
const EMOTE_COLOURS: Readonly<Record<string, string>> = { a: '#f2b84b', k: '#1b1b24', r: '#c8323c', b: '#4ea1ff' };

/** Draw emote `id` into `ctx` at (x, y), `px` CSS px per pixel. */
export const drawEmote = (ctx: CanvasRenderingContext2D, id: number, x: number, y: number, px: number): void => {
  const rows = EMOTES[id];
  if (!rows) return;
  rows.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      const c = EMOTE_COLOURS[row[rx]];
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(x + rx * px, y + ry * px, px, px);
    }
  });
};

export interface Art {
  atlas: Atlas;
  /** Draws a card (or the back) at (x, y) with `scale` CSS px per art pixel. */
  card(ctx: CanvasRenderingContext2D, card: number, x: number, y: number, scale: number, deck: 0 | 1): void;
  felt: HTMLCanvasElement;
  avatar(seed: number): HTMLCanvasElement;
  dispose(): void;
}

/** A 64 × 64 seeded value-noise felt tile. */
const feltTile = (): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const img = ctx.createImageData(64, 64);
  let s = 0x1f4d4a;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  const lattice = Array.from({ length: 9 }, () => Array.from({ length: 9 }, rnd));
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const gx = x / 8;
      const gy = y / 8;
      const x0 = Math.floor(gx) % 8;
      const y0 = Math.floor(gy) % 8;
      const fx = gx - Math.floor(gx);
      const fy = gy - Math.floor(gy);
      const a = lattice[y0][x0];
      const b = lattice[y0][(x0 + 1) % 8];
      const cc = lattice[(y0 + 1) % 8][x0];
      const d = lattice[(y0 + 1) % 8][(x0 + 1) % 8];
      const v = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy;
      const shade = Math.round((v - 0.5) * 14 + (rnd() - 0.5) * 6);
      const o = (y * 64 + x) * 4;
      img.data[o] = 0x1f + shade;
      img.data[o + 1] = 0x4d + shade;
      img.data[o + 2] = 0x4a + shade;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
};

/** A symmetric 8 × 8 lantern spirit coloured from a hash. */
const spirit = (seed: number): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.width = c.height = 8;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  let s = seed >>> 0 || 7;
  const bit = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) & 1;
  };
  const hue = (seed >>> 3) % 360;
  const body = 'hsl(' + hue + ',62%,62%)';
  const deep = 'hsl(' + hue + ',55%,38%)';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 4; x++) {
      // A rounded body with a random edge; the eyes are fixed.
      const inside = y >= 1 && y <= 6 && x >= (y === 1 || y === 6 ? 2 : 1);
      const on = inside || (y === 0 && x === 3) || (y === 7 && x >= 1 && bit() === 1);
      if (!on) continue;
      ctx.fillStyle = y >= 5 && bit() === 1 ? deep : body;
      ctx.fillRect(x, y, 1, 1);
      ctx.fillRect(7 - x, y, 1, 1);
    }
  }
  ctx.fillStyle = '#1b1b24';
  ctx.fillRect(2, 3, 1, 2);
  ctx.fillRect(5, 3, 1, 2);
  ctx.fillStyle = '#f2b84b';
  ctx.fillRect(3, 0, 2, 1);
  return c;
};

export const createArt = async (): Promise<Art> => {
  const frames: string[][] = [];
  for (let c = 0; c < 52; c++) frames.push(face(c));
  frames.push(back());
  const atlas = await bakeAtlas([{ id: 'card', w: CARD_W, h: CARD_H, frames }], [FOUR, TWO]);
  const felt = feltTile();
  const avatars = new Map<number, HTMLCanvasElement>();
  return {
    atlas,
    card(ctx, card, x, y, scale, deck) {
      const r = atlas.rect('card', card, card === BACK ? 0 : deck);
      if (!r) return;
      ctx.drawImage(atlas.image, r.x, r.y, r.w, r.h, x, y, CARD_W * scale, CARD_H * scale);
    },
    felt,
    avatar(seed) {
      let a = avatars.get(seed);
      if (!a) {
        a = spirit(seed);
        if (avatars.size > 24) avatars.clear();
        avatars.set(seed, a);
      }
      return a;
    },
    dispose() {
      atlas.dispose();
      felt.width = felt.height = 0;
      for (const a of avatars.values()) a.width = a.height = 0;
      avatars.clear();
    },
  };
};

/** Chip colours by denomination (striped ellipses, at most 5 high). */
export const CHIP_COLOURS: readonly [number, string, string][] = [
  [1000, '#f2b84b', '#7a5a1a'],
  [500, '#8e5bd1', '#e9dcff'],
  [100, '#24262b', '#d9d9d9'],
  [25, '#2e8b4e', '#e8f5e9'],
  [5, '#c8323c', '#ffe3e3'],
  [1, '#e8e2d2', '#4a4a4a'],
];
