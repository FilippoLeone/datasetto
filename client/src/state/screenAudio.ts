import { signal } from '@preact/signals';
import { Storage } from '@/lib/storage';
import { usersById } from './presence';

const KEY = 'rtmpdisc.screenAudio.v1';

/** How loud a particular host's shared screen plays for me; remembered per host account. */
export interface ScreenAudioPref {
  muted: boolean;
  /** 0..1 */
  volume: number;
}

export const DEFAULT_SCREEN_AUDIO: ScreenAudioPref = { muted: false, volume: 1 };

const clampVolume = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SCREEN_AUDIO.volume;
  return Math.min(1, Math.max(0, parsed));
};

/** Stored prefs with anything malformed dropped. */
export const parseScreenAudioPrefs = (stored: unknown): Record<string, ScreenAudioPref> => {
  const out: Record<string, ScreenAudioPref> = {};
  if (!stored || typeof stored !== 'object') return out;
  for (const [hostKey, pref] of Object.entries(stored as Record<string, unknown>)) {
    if (!hostKey || !pref || typeof pref !== 'object') continue;
    const { muted, volume } = pref as Partial<ScreenAudioPref>;
    out[hostKey] = { muted: Boolean(muted), volume: clampVolume(volume ?? DEFAULT_SCREEN_AUDIO.volume) };
  }
  return out;
};

export const screenAudioPrefs = signal<Record<string, ScreenAudioPref>>(parseScreenAudioPrefs(Storage.get<unknown>(KEY, {})));

export const screenAudioPref = (hostKey: string | null | undefined): ScreenAudioPref =>
  (hostKey ? screenAudioPrefs.value[hostKey] : undefined) ?? DEFAULT_SCREEN_AUDIO;

export const setScreenAudioPref = (hostKey: string, patch: Partial<ScreenAudioPref>): ScreenAudioPref => {
  const next: ScreenAudioPref = { ...screenAudioPref(hostKey), ...patch };
  next.volume = clampVolume(next.volume);
  screenAudioPrefs.value = { ...screenAudioPrefs.value, [hostKey]: next };
  Storage.set(KEY, screenAudioPrefs.value);
  return next;
};

/** Stable key for a presenter: their account id when they are online, else the given fallback. */
export const screenHostKey = (socketId: string | null | undefined, fallback: string | null | undefined): string | null => {
  if (socketId) {
    const accountId = usersById.value.get(socketId)?.accountId;
    if (accountId) return 'account:' + accountId;
  }
  return fallback ? 'name:' + fallback : null;
};
