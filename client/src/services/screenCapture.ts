/**
 * Screen capture shared by the screenshare rooms and the voice-channel screen
 * share: quality presets, the browser / desktop-shell capture paths, encoder
 * parameters and the "why is there no sound" explanation.
 */
import { config } from '@/config';
import type { ScreenQuality } from '@/types/protocol';

export interface ScreenQualityPreset {
  id: ScreenQuality;
  label: string;
  width: number;
  height: number;
  fps: number;
  /** Encoder cap in bits per second, before the deployment ceiling. */
  maxBitrateBps: number;
}

export interface ScreenCaptureResult {
  stream: MediaStream;
  /** True when the capture carries a live audio track. */
  hasAudio: boolean;
  /** Which capture path produced the stream. */
  source: 'browser' | 'desktop';
  /** True when the browser confirmed it excluded this page's own audio. */
  ownAudioExcluded: boolean;
}

type DisplayMediaRequest = MediaStreamConstraints & { systemAudio?: 'include' | 'exclude' };

type DisplayMediaDevices = {
  getDisplayMedia?: (constraints?: DisplayMediaRequest) => Promise<MediaStream>;
  getSupportedConstraints?: () => MediaTrackSupportedConstraints & { restrictOwnAudio?: boolean };
};

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Deployment-wide ceilings (VITE_SCREENSHARE_*). Presets never exceed them. */
const CEILING = {
  bitrateBps: num(config.SCREENSHARE_MAX_BITRATE_KBPS, 25000) * 1000,
  fps: num(config.SCREENSHARE_MAX_FPS, 120),
};

/** Bitrate for the screen's audio track (Opus; game sound, not speech). */
export const SCREEN_AUDIO_BITRATE_BPS = 96_000;

export const DEFAULT_SCREEN_QUALITY: ScreenQuality = '720p30';

export const SCREEN_QUALITY_PRESETS: Record<ScreenQuality, ScreenQualityPreset> = {
  '720p30': { id: '720p30', label: '720p · 30 fps (default)', width: 1280, height: 720, fps: 30, maxBitrateBps: 3_500_000 },
  '1080p60': { id: '1080p60', label: '1080p · 60 fps (games, more bandwidth)', width: 1920, height: 1080, fps: 60, maxBitrateBps: 8_000_000 },
};

export const SCREEN_QUALITY_OPTIONS = Object.values(SCREEN_QUALITY_PRESETS).map((preset) => ({ value: preset.id, label: preset.label }));

export const isScreenQuality = (value: unknown): value is ScreenQuality =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(SCREEN_QUALITY_PRESETS, value);

export const screenQualityPreset = (quality: unknown): ScreenQualityPreset =>
  SCREEN_QUALITY_PRESETS[isScreenQuality(quality) ? quality : DEFAULT_SCREEN_QUALITY];

/** Frame rate and bitrate a preset is allowed to use under the deployment ceilings. */
export const screenQualityLimits = (quality: unknown): { width: number; height: number; fps: number; maxBitrateBps: number } => {
  const preset = screenQualityPreset(quality);
  return {
    width: preset.width,
    height: preset.height,
    fps: Math.min(preset.fps, CEILING.fps),
    maxBitrateBps: Math.min(preset.maxBitrateBps, CEILING.bitrateBps),
  };
};

/** 60 fps presets are for games (keep motion smooth); 30 fps keeps text sharp. */
const videoContentHint = (fps: number): 'motion' | 'detail' => (fps >= 60 ? 'motion' : 'detail');

/** The user closed the picker or declined: nothing to report. */
export const isCancelError = (error: unknown): boolean => {
  const name = (error as { name?: string } | null)?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
};

const notAllowed = (message: string): Error => {
  if (typeof DOMException === 'function') return new DOMException(message, 'NotAllowedError');
  const error = new Error(message);
  error.name = 'NotAllowedError';
  return error;
};

/**
 * Chromium 128+ can leave this page's own audio (the voice chat) out of a
 * system-audio capture so viewers do not hear themselves echoed back.
 */
export const supportsRestrictOwnAudio = (mediaDevices: DisplayMediaDevices | undefined = navigator.mediaDevices): boolean => {
  try {
    return mediaDevices?.getSupportedConstraints?.()?.restrictOwnAudio === true;
  } catch {
    return false;
  }
};

/** getDisplayMedia request for a preset; the audio hint is only sent when the engine advertises it. */
export const buildDisplayMediaRequest = (quality: unknown, restrictOwnAudio: boolean): DisplayMediaRequest => {
  const limits = screenQualityLimits(quality);
  const audio: MediaTrackConstraints & { restrictOwnAudio?: boolean } = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (restrictOwnAudio) audio.restrictOwnAudio = true;
  return {
    video: {
      width: { ideal: limits.width },
      height: { ideal: limits.height },
      frameRate: { ideal: limits.fps, max: limits.fps },
    },
    audio,
    systemAudio: 'include',
  };
};

const finish = (stream: MediaStream, source: ScreenCaptureResult['source'], quality: unknown): ScreenCaptureResult => {
  const limits = screenQualityLimits(quality);
  const video = stream.getVideoTracks()[0];
  if (video) video.contentHint = videoContentHint(limits.fps);
  const audio = stream.getAudioTracks()[0];
  if (audio) audio.contentHint = 'music';
  let ownAudioExcluded = false;
  try {
    ownAudioExcluded = (audio?.getSettings() as { restrictOwnAudio?: boolean } | undefined)?.restrictOwnAudio === true;
  } catch {
    /* settings unavailable */
  }
  return { stream, hasAudio: Boolean(audio && audio.readyState === 'live'), source, ownAudioExcluded };
};

const captureInDesktopShell = async (quality: unknown): Promise<ScreenCaptureResult | null> => {
  const bridge = window.desktopAPI;
  if (!bridge?.pickScreenshareSource) return null;
  const limits = screenQualityLimits(quality);
  // The quality is only a hint for the picker's footer; the result object is unchanged.
  const picked = await bridge.pickScreenshareSource({ audio: true, quality: { ...limits, label: screenQualityPreset(quality).label } });
  if (!picked?.success || !picked.source) throw notAllowed('Screen share was cancelled');
  const video = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: picked.source.id,
      maxWidth: limits.width,
      maxHeight: limits.height,
      maxFrameRate: limits.fps,
    },
  } as unknown as MediaTrackConstraints;
  const audio = picked.shareAudio ? ({ mandatory: { chromeMediaSource: 'desktop' } } as unknown as MediaTrackConstraints) : false;
  try {
    return finish(await navigator.mediaDevices.getUserMedia({ audio, video }), 'desktop', quality);
  } catch (error) {
    // System-audio loopback is not available on every OS (macOS needs a virtual
    // device). Share without sound rather than fail; the caller explains why.
    if (audio === false || isCancelError(error)) throw error;
    return finish(await navigator.mediaDevices.getUserMedia({ audio: false, video }), 'desktop', quality);
  }
};

const captureInBrowser = async (quality: unknown): Promise<ScreenCaptureResult> => {
  const mediaDevices = navigator.mediaDevices as DisplayMediaDevices | undefined;
  if (!mediaDevices?.getDisplayMedia) throw new Error('Screen sharing is not supported in this browser');
  const restrictOwnAudio = supportsRestrictOwnAudio(mediaDevices);
  try {
    return finish(await mediaDevices.getDisplayMedia(buildDisplayMediaRequest(quality, restrictOwnAudio)), 'browser', quality);
  } catch (error) {
    // An engine that advertises the hint but rejects it must not break the share.
    if (!restrictOwnAudio || isCancelError(error)) throw error;
    return finish(await mediaDevices.getDisplayMedia(buildDisplayMediaRequest(quality, false)), 'browser', quality);
  }
};

/**
 * Capture the screen (and system audio when the user allows it) at a preset.
 * Throws a NotAllowedError when the user cancels; see isCancelError.
 */
export const captureScreen = async (quality: unknown): Promise<ScreenCaptureResult> =>
  (await captureInDesktopShell(quality)) ?? captureInBrowser(quality);

/** Re-apply a preset to a running capture (resolution, frame rate, content hint). */
export const applyScreenQualityToStream = (stream: MediaStream, quality: unknown): void => {
  const limits = screenQualityLimits(quality);
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  track.contentHint = videoContentHint(limits.fps);
  void track
    .applyConstraints({
      width: { ideal: limits.width },
      height: { ideal: limits.height },
      frameRate: { ideal: limits.fps, max: limits.fps },
    })
    .catch(() => undefined);
};

/**
 * Encoder caps for a screen-share sender: the preset's bitrate and frame rate
 * for video, a music-grade bitrate for the screen's audio. Other senders are
 * left alone. Safe to call before and after negotiation.
 */
export const applyScreenEncoding = (sender: RTCRtpSender, quality: unknown): void => {
  const kind = sender.track?.kind;
  if (kind !== 'video' && kind !== 'audio') return;
  const limits = screenQualityLimits(quality);
  let parameters: RTCRtpSendParameters;
  try {
    parameters = sender.getParameters();
  } catch {
    return;
  }
  if (!parameters.encodings || parameters.encodings.length === 0) parameters.encodings = [{}];
  for (const encoding of parameters.encodings) {
    const target = encoding as RTCRtpEncodingParameters & { priority?: string; networkPriority?: string };
    if (kind === 'video') {
      target.maxBitrate = limits.maxBitrateBps;
      target.maxFramerate = limits.fps;
    } else {
      target.maxBitrate = SCREEN_AUDIO_BITRATE_BPS;
    }
    target.priority = 'high';
  }
  if (kind === 'video') parameters.degradationPreference = limits.fps >= 60 ? 'maintain-framerate' : 'maintain-resolution';
  sender.setParameters(parameters).catch((error: unknown) => {
    if (import.meta.env.DEV) console.warn('[screenCapture] setParameters failed', error);
  });
};

const isFirefox = (): boolean => typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent);

/** Shown to the host when the capture came back without an audio track. */
export const missingAudioHint = (source: ScreenCaptureResult['source']): string => {
  if (source === 'desktop') {
    return 'Sharing without sound. Pick a screen and tick "Share system audio" in the picker to stream game audio. Use headphones so your friends do not hear themselves twice.';
  }
  if (isFirefox()) {
    // Firefox's screen picker has no audio option at all (no tab or system audio capture).
    return 'Sharing without sound: Firefox cannot capture screen audio. To stream game sound, share from Chrome or Edge ("Entire screen" + "Share audio") or from the desktop app.';
  }
  return 'Sharing without sound. Choose "Entire screen" (or a browser tab) and tick "Share audio" in the picker to stream game audio. Use headphones so your friends do not hear themselves twice.';
};
