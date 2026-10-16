import { describe, expect, it, vi } from 'vitest';
import {
  SCREEN_AUDIO_BITRATE_BPS,
  SCREEN_QUALITY_PRESETS,
  applyScreenEncoding,
  buildDisplayMediaRequest,
  isCancelError,
  missingAudioHint,
  screenQualityLimits,
  screenQualityPreset,
  supportsRestrictOwnAudio,
} from './screenCapture';
import { normalizeAudioSettings } from '@/state/settings';

describe('screen quality presets', () => {
  it('falls back to 720p30 for unknown values', () => {
    expect(screenQualityPreset('1080p60').id).toBe('1080p60');
    expect(screenQualityPreset('potato').id).toBe('720p30');
    expect(screenQualityPreset(undefined).id).toBe('720p30');
  });

  it('keeps the presets under the deployment ceilings', () => {
    for (const preset of Object.values(SCREEN_QUALITY_PRESETS)) {
      const limits = screenQualityLimits(preset.id);
      expect(limits.fps).toBeLessThanOrEqual(preset.fps);
      expect(limits.maxBitrateBps).toBeLessThanOrEqual(preset.maxBitrateBps);
      expect(limits.width).toBe(preset.width);
      expect(limits.height).toBe(preset.height);
    }
    expect(screenQualityLimits('1080p60').fps).toBe(60);
    expect(screenQualityLimits('720p30').maxBitrateBps).toBeLessThan(screenQualityLimits('1080p60').maxBitrateBps);
  });

  it('is persisted through the audio settings with validation', () => {
    expect(normalizeAudioSettings({}).screenQuality).toBe('720p30');
    expect(normalizeAudioSettings({ screenQuality: '1080p60' }).screenQuality).toBe('1080p60');
    expect(normalizeAudioSettings({ screenQuality: 'nope' as never }).screenQuality).toBe('720p30');
  });
});

describe('getDisplayMedia request', () => {
  it('asks for the preset size and frame rate with unprocessed system audio', () => {
    const request = buildDisplayMediaRequest('1080p60', false);
    expect(request.video).toEqual({ width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 } });
    expect(request.audio).toEqual({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    expect(request.systemAudio).toBe('include');
  });

  it('only sends restrictOwnAudio when the engine advertises it', () => {
    expect((buildDisplayMediaRequest('720p30', true).audio as { restrictOwnAudio?: boolean }).restrictOwnAudio).toBe(true);
    expect('restrictOwnAudio' in (buildDisplayMediaRequest('720p30', false).audio as object)).toBe(false);
    expect(supportsRestrictOwnAudio({ getSupportedConstraints: () => ({ restrictOwnAudio: true }) } as never)).toBe(true);
    expect(supportsRestrictOwnAudio({ getSupportedConstraints: () => ({}) } as never)).toBe(false);
    expect(supportsRestrictOwnAudio({} as never)).toBe(false);
    expect(supportsRestrictOwnAudio(undefined)).toBe(false);
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
