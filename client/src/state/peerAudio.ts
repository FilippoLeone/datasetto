import { signal } from '@preact/signals';
import { Storage } from '@/lib/storage';
import { usersById } from './presence';
import { voicePeers } from './voice';

const KEY = 'rtmpdisc.peerAudio.v1';

/**
 * How loud one person plays for me and whether I muted them on my side, remembered per
 * account (socket ids change on every connection, so they are no key). The voice service
 * applies it to that person's audio path through a gain node: above 1 is a boost, a local
 * mute is gain 0. Nothing here is sent to the server or touches their stream.
 */
export interface PeerAudioPref {
  /** 0..2 multiplier; 1 is their natural level. */
  volume: number;
  /** "Mute for me": silenced on my side only. */
  muted: boolean;
}

/** Highest multiplier the per-person slider allows (200 %). */
export const PEER_VOLUME_MAX = 2;
/** Slider and arrow-key step, in percent. */
export const PEER_VOLUME_STEP_PERCENT = 5;
export const DEFAULT_PEER_AUDIO: PeerAudioPref = { volume: 1, muted: false };

/** 0..PEER_VOLUME_MAX, rounded to whole percents; anything unusable becomes 1. */
export const clampPeerVolume = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_PEER_AUDIO.volume;
  return Math.min(PEER_VOLUME_MAX, Math.max(0, Math.round(parsed * 100) / 100));
};

/** The percentage shown next to a slider for this multiplier. */
export const volumePercent = (volume: number): number => Math.round(volume * 100);

const isDefault = (pref: PeerAudioPref): boolean => pref.volume === DEFAULT_PEER_AUDIO.volume && pref.muted === DEFAULT_PEER_AUDIO.muted;

/** Stored prefs with anything malformed or equal to the default dropped. */
export const parsePeerAudioPrefs = (stored: unknown): Record<string, PeerAudioPref> => {
  const out: Record<string, PeerAudioPref> = {};
  if (!stored || typeof stored !== 'object') return out;
  for (const [accountId, pref] of Object.entries(stored as Record<string, unknown>)) {
    if (!accountId || !pref || typeof pref !== 'object') continue;
    const { muted, volume } = pref as Partial<PeerAudioPref>;
    const next: PeerAudioPref = { muted: Boolean(muted), volume: clampPeerVolume(volume ?? DEFAULT_PEER_AUDIO.volume) };
    if (!isDefault(next)) out[accountId] = next;
  }
  return out;
};

/** Per-account settings of everyone who has one; people at the default are not listed. */
export const peerAudioPrefs = signal<Record<string, PeerAudioPref>>(parsePeerAudioPrefs(Storage.get<unknown>(KEY, {})));

export const peerAudioPref = (accountId: string | null | undefined): PeerAudioPref =>
  (accountId ? peerAudioPrefs.value[accountId] : undefined) ?? DEFAULT_PEER_AUDIO;

const store = (next: Record<string, PeerAudioPref>): void => {
  peerAudioPrefs.value = next;
  Storage.set(KEY, next);
};

/**
 * Change someone's volume or local mute. Moving the slider to an audible level while they
 * are muted for me unmutes them (the slider is the louder statement of intent); a mute
 * keeps the volume so unmuting brings it back.
 */
export const setPeerAudioPref = (accountId: string, patch: Partial<PeerAudioPref>): PeerAudioPref => {
  const current = peerAudioPref(accountId);
  const next: PeerAudioPref = { ...current, ...patch };
  next.volume = clampPeerVolume(next.volume);
  if (patch.volume !== undefined && patch.muted === undefined && next.volume > 0) next.muted = false;
  const all = { ...peerAudioPrefs.value };
  if (isDefault(next)) delete all[accountId];
  else all[accountId] = next;
  store(all);
  return next;
};

/** Back to 100 %, unmuted. */
export const resetPeerAudioPref = (accountId: string): void => {
  if (!(accountId in peerAudioPrefs.value)) return;
  const all = { ...peerAudioPrefs.value };
  delete all[accountId];
  store(all);
};

/** The account behind a voice peer (socket id), from the room or from presence. */
export const peerAccountId = (peerId: string | null | undefined): string | null => {
  if (!peerId) return null;
  return voicePeers.value[peerId]?.accountId ?? usersById.value.get(peerId)?.accountId ?? null;
};
