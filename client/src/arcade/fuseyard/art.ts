/**
 * Fuseyard's art (fuseyard.md §9), all original and made in code: palette-indexed 16 × 16 text
 * grids for the Wicks, their hats, bombs, flames, items and small icons, the palettes, and the
 * per-arena tiles generated from seeded noise. Chars '0'–'9', 'a'–'z' are palette indices; '.' is
 * transparent (runtime/sprites.ts).
 */
import type { Palette, SpriteSheet } from '@/arcade/runtime/sprites';

// ------------------------------------------------------------------ helpers

const blank = (): string[][] => Array.from({ length: 16 }, () => Array<string>(16).fill('.'));
const rows = (g: string[][]): string[] => g.map((r) => r.join(''));
const put = (g: string[][], x: number, y: number, ch: string): void => {
  if (x >= 0 && x < 16 && y >= 0 && y < 16) (g[y] as string[])[x] = ch;
};
/** Copies `src` rows onto `g` at row `y0`; '.' in `src` leaves `g` untouched. */
const stamp = (g: string[][], src: readonly string[], y0: number, x0 = 0): void => {
  src.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx += 1) if (row[dx] !== '.') put(g, x0 + dx, y0 + dy, row[dx] as string);
  });
};
const recolor = (frame: readonly string[], map: Record<string, string>): string[] => frame.map((r) => r.replace(/./g, (c) => map[c] ?? c));

// ------------------------------------------------------------------ Wicks

/*
 * Wick palette: 0 outline, 1 body, 2 body shade, 3 body light, 4 lantern glass, 5 eyes, 6 glint,
 * 7 feet, 8 hat, 9 hat shade.
 */
const HEAD_FRONT = [
  '.....000000.....',
  '....04444440....',
  '....04644440....',
  '....04544540....',
  '....04444440....',
  '.....022220.....',
];
const HEAD_BLINK = [
  '.....000000.....',
  '....04444440....',
  '....04644440....',
  '....04444440....',
  '....04555540....',
  '.....022220.....',
];
const HEAD_BACK = [
  '.....000000.....',
  '....04444440....',
  '....04422440....',
  '....04422440....',
  '....04444440....',
  '.....022220.....',
];
const HEAD_SIDE = [
  '......00000.....',
  '.....0444440....',
  '.....0446440....',
  '.....0444540....',
  '.....0444440....',
  '......02220.....',
];
const BODY_FRONT = ['....01111110....', '...0131111110...', '...0111111210...', '....01111110....'];
const BODY_BACK = ['....01111110....', '...0111111110...', '...0121111210...', '....01111110....'];
const BODY_SIDE = ['.....0111110....', '.....01311110...', '.....0111210....', '......01110.....'];
const BODY_CHEER_A = ['..0.01111110.0..', '..0131111111310.', '...0111111210...', '....01111110....'];
const BODY_CHEER_B = ['.0..01111110..0.', '..0131111111310.', '...0111111210...', '....01111110....'];
const FEET_FRONT = [['.....77..77.....'], ['....77....77....'], ['......7777......']];
const FEET_SIDE = [['.......77.......'], ['......7...7.....'], ['.......7.7......']];

const wickFrame = (head: readonly string[], body: readonly string[], feet: readonly string[], bob = 0): string[] => {
  const g = blank();
  stamp(g, head, 4 + bob);
  stamp(g, body, 10 + bob);
  stamp(g, feet, 14);
  return rows(g);
};

const deathFlash = recolor(wickFrame(HEAD_FRONT, BODY_FRONT, FEET_FRONT[0]!), { '1': '6', '2': '6', '3': '6', '4': '6', '5': '6', '7': '6' });
const deathDark = recolor(wickFrame(HEAD_BLINK, BODY_FRONT, FEET_FRONT[0]!), { '4': '0', '6': '2' });
const SMOKE = [
  '................',
  '................',
  '................',
  '................',
  '.......66.......',
  '.....666666.....',
  '....66666666....',
  '...6666226666...',
  '...6662222666...',
  '....66666666....',
  '.....66.666.....',
  '......6..66.....',
  '................',
  '................',
  '................',
  '................',
];
const EMBER = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '........6.......',
  '.......6........',
  '........2.......',
  '.......242......',
  '......24442.....',
  '.....0222220....',
  '................',
  '................',
  '................',
];

/** Frame order in the 'wick' sheet. */
export const WF = {
  down: 0, // 0–2 walk down (0 = standing)
  up: 3, // 3–5
  side: 6, // 6–8 (east; west is mirrored)
  idle: 9, // 9–10
  death: 11, // 11–14
  cheer: 15, // 15–16
} as const;

const WICK_FRAMES: string[][] = [
  wickFrame(HEAD_FRONT, BODY_FRONT, FEET_FRONT[0]!),
  wickFrame(HEAD_FRONT, BODY_FRONT, FEET_FRONT[1]!, -1),
  wickFrame(HEAD_FRONT, BODY_FRONT, FEET_FRONT[2]!, -1),
  wickFrame(HEAD_BACK, BODY_BACK, FEET_FRONT[0]!),
  wickFrame(HEAD_BACK, BODY_BACK, FEET_FRONT[1]!, -1),
  wickFrame(HEAD_BACK, BODY_BACK, FEET_FRONT[2]!, -1),
  wickFrame(HEAD_SIDE, BODY_SIDE, FEET_SIDE[0]!),
  wickFrame(HEAD_SIDE, BODY_SIDE, FEET_SIDE[1]!, -1),
  wickFrame(HEAD_SIDE, BODY_SIDE, FEET_SIDE[2]!, -1),
  wickFrame(HEAD_FRONT, BODY_FRONT, FEET_FRONT[0]!),
  wickFrame(HEAD_BLINK, BODY_FRONT, FEET_FRONT[0]!),
  deathFlash,
  deathDark,
  SMOKE,
  EMBER,
  wickFrame(HEAD_FRONT, BODY_CHEER_A, FEET_FRONT[0]!, -1),
  wickFrame(HEAD_FRONT, BODY_CHEER_B, FEET_FRONT[1]!, -2),
];

/** Hats, 16 × 6, drawn over rows 0–5 of a Wick frame; frame = slot. */
const HATS: string[][] = [
  // Ember: a flame tuft.
  ['.......6........', '......868.......', '......8988......', '.....889988.....', '......9999......', '................'],
  // Tide: a sailor cap with a band and brim.
  ['................', '.....888888.....', '....88888888....', '....99999999....', '...0000000000...', '................'],
  // Fern: a leaf sprout.
  ['....88.....99...', '...8888...999...', '.....88..99.....', '.......88.......', '.......9........', '................'],
  // Dusk: a crescent hood.
  ['......9999......', '....99999999....', '...999998899....', '..99999888999...', '..999......999..', '..99........99..'],
];
/** HUD faces, 8 × 8, in each Wick's palette. */
const FACE = ['.000000.', '04444440', '04644440', '04544540', '04444440', '04444440', '.022220.', '..0000..'];

export const wickSheets: readonly SpriteSheet[] = [
  { id: 'wick', w: 16, h: 16, frames: WICK_FRAMES },
  { id: 'hat', w: 16, h: 6, frames: HATS },
  { id: 'face', w: 8, h: 8, frames: [FACE] },
];

/** [outline, body, shade, light, glass, eyes, glint, feet, hat, hat shade] per Wick, then ghost and flash. */
export const wickPalettes: readonly Palette[] = [
  [0x24130e, 0xe8603c, 0xa83a24, 0xff9a6a, 0xffd46b, 0x3a1a10, 0xfff8e0, 0x4a2418, 0xffb03a, 0xe25a1c],
  [0x0e1630, 0x3a7ee8, 0x2450a8, 0x7ab4ff, 0xfff0b0, 0x14204a, 0xffffff, 0x1a2a4a, 0xf4f4f4, 0x24305a],
  [0x10240e, 0x4cb05a, 0x2e7a3a, 0x8ee08a, 0xfff2a0, 0x163a16, 0xffffff, 0x203a1a, 0x7ad15a, 0x3e8a2e],
  [0x1a1030, 0x8a5ad0, 0x5a3a94, 0xb894f0, 0xffe6b0, 0x2a1a48, 0xffffff, 0x2a1a42, 0x3e2a6a, 0xf0d070],
  // Ghost: grey and pale (drawn translucent).
  [0x2a2a34, 0x9a9aa8, 0x6a6a78, 0xc4c4d0, 0xb8c8d8, 0x40404c, 0xffffff, 0x50505c, 0xa0a0ac, 0x707080],
  // Shield flash: near white.
  [0xffffff, 0xfff4d8, 0xffe0b0, 0xffffff, 0xffffff, 0xffe0b0, 0xffffff, 0xfff4d8, 0xffffff, 0xfff4d8],
];
export const PAL_GHOST = 4;
export const PAL_FLASH = 5;

// ------------------------------------------------------------------ UI palette and sheets

/**
 * The UI palette (also the font's colours): 0 ink, 1 white, 2 yellow, 3 orange, 4 red, 5 dark grey,
 * 6 grey, 7 light grey, 8 bomb, 9 bomb shine, a fuse, b spark, c blue, d green, e purple, f pink,
 * g flame core, h flame mid, i flame outer, j flame edge, k Ember, l Tide, m Fern, n Dusk, o HUD bg,
 * p HUD chip, q shadow, r gold.
 */
export const uiPalette: Palette = [
  0x0b0b12, 0xf4f0e8, 0xffd84a, 0xff8a2a, 0xe8342a, 0x3a3a48, 0x7a7a8a, 0xbdbdc8, 0x22222e, 0x5c5c78, 0x8a5a2a, 0xfff6c0, 0x4aa8ff,
  0x5ad06a, 0xb07ae8, 0xff7ab0, 0xfff2b0, 0xffb43a, 0xe8502a, 0xa82a1a, 0xff8a5a, 0x6aaeff, 0x7ad87a, 0xc49af4, 0x14141e, 0x2a2a3a,
  0x101018, 0xffc93a,
];
export const UI = {
  ink: 0,
  white: 1,
  yellow: 2,
  orange: 3,
  red: 4,
  dark: 5,
  grey: 6,
  light: 7,
  ember: 20,
  tide: 21,
  fern: 22,
  dusk: 23,
  hudBg: 24,
  chip: 25,
  shadow: 26,
  gold: 27,
} as const;
export const SLOT_TEXT = [UI.ember, UI.tide, UI.fern, UI.dusk];

const BOMB_BASE = [
  '................',
  '..........b.....',
  '.........a......',
  '........a.......',
  '......00a.......',
  '....00888800....',
  '...0899888880...',
  '...0898888880...',
  '..089888888880..',
  '..088888888880..',
  '..088888888880..',
  '..088888888880..',
  '...0888888880...',
  '...0888888880...',
  '....00888800....',
  '......0000......',
];
const bombFrames = (): string[][] => {
  const a = BOMB_BASE;
  const b = recolor(BOMB_BASE, { b: '2' });
  const c = recolor(BOMB_BASE, { b: '1', '9': '7' });
  return [a, b, c];
};

/** Flame shapes: centre, horizontal, vertical, then ends opening N, E, S, W. */
export const FLAME_SHAPE = { centre: 0, h: 1, v: 2, endN: 3, endE: 4, endS: 5, endW: 6 } as const;
const flameFrames = (): string[][] => {
  const out: string[][] = [];
  // Intensity 0 (dying), 1, 2 (fresh): half-widths of the core, mid and outer bands.
  const widths = [
    [0, 1, 3],
    [1, 3, 5],
    [2, 4, 7],
  ];
  for (let level = 0; level < 3; level += 1) {
    const [core, mid, outer] = widths[level] as number[];
    for (let shape = 0; shape < 7; shape += 1) {
      const g = blank();
      for (let y = 0; y < 16; y += 1) {
        for (let x = 0; x < 16; x += 1) {
          const dx = Math.abs(x - 7.5);
          const dy = Math.abs(y - 7.5);
          // Distance to the flame's spine for this shape.
          let d: number;
          if (shape === FLAME_SHAPE.centre) d = Math.min(dx, dy);
          else if (shape === FLAME_SHAPE.h) d = dy;
          else if (shape === FLAME_SHAPE.v) d = dx;
          else {
            // An end cap: the spine runs from the open side to the middle, then rounds off.
            const along = shape === FLAME_SHAPE.endN ? 7.5 - y : shape === FLAME_SHAPE.endS ? y - 7.5 : shape === FLAME_SHAPE.endE ? x - 7.5 : 7.5 - x;
            const across = shape === FLAME_SHAPE.endN || shape === FLAME_SHAPE.endS ? dx : dy;
            d = along > 0 ? across : Math.hypot(across, along * 1.4);
          }
          // A little flicker so the bands are not ruler-straight.
          const wobble = ((x * 7 + y * 13 + level * 5 + shape) % 5 === 0 ? 0.6 : 0) - 0.2;
          const v = d + wobble;
          const ch = v <= core ? 'g' : v <= mid ? 'h' : v <= outer ? 'i' : v <= outer + 0.8 ? 'j' : '.';
          put(g, x, y, ch);
        }
      }
      out.push(rows(g));
    }
  }
  return out;
};

const ITEM_DISC = [
  '................',
  '.....000000.....',
  '...0055555500...',
  '..055555555550..',
  '..055555555550..',
  '.05555555555550.',
  '.05555555555550.',
  '.05555555555550.',
  '.05555555555550.',
  '.05555555555550.',
  '.05555555555550.',
  '..055555555550..',
  '..055555555550..',
  '...0055555500...',
  '.....000000.....',
  '................',
];
const ICON_FUSE = [
  '..........b.....',
  '.........a......',
  '.......aaa......',
  '......a.........',
  '......a.........',
  '.....0000.......',
  '....099880......',
  '....098880......',
  '....088880......',
  '.....0000.......',
];
const ICON_SPARK = [
  '.......2........',
  '.......2........',
  '......222.......',
  '.2222.212.2222..',
  '..222221122222..',
  '...2221111222...',
  '....22111122....',
  '...2221111222...',
  '..222.2222.222..',
  '..22.......22...',
];
const ICON_BOOT = [
  '....11..........',
  '...1111.........',
  '..11111..cc.....',
  '.......cccc.....',
  '.......cccc.....',
  '.......cccc.....',
  '.......ccccccc..',
  '......cccccccc..',
  '......00000000..',
  '................',
];
const ICON_GLOVE = [
  '.....f.f.f......',
  '....fffffff.....',
  '....fffffff.ff..',
  '....fffffffffff.',
  '....ffffffffff..',
  '....fffffffff...',
  '.....fffffff....',
  '.....7777777....',
  '.....7777777....',
  '................',
];
const ICON_BUTTON = [
  '................',
  '.....444444.....',
  '....44444444....',
  '....41444444....',
  '....44444444....',
  '.....444444.....',
  '...7777777777...',
  '...6666666666...',
  '................',
  '................',
];
const item = (icon: readonly string[]): string[] => {
  const g = blank();
  stamp(g, ITEM_DISC, 0);
  stamp(g, icon, 3);
  return rows(g);
};

/** Cracks over a breaking block, 3 stages. */
const CRUMBLE = [
  ['................', '.....0..........', '......0....0....', '......0...0.....', '.......0.0......', '.......00.......', '......0..0......', '.....0....0.....', '..........0.....', '...........0....', '................', '................', '................', '................', '................', '................'],
  ['..7.......7.....', '.....0....7.....', '.7....0....0..7.', '......0...0.....', '...7...0.0......', '.......00....7..', '......0..0......', '..7..0....0.....', '..........0..7..', '....7......0....', '..........7.....', '..7.............', '.......7....7...', '................', '................', '................'],
  ['................', '................', '..7.....7.......', '.........7...7..', '....7...........', '..........7.....', '.7....7.........', '...........7....', '....7...........', '.........7..7...', '..7...7.........', '.....7666.7.....', '...76666667.....', '..7666666666....', '.766666666667...', '................'],
];
const WARN = [
  ['3333333333333333', '3..............3', '3..............3', '3..............3', '3.....4444.....3', '3.....4444.....3', '3.....4444.....3', '3.....4444.....3', '3.....4444.....3', '3..............3', '3.....4444.....3', '3.....4444.....3', '3..............3', '3..............3', '3..............3', '3333333333333333'],
  ['4444444444444444', '4..............4', '4.333333333333.4', '4.3..........3.4', '4.3..........3.4', '4.3..........3.4', '4.3..........3.4', '4.3..........3.4', '4.3..........3.4', '4.3..........3.4', '4.3..........3.4', '4.3..........3.4', '4.3..........3.4', '4.333333333333.4', '4..............4', '4444444444444444'],
];
/** Belt chevrons pointing east, 2 frames (rotated for the other directions in code). */
const CHEVRON = [
  ['................', '................', '................', '...6.....6......', '....6.....6.....', '.....6.....6....', '......6.....6...', '.......6.....6..', '......6.....6...', '.....6.....6....', '....6.....6.....', '...6.....6......', '................', '................', '................', '................'],
  ['................', '................', '................', '6.....6.....6...', '.6.....6.....6..', '..6.....6.....6.', '...6.....6.....6', '6...6.....6.....', '...6.....6.....6', '..6.....6.....6.', '.6.....6.....6..', '6.....6.....6...', '................', '................', '................', '................'],
];
const rotate = (frame: readonly string[], turns: number): string[] => {
  let g = frame.map((r) => r.split(''));
  for (let t = 0; t < turns; t += 1) g = g.map((_, y) => g.map((row) => row[y] as string).reverse());
  return g.map((r) => r.join(''));
};
const PAD_GLOW = [
  ['................', '................', '.....cccccc.....', '....c......c....', '...c..1111..c...', '..c..1....1..c..', '..c.1......1.c..', '..c.1......1.c..', '..c.1......1.c..', '..c.1......1.c..', '..c..1....1..c..', '...c..1111..c...', '....c......c....', '.....cccccc.....', '................', '................'],
  ['................', '.....cccccc.....', '....c......c....', '...c..cccc..c...', '..c..c....c..c..', '..c.c..11..c.c..', '..c.c.1..1.c.c..', '..c.c.1..1.c.c..', '..c.c.1..1.c.c..', '..c.c..11..c.c..', '..c..c....c..c..', '...c..cccc..c...', '....c......c....', '.....cccccc.....', '................', '................'],
];
const YOU = ['...111...', '...111...', '...111...', '1111111..', '.11111...', '..111....', '...1.....'];
const LAG = ['.......4', '......44', '....4.44', '....4444', '..4.4444', '..444444', '4.444444', '44444444'];
const SIGNAL = ['.....6', '....66', '..6.66', '..6666', '6.6666', '666666'];
const SHADOW = ['................', '................', '................', '................', '................', '................', '................', '................', '................', '................', '................', '................', '................', '....qqqqqqqq....', '...qqqqqqqqqq...', '....qqqqqqqq....'];
const PAUSE = ['..........', '.11....11.', '.11....11.', '.11....11.', '.11....11.', '.11....11.', '.11....11.', '..........'];
const CLOCK_ICON = ['..111..', '.1...1.', '1..1..1', '1..11.1', '1.....1', '.1...1.', '..111..'];

export const uiSheets: readonly SpriteSheet[] = [
  { id: 'bomb', w: 16, h: 16, frames: bombFrames() },
  { id: 'flame', w: 16, h: 16, frames: flameFrames() },
  { id: 'item', w: 16, h: 16, frames: [item(ICON_FUSE), item(ICON_SPARK), item(ICON_BOOT), item(ICON_GLOVE), item(ICON_BUTTON)] },
  { id: 'crumble', w: 16, h: 16, frames: CRUMBLE },
  { id: 'warn', w: 16, h: 16, frames: WARN },
  { id: 'belt', w: 16, h: 16, frames: [0, 1, 2, 3].flatMap((turns) => CHEVRON.map((f) => rotate(f, (turns + 3) % 4))) },
  { id: 'pad', w: 16, h: 16, frames: PAD_GLOW },
  { id: 'you', w: 9, h: 7, frames: [YOU] },
  { id: 'lag', w: 8, h: 8, frames: [LAG] },
  { id: 'signal', w: 6, h: 6, frames: [SIGNAL] },
  { id: 'shadow', w: 16, h: 16, frames: [SHADOW] },
  { id: 'pause', w: 10, h: 8, frames: [PAUSE] },
  { id: 'clock', w: 7, h: 7, frames: [CLOCK_ICON] },
];

/** Belt frame for a direction (Dir 1–4) and animation step 0–1. */
export const beltFrame = (dir: number, step: number): number => ((dir - 1) % 4) * 2 + (step & 1);

// ------------------------------------------------------------------ tiles

export interface Theme {
  name: string;
  /** floor, floor speckle, wall, wall light, pillar, pillar light, block, block dark, block light, mortar, special, special light. */
  colors: readonly number[];
}

/** One theme per arena (index = arena index). */
export const THEMES: readonly Theme[] = [
  { name: 'Brickyard', colors: [0x6e5a48, 0x5e4c3c, 0x2e2026, 0x4a3438, 0x4e3a34, 0x7a5a48, 0xb45c3c, 0x7e3a26, 0xd8865c, 0xc8b49a, 0x3a3a48, 0x8a8a9a] },
  { name: 'Rolling Mill', colors: [0x55504c, 0x48433f, 0x262428, 0x3e3a3e, 0x5a4e46, 0x80706a, 0x9a6a3a, 0x6a4422, 0xc8945a, 0x302a26, 0x2c2c30, 0xe0a030] },
  { name: 'Frostbite Pond', colors: [0xc8d8e8, 0xb4c8dc, 0x3a4a64, 0x5a6c88, 0x6a80a0, 0x9ab0cc, 0xe8f0f8, 0xa8bcd4, 0xffffff, 0x8aa0bc, 0x8ad0f0, 0xd8f4ff] },
  { name: 'Warp Garden', colors: [0x3e5a3a, 0x344e30, 0x1a2a1c, 0x2e422c, 0x46603e, 0x6a8a5a, 0x5a7a3a, 0x3a5228, 0x8ab05a, 0x2a3a22, 0x7a4ae0, 0xb89aff] },
  { name: 'Night Depot', colors: [0x2c2c36, 0x24242e, 0x101016, 0x1e1e28, 0x34344a, 0x54547a, 0x3a5a7a, 0x22384e, 0x5ad0ff, 0x1a1a22, 0xff4ab0, 0x4affd8] },
];

export const STEEL = [0x5a6474, 0x8a96a6, 0xc4ccd8, 0x2e3440];

/** Kinds of tile the static layer draws. */
export const TILE = { floor: 0, floorB: 1, wall: 2, pillar: 3, block: 4, steel: 5, belt: 6, ice: 7, pad: 8 } as const;

const hash = (x: number, y: number, s: number): number => {
  let h = (x * 374761393 + y * 668265263 + s * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** A 16 × 16 RGBA tile for a theme, kind and variant (seeded noise, no randomness at run time). */
export const makeTile = (theme: Theme, kind: number, variant: number): Uint8ClampedArray => {
  const c = theme.colors;
  const px = new Uint8ClampedArray(16 * 16 * 4);
  const set = (x: number, y: number, col: number): void => {
    const o = (y * 16 + x) * 4;
    px[o] = (col >> 16) & 255;
    px[o + 1] = (col >> 8) & 255;
    px[o + 2] = col & 255;
    px[o + 3] = 255;
  };
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const n = hash(x, y, variant * 31 + kind * 7);
      let col: number;
      switch (kind) {
        case TILE.floor:
        case TILE.floorB: {
          col = n < (kind === TILE.floorB ? 0.16 : 0.08) ? (c[1] as number) : (c[0] as number);
          if ((x === 0 || y === 0) && n < 0.5) col = c[1] as number;
          break;
        }
        case TILE.wall: {
          const edge = x === 0 || y === 0 || (y % 8 === 0) || ((x + (y >> 3) * 8) % 16 === 0);
          col = edge ? (c[2] as number) : n < 0.2 ? (c[2] as number) : (c[3] as number);
          break;
        }
        case TILE.pillar: {
          const rim = x === 0 || y === 0 || x === 15 || y === 15;
          const light = x < 3 || y < 3;
          const dark = x > 12 || y > 12;
          col = rim ? (c[2] as number) : light ? (c[5] as number) : dark ? (c[2] as number) : n < 0.1 ? (c[5] as number) : (c[4] as number);
          break;
        }
        case TILE.block: {
          // Bricks in two courses per 8 rows, mortar lines between.
          const course = y >> 2;
          const off = course % 2 === 0 ? 0 : 4;
          const mortar = y % 4 === 3 || (x + off) % 8 === 7;
          const top = y % 4 === 0;
          col = mortar ? (c[9] as number) : top ? (c[8] as number) : n < 0.15 ? (c[7] as number) : (c[6] as number);
          break;
        }
        case TILE.steel: {
          const rim = x === 0 || y === 0 || x === 15 || y === 15;
          const rivet = (x === 3 || x === 12) && (y === 3 || y === 12);
          const sheen = (x + y) % 9 === 0;
          col = rim ? (STEEL[3] as number) : rivet ? (STEEL[2] as number) : sheen ? (STEEL[1] as number) : (STEEL[0] as number);
          break;
        }
        case TILE.belt: {
          const rail = x < 2 || x > 13 || y < 2 || y > 13;
          col = rail ? (c[11] as number) : (c[10] as number);
          if (!rail && n < 0.05) col = c[2] as number;
          break;
        }
        case TILE.ice: {
          const streak = (x + y * 2 + variant * 3) % 13 === 0 || (x * 2 + y) % 17 === 0;
          col = streak ? 0xffffff : n < 0.1 ? 0xbfe6f8 : 0x9ad4f0;
          break;
        }
        default: {
          // Pad: floor with a dark ring the glow sprite lights up.
          const d = Math.hypot(x - 7.5, y - 7.5);
          col = d > 5 && d < 7 ? (c[2] as number) : d <= 5 ? (c[10] as number) : (c[0] as number);
        }
      }
      set(x, y, col);
    }
  }
  return px;
};

