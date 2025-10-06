const COLOR_PALETTES = [
  ['#f48024', '#f59f45', '#fcd28d'],
  ['#6f42c1', '#9b6cc5', '#d6b7f0'],
  ['#d6336c', '#f080a1', '#f8bacf'],
  ['#0d6efd', '#4c8bff', '#9fc2ff'],
  ['#20c997', '#69dab8', '#b9f3e2'],
  ['#fd7e14', '#ffa94d', '#ffd8a8'],
  ['#6610f2', '#8c4bff', '#c6a7ff'],
  ['#198754', '#5cb176', '#b1e2b8'],
];

const BACKGROUND_COLOR = '#0f1117';
const GRID_SIZE = 5;
const CELL_SIZE = 8;
const PADDING = 4;
const VIEWBOX_SIZE = GRID_SIZE * CELL_SIZE + PADDING * 2;

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const cyrb128 = (str: string): [number, number, number, number] => {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;

  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = (h2 ^ Math.imul(h1 ^ ch, 597399067)) >>> 0;
    h2 = (h3 ^ Math.imul(h2 ^ ch, 2869860233)) >>> 0;
    h3 = (h4 ^ Math.imul(h3 ^ ch, 951274213)) >>> 0;
    h4 = (h1 ^ Math.imul(h4 ^ ch, 2716044179)) >>> 0;
  }

  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067) >>> 0;
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233) >>> 0;
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213) >>> 0;
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179) >>> 0;

  return [h1, h2, h3, h4];
};

const mulberry32 = (a: number) => () => {
  let t = (a += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const pickPalette = (rand: () => number): string[] =>
  COLOR_PALETTES[Math.floor(rand() * COLOR_PALETTES.length) % COLOR_PALETTES.length];

const chooseColor = (palette: string[], rand: () => number): string =>
  palette[Math.floor(rand() * palette.length) % palette.length];

const generateCells = (rand: () => number): Array<{ x: number; y: number; color: string }> => {
  const cells: Array<{ x: number; y: number; color: string }> = [];
  const palette = pickPalette(rand);

  for (let row = 0; row < GRID_SIZE; row += 1) {
    for (let col = 0; col < Math.ceil(GRID_SIZE / 2); col += 1) {
      const shouldFill = rand() > 0.35;
      if (!shouldFill) continue;

      const color = chooseColor(palette, rand);
      const mirroredCol = GRID_SIZE - col - 1;

      cells.push({ x: col, y: row, color });

      if (mirroredCol !== col) {
        cells.push({ x: mirroredCol, y: row, color });
      }
    }
  }

  return cells;
};

export interface IdenticonOptions {
  size?: number;
  label?: string;
}

export const generateIdenticonSvg = (seedRaw: string, options: IdenticonOptions = {}): string => {
  const seed = seedRaw || 'anonymous';
  const [h1] = cyrb128(seed);
  const rand = mulberry32(h1);
  const cells = generateCells(rand);

  if (cells.length === 0) {
    cells.push({ x: 2, y: 2, color: '#f48024' });
  }

  const size = options.size ?? 48;
  const label = options.label ? escapeAttribute(options.label) : `Avatar for ${escapeAttribute(seed)}`;

  const cellElements = cells
    .map(({ x, y, color }) => {
      const cx = PADDING + x * CELL_SIZE;
      const cy = PADDING + y * CELL_SIZE;
      return `<rect x="${cx}" y="${cy}" width="${CELL_SIZE}" height="${CELL_SIZE}" rx="2" ry="2" fill="${color}" />`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg class="user-avatar-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}" width="${size}" height="${size}" role="img" aria-label="${label}">\n  <rect width="${VIEWBOX_SIZE}" height="${VIEWBOX_SIZE}" fill="${BACKGROUND_COLOR}" rx="${PADDING}" ry="${PADDING}" />\n  ${cellElements}\n</svg>`;
};

export const generateIdenticonDataUri = (seed: string, options?: IdenticonOptions): string => {
  const svg = generateIdenticonSvg(seed, options);
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
};
