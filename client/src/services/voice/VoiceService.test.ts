import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceService } from './VoiceService';

/** Fake AudioContext installed on window: records every gain node the service creates. */
const installAudioContext = () => {
  const gains: Array<{ gain: { value: number } }> = [];
  class FakeAudioContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    setSinkId = vi.fn(() => Promise.resolve());
    resume = vi.fn(() => Promise.resolve());
    close = vi.fn(() => Promise.resolve());
    createMediaStreamSource() {
      return { connect: vi.fn(), disconnect: vi.fn() };
    }
    createGain() {
      const node = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      gains.push(node);
      return node;
    }
    createAnalyser() {
      return { connect: vi.fn(), disconnect: vi.fn(), fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 128, getByteFrequencyData: vi.fn() };
    }
  }
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  return gains;
};

describe('VoiceService per-person volume', () => {
  let gains: Array<{ gain: { value: number } }>;
  let service: VoiceService;

  beforeEach(() => {
    gains = installAudioContext();
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: vi.fn(() => Promise.resolve()) });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: vi.fn() });
    localStorage.setItem('datasetto.voice.peerPreferences.v1', '{"old-socket":{"muted":true,"volume":0.1}}');
    service = new VoiceService();
  });

  afterEach(() => {
    service.dispose();
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('drops the old per-socket volume file and starts everyone at 100 % unmuted', () => {
    expect(localStorage.getItem('datasetto.voice.peerPreferences.v1')).toBeNull();
    expect(service.getPeerAudioPreference('anyone')).toEqual({ muted: false, volume: 1 });
    expect(service.peerGain('anyone')).toBeNull();
  });

  it('applies a setting made before the audio arrives, and changes the gain at once afterwards', () => {
    service.setPeerAudio('sock-bob', { muted: false, volume: 0.4 });
    expect(service.getPeerAudioPreference('sock-bob')).toEqual({ muted: false, volume: 0.4 });
    service.attachRemoteAudio('sock-bob', {} as MediaStream);
    expect(gains).toHaveLength(1);
    expect(gains[0].gain.value).toBeCloseTo(0.4);
    expect(service.peerGain('sock-bob')).toBeCloseTo(0.4);

    service.setPeerAudio('sock-bob', { muted: false, volume: 1.6 });
    expect(gains[0].gain.value).toBeCloseTo(1.6);
    service.setPeerAudio('sock-bob', { muted: true, volume: 1.6 });
    expect(gains[0].gain.value).toBe(0);
    expect((document.querySelector('audio[data-peer-id="sock-bob"]') as HTMLElement).dataset.gain).toBe('0');
    service.setPeerAudio('sock-bob', { muted: false, volume: 1.6 });
    expect(gains[0].gain.value).toBeCloseTo(1.6);
  });

  it('clamps the volume to 0..2 and ignores unusable numbers', () => {
    service.attachRemoteAudio('sock-bob', {} as MediaStream);
    service.setPeerAudio('sock-bob', { muted: false, volume: 7 });
    expect(gains[0].gain.value).toBe(2);
    service.setPeerAudio('sock-bob', { muted: false, volume: -3 });
    expect(gains[0].gain.value).toBe(0);
    service.setPeerAudio('sock-bob', { muted: false, volume: Number.NaN });
    expect(gains[0].gain.value).toBe(1);
  });

  it('combines the person volume with deafen and the output volume; each person has their own gain node', () => {
    service.attachRemoteAudio('sock-bob', {} as MediaStream);
    service.attachRemoteAudio('sock-carol', {} as MediaStream);
    expect(gains).toHaveLength(2);
    service.setPeerAudio('sock-bob', { muted: false, volume: 2 });
    service.setPeerAudio('sock-carol', { muted: false, volume: 0.5 });
    service.setOutputVolume(0.5);
    expect(gains[0].gain.value).toBe(1);
    expect(gains[1].gain.value).toBe(0.25);
    service.setDeafened(true);
    expect(gains[0].gain.value).toBe(0);
    expect(gains[1].gain.value).toBe(0);
    service.setDeafened(false);
    expect(gains[0].gain.value).toBe(1);
    expect(gains[1].gain.value).toBe(0.25);
  });

  it('forgets the socket entry when the peer leaves', () => {
    service.setPeerAudio('sock-bob', { muted: true, volume: 0.2 });
    service.attachRemoteAudio('sock-bob', {} as MediaStream);
    service.removePeer('sock-bob');
    expect(service.getPeerAudioPreference('sock-bob')).toEqual({ muted: false, volume: 1 });
    expect(service.peerGain('sock-bob')).toBeNull();
    expect(document.querySelector('audio[data-peer-id="sock-bob"]')).toBeNull();
  });
});
