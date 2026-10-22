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

/** Opus offer/answer as Chrome writes it, cut down to the lines the service rewrites. */
const OPUS_SDP = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1', ''].join('\r\n');

class FakeSender {
  params: { encodings: Array<Record<string, unknown>> } = { encodings: [{}] };
  constructor(
    public track: { kind: string; contentHint?: string } | null,
    private owner?: FakePeerConnection,
  ) {}
  getParameters = vi.fn(() => JSON.parse(JSON.stringify(this.params)) as RTCRtpSendParameters);
  setParameters = vi.fn(async (parameters: { encodings: Array<Record<string, unknown>> }) => {
    // Like Chrome on the answering side: before the answer is applied, the call does not stick.
    if (this.owner?.remoteDescription && !this.owner.localDescription) return;
    this.params = parameters;
  });
  replaceTrack = vi.fn(async (track: { kind: string } | null) => {
    this.track = track;
  });
  get maxBitrate() {
    return this.params.encodings[0]?.maxBitrate;
  }
}

class FakePeerConnection {
  static all: FakePeerConnection[] = [];
  senders: FakeSender[] = [];
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  signalingState = 'stable';
  connectionState = 'new';
  iceConnectionState = 'new';
  report = new Map<string, Record<string, unknown>>();
  createOffer = vi.fn(async () => ({ type: 'offer' as const, sdp: OPUS_SDP }));
  createAnswer = vi.fn(async () => ({ type: 'answer' as const, sdp: OPUS_SDP }));
  setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.localDescription = description;
  });
  setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.remoteDescription = description;
  });
  addTrack = vi.fn((track: { kind: string }) => {
    const sender = new FakeSender(track, this);
    this.senders.push(sender);
    return sender;
  });
  getSenders = () => this.senders;
  getStats = vi.fn(async () => this.report);
  close = vi.fn();
  constructor() {
    FakePeerConnection.all.push(this);
  }
}

describe('VoiceService data-saver voice', () => {
  let service: VoiceService;
  const offers: Array<{ peerId: string; sdp: string }> = [];
  const original = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  const originalDescription = (globalThis as { RTCSessionDescription?: unknown }).RTCSessionDescription;

  const micStream = () => {
    const track = { kind: 'audio', contentHint: '' };
    return { id: 'mic', getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  };
  const pcFor = (index: number) => FakePeerConnection.all[index];
  const voiceSenderOf = (index: number) => pcFor(index).senders.find((sender) => sender.track?.kind === 'audio' && !(sender as { screen?: boolean }).screen)!;
  const createOfferCalls = () => FakePeerConnection.all.reduce((sum, pc) => sum + pc.createOffer.mock.calls.length, 0);
  const maxAverage = (sdp: string) => /maxaveragebitrate=(\d+)/.exec(sdp)?.[1];

  beforeEach(async () => {
    installAudioContext();
    FakePeerConnection.all = [];
    offers.length = 0;
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePeerConnection;
    (globalThis as { RTCSessionDescription?: unknown }).RTCSessionDescription = class {
      constructor(init: RTCSessionDescriptionInit) {
        Object.assign(this, init);
      }
    };
    service = new VoiceService(128000, true);
    service.on('voice:offer', ({ peerId, offer }) => offers.push({ peerId, sdp: offer.sdp ?? '' }));
    service.setLocalStream(micStream());
    await service.createOffer('sock-bob');
    await service.createOffer('sock-carol');
  });

  afterEach(() => {
    service.dispose();
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = original;
    (globalThis as { RTCSessionDescription?: unknown }).RTCSessionDescription = originalDescription;
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('sends at the full bitrate and asks for it while the link is fine', () => {
    expect(voiceSenderOf(0).maxBitrate).toBe(128000);
    expect(voiceSenderOf(1).maxBitrate).toBe(128000);
    expect(offers.map((offer) => maxAverage(offer.sdp))).toEqual(['128000', '128000']);
  });

  it('caps every voice sender at 24 kbps with setParameters and no renegotiation, and the next SDP asks for 24 kbps', async () => {
    const before = createOfferCalls();
    const calls = [voiceSenderOf(0).setParameters.mock.calls.length, voiceSenderOf(1).setParameters.mock.calls.length];
    service.setLinkConstrained(true);
    expect(voiceSenderOf(0).maxBitrate).toBe(24000);
    expect(voiceSenderOf(1).maxBitrate).toBe(24000);
    expect(voiceSenderOf(0).setParameters.mock.calls.length).toBe(calls[0] + 1);
    expect(voiceSenderOf(1).setParameters.mock.calls.length).toBe(calls[1] + 1);
    expect(createOfferCalls()).toBe(before);
    expect(voiceSenderOf(0).params.encodings[0].dtx).toBe(true);

    // Setting the same state again does nothing.
    service.setLinkConstrained(true);
    expect(voiceSenderOf(0).setParameters.mock.calls.length).toBe(calls[0] + 1);

    await service.createOffer('sock-bob');
    expect(maxAverage(offers.at(-1)!.sdp)).toBe('24000');

    service.setLinkConstrained(false);
    expect(voiceSenderOf(0).maxBitrate).toBe(128000);
    await service.createOffer('sock-bob');
    expect(maxAverage(offers.at(-1)!.sdp)).toBe('128000');
  });

  it('applies the cap on the answering side too, once the answer is set', async () => {
    service.setLinkConstrained(true);
    await service.handleOffer('sock-erin', { type: 'offer', sdp: OPUS_SDP });
    const erin = FakePeerConnection.all.at(-1)!;
    expect(erin.senders[0].maxBitrate).toBe(24000);
    expect(maxAverage(erin.localDescription?.sdp ?? '')).toBe('24000');
  });

  it('never goes above the bitrate chosen in the settings', () => {
    service.updateVoiceSettings(16000, true);
    service.setLinkConstrained(true);
    expect(voiceSenderOf(0).maxBitrate).toBe(16000);
  });

  it('caps only the sender to a peer that reports a constrained link', () => {
    const before = createOfferCalls();
    service.setPeerLinkConstrained('sock-bob', true);
    expect(voiceSenderOf(0).maxBitrate).toBe(24000);
    expect(voiceSenderOf(1).maxBitrate).toBe(128000);
    expect(createOfferCalls()).toBe(before);

    // A settings change keeps the per-peer cap.
    service.updateVoiceSettings(96000, true);
    expect(voiceSenderOf(0).maxBitrate).toBe(24000);
    expect(voiceSenderOf(1).maxBitrate).toBe(96000);

    service.setPeerLinkConstrained('sock-bob', false);
    expect(voiceSenderOf(0).maxBitrate).toBe(96000);
  });

  it('keeps a peer cap across a rekey and applies one that arrived before the connection', async () => {
    service.setPeerLinkConstrained('sock-bob', true);
    expect(service.rekeyPeer('sock-bob', 'sock-bob-2')).toBe(true);
    expect(service.voiceSenderBitrate('sock-bob-2')).toBe(24000);
    service.updateVoiceSettings(128000, true);
    expect(voiceSenderOf(0).maxBitrate).toBe(24000);

    service.setPeerLinkConstrained('sock-dave', true);
    await service.createOffer('sock-dave');
    expect(voiceSenderOf(2).maxBitrate).toBe(24000);
    service.forgetPeerLink('sock-dave');
    expect(service.voiceSenderBitrate('sock-dave')).toBe(128000);
  });

  it('leaves the screen share audio sender alone', () => {
    const screenAudio = Object.assign(new FakeSender({ kind: 'audio' }), { screen: true });
    pcFor(0).senders.unshift(screenAudio);
    (service as unknown as { videoSenders: Map<string, { screenAudio?: unknown }> }).videoSenders.set('sock-bob', { screenAudio });
    service.setLinkConstrained(true);
    expect(screenAudio.setParameters).not.toHaveBeenCalled();
    expect(voiceSenderOf(0).maxBitrate).toBe(24000);
  });

  it('reports what the call needs against what the browser estimates, after each stats round', async () => {
    const samples: unknown[] = [];
    service.on('voice:bandwidth', (sample) => samples.push(sample));
    const internals = service as unknown as { pollConnectionStats: () => Promise<void> };

    await internals.pollConnectionStats();
    expect(samples).toEqual([null]);

    const pair = (estimate: number) => ({ type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.04, availableOutgoingBitrate: estimate });
    pcFor(0).report.set('pair', pair(100_000));
    pcFor(1).report.set('pair', pair(150_000));
    service.setPeerLinkConstrained('sock-carol', true);
    await internals.pollConnectionStats();
    expect(samples.at(-1)).toEqual({ estimate: 250_000, need: 128_000 + 25_000 + 24_000 + 25_000 });
    expect(service.getPeerStats('sock-bob')?.availableOutgoingBitrate).toBe(100_000);
  });
});
