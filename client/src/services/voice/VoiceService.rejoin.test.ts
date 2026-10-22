/**
 * The camera and the transport after a drop: two VoiceServices talk to each other through a
 * fake RTCPeerConnection that models what matters here (m-lines and their directions, offer
 * and answer states, rollback, new ICE credentials on a restart, DTLS fingerprints). Each test
 * replays one way a connection gets renegotiated after a reconnect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFER_STALE_MS } from './negotiation';
import { VoiceService } from './VoiceService';

type Dir = RTCRtpTransceiverDirection;
const sends = (d: Dir | null) => d === 'sendrecv' || d === 'sendonly';
const receives = (d: Dir | null) => d === 'sendrecv' || d === 'recvonly';
const dirOf = (send: boolean, recv: boolean): Dir => (send && recv ? 'sendrecv' : send ? 'sendonly' : recv ? 'recvonly' : 'inactive');
const flip = (d: Dir): Dir => dirOf(receives(d), sends(d));

class FakeTrack {
  readyState: MediaStreamTrackState = 'live';
  contentHint = '';
  constructor(
    public kind: 'audio' | 'video',
    public id: string,
  ) {}
  addEventListener() {}
  removeEventListener() {}
  getSettings() {
    return {};
  }
  stop() {
    this.readyState = 'ended';
  }
}

class FakeStream {
  constructor(
    public id: string,
    private tracks: FakeTrack[],
  ) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  addEventListener() {}
  removeEventListener() {}
}

class FakeSender {
  constructor(public track: FakeTrack | null) {}
  async replaceTrack(track: FakeTrack | null) {
    this.track = track;
  }
  getParameters() {
    return { encodings: [{}] };
  }
  setParameters() {
    return Promise.resolve();
  }
}

class FakeTransceiver {
  mid: string | null = null;
  currentDirection: Dir | null = null;
  sender: FakeSender;
  receiver: { track: FakeTrack };
  /** Given by a local offer that may still be taken back. */
  provisionalMid = false;
  remoteTrackShown = false;
  constructor(
    public kind: 'audio' | 'video',
    public direction: Dir,
    track: FakeTrack | null,
    public fromRemote = false,
  ) {
    this.sender = new FakeSender(track);
    this.receiver = { track: new FakeTrack(kind, 'rx-' + kind) };
  }
}

interface Line {
  mid: string;
  kind: 'audio' | 'video';
  dir: Dir;
}

const parse = (sdp: string) => {
  const lines: Line[] = [];
  let ufrag = '';
  for (const row of sdp.split(/\r?\n/)) {
    if (row.startsWith('a=ice-ufrag:')) ufrag = row.slice(12);
    else if (row.startsWith('m=')) {
      const [kind, mid, dir] = row.slice(2).split(' ');
      lines.push({ kind: kind as 'audio' | 'video', mid, dir: dir as Dir });
    }
  }
  return { lines, ufrag };
};
const ufragOf = (desc: { sdp: string } | null) => (desc ? parse(desc.sdp).ufrag : null);

let fingerprints = 0;
const invalidState = (message: string) => Object.assign(new Error(message), { name: 'InvalidStateError' });

class FakePeerConnection {
  static all: FakePeerConnection[] = [];
  /** Report "connected" as soon as a negotiation completes (off: the transport stays as the test sets it). */
  static autoConnect = true;
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  localDescription: { type: RTCSdpType; sdp: string } | null = null;
  remoteDescription: { type: RTCSdpType; sdp: string } | null = null;
  transceivers: FakeTransceiver[] = [];
  readonly name = 'P' + ++fingerprints;
  /** Our ICE credentials generation: a new one with each ICE restart, ours or theirs. */
  ufrag = 1;
  private ufragBeforeOffer = 1;
  nextMid = 0;
  onicecandidate: unknown = null;
  onicecandidateerror: unknown = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: { track: FakeTrack; streams: FakeStream[] }) => void) | null = null;
  private remoteOffer: Line[] | null = null;

  constructor() {
    FakePeerConnection.all.push(this);
  }

  getTransceivers() {
    return this.transceivers;
  }
  getSenders() {
    return this.transceivers.map((t) => t.sender);
  }
  getStats() {
    return Promise.resolve(new Map());
  }
  restartIce() {}
  close() {
    this.connectionState = 'closed';
    this.signalingState = 'closed';
  }
  addTrack(track: FakeTrack) {
    // addTrack reuses a line their offer created that we never sent on.
    const reuse = this.transceivers.find((t) => t.kind === track.kind && t.fromRemote && t.sender.track === null && !sends(t.currentDirection));
    if (reuse) {
      reuse.sender.track = track;
      reuse.direction = dirOf(true, receives(reuse.direction));
      return reuse.sender;
    }
    const transceiver = new FakeTransceiver(track.kind, 'sendrecv', track);
    this.transceivers.push(transceiver);
    return transceiver.sender;
  }
  removeTrack(sender: FakeSender) {
    const t = this.transceivers.find((x) => x.sender === sender)!;
    sender.track = null;
    t.direction = dirOf(false, receives(t.direction));
  }

  private sdp(lines: Line[]) {
    return ['a=fingerprint:sha-256 ' + this.name, 'a=ice-ufrag:' + this.name + '-' + this.ufrag, ...lines.map((l) => `m=${l.kind} ${l.mid} ${l.dir}`)].join('\r\n');
  }

  async createOffer(options: RTCOfferOptions = {}) {
    if (this.signalingState === 'stable') this.ufragBeforeOffer = this.ufrag;
    if (options.iceRestart) this.ufrag += 1;
    let next = this.nextMid;
    const lines = this.transceivers.map((t) => ({ mid: t.mid ?? String(next++), kind: t.kind, dir: t.sender.track ? t.direction : dirOf(false, receives(t.direction)) }));
    return { type: 'offer' as RTCSdpType, sdp: this.sdp(lines) };
  }

  async createAnswer() {
    if (this.signalingState !== 'have-remote-offer' || !this.remoteOffer) throw invalidState('createAnswer in ' + this.signalingState);
    const lines = this.remoteOffer.map((line) => {
      const t = this.transceivers.find((x) => x.mid === line.mid)!;
      return { ...line, dir: dirOf(Boolean(t.sender.track) && sends(t.direction) && receives(line.dir), receives(t.direction) && sends(line.dir)) };
    });
    return { type: 'answer' as RTCSdpType, sdp: this.sdp(lines) };
  }

  async setLocalDescription(desc: { type: RTCSdpType | 'rollback'; sdp?: string }) {
    if (desc.type === 'rollback') {
      if (this.signalingState !== 'have-local-offer') throw invalidState('rollback in ' + this.signalingState);
      for (const t of this.transceivers) {
        if (t.provisionalMid) {
          t.mid = null;
          t.provisionalMid = false;
        }
      }
      this.ufrag = this.ufragBeforeOffer;
      this.signalingState = 'stable';
      return;
    }
    const { lines } = parse(desc.sdp!);
    if (desc.type === 'offer') {
      if (this.signalingState !== 'stable' && this.signalingState !== 'have-local-offer') throw invalidState('offer in ' + this.signalingState);
      lines.forEach((line, i) => {
        const t = this.transceivers[i];
        if (t.mid === null) {
          t.mid = line.mid;
          t.provisionalMid = true;
          this.nextMid = Math.max(this.nextMid, Number(line.mid) + 1);
        }
      });
      this.signalingState = 'have-local-offer';
    } else {
      if (this.signalingState !== 'have-remote-offer') throw invalidState('answer in ' + this.signalingState);
      for (const line of lines) this.transceivers.find((t) => t.mid === line.mid)!.currentDirection = line.dir;
      this.signalingState = 'stable';
      this.remoteOffer = null;
      this.negotiated();
    }
    this.localDescription = { type: desc.type as RTCSdpType, sdp: desc.sdp! };
  }

  async setRemoteDescription(desc: { type: RTCSdpType; sdp: string }) {
    const { lines, ufrag } = parse(desc.sdp);
    if (desc.type === 'offer') {
      if (this.signalingState !== 'stable') throw invalidState('Failed to set remote offer sdp: Called in wrong state: ' + this.signalingState);
      // They restarted ICE: our answer comes with new credentials too.
      if (this.remoteDescription && ufragOf(this.remoteDescription) !== ufrag) this.ufrag += 1;
      for (const line of lines) {
        let t = this.transceivers.find((x) => x.mid === line.mid);
        if (!t) {
          t = new FakeTransceiver(line.kind, 'recvonly', null, true);
          t.mid = line.mid;
          this.transceivers.push(t);
          this.nextMid = Math.max(this.nextMid, Number(line.mid) + 1);
        }
        if (sends(line.dir)) this.showRemoteTrack(t);
      }
      this.remoteOffer = lines;
      this.signalingState = 'have-remote-offer';
    } else {
      if (this.signalingState !== 'have-local-offer') throw invalidState('Failed to set remote answer sdp: Called in wrong state: ' + this.signalingState);
      for (const line of lines) {
        const t = this.transceivers.find((x) => x.mid === line.mid)!;
        t.provisionalMid = false;
        t.currentDirection = flip(line.dir);
        if (sends(line.dir)) this.showRemoteTrack(t);
      }
      this.signalingState = 'stable';
      this.negotiated();
    }
    this.remoteDescription = desc;
  }

  async addIceCandidate() {}

  private negotiated() {
    if (FakePeerConnection.autoConnect) {
      this.iceConnectionState = 'connected';
      this.connectionState = 'connected';
    }
  }

  private showRemoteTrack(t: FakeTransceiver) {
    if (t.remoteTrackShown) return;
    t.remoteTrackShown = true;
    this.ontrack?.({ track: t.receiver.track, streams: [new FakeStream('remote-' + t.kind + '-' + t.mid, [t.receiver.track])] });
  }

  /** What this side sends that the other side gets: lines with a track, negotiated as sending. */
  sentKinds() {
    return this.transceivers.filter((t) => t.sender.track && t.mid !== null && sends(t.currentDirection)).map((t) => t.kind + ':' + (t.sender.track as FakeTrack).id);
  }

  setIce(ice: RTCIceConnectionState, connection: RTCPeerConnectionState) {
    this.iceConnectionState = ice;
    this.connectionState = connection;
    this.oniceconnectionstatechange?.();
    this.onconnectionstatechange?.();
  }
}

class FakeSessionDescription {
  type: RTCSdpType;
  sdp: string;
  constructor(init: { type: RTCSdpType; sdp: string }) {
    this.type = init.type;
    this.sdp = init.sdp;
  }
}

const installMedia = () => {
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
      return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
    }
    createAnalyser() {
      return { connect: vi.fn(), disconnect: vi.fn(), fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 128, getByteFrequencyData: vi.fn() };
    }
  }
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: vi.fn(() => Promise.resolve()) });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: vi.fn() });
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  vi.stubGlobal('RTCSessionDescription', FakeSessionDescription);
  vi.stubGlobal('RTCIceCandidate', class {});
  FakePeerConnection.all = [];
  FakePeerConnection.autoConnect = true;
};

type Internals = { peers: Map<string, FakePeerConnection>; localStream: FakeStream | null; localVideoStream: FakeStream | null };
const internals = (service: VoiceService) => service as unknown as Internals;
const pcOf = (service: VoiceService, peerId: string) => internals(service).peers.get(peerId)!;

/**
 * The "server" between two services: what one emits is delivered to the other as coming
 * from the sender's socket id, in order. `held` keeps messages back (a stalled socket),
 * `lost` drops them (a dead socket).
 */
const connect = (a: VoiceService, aId: string, b: VoiceService, bId: string) => {
  /** The socket ids the "server" says each side's messages come from; a reconnect changes them. */
  const ids = { a: aId, b: bId };
  const held = { ab: false, ba: false };
  const lost = { ab: false, ba: false };
  const queues = { ab: [] as Array<() => Promise<void>>, ba: [] as Array<() => Promise<void>> };
  const log: string[] = [];
  const errors: unknown[] = [];
  const wire = (from: VoiceService, fromId: () => string, to: VoiceService, key: 'ab' | 'ba') => {
    const push = (label: string, run: () => Promise<void>) => {
      if (lost[key]) return;
      log.push(key + ' ' + label);
      queues[key].push(run);
    };
    from.on('voice:offer', ({ offer, offerId }) => push('offer#' + offerId, () => to.handleOffer(fromId(), offer, offerId)));
    from.on('voice:answer', ({ answer, offerId }) => push('answer#' + offerId, () => to.handleAnswer(fromId(), answer, offerId)));
    from.on('voice:send-stream-metadata', ({ metadata }) => push('metadata', async () => to.handleStreamMetadata({ from: fromId(), metadata })));
  };
  wire(a, () => ids.a, b, 'ab');
  wire(b, () => ids.b, a, 'ba');
  const flush = async () => {
    for (let round = 0; round < 50; round += 1) {
      let moved = false;
      for (const key of ['ab', 'ba'] as const) {
        while (!held[key] && queues[key].length) {
          moved = true;
          await queues[key].shift()!().catch((error) => errors.push(error));
        }
      }
      if (!moved) return;
    }
  };
  return { ids, held, lost, log, errors, flush, offers: (key: 'ab' | 'ba') => log.filter((l) => l.startsWith(key + ' offer')) };
};

const camera = () => new FakeStream('camera-stream', [new FakeTrack('video', 'cam-raw')]);
const mic = (who: string) => new FakeStream('mic-' + who, [new FakeTrack('audio', 'mic-' + who)]);

describe('VoiceService: the camera after a renegotiation', () => {
  let alice: VoiceService;
  let bob: VoiceService;

  beforeEach(() => {
    installMedia();
    alice = new VoiceService();
    bob = new VoiceService();
    // Alice's account id sorts after Bob's: she is the one who yields when both offer at once.
    alice.setPolitePeer(() => true);
    bob.setPolitePeer(() => false);
    internals(alice).localStream = mic('alice');
    internals(bob).localStream = mic('bob');
    internals(alice).localVideoStream = camera();
  });

  afterEach(() => {
    alice.dispose();
    bob.dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('a connection the other side offers without video gets the camera right after the answer', async () => {
    const net = connect(alice, 'sock-alice', bob, 'sock-bob');
    const bobVideo: string[] = [];
    bob.on('video:remote:track', ({ peerId, streamType }) => bobVideo.push(peerId + ':' + streamType));

    // Bob lost Alice (the server said she left) and offers afresh when she is back: audio only.
    await bob.createOffer('sock-alice');
    await net.flush();

    expect(pcOf(alice, 'sock-bob').sentKinds()).toEqual(['audio:mic-alice', 'video:cam-raw']);
    expect(pcOf(alice, 'sock-bob').signalingState).toBe('stable');
    expect(pcOf(bob, 'sock-alice').signalingState).toBe('stable');
    expect(bobVideo).toEqual(['sock-alice:camera']);
    // Bob offered (audio), Alice answered, then offered herself (her camera), Bob answered.
    expect(net.log.filter((l) => !l.endsWith('metadata'))).toEqual(['ba offer#1', 'ab answer#1', 'ab offer#1', 'ba answer#1']);
    expect(net.errors).toEqual([]);
  });

  it('when Bob starts over with a new connection, Alice rebuilds hers and the camera comes along', async () => {
    const net = connect(alice, 'sock-alice', bob, 'sock-bob');
    await alice.createOffer('sock-bob');
    await net.flush();
    const first = pcOf(alice, 'sock-bob');
    expect(first.sentKinds()).toEqual(['audio:mic-alice', 'video:cam-raw']);

    bob.removePeer('sock-alice');
    await bob.createOffer('sock-alice');
    await net.flush();

    const second = pcOf(alice, 'sock-bob');
    expect(second).not.toBe(first);
    expect(first.connectionState).toBe('closed');
    expect(second.sentKinds()).toEqual(['audio:mic-alice', 'video:cam-raw']);
    expect(net.errors).toEqual([]);
  });

  it('new and rebuilt connections carry the camera track an effect produces, never the raw one behind it', async () => {
    const net = connect(alice, 'sock-alice', bob, 'sock-bob');
    await alice.createOffer('sock-bob');
    await net.flush();
    const processed = new FakeTrack('video', 'cam-blurred');
    await alice.setCameraOutputTrack(processed as unknown as MediaStreamTrack);
    expect(pcOf(alice, 'sock-bob').sentKinds()).toEqual(['audio:mic-alice', 'video:cam-blurred']);
    expect(alice.outgoingCameraTrack()).toBe(processed);

    bob.removePeer('sock-alice');
    await bob.createOffer('sock-alice');
    await net.flush();
    expect(pcOf(alice, 'sock-bob').sentKinds()).toEqual(['audio:mic-alice', 'video:cam-blurred']);

    // An effect track that ended is still not swapped for the raw picture.
    processed.readyState = 'ended';
    expect(alice.outgoingCameraTrack()).toBe(processed);
    await alice.setCameraOutputTrack(null);
    expect(pcOf(alice, 'sock-bob').sentKinds()).toEqual(['audio:mic-alice', 'video:cam-raw']);
    alice.stopCamera();
    expect(alice.outgoingCameraTrack()).toBeNull();
  });

  it('when both restart ICE at once, the polite side yields and both end on the same credentials', async () => {
    const net = connect(alice, 'sock-alice', bob, 'sock-bob');
    await alice.createOffer('sock-bob');
    await net.flush();
    const a = pcOf(alice, 'sock-bob');
    const b = pcOf(bob, 'sock-alice');

    // Both notice the broken transport and restart at the same moment: the offers cross.
    a.setIce('disconnected', 'disconnected');
    b.setIce('disconnected', 'disconnected');
    net.held.ab = true;
    net.held.ba = true;
    await alice.restartIce('sock-bob');
    await bob.restartIce('sock-alice');
    net.held.ab = false;
    net.held.ba = false;
    await net.flush();

    expect(a.signalingState).toBe('stable');
    expect(b.signalingState).toBe('stable');
    // Bob (impolite) kept his offer and took Alice's answer; Alice took hers back and answered his.
    expect(a.remoteDescription?.type).toBe('offer');
    expect(b.remoteDescription?.type).toBe('answer');
    expect(ufragOf(a.remoteDescription)).toBe(ufragOf(b.localDescription));
    expect(ufragOf(b.remoteDescription)).toBe(ufragOf(a.localDescription));
    expect(a.sentKinds()).toEqual(['audio:mic-alice', 'video:cam-raw']);
    expect(net.errors).toEqual([]);
  });

  it('an answer to an older offer (a stalled socket delivering late) is ignored', async () => {
    vi.useFakeTimers();
    const net = connect(alice, 'sock-alice', bob, 'sock-bob');
    await alice.createOffer('sock-bob');
    await net.flush();
    const a = pcOf(alice, 'sock-bob');
    const b = pcOf(bob, 'sock-alice');
    FakePeerConnection.autoConnect = false;
    b.setIce('failed', 'failed');

    // Bob's restarts pile up behind a stalled socket: the first goes unanswered long enough to
    // count as lost, so he sends a second. Then everything arrives at once and Alice answers both.
    net.held.ba = true;
    await bob.restartIce('sock-alice');
    await vi.advanceTimersByTimeAsync(OFFER_STALE_MS + 1000);
    await bob.restartIce('sock-alice');
    expect(net.offers('ba')).toHaveLength(2);
    net.held.ba = false;
    await net.flush();

    expect(b.signalingState).toBe('stable');
    expect(ufragOf(b.remoteDescription)).toBe(ufragOf(a.localDescription));
    expect(ufragOf(a.remoteDescription)).toBe(ufragOf(b.localDescription));
    expect(net.errors).toEqual([]);
  });

  it('the impolite side gives way when its own offer was lost with the socket', async () => {
    const net = connect(alice, 'sock-alice', bob, 'sock-bob');
    await alice.createOffer('sock-bob');
    await net.flush();
    const a = pcOf(alice, 'sock-bob');
    const b = pcOf(bob, 'sock-alice');

    // Bob's socket is down: his ICE restart goes nowhere.
    bob.setSignallingUp(false);
    net.lost.ba = true;
    b.setIce('disconnected', 'disconnected');
    await bob.restartIce('sock-alice');
    expect(b.signalingState).toBe('have-local-offer');
    net.lost.ba = false;

    // Alice's restart reaches him; he takes his lost offer back and answers hers.
    a.setIce('disconnected', 'disconnected');
    await alice.restartIce('sock-bob');
    await net.flush();
    expect(b.signalingState).toBe('stable');
    expect(a.signalingState).toBe('stable');
    expect(b.remoteDescription?.type).toBe('offer');
  });

  it('an offer lost while the socket was down goes out again once signalling is back', async () => {
    const net = connect(alice, 'sock-alice', bob, 'sock-bob');
    await bob.createOffer('sock-alice');
    await net.flush();
    const a = pcOf(alice, 'sock-bob');

    alice.setSignallingUp(false);
    net.lost.ab = true;
    a.setIce('disconnected', 'disconnected');
    await alice.restartIce('sock-bob');
    expect(a.signalingState).toBe('have-local-offer');
    const sent = net.offers('ab').length;

    net.lost.ab = false;
    alice.setSignallingUp(true);
    await vi.waitFor(() => expect(net.offers('ab').length).toBe(sent + 1));
    await net.flush();
    expect(a.signalingState).toBe('stable');
    expect(ufragOf(pcOf(bob, 'sock-alice').remoteDescription)).toBe(ufragOf(a.localDescription));
    expect(a.sentKinds()).toEqual(['audio:mic-alice', 'video:cam-raw']);
  });

  it('an offer sent to a socket id that is gone counts as lost once the peer moves to its new id', async () => {
    const net = connect(alice, 'sock-alice', bob, 'sock-bob');
    await alice.createOffer('sock-bob');
    await net.flush();
    const a = pcOf(alice, 'sock-bob');

    // Bob reconnected; Alice's ICE restart went to his old socket.
    a.setIce('disconnected', 'disconnected');
    net.lost.ab = true;
    await alice.restartIce('sock-bob');
    net.lost.ab = false;

    expect(alice.rekeyPeer('sock-bob', 'sock-bob-2')).toBe(true);
    net.ids.b = 'sock-bob-2';
    expect(pcOf(alice, 'sock-bob-2')).toBe(a);
    await alice.resendLostOffer('sock-bob-2');
    await net.flush();
    expect(a.signalingState).toBe('stable');
    expect(ufragOf(pcOf(bob, 'sock-alice').remoteDescription)).toBe(ufragOf(a.localDescription));
  });
});

describe('VoiceService: ICE restarts keep trying while the transport is down', () => {
  let service: VoiceService;

  beforeEach(() => {
    vi.useFakeTimers();
    installMedia();
    FakePeerConnection.autoConnect = false;
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    service = new VoiceService();
  });

  afterEach(() => {
    service.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** A peer that answers every offer at once, while the transport stays down. */
  const answeringPeer = async () => {
    const offers: number[] = [];
    service.on('voice:offer', ({ peerId, offer, offerId }) => {
      offers.push(Date.now());
      void service.handleAnswer(peerId, { type: 'answer', sdp: offer.sdp }, offerId);
    });
    await service.createOffer('sock-bob');
    await vi.advanceTimersByTimeAsync(0);
    offers.length = 0;
    return { pc: FakePeerConnection.all[0], offers };
  };

  it('restarts after 2 s, then 4 s, 8 s and every 10 s, and stops once connected', async () => {
    const { pc, offers } = await answeringPeer();
    const start = Date.now();
    pc.setIce('failed', 'failed');
    for (const wait of [2000, 4000, 8000, 10000, 10000]) await vi.advanceTimersByTimeAsync(wait);
    expect(offers.map((at) => at - start)).toEqual([2000, 6000, 14000, 24000, 34000]);

    pc.setIce('connected', 'connected');
    await vi.advanceTimersByTimeAsync(60000);
    expect(offers).toHaveLength(5);
  });

  it('leaves a transport alone that recovers within the first wait', async () => {
    const { pc, offers } = await answeringPeer();
    pc.setIce('disconnected', 'disconnected');
    await vi.advanceTimersByTimeAsync(1000);
    pc.setIce('connected', 'connected');
    await vi.advanceTimersByTimeAsync(30000);
    expect(offers).toEqual([]);
  });

  it('keeps the retries going after the peer moved to a new socket id', async () => {
    const { pc, offers } = await answeringPeer();
    pc.setIce('failed', 'failed');
    await vi.advanceTimersByTimeAsync(2000);
    expect(offers).toHaveLength(1);
    service.rekeyPeer('sock-bob', 'sock-bob-2');
    await vi.advanceTimersByTimeAsync(4000);
    expect(offers).toHaveLength(2);
  });
});
