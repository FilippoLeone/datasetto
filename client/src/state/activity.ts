import { signal } from '@preact/signals';
import { Storage } from '@/lib/storage';
import { normalizeGameActivitySettings, type GameActivitySettings } from '@/features/activity/gameActivity';

const SETTINGS_KEY = 'datasetto.gameActivity.v1';

/** "Playing <game>" settings; off by default and only meaningful in the desktop app. */
export const gameActivitySettings = signal<GameActivitySettings>(normalizeGameActivitySettings(Storage.get<unknown>(SETTINGS_KEY, null)));

export const updateGameActivitySettings = (patch: Partial<GameActivitySettings>): GameActivitySettings => {
  const next = normalizeGameActivitySettings({ ...gameActivitySettings.value, ...patch });
  gameActivitySettings.value = next;
  Storage.set(SETTINGS_KEY, next);
  return next;
};

/** Title the desktop shell detects right now; null when nothing runs, the feature is off, or there is no shell. */
export const detectedGame = signal<string | null>(null);

/** Games in the shell's bundled catalogue (0 until the shell has answered). */
export const catalogueSize = signal(0);
