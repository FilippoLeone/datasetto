/**
 * Device preferences for the Arcade, `datasetto.arcade.prefs.v1` (platform.md §10.6): control
 * layout, vibration, volume and music for every game, plus a small per-game record a game may keep
 * there (Glimmerhall's turbo and last machine, for example) through `readGamePref` / `writeGamePref`.
 */
import type { ArcadePrefs, GameId } from './types';
import { readLocal, writeLocal } from './store';

export const PREFS_KEY = 'datasetto.arcade.prefs.v1';

export const DEFAULT_PREFS: ArcadePrefs = { volume: 0.4, music: false, vibrate: false, stick: 'float', buttonPx: 76, batterySaver: false };

interface Stored {
  v: 1;
  device: ArcadePrefs;
  games: Partial<Record<GameId, unknown>>;
}

const parseDevice = (raw: unknown): ArcadePrefs => {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    volume: typeof o.volume === 'number' && o.volume >= 0 && o.volume <= 1 ? o.volume : DEFAULT_PREFS.volume,
    music: typeof o.music === 'boolean' ? o.music : DEFAULT_PREFS.music,
    vibrate: typeof o.vibrate === 'boolean' ? o.vibrate : DEFAULT_PREFS.vibrate,
    stick: o.stick === 'dpad' ? 'dpad' : 'float',
    buttonPx: o.buttonPx === 56 ? 56 : 76,
    batterySaver: typeof o.batterySaver === 'boolean' ? o.batterySaver : DEFAULT_PREFS.batterySaver,
  };
};

const parse = (raw: unknown): Stored | null => {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return null;
  return { v: 1, device: parseDevice(o.device), games: o.games && typeof o.games === 'object' ? (o.games as Stored['games']) : {} };
};

const load = (): Stored => readLocal(PREFS_KEY, parse) ?? { v: 1, device: { ...DEFAULT_PREFS }, games: {} };

export const loadPrefs = (): ArcadePrefs => load().device;

export const savePrefs = (next: Partial<ArcadePrefs>): ArcadePrefs => {
  const stored = load();
  stored.device = parseDevice({ ...stored.device, ...next });
  writeLocal(PREFS_KEY, stored);
  return stored.device;
};

export const readGamePref = <T>(game: GameId, parseValue: (v: unknown) => T | null): T | null => {
  const value = load().games[game];
  return value === undefined ? null : parseValue(value);
};

export const writeGamePref = (game: GameId, value: unknown): boolean => {
  const stored = load();
  stored.games[game] = value;
  return writeLocal(PREFS_KEY, stored);
};
