import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SCREEN_QUALITY,
  SCREEN_AUDIO_BITRATE_BPS,
  SCREEN_QUALITY_OPTIONS,
  SCREEN_QUALITY_PRESETS,
  applyScreenEncoding,
  applyScreenQualityToStream,
  buildDisplayMediaRequest,
  captureScreen,
  classifyOwnAudio,
  detectPlatform,
  isCancelError,
  isSharingScreenAudio,
  missingAudioHint,
  ownAudioWarning,
  screenAudioNotice,
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
    // A shared window sends only that app's sound where Chromium can; the Datasetto tab is never offered.
    expect(request.windowAudio).toBe('window');
    expect(request.selfBrowserSurface).toBe('exclude');
  });

  it('asks for the picture only when the share has no sound', () => {
    const request = buildDisplayMediaRequest('720p30', true, false);
    expect(request.audio).toBe(false);
    expect(request.systemAudio).toBeUndefined();
    expect(request.windowAudio).toBeUndefined();
    expect(request.video).toEqual({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } });
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
  });
});

describe("Datasetto's own sound in the shared audio", () => {
  it('reads the audio device the engine opened', () => {
    // Process loopback without this app (Windows 11, macOS 14.2+).
    expect(classifyOwnAudio({ deviceId: 'loopbackWithoutChrome', restrictOwnAudio: true }, { displaySurface: 'monitor' })).toBe('excluded');
    // Plain whole-system loopback carries our playback, whatever the settings claim.
    expect(classifyOwnAudio({ deviceId: 'loopback' }, { displaySurface: 'monitor' })).toBe('included');
    expect(classifyOwnAudio({ deviceId: 'loopback', restrictOwnAudio: true }, { displaySurface: 'monitor' })).toBe('included');
    expect(classifyOwnAudio({ deviceId: 'loopbackWithMute' }, { displaySurface: 'monitor' })).toBe('included');
    // One app's sound (a shared window on Windows 11).
    expect(classifyOwnAudio({ deviceId: 'applicationLoopback:4321' }, { displaySurface: 'window' })).toBe('excluded');
    expect(classifyOwnAudio({ deviceId: 'restrictOwnAudioBrowserLoopback:99' }, { displaySurface: 'window' })).toBe('excluded');
  });

  it('falls back to restrictOwnAudio and the shared surface without a known device id', () => {
    expect(classifyOwnAudio({ restrictOwnAudio: true }, { displaySurface: 'monitor' })).toBe('excluded');
    expect(classifyOwnAudio({ restrictOwnAudio: false }, { displaySurface: 'monitor' })).toBe('included');
    expect(classifyOwnAudio({}, { displaySurface: 'window' })).toBe('included');
    // Another tab's sound only.
    expect(classifyOwnAudio({ deviceId: 'web-contents-media-stream://1:2' }, { displaySurface: 'browser' })).toBe('excluded');
    expect(classifyOwnAudio(null, { displaySurface: 'monitor' })).toBe('none');
    expect(classifyOwnAudio({}, null)).toBe('included');
  });

  it('names the operating system for the warning', () => {
    expect(detectPlatform({ userAgentData: { platform: 'Windows' } })).toBe('windows');
    expect(detectPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141' })).toBe('windows');
    expect(detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron/44.8.0' })).toBe('mac');
    expect(detectPlatform({ userAgentData: { platform: 'macOS' } })).toBe('mac');
    expect(detectPlatform({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe('linux');
    expect(detectPlatform({})).toBe('other');
  });

  it('warns honestly when the system cannot leave Datasetto out', () => {
    expect(ownAudioWarning('desktop', true, 'windows')).toMatch(/^Windows 10 cannot leave Datasetto out.*hear themselves echoed back\. Windows 11 can\.$/);
    expect(ownAudioWarning('desktop', true, 'mac')).toMatch(/macOS 14\.2 or later can\.$/);
    expect(ownAudioWarning('desktop', true, 'linux')).toMatch(/^Linux cannot leave Datasetto out/);
    // In a browser, sharing a tab is a way out everywhere.
    expect(ownAudioWarning('browser', true, 'windows')).toMatch(/Windows 11 can\. Sharing a browser tab avoids it\.$/);
    // We did not ask (old engine) or the request with the exclusion failed: no blaming the OS.
    expect(ownAudioWarning('browser', false, 'windows')).toMatch(/^Datasetto's own sound could not be left out.*Chrome or Edge on Windows 11 or macOS 14\.2\+ can leave it out\./);
    expect(ownAudioWarning('desktop', false, 'windows')).toBe(
      "Datasetto's own sound could not be left out of the shared audio, so your friends may hear themselves echoed back.",
    );
    // Nothing suggests headphones: they do not keep a loopback from capturing the output.
    expect(ownAudioWarning('desktop', true, 'windows')).not.toMatch(/headphones/i);
  });

  it('picks the toast for the host after a share started', () => {
    expect(screenAudioNotice({ source: 'desktop', ownAudio: 'excluded', restrictRequested: true }, 'windows')).toBeNull();
    expect(screenAudioNotice({ source: 'desktop', ownAudio: 'none', restrictRequested: true }, 'windows')).toBe(missingAudioHint('desktop'));
    expect(screenAudioNotice({ source: 'desktop', ownAudio: 'included', restrictRequested: true }, 'windows')).toBe(ownAudioWarning('desktop', true, 'windows'));
    expect(screenAudioNotice({ source: 'browser', ownAudio: 'included', restrictRequested: false }, 'mac')).toBe(ownAudioWarning('browser', false, 'mac'));
  });
});

type FakeTrack = MediaStreamTrack & { settings: Record<string, unknown> };

const fakeTrack = (kind: 'audio' | 'video', settings: Record<string, unknown>): FakeTrack => {
  const track = {
    kind,
    contentHint: '',
    readyState: 'live',
    settings,
    getSettings: () => settings,
    stop() {
      (track as { readyState: string }).readyState = 'ended';
    },
  };
  return track as unknown as FakeTrack;
};

const fakeStream = (audioSettings: Record<string, unknown> | null, videoSettings: Record<string, unknown> = { displaySurface: 'monitor' }): MediaStream => {
  const audio = audioSettings ? [fakeTrack('audio', audioSettings)] : [];
  const video = [fakeTrack('video', videoSettings)];
  return {
    getAudioTracks: () => audio,
    getVideoTracks: () => video,
    getTracks: () => [...audio, ...video],
  } as unknown as MediaStream;
};

const cancelled = (): Error => Object.assign(new Error('cancelled'), { name: 'NotAllowedError' });

describe('captureScreen', () => {
  const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

  const install = (mediaDevices: Record<string, unknown>, desktopAPI?: Record<string, unknown>) => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
    (window as unknown as { desktopAPI?: unknown }).desktopAPI = desktopAPI;
  };

  afterEach(() => {
    if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
    else delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
    delete (window as unknown as { desktopAPI?: unknown }).desktopAPI;
    vi.restoreAllMocks();
  });

  const supported = () => ({ restrictOwnAudio: true });

  it('desktop: hands the pick to getDisplayMedia and asks for system audio without Datasetto', async () => {
    const getDisplayMedia = vi.fn(async () => fakeStream({ deviceId: 'loopbackWithoutChrome', restrictOwnAudio: true }));
    const getUserMedia = vi.fn();
    const pickScreenshareSource = vi.fn(async () => ({ success: true, source: { id: 'screen:0:0', name: 'Screen 1' }, shareAudio: true, displayMedia: true }));
    install({ getDisplayMedia, getUserMedia, getSupportedConstraints: supported }, { pickScreenshareSource });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const capture = await captureScreen('1080p60');

    expect(pickScreenshareSource).toHaveBeenCalledWith(expect.objectContaining({ audio: true, displayMedia: true }));
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    const request = (getDisplayMedia.mock.calls[0] as unknown[])[0] as { audio: { restrictOwnAudio?: boolean } };
    expect(request.audio.restrictOwnAudio).toBe(true);
    expect(capture).toMatchObject({ source: 'desktop', hasAudio: true, ownAudio: 'excluded', restrictRequested: true });
    expect(screenAudioNotice(capture, 'windows')).toBeNull();
    expect(isSharingScreenAudio()).toBe(true);
    capture.stream.getTracks().forEach((track) => track.stop());
    expect(isSharingScreenAudio()).toBe(false);
  });

  it('desktop: when the excluding loopback cannot open, shares plain system audio, then the picture alone', async () => {
    const plain = fakeStream({ deviceId: 'loopback' });
    const getDisplayMedia = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Could not start audio source'), { name: 'NotReadableError' }))
      .mockResolvedValueOnce(plain);
    const pickScreenshareSource = vi.fn(async () => ({ success: true, source: { id: 'window:42:0', name: 'Game' }, shareAudio: true, displayMedia: true }));
    install({ getDisplayMedia, getSupportedConstraints: supported }, { pickScreenshareSource });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const capture = await captureScreen('720p30');
    expect(getDisplayMedia.mock.calls.map(([request]) => [request.audio === false ? false : (request.audio.restrictOwnAudio ?? false), request.audio !== false])).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(capture).toMatchObject({ ownAudio: 'included', restrictRequested: false });
    expect(screenAudioNotice(capture, 'windows')).toMatch(/could not be left out/);

    const videoOnly = fakeStream(null);
    const failing = vi
      .fn()
      .mockRejectedValueOnce(new Error('no excluding loopback'))
      .mockRejectedValueOnce(new Error('no loopback at all'))
      .mockResolvedValueOnce(videoOnly);
    install({ getDisplayMedia: failing, getSupportedConstraints: supported }, { pickScreenshareSource });
    const silent = await captureScreen('720p30');
    expect(failing).toHaveBeenCalledTimes(3);
    expect((failing.mock.calls[2] as unknown[])[0]).toMatchObject({ audio: false });
    expect(silent).toMatchObject({ hasAudio: false, ownAudio: 'none' });
  });

  it('desktop: does not ask for audio the user switched off, and stops at a cancel', async () => {
    const getDisplayMedia = vi.fn(async () => fakeStream(null));
    install({ getDisplayMedia, getSupportedConstraints: supported }, { pickScreenshareSource: async () => ({ success: true, source: { id: 'screen:1:0' }, shareAudio: false, displayMedia: true }) });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await captureScreen('1080p60');
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect((getDisplayMedia.mock.calls[0] as unknown[])[0]).toMatchObject({ audio: false });

    const denied = vi.fn().mockRejectedValue(cancelled());
    install({ getDisplayMedia: denied, getSupportedConstraints: supported }, { pickScreenshareSource: async () => ({ success: true, source: { id: 'screen:1:0' }, shareAudio: true, displayMedia: true }) });
    await expect(captureScreen('1080p60')).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(denied).toHaveBeenCalledTimes(1);

    install({ getDisplayMedia, getSupportedConstraints: supported }, { pickScreenshareSource: async () => ({ success: false, error: 'cancelled' }) });
    await expect(captureScreen('1080p60')).rejects.toSatisfy(isCancelError);
  });

  it('desktop: an older shell without the hand-over keeps the getUserMedia route and is reported as including Datasetto', async () => {
    const getDisplayMedia = vi.fn();
    const getUserMedia = vi.fn(async () => fakeStream({ deviceId: 'loopback' }));
    install({ getDisplayMedia, getUserMedia, getSupportedConstraints: supported }, { pickScreenshareSource: async () => ({ success: true, source: { id: 'screen:0:0' }, shareAudio: true }) });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const capture = await captureScreen('native60');
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect((getUserMedia.mock.calls[0] as unknown[])[0]).toMatchObject({ audio: { mandatory: { chromeMediaSource: 'desktop' } } });
    expect(capture).toMatchObject({ ownAudio: 'included', restrictRequested: false });
  });

  it('browser: asks with restrictOwnAudio where the engine knows it and reports what the OS did', async () => {
    // Windows 10: Chromium drops the constraint and opens plain loopback.
    const getDisplayMedia = vi.fn(async () => fakeStream({ deviceId: 'loopback', restrictOwnAudio: false }));
    install({ getDisplayMedia, getSupportedConstraints: supported });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const capture = await captureScreen('1080p60');
    expect(((getDisplayMedia.mock.calls[0] as unknown[])[0] as { audio: { restrictOwnAudio?: boolean } }).audio.restrictOwnAudio).toBe(true);
    expect(capture).toMatchObject({ source: 'browser', ownAudio: 'included', restrictRequested: true });
    expect(screenAudioNotice(capture, 'windows')).toMatch(/^Windows 10 cannot leave Datasetto out/);

    // An engine without the constraint never gets it.
    const older = vi.fn(async () => fakeStream({ deviceId: 'loopback' }));
    install({ getDisplayMedia: older, getSupportedConstraints: () => ({}) });
    const oldCapture = await captureScreen('1080p60');
    expect('restrictOwnAudio' in (((older.mock.calls[0] as unknown[])[0] as { audio: object }).audio)).toBe(false);
    expect(screenAudioNotice(oldCapture, 'windows')).toMatch(/could not be left out/);
  });
});
