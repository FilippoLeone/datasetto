import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SCREEN_QUALITY,
  SCREEN_AUDIO_BITRATE_BPS,
  SCREEN_QUALITY_OPTIONS,
  SCREEN_QUALITY_PRESETS,
  applyScreenEncoding,
  applyScreenQualityToStream,
  buildDisplayMediaRequest,
  isCancelError,
  missingAudioHint,
  screenQualityLimits,
  screenQualityPreset,
  supportsRestrictOwnAudio,
} from './screenCapture';
import { DEFAULT_AUDIO_SETTINGS, normalizeAudioSettings } from '@/state/settings';
import { formatVideoStats } from '@/features/voice/VideoTile';

describe('screen quality presets', () => {
  it('defaults to 1080p60 and falls back to it for unknown values', () => {
    expect(DEFAULT_SCREEN_QUALITY).toBe('1080p60');
    expect(screenQualityPreset('720p30').id).toBe('720p30');
    expect(screenQualityPreset('native120').id).toBe('native120');
    expect(screenQualityPreset('potato').id).toBe('1080p60');
    expect(screenQualityPreset(undefined).id).toBe('1080p60');
    expect(SCREEN_QUALITY_OPTIONS.map((option) => option.value)).toEqual(['720p30', '1080p60', 'native60', 'native120']);
  });

  it('keeps the presets under the deployment ceilings and orders their bitrates', () => {
    for (const preset of Object.values(SCREEN_QUALITY_PRESETS)) {
      const limits = screenQualityLimits(preset.id);
      expect(limits.fps).toBeLessThanOrEqual(preset.fps);
      expect(limits.maxBitrateBps).toBeLessThanOrEqual(preset.maxBitrateBps);
      expect(limits.width).toBe(preset.width);
      expect(limits.height).toBe(preset.height);
    }
    expect(screenQualityLimits('1080p60').fps).toBe(60);
    expect(screenQualityLimits('native120').fps).toBe(120);
    const bitrates = ['720p30', '1080p60', 'native60', 'native120'].map((id) => screenQualityLimits(id).maxBitrateBps);
    expect([...bitrates].sort((a, b) => a - b)).toEqual(bitrates);
    // Sensible cap: even the competitive preset stays well under the 25 Mbit/s deployment ceiling.
    expect(screenQualityLimits('native120').maxBitrateBps).toBeLessThanOrEqual(20_000_000);
  });

  it('is persisted through the audio settings with validation', () => {
    expect(DEFAULT_AUDIO_SETTINGS.screenQuality).toBe('1080p60');
    expect(normalizeAudioSettings({}).screenQuality).toBe('1080p60');
    expect(normalizeAudioSettings({ screenQuality: '720p30' }).screenQuality).toBe('720p30');
    expect(normalizeAudioSettings({ screenQuality: 'native60' }).screenQuality).toBe('native60');
    expect(normalizeAudioSettings({ screenQuality: 'nope' as never }).screenQuality).toBe('1080p60');
  });

  it('defaults voice to 128 kbps Opus while lower values stay allowed', () => {
    expect(DEFAULT_AUDIO_SETTINGS.voiceBitrate).toBe(128000);
    expect(normalizeAudioSettings({ voiceBitrate: 32000 }).voiceBitrate).toBe(32000);
  });
});

describe('getDisplayMedia request', () => {
  it('asks for the preset size and frame rate with unprocessed system audio', () => {
    const request = buildDisplayMediaRequest('1080p60', false);
    expect(request.video).toEqual({ width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 } });
    expect(request.audio).toEqual({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    expect(request.systemAudio).toBe('include');
  });

  it('leaves the size to the display for native presets and asks for 120 fps where allowed', () => {
    expect(buildDisplayMediaRequest('native60', false).video).toEqual({ frameRate: { ideal: 60, max: 60 } });
    expect(buildDisplayMediaRequest('native120', false).video).toEqual({ frameRate: { ideal: 120, max: 120 } });
  });

  it('only sends restrictOwnAudio when the engine advertises it', () => {
    expect((buildDisplayMediaRequest('720p30', true).audio as { restrictOwnAudio?: boolean }).restrictOwnAudio).toBe(true);
    expect('restrictOwnAudio' in (buildDisplayMediaRequest('720p30', false).audio as object)).toBe(false);
    expect(supportsRestrictOwnAudio({ getSupportedConstraints: () => ({ restrictOwnAudio: true }) } as never)).toBe(true);
    expect(supportsRestrictOwnAudio({ getSupportedConstraints: () => ({}) } as never)).toBe(false);
    expect(supportsRestrictOwnAudio({} as never)).toBe(false);
    expect(supportsRestrictOwnAudio(undefined)).toBe(false);
  });

  it('re-applies a preset to a running capture without forcing a size for native presets', () => {
    const applyConstraints = vi.fn(() => Promise.resolve());
    const track = { contentHint: '', applyConstraints } as unknown as MediaStreamTrack;
    const stream = { getVideoTracks: () => [track] } as unknown as MediaStream;
    applyScreenQualityToStream(stream, 'native120');
    expect(track.contentHint).toBe('motion');
    expect(applyConstraints).toHaveBeenCalledWith({ frameRate: { ideal: 120, max: 120 } });
    applyScreenQualityToStream(stream, '720p30');
    expect(track.contentHint).toBe('detail');
    expect(applyConstraints).toHaveBeenLastCalledWith({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } });
  });
});

describe('applyScreenEncoding', () => {
  const fakeSender = (kind: 'audio' | 'video', encodings: RTCRtpEncodingParameters[] = []) => {
    const setParameters = vi.fn<(parameters: RTCRtpSendParameters) => Promise<void>>(() => Promise.resolve());
    const sender = {
      track: { kind },
      getParameters: () => ({ encodings, codecs: [], headerExtensions: [], rtcp: {}, transactionId: 't' }),
      setParameters,
    } as unknown as RTCRtpSender;
    return { sender, setParameters };
  };

  it('caps video at the preset bitrate and frame rate', () => {
    const { sender, setParameters } = fakeSender('video');
    applyScreenEncoding(sender, '1080p60');
    const parameters = setParameters.mock.calls[0][0];
    expect(parameters.encodings[0].maxBitrate).toBe(screenQualityLimits('1080p60').maxBitrateBps);
    expect(parameters.encodings[0].maxFramerate).toBe(60);
    expect(parameters.degradationPreference).toBe('maintain-framerate');

    const competitive = fakeSender('video');
    applyScreenEncoding(competitive.sender, 'native120');
    expect(competitive.setParameters.mock.calls[0][0].encodings[0].maxFramerate).toBe(120);
    expect(competitive.setParameters.mock.calls[0][0].encodings[0].maxBitrate).toBe(18_000_000);
  });

  it('prefers resolution at 30 fps and gives the screen audio a music bitrate', () => {
    const video = fakeSender('video', [{ maxBitrate: 1 }]);
    applyScreenEncoding(video.sender, '720p30');
    expect(video.setParameters.mock.calls[0][0].degradationPreference).toBe('maintain-resolution');
    const audio = fakeSender('audio');
    applyScreenEncoding(audio.sender, '720p30');
    expect(audio.setParameters.mock.calls[0][0].encodings[0].maxBitrate).toBe(SCREEN_AUDIO_BITRATE_BPS);
  });

  it('ignores senders without a track', () => {
    const setParameters = vi.fn();
    applyScreenEncoding({ track: null, setParameters } as unknown as RTCRtpSender, '720p30');
    expect(setParameters).not.toHaveBeenCalled();
  });
});

describe('tile stats label', () => {
  it('shows the effective resolution and frame rate', () => {
    expect(formatVideoStats(1920, 1080, 59.94)).toBe('1920×1080 · 60 fps');
    expect(formatVideoStats(2560, 1440, null)).toBe('2560×1440');
    expect(formatVideoStats(0, 0, 60)).toBe('');
  });
});

describe('errors and hints', () => {
  it('treats a closed picker as a cancel, not an error', () => {
    expect(isCancelError({ name: 'NotAllowedError' })).toBe(true);
    expect(isCancelError({ name: 'AbortError' })).toBe(true);
    expect(isCancelError(new Error('boom'))).toBe(false);
    expect(isCancelError(null)).toBe(false);
  });

  it('tells the host how to get sound on each platform', () => {
    expect(missingAudioHint('browser')).toMatch(/Entire screen/);
    expect(missingAudioHint('browser')).toMatch(/Share audio/);
    expect(missingAudioHint('desktop')).toMatch(/Share system audio/);
    expect(missingAudioHint('desktop')).toMatch(/headphones/i);
  });
});
