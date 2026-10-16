import { signal } from '@preact/signals';
import { config } from '@/config';
import { Storage } from '@/lib/storage';
import type { AudioSettings, ScreenQuality } from '@/types/protocol';

const SETTINGS_KEY = 'rtmpdisc.settings.v1';
const SCREEN_QUALITIES: ScreenQuality[] = ['720p30', '1080p60'];

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
  noiseSuppression: true,
  noiseReducerLevel: num(config.NOISE_REDUCTION_LEVEL, 0.35, 0, 1),
  autoGain: true,
  micGain: 1,
  outputVol: 1,
  pttEnable: false,
  pttKey: '',
  voiceBitrate: num(config.VOICE_OPUS_BITRATE, 64000, 6000, 128000),
  dtx: bool(config.VOICE_DTX_ENABLED, true),
  latencyHint: 'interactive',
  vadThreshold: num(config.VOICE_VAD_THRESHOLD, 0.07, 0.01, 0.5),
  screenQuality: '720p30',
};

/** Merge stored settings over the defaults, dropping values this build does not know. */
export const normalizeAudioSettings = (stored: Partial<AudioSettings> | null | undefined): AudioSettings => {
  const next = { ...DEFAULT_AUDIO_SETTINGS, ...(stored ?? {}) };
  if (!SCREEN_QUALITIES.includes(next.screenQuality)) next.screenQuality = DEFAULT_AUDIO_SETTINGS.screenQuality;
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
