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

describe('VoiceService clips signals', () => {
  let service: VoiceService;

  beforeEach(() => {
    installAudioContext();
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: vi.fn(() => Promise.resolve()) });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: vi.fn() });
    service = new VoiceService();
  });

  afterEach(() => {
    service.dispose();
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('reads the clip permission from the screen metadata and reports changes once', () => {
    const changes: Array<{ peerId: string; allowed: boolean }> = [];
    service.on('video:remote:clips', (event) => changes.push(event as { peerId: string; allowed: boolean }));
    // Unknown friend, or an older client that sends no flag: allowed.
    expect(service.remoteScreenClipsAllowed('sock-bob')).toBe(true);
    service.handleStreamMetadata({ from: 'sock-bob', metadata: { streamId: 's1', type: 'screen' } });
    expect(service.remoteScreenClipsAllowed('sock-bob')).toBe(true);
    expect(changes).toEqual([{ peerId: 'sock-bob', allowed: true }]);
    // Bob says no, twice: one change.
    service.handleStreamMetadata({ from: 'sock-bob', metadata: { streamId: 's1', type: 'screen', allowClips: false } });
    service.handleStreamMetadata({ from: 'sock-bob', metadata: { streamId: 's1', type: 'screen', allowClips: false } });
    expect(service.remoteScreenClipsAllowed('sock-bob')).toBe(false);
    expect(changes).toHaveLength(2);
    // A camera carries no such flag and changes nothing; garbage is ignored.
    service.handleStreamMetadata({ from: 'sock-bob', metadata: { streamId: 's2', type: 'camera', allowClips: true } });
    service.handleStreamMetadata({ from: 'sock-bob', metadata: { streamId: 's3', type: 'bogus' as 'screen' } });
    expect(service.remoteScreenClipsAllowed('sock-bob')).toBe(false);
    expect(changes).toHaveLength(2);
    // The flag follows a reconnected socket.
    (service as unknown as { peers: Map<string, unknown> }).peers.set('sock-bob', { close: vi.fn() });
    service.rekeyPeer('sock-bob', 'sock-bob-2');
    expect(service.remoteScreenClipsAllowed('sock-bob-2')).toBe(false);
    expect(service.remoteScreenClipsAllowed('sock-bob')).toBe(true);
  });

  it('lists the voice streams it plays, for the clip mixer, and announces changes', () => {
    const events: Array<{ peerId: string; stream: MediaStream | null }> = [];
    service.on('voice:remote-audio', (event) => events.push(event as { peerId: string; stream: MediaStream | null }));
    const bobStream = { id: 'bob-audio' } as unknown as MediaStream;
    service.attachRemoteAudio('sock-bob', bobStream);
    expect(service.remoteAudioStreams()).toEqual([bobStream]);
    expect(events).toEqual([{ peerId: 'sock-bob', stream: bobStream }]);
    (service as unknown as { peers: Map<string, unknown> }).peers.set('sock-bob', { close: vi.fn() });
    service.removePeer('sock-bob');
    expect(service.remoteAudioStreams()).toEqual([]);
    expect(events[1]).toEqual({ peerId: 'sock-bob', stream: null });
  });

  it('sends the clip permission with the screen metadata and again when it changes', () => {
    const sent: Array<{ to: string; metadata: { streamId: string; type: string; allowClips?: boolean } }> = [];
    service.on('voice:send-stream-metadata', (event) => sent.push(event as (typeof sent)[number]));
    const screen = { id: 'screen-1', getVideoTracks: () => [{ kind: 'video' }], getAudioTracks: () => [] } as unknown as MediaStream;
    const sender = { track: { kind: 'video' }, getParameters: () => ({ encodings: [{}] }), setParameters: () => Promise.resolve() };
    const pc = { addTrack: vi.fn(() => sender) } as unknown as RTCPeerConnection;
    const internals = service as unknown as {
      localScreenStream: MediaStream | null;
      addVideoTrackToPeer: (peerId: string, pc: RTCPeerConnection, type: 'camera' | 'screen', stream: MediaStream) => void;
    };
    internals.localScreenStream = screen;
    internals.addVideoTrackToPeer('sock-bob', pc, 'screen', screen);
    expect(sent).toEqual([{ to: 'sock-bob', metadata: { streamId: 'screen-1', type: 'screen', allowClips: true } }]);
    service.setShareClipsAllowed(false);
    expect(sent[1]).toEqual({ to: 'sock-bob', metadata: { streamId: 'screen-1', type: 'screen', allowClips: false } });
    // Unchanged: nothing is sent; a camera never carries the flag.
    service.setShareClipsAllowed(false);
    expect(sent).toHaveLength(2);
    const camera = { id: 'cam-1', getVideoTracks: () => [{ kind: 'video' }], getAudioTracks: () => [] } as unknown as MediaStream;
    internals.addVideoTrackToPeer('sock-bob', pc, 'camera', camera);
    expect(sent[2]).toEqual({ to: 'sock-bob', metadata: { streamId: 'cam-1', type: 'camera' } });
    internals.localScreenStream = null;
  });
});

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
