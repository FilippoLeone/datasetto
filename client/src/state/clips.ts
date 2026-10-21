import { computed, signal } from '@preact/signals';
import { Storage } from '@/lib/storage';
import type { ClipRecord } from '@/services/clips/clipStore';

/**
 * Clips state: which watched sources have "Clips on" (remembered, so a stream you
 * always clip starts buffering as soon as it plays again), what each buffer is
 * doing, and the library of saved clips as last read from IndexedDB.
 *
 * Source keys: `stream:<channelId>` for a live stream, `share:<channelId>` for a
 * screenshare room, `voice:<accountId>` for a friend's screen in a voice channel,
 * `voice:me` for your own share there (see features/clips/clipKeys.ts).
 */

const ON_KEY = 'rtmpdisc.clipsOn.v1';

const loadOn = (): Record<string, true> => {
  const stored = Storage.get<unknown>(ON_KEY, []);
  const out: Record<string, true> = {};
  if (Array.isArray(stored)) for (const key of stored) if (typeof key === 'string' && key) out[key] = true;
  return out;
};

/** Sources with Clips on, as a set. */
export const clipsOn = signal<Record<string, true>>(loadOn());

export const isClipsOn = (key: string | null | undefined): boolean => Boolean(key && clipsOn.value[key]);

export const setClipsOn = (key: string, on: boolean): void => {
  if (isClipsOn(key) === on) return;
  const next = { ...clipsOn.value };
  if (on) next[key] = true;
  else delete next[key];
  clipsOn.value = next;
  Storage.set(ON_KEY, Object.keys(next));
};

export interface ClipStatus {
  /** The rolling buffer runs. */
  recording: boolean;
  /** Milliseconds of history available to clip right now. */
  availableMs: number;
  /** A clip is being saved. */
  saving: boolean;
  /** Why the buffer is not running although Clips is on (no picture yet, recorder unsupported...). */
  error: string | null;
}

export const IDLE_CLIP_STATUS: ClipStatus = { recording: false, availableMs: 0, saving: false, error: null };

/** Per source key. Updated by services/clips/clipManager.ts about once a second. */
export const clipStatuses = signal<Record<string, ClipStatus>>({});

export const clipStatus = (key: string | null | undefined): ClipStatus => (key ? clipStatuses.value[key] : undefined) ?? IDLE_CLIP_STATUS;

/** The source the clip shortcut acts on: the one last turned on or clipped. */
export const activeClipKey = signal<string | null>(null);

/** Saved clips, newest first; null until the library has been read once. */
export const clipLibrary = signal<ClipRecord[] | null>(null);

export const clipLibraryBytes = computed(() => (clipLibrary.value ?? []).reduce((sum, clip) => sum + clip.bytes, 0));

export const clipCount = computed(() => clipLibrary.value?.length ?? 0);
