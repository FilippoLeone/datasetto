import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../utils/logger.js';

const DEFAULT_TILE_SIZE = 40;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPS_DIR = path.join(__dirname, 'pacmanMaps');

const CLASSIC_TILES = [
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
  [1,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,1],
  [1,0,1,1,1,0,1,1,1,0,1,0,1,1,1,0,1,1,1,0,1],
  [1,0,1,1,1,0,1,1,1,0,1,0,1,1,1,0,1,1,1,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,1,1,1,0,1,0,1,1,1,1,1,0,1,0,1,1,1,0,1],
  [1,0,0,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,0,0,1],
  [1,1,1,1,1,0,1,1,1,0,1,0,1,1,1,0,1,1,1,1,1],
  [1,1,1,1,1,0,1,0,0,0,0,0,0,0,1,0,1,1,1,1,1],
  [1,0,0,0,0,0,0,0,1,1,0,1,1,0,0,0,0,0,0,0,1],
  [1,1,1,1,1,0,1,0,1,1,1,1,1,0,1,0,1,1,1,1,1],
  [1,1,1,1,1,0,1,0,0,0,0,0,0,0,1,0,1,1,1,1,1],
  [1,1,1,1,1,0,1,0,1,1,1,1,1,0,1,0,1,1,1,1,1],
  [1,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,1],
  [1,0,1,1,1,0,1,1,1,0,1,0,1,1,1,0,1,1,1,0,1],
  [1,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,1],
  [1,1,1,0,1,0,1,0,1,1,1,1,1,0,1,0,1,0,1,1,1],
  [1,0,0,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,0,0,1],
  [1,0,1,1,1,1,1,1,1,0,1,0,1,1,1,1,1,1,1,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
];

const DEFAULT_PACMAN_MAP = {
  id: 'neo-classic',
  name: 'Neon Circuit',
  author: 'Datasetto',
  description: 'Baseline arena inspired by the 1980s layout.',
  tileSize: DEFAULT_TILE_SIZE,
  wrapRows: [9, 10],
  powerPellets: [
    { x: 1, y: 1 },
    { x: 19, y: 1 },
    { x: 1, y: 19 },
    { x: 19, y: 19 },
  ],
  spawnTiles: [
    { x: 10, y: 15 },
    { x: 10, y: 9 },
    { x: 1, y: 1 },
    { x: 19, y: 1 },
    { x: 1, y: 19 },
    { x: 19, y: 19 },
  ],
  tiles: CLASSIC_TILES,
};

const normalizeCoordinate = (value) => {
  if (Array.isArray(value) && value.length >= 2) {
    return { x: Number(value[0]), y: Number(value[1]) };
  }
  if (value && typeof value === 'object' && 'x' in value && 'y' in value) {
    return { x: Number(value.x), y: Number(value.y) };
  }
  return null;
};

const normalizeMap = (definition) => {
  if (!definition || typeof definition !== 'object') {
    return null;
  }

  const tiles = Array.isArray(definition.tiles) ? definition.tiles.map((row) => Array.isArray(row) ? row.slice() : []) : [];
  const rows = tiles.length;
  const columns = rows > 0 ? tiles[0].length : 0;
  if (!rows || !columns) {
    return null;
  }

  const tileSize = Number(definition.tileSize) || DEFAULT_TILE_SIZE;
  if (!Number.isFinite(tileSize) || tileSize <= 0) {
    return null;
  }

  const wrapRows = Array.isArray(definition.wrapRows) ? definition.wrapRows.map((row) => Number(row)).filter(Number.isFinite) : [];
  const wrapRowSet = new Set(wrapRows.filter((row) => row >= 0 && row < rows));

  const powerPellets = Array.isArray(definition.powerPellets)
    ? definition.powerPellets.map(normalizeCoordinate).filter(Boolean)
    : [];

  const spawnTiles = Array.isArray(definition.spawnTiles)
    ? definition.spawnTiles.map(normalizeCoordinate).filter(Boolean)
    : [];

  const metadata = {
    author: definition.author || null,
    description: definition.description || null,
    difficulty: definition.difficulty || null,
  };

  return {
    id: definition.id || `map-${rows}x${columns}`,
    name: definition.name || 'Unnamed Arena',
    tileSize,
    tiles,
    width: columns * tileSize,
    height: rows * tileSize,
    wrapRows: Array.from(wrapRowSet),
    wrapRowSet,
    powerPellets: (powerPellets.length ? powerPellets : DEFAULT_PACMAN_MAP.powerPellets).map(({ x, y }) => ({ x, y })),
    spawnTiles: (spawnTiles.length ? spawnTiles : DEFAULT_PACMAN_MAP.spawnTiles).map(({ x, y }) => ({ x, y })),
    metadata,
  };
};

export const loadPacmanMaps = () => {
  const loaded = [];
  try {
    const entries = fs.existsSync(MAPS_DIR) ? fs.readdirSync(MAPS_DIR, { withFileTypes: true }) : [];
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .forEach((entry) => {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, entry.name), 'utf-8'));
          const map = normalizeMap(raw);
          if (map) {
            loaded.push(map);
          } else {
            logger.warn(`Skipping invalid Pacman map: ${entry.name}`);
          }
        } catch (error) {
          logger.warn(`Failed to load Pacman map ${entry.name}`, { error });
        }
      });
  } catch (error) {
    logger.warn('Unable to scan Pacman maps directory', { error });
  }

  if (!loaded.length) {
    logger.warn('No Pacman maps detected. Falling back to default map definition.');
    const fallback = normalizeMap(DEFAULT_PACMAN_MAP);
    return fallback ? [fallback] : [];
  }

  return loaded;
};

export { DEFAULT_PACMAN_MAP };
