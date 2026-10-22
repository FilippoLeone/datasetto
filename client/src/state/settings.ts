import { signal } from '@preact/signals';
import { config } from '@/config';
import { parseShortcut, serializeShortcut } from '@/lib/shortcut';
import { Storage } from '@/lib/storage';
import { DEFAULT_OVERLAY_CORNER, isOverlayCorner } from '@/features/voice/voiceOverlayState';
import { clampStrength, DEFAULT_STRENGTH_DB } from '@/services/voice/neuralEngine';
import { normalizeBlurLevel } from '@/services/voice/backgroundBlur';
import type { AudioSettings, ClipSeconds, NoiseSuppressionLevel, ScreenQuality } from '@/types/protocol';

const SETTINGS_KEY = 'rtmpdisc.settings.v1';
const SCREEN_QUALITIES: ScreenQuality[] = ['720p30', '1080p60', 'native60', 'native120'];
const NOISE_LEVELS: NoiseSuppressionLevel[] = ['off', 'standard', 'strong'];
export const CLIP_SECONDS: ClipSeconds[] = [15, 30, 60];
/** Saves a clip while the app has the focus; changeable in Settings > Clips. */
export const DEFAULT_CLIP_SHORTCUT = 'Alt+KeyC';

const num = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
};

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  echoCancel: true,
  noiseSuppressionLevel: 'standard',
  strongSuppressionDb: DEFAULT_STRENGTH_DB,
  noiseReducerLevel: num(config.NOISE_REDUCTION_LEVEL, 0.35, 0, 1),
  autoGain: true,
  micGain: 1,
  outputVol: 1,
  pttEnable: false,
  pttKey: '',
  overlayEnabled: true,
  overlayCorner: DEFAULT_OVERLAY_CORNER,
  voiceBitrate: num(config.VOICE_OPUS_BITRATE, 128000, 6000, 128000),
  dtx: bool(config.VOICE_DTX_ENABLED, true),
  latencyHint: 'interactive',
  vadThreshold: num(config.VOICE_VAD_THRESHOLD, 0.07, 0.01, 0.5),
  screenQuality: '1080p60',
  cameraBlur: 'off',
  clipSeconds: 30,
  clipIncludeVoice: false,
  clipShortcut: DEFAULT_CLIP_SHORTCUT,
  shareClipsAllowed: true,
};

/** Merge stored settings over the defaults, dropping values this build does not know. */
export const normalizeAudioSettings = (stored: Partial<AudioSettings> | null | undefined): AudioSettings => {
  const next = { ...DEFAULT_AUDIO_SETTINGS, ...(stored ?? {}) };
  // Earlier builds stored a boolean `noiseSuppression`: off stays off, on becomes the standard level.
  const legacy = (stored as { noiseSuppression?: unknown } | null | undefined)?.noiseSuppression;
  if (!NOISE_LEVELS.includes(next.noiseSuppressionLevel)) next.noiseSuppressionLevel = legacy === false ? 'off' : 'standard';
  delete (next as { noiseSuppression?: unknown }).noiseSuppression;
  next.strongSuppressionDb = clampStrength(next.strongSuppressionDb);
  if (!SCREEN_QUALITIES.includes(next.screenQuality)) next.screenQuality = DEFAULT_AUDIO_SETTINGS.screenQuality;
  // Settings saved before background blur existed (or a value this build does not know) mean Off.
  next.cameraBlur = normalizeBlurLevel(next.cameraBlur);
  if (!isOverlayCorner(next.overlayCorner)) next.overlayCorner = DEFAULT_OVERLAY_CORNER;
  next.overlayEnabled = Boolean(next.overlayEnabled);
  // The old client stored the bare KeyboardEvent.code; normalise to the shortcut form.
  const shortcut = parseShortcut(typeof next.pttKey === 'string' ? next.pttKey : '');
  next.pttKey = shortcut ? serializeShortcut(shortcut) : '';
  if (!CLIP_SECONDS.includes(next.clipSeconds)) next.clipSeconds = DEFAULT_AUDIO_SETTINGS.clipSeconds;
  next.clipIncludeVoice = Boolean(next.clipIncludeVoice);
  next.shareClipsAllowed = next.shareClipsAllowed !== false;
  // An unset shortcut stays unset (people may turn the key off); garbage falls back to the default.
  if (typeof next.clipShortcut !== 'string') next.clipShortcut = DEFAULT_CLIP_SHORTCUT;
  else if (next.clipShortcut !== '') {
    const clipShortcut = parseShortcut(next.clipShortcut);
    next.clipShortcut = clipShortcut ? serializeShortcut(clipShortcut) : DEFAULT_CLIP_SHORTCUT;
  }
  return next;
};

const load = (): AudioSettings => normalizeAudioSettings(Storage.get<Partial<AudioSettings>>(SETTINGS_KEY, {}));

export const audioSettings = signal<AudioSettings>(load());

export const updateAudioSettings = (patch: Partial<AudioSettings>): AudioSettings => {
  const next = { ...audioSettings.value, ...patch };
  audioSettings.value = next;
  Storage.set(SETTINGS_KEY, next);
  return next;
};
