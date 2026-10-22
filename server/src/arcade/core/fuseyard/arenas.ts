/**
 * The five arenas (fuseyard.md §1.6) as 15 × 13 ASCII rows, parsed once into typed arrays.
 *
 * Legend: `#` wall, `P` pillar, `.` always-empty floor, `,` fillable floor, `X` fixed block,
 * `^ > v <` belts, `~` ice, `A a B b` pads (A↔a, B↔b), `1`–`4` spawns. (The standalone legend
 * used `B` for a fixed block too; here the fixed block is `X` so pad B stays unambiguous.)
 *
 * Every arena has the border wall and a pillar on each interior cell whose x and y are both even;
 * the parser checks both. Cells within Manhattan distance 3 of a spawn are never filled.
 */
import { CELLS, Cell, H, SPIRAL_CELLS, Special, W, type ArenaId } from './rules.js';

export interface Arena {
  id: ArenaId;
  index: number;
  name: string;
  /** Block probability in percent. */
  density: number;
  /** Fixed cells: Floor, Wall, Pillar or Block. */
  cells: Uint8Array;
  special: Uint8Array;
  /** 1 where a random block may go. */
  fillable: Uint8Array;
  /** Partner pad cell, or -1. */
  padPartner: Int16Array;
  /** Belt direction (Dir) per cell, 0 elsewhere. */
  beltDir: Uint8Array;
  hasBelts: boolean;
  hasIce: boolean;
  hasPads: boolean;
}

const SOURCES: readonly { id: ArenaId; name: string; density: number; rows: readonly string[] }[] = [
  {
    id: 'yard',
    name: 'Brickyard',
    density: 80,
    rows: [
      '###############',
      '#1,,,,,,,,,,,2#',
      '#,P,P,P,P,P,P,#',
      '#,,,,,,,,,,,,,#',
      '#,P,P,P,P,P,P,#',
      '#,,,,,,X,,,,,,#',
      '#,P,P,PXP,P,P,#',
      '#,,,,,,X,,,,,,#',
      '#,P,P,P,P,P,P,#',
      '#,,,,,,,,,,,,,#',
      '#,P,P,P,P,P,P,#',
      '#3,,,,,,,,,,,4#',
      '###############',
    ],
  },
  {
    id: 'mill',
    name: 'Rolling Mill',
    density: 70,
    rows: [
      '###############',
      '#1,,,,,,,,,,,2#',
      '#,P,P,P,P,P,P,#',
      '#,,,,,,,,,,,,,#',
      '#,P,P,P,P,P,P,#',
      '#,,>>v,,,v<<,,#',
      '#,P^PvP,PvP^P,#',
      '#,,^<<,,,>>^,,#',
      '#,P,P,P,P,P,P,#',
      '#,,,,,,,,,,,,,#',
      '#,P,P,P,P,P,P,#',
      '#3,,,,,,,,,,,4#',
      '###############',
    ],
  },
  {
    id: 'pond',
    name: 'Frostbite Pond',
    density: 65,
    rows: [
      '###############',
      '#1,,,,,,,,,,,2#',
      '#,P,P,P,P,P,P,#',
      '#,,,,,,,,,,,,,#',
      '#,P,P~P~P~P,P,#',
      '#,,,~~~~~~~,,,#',
      '#,P,P~P~P~P,P,#',
      '#,,,~~~~~~~,,,#',
      '#,P,P~P~P~P,P,#',
      '#,,,,,,,,,,,,,#',
      '#,P,P,P,P,P,P,#',
      '#3,,,,,,,,,,,4#',
      '###############',
    ],
  },
  {
    id: 'garden',
    name: 'Warp Garden',
    density: 75,
    rows: [
      '###############',
      '#1,,,,,,,,,,,2#',
      '#,P,P,P.P,P,P,#',
      '#,,,,,.B.,,,,,#',
      '#,P,P,P.P,P,P,#',
      '#,,.,,,,,,,.,,#',
      '#,PAP,P,P,PaP,#',
      '#,,.,,,,,,,.,,#',
      '#,P,P,P.P,P,P,#',
      '#,,,,,.b.,,,,,#',
      '#,P,P,P.P,P,P,#',
      '#3,,,,,,,,,,,4#',
      '###############',
    ],
  },
  {
    id: 'depot',
    name: 'Night Depot',
    density: 85,
    rows: [
      '###############',
      '#1,,,,,,,,,,,2#',
      '#,P,P,P,P,P,P,#',
      '#,,,,>>>>>,,,,#',
      '#,P,P,P,P,P,P,#',
      '#.,,,,,v,,,,,.#',
      '#AP,P,PvP,P,Pa#',
      '#.,,,,,v,,,,,.#',
      '#,P,P,P,P,P,P,#',
      '#,,,,<<<<<,,,,#',
      '#,P,P,P,P,P,P,#',
      '#3,,,,,,,,,,,4#',
      '###############',
    ],
  },
];

/** Spawn cells of slots 0–3: (1,1), (13,1), (1,11), (13,11). */
export const SPAWNS: readonly number[] = [1 * W + 1, 1 * W + 13, 11 * W + 1, 11 * W + 13];

/** Which spawn each slot uses: two fighters start on opposite corners. */
export const spawnOf = (slot: number, fighters: number): number => (fighters === 2 && slot === 1 ? (SPAWNS[3] as number) : (SPAWNS[slot] as number));

const BELT_DIR: readonly number[] = [0, 1, 2, 3, 4, 0, 0, 0, 0, 0];

const inSafeZone = (x: number, y: number): boolean => {
  for (let s = 0; s < 4; s += 1) {
    const sc = SPAWNS[s] as number;
    const d = Math.abs((sc % W) - x) + Math.abs(((sc / W) | 0) - y);
    if (d <= 3) return true;
  }
  return false;
};

const parse = (src: (typeof SOURCES)[number], index: number): Arena => {
  if (src.rows.length !== H) throw new Error('arena ' + src.id + ': ' + src.rows.length + ' rows');
  const cells = new Uint8Array(CELLS);
  const special = new Uint8Array(CELLS);
  const fillable = new Uint8Array(CELLS);
  const padPartner = new Int16Array(CELLS).fill(-1);
  const beltDir = new Uint8Array(CELLS);
  const pads = [-1, -1, -1, -1];
  for (let y = 0; y < H; y += 1) {
    const row = src.rows[y] as string;
    if (row.length !== W) throw new Error('arena ' + src.id + ' row ' + y + ' is ' + row.length + ' wide');
    for (let x = 0; x < W; x += 1) {
      const i = y * W + x;
      const ch = row[x] as string;
      const border = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      const pillar = !border && x % 2 === 0 && y % 2 === 0;
      if (border !== (ch === '#')) throw new Error('arena ' + src.id + ': bad wall at ' + x + ',' + y);
      if (pillar !== (ch === 'P')) throw new Error('arena ' + src.id + ': bad pillar at ' + x + ',' + y);
      let cell: number = Cell.Floor;
      let sp: number = Special.None;
      switch (ch) {
        case '#':
          cell = Cell.Wall;
          break;
        case 'P':
          cell = Cell.Pillar;
          break;
        case 'X':
          cell = Cell.Block;
          break;
        case ',':
          if (!inSafeZone(x, y)) fillable[i] = 1;
          break;
        case '^':
          sp = Special.BeltN;
          break;
        case '>':
          sp = Special.BeltE;
          break;
        case 'v':
          sp = Special.BeltS;
          break;
        case '<':
          sp = Special.BeltW;
          break;
        case '~':
          sp = Special.Ice;
          break;
        case 'A':
          sp = Special.PadA;
          pads[0] = i;
          break;
        case 'a':
          sp = Special.Pada;
          pads[1] = i;
          break;
        case 'B':
          sp = Special.PadB;
          pads[2] = i;
          break;
        case 'b':
          sp = Special.Padb;
          pads[3] = i;
          break;
        case '.':
        case '1':
        case '2':
        case '3':
        case '4':
          break;
        default:
          throw new Error('arena ' + src.id + ': unknown char ' + ch);
      }
      if (sp !== Special.None && inSafeZone(x, y)) throw new Error('arena ' + src.id + ': special tile in a safe zone at ' + x + ',' + y);
      cells[i] = cell;
      special[i] = sp;
      beltDir[i] = BELT_DIR[sp] ?? 0;
    }
  }
  for (let p = 0; p < 4; p += 2) {
    const a = pads[p] as number;
    const b = pads[p + 1] as number;
    if ((a < 0) !== (b < 0)) throw new Error('arena ' + src.id + ': unpaired pad');
    if (a >= 0) {
      padPartner[a] = b;
      padPartner[b] = a;
    }
  }
  let hasBelts = false;
  let hasIce = false;
  for (let i = 0; i < CELLS; i += 1) {
    if ((beltDir[i] as number) > 0) hasBelts = true;
    if (special[i] === Special.Ice) hasIce = true;
  }
  return { id: src.id, index, name: src.name, density: src.density, cells, special, fillable, padPartner, beltDir, hasBelts, hasIce, hasPads: (pads[0] as number) >= 0 };
};

export const ARENAS: readonly Arena[] = SOURCES.map((s, i) => parse(s, i));

export const arenaIndex = (id: ArenaId): number => {
  for (let i = 0; i < ARENAS.length; i += 1) if ((ARENAS[i] as Arena).id === id) return i;
  return 0;
};

/**
 * Closing Time's order: rings walked clockwise from (1,1) inwards, skipping pillars and the 3 × 3
 * around (7,6): 106 cells.
 */
const buildSpiral = (): Uint8Array => {
  const out = new Uint8Array(SPIRAL_CELLS);
  let n = 0;
  const push = (x: number, y: number): void => {
    if (x % 2 === 0 && y % 2 === 0) return;
    if (x >= 6 && x <= 8 && y >= 5 && y <= 7) return;
    if (n < SPIRAL_CELLS) out[n] = y * W + x;
    n += 1;
  };
  for (let r = 0; r < 5; r += 1) {
    const x0 = 1 + r;
    const x1 = W - 2 - r;
    const y0 = 1 + r;
    const y1 = H - 2 - r;
    for (let x = x0; x <= x1; x += 1) push(x, y0);
    for (let y = y0 + 1; y <= y1; y += 1) push(x1, y);
    for (let x = x1 - 1; x >= x0; x -= 1) push(x, y1);
    for (let y = y1 - 1; y > y0; y -= 1) push(x0, y);
  }
  if (n !== SPIRAL_CELLS) throw new Error('spiral has ' + n + ' cells');
  return out;
};

export const SPIRAL: Uint8Array = buildSpiral();
