import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRESET_DIR = path.join(__dirname, 'presets');
const DEFAULT_TILE_SIZE = 40;

const FALLBACK_MAP_DATA = {
  id: 'fallback-classic',
  name: 'Classic Grid',
  wrapRows: [9, 10],
  tileSize: DEFAULT_TILE_SIZE,
  spawnTiles: [
    { x: 1, y: 1 },
    { x: 19, y: 1 },
    { x: 1, y: 18 },
    { x: 19, y: 18 },
  ],
  powerPellets: [
    { x: 1, y: 1 },
    { x: 19, y: 1 },
    { x: 1, y: 18 },
    { x: 19, y: 18 },
  ],
  tiles: [
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
    [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]
  ]
};

let cache = null;

const sanitizeTiles = (tiles) => {
  if (!Array.isArray(tiles) || tiles.length === 0) {
    return FALLBACK_MAP_DATA.tiles.map((row) => row.slice());
  }

  const width = Math.max(...tiles.map((row) => Array.isArray(row) ? row.length : 0));
  if (width === 0) {
    return FALLBACK_MAP_DATA.tiles.map((row) => row.slice());
  }

  return tiles.map((row) => {
    if (!Array.isArray(row) || row.length === 0) {
      return new Array(width).fill(1);
    }
    const padded = row.slice(0, width).map((value) => (value === 0 ? 0 : 1));
    if (padded.length < width) {
      const fill = new Array(width - padded.length).fill(1);
      return padded.concat(fill);
    }
    return padded;
  });
};

const sanitizePoints = (points) => {
  if (!Array.isArray(points)) {
    return [];
  }
  return points
    .map((point) => {
      const x = Number(point?.x);
      const y = Number(point?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
      }
      return { x: Math.floor(x), y: Math.floor(y) };
    })
    .filter((point) => point !== null);
};

const normalizeMap = (raw, fallbackId) => {
  const id = typeof raw?.id === 'string' && raw.id.length > 0 ? raw.id : fallbackId;
  const name = typeof raw?.name === 'string' && raw.name.length > 0 ? raw.name : id;
  const wrapRows = Array.isArray(raw?.wrapRows)
    ? raw.wrapRows.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0)
    : [];
  const tiles = sanitizeTiles(raw?.tiles);
  const tileSize = Number(raw?.tileSize);
  const normalizedTileSize = Number.isFinite(tileSize) && tileSize >= 16 ? tileSize : DEFAULT_TILE_SIZE;
  const spawnTiles = sanitizePoints(raw?.spawnTiles);
  const powerPellets = sanitizePoints(raw?.powerPellets);

  return {
    id,
    name,
    wrapRows,
    wrapRowSet: new Set(wrapRows),
    tiles,
    tileSize: normalizedTileSize,
    spawnTiles,
    powerPellets,
  };
};

const readPresetFiles = () => {
  try {
    const entries = readdirSync(PRESET_DIR, { withFileTypes: true });
    const maps = [];
    entries.forEach((entry) => {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        return;
      }
      const filePath = path.join(PRESET_DIR, entry.name);
      try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
        maps.push(normalizeMap(parsed, path.parse(entry.name).name));
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(`[PacmanMapLoader] Failed to load ${entry.name}: ${error.message}`);
      }
    });
    return maps;
  } catch (error) {
    return [];
  }
};

const ensureCache = () => {
  if (cache) {
    return cache;
  }
  const maps = readPresetFiles();
  cache = maps.length > 0 ? maps : [normalizeMap(FALLBACK_MAP_DATA, FALLBACK_MAP_DATA.id)];
  return cache;
};

const cloneMap = (map) => ({
  id: map.id,
  name: map.name,
  tiles: map.tiles.map((row) => row.slice()),
  wrapRows: map.wrapRows.slice(),
  wrapRowSet: new Set(map.wrapRows),
  spawnTiles: Array.isArray(map.spawnTiles) ? map.spawnTiles.map((spawn) => ({ ...spawn })) : [],
  powerPellets: Array.isArray(map.powerPellets) ? map.powerPellets.map((pellet) => ({ ...pellet })) : [],
  tileSize: map.tileSize ?? DEFAULT_TILE_SIZE,
});

export const getAvailablePacmanMaps = () => ensureCache().map((map) => cloneMap(map));

export const getPacmanMapById = (id) => {
  if (!id) {
    return cloneMap(ensureCache()[0]);
  }
  const match = ensureCache().find((map) => map.id === id);
  return cloneMap(match ?? ensureCache()[0]);
};

export const getRandomPacmanMap = () => {
  const maps = ensureCache();
  const index = Math.floor(Math.random() * maps.length);
  return cloneMap(maps[index] ?? maps[0]);
};

export const FALLBACK_PACMAN_MAP = cloneMap(normalizeMap(FALLBACK_MAP_DATA, FALLBACK_MAP_DATA.id));
