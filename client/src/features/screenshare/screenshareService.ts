import { batch, signal } from '@preact/signals';
import { config } from '@/config';
import { api } from '@/services/socket/api';
import { socketClient } from '@/services/socket/client';
import { serverConfig } from '@/services/ServerConfigService';
import { screenshareSessions, setScreenshareSession } from '@/state/misc';
import { socketId } from '@/state/session';
import { toast } from '@/state/ui';
import type { ScreenshareSessionEvent, ScreenshareSignalEvent } from '@/types/protocol';

type Role = 'idle' | 'host' | 'viewer';

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const CAPTURE = {
  idealFps: num(config.SCREENSHARE_IDEAL_FPS, 30),
  maxFps: num(config.SCREENSHARE_MAX_FPS, 60),
  maxBitrateBps: num(config.SCREENSHARE_MAX_BITRATE_KBPS, 8000) * 1000,
};

/** Local screenshare-room state. */
export const screenshareRole = signal<Role>('idle');
export const screenshareChannel = signal<string | null>(null);
/** The stream being shown: our own capture when hosting, the host's when viewing. */
export const screenshareStream = signal<MediaStream | null>(null);
export const screenshareStatus = signal<string>('');

/**
 * One presenter streams their screen to any number of viewers through
 * direct WebRTC connections (one peer connection per viewer on the host).
 */
class ScreenshareService {
  private peers = new Map<string, RTCPeerConnection>();
  private candidateQueue = new Map<string, RTCIceCandidateInit[]>();
  private localStream: MediaStream | null = null;
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    socketClient.on<ScreenshareSessionEvent>('screenshare:session', (session) => this.onSession(session));
    socketClient.on<ScreenshareSignalEvent>('screenshare:signal', (payload) => void this.onSignal(payload));
    socketClient.on<{ channelId: string; viewerId: string; viewerName: string }>('screenshare:viewer:pending', (payload) => {
      void this.onViewerPending(payload);
    });
    socketClient.on('disconnect', () => this.teardown('Connection lost'));
    socketClient.on('connect', () => {
      if (screenshareStatus.value === 'Connection lost') screenshareStatus.value = '';
    });
  }

  // ------------------------------------------------------------------ host

  async startHosting(channelId: string): Promise<void> {
    if (screenshareRole.value === 'host') return;
    if (screenshareRole.value === 'viewer') this.stopViewing();
    try {
      const stream = await this.captureScreen();
      this.localStream = stream;
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (screenshareRole.value === 'host') this.stopHosting();
      });
      batch(() => {
        screenshareRole.value = 'host';
        screenshareChannel.value = channelId;
        screenshareStream.value = stream;
        screenshareStatus.value = 'Sharing your screen';
      });
      api.startScreenshare(channelId);
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name !== 'NotAllowedError') toast.error(error instanceof Error ? error.message : 'Could not capture the screen');
      this.localStream?.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
  }

  stopHosting(): void {
    if (screenshareRole.value !== 'host') return;
    const channelId = screenshareChannel.value;
    if (channelId && socketClient.connected) api.stopScreenshare(channelId);
    this.teardown();
  }

  private async captureScreen(): Promise<MediaStream> {
    const video: MediaTrackConstraints & { cursor?: string } = {
      frameRate: { ideal: CAPTURE.idealFps, max: CAPTURE.maxFps },
      cursor: 'always',
    };
    const bridge = window.desktopAPI;
    if (bridge?.pickScreenshareSource) {
      const picked = await bridge.pickScreenshareSource({ audio: true });
      if (!picked.success || !picked.source) {
        const error = new Error('Screen share was cancelled');
        error.name = 'NotAllowedError';
        throw error;
      }
      const chromeConstraints = {
        mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: picked.source.id, maxFrameRate: CAPTURE.maxFps },
      };
      return navigator.mediaDevices.getUserMedia({
        audio: picked.shareAudio ? ({ mandatory: { chromeMediaSource: 'desktop' } } as unknown as MediaTrackConstraints) : false,
        video: chromeConstraints as unknown as MediaTrackConstraints,
      });
    }
    const mediaDevices = navigator.mediaDevices as MediaDevices & { getDisplayMedia?: (c: MediaStreamConstraints) => Promise<MediaStream> };
    if (!mediaDevices.getDisplayMedia) throw new Error('Screen sharing is not supported in this browser');
    return mediaDevices.getDisplayMedia({ video, audio: true });
  }

  private async onViewerPending({ channelId, viewerId }: { channelId: string; viewerId: string; viewerName: string }): Promise<void> {
    if (screenshareRole.value !== 'host' || screenshareChannel.value !== channelId || !this.localStream) return;
    const peer = this.createPeer(viewerId, channelId);
    for (const track of this.localStream.getTracks()) {
      peer.addTrack(track, this.localStream);
    }
    this.applyEncoding(peer);
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      api.sendScreenshareSignal(viewerId, { sdp: peer.localDescription ?? offer }, channelId);
    } catch (error) {
      console.error('[screenshare] offer failed', error);
      this.closePeer(viewerId);
    }
  }

  private applyEncoding(peer: RTCPeerConnection): void {
    for (const sender of peer.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      const parameters = sender.getParameters();
      if (!parameters.encodings || parameters.encodings.length === 0) parameters.encodings = [{}];
      const encoding = parameters.encodings[0] as RTCRtpEncodingParameters & { priority?: string };
      encoding.maxBitrate = CAPTURE.maxBitrateBps;
      encoding.maxFramerate = CAPTURE.maxFps;
      encoding.priority = 'high';
      parameters.degradationPreference = 'maintain-framerate';
      sender.setParameters(parameters).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- viewer

  /** Ask to watch the current presenter in a channel (no-op when nobody shares). */
  watch(channelId: string): void {
    if (screenshareRole.value === 'host') return;
    const session = screenshareSessions.value[channelId];
    if (!session?.active || !session.hostId || session.hostId === socketId.value) return;
    if (screenshareRole.value === 'viewer' && screenshareChannel.value === channelId) return;
    if (screenshareRole.value === 'viewer') this.stopViewing();
    batch(() => {
      screenshareRole.value = 'viewer';
      screenshareChannel.value = channelId;
      screenshareStatus.value = 'Connecting to ' + (session.hostName ?? 'presenter') + '…';
    });
    api.joinScreenshareViewer(channelId);
  }

  stopViewing(): void {
    if (screenshareRole.value !== 'viewer') return;
    const channelId = screenshareChannel.value;
    if (channelId && socketClient.connected) api.leaveScreenshareViewer(channelId);
    this.teardown();
  }

  /** Leave whatever we are doing in this channel (page closed). */
  leaveChannel(channelId: string): void {
    if (screenshareChannel.value !== channelId) return;
    if (screenshareRole.value === 'host') this.stopHosting();
    else if (screenshareRole.value === 'viewer') this.stopViewing();
  }

  // --------------------------------------------------------------- events

  private onSession(session: ScreenshareSessionEvent): void {
    setScreenshareSession(session);
    if (screenshareChannel.value !== session.channelId) return;
    if (screenshareRole.value === 'viewer' && !session.active) {
      this.teardown('The presenter stopped sharing');
    }
  }

  private async onSignal(payload: ScreenshareSignalEvent): Promise<void> {
    const role = screenshareRole.value;
    const channelId = payload.channelId ?? screenshareChannel.value;
    if (role === 'idle' || !channelId || channelId !== screenshareChannel.value) return;
    try {
      if (role === 'viewer') {
        const session = screenshareSessions.value[channelId];
        if (session?.hostId && session.hostId !== payload.from) return;
        const peer = this.peers.get(payload.from) ?? this.createPeer(payload.from, channelId, true);
        if (payload.data.sdp?.type === 'offer') {
          await peer.setRemoteDescription(new RTCSessionDescription(payload.data.sdp));
          this.flushCandidates(payload.from);
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          api.sendScreenshareSignal(payload.from, { sdp: peer.localDescription ?? answer }, channelId);
        } else if (payload.data.candidate) {
          this.queueOrAddCandidate(payload.from, payload.data.candidate);
        }
      } else if (role === 'host') {
        const peer = this.peers.get(payload.from);
        if (!peer) return;
        if (payload.data.sdp?.type === 'answer') {
          await peer.setRemoteDescription(new RTCSessionDescription(payload.data.sdp));
          this.flushCandidates(payload.from);
        } else if (payload.data.candidate) {
          this.queueOrAddCandidate(payload.from, payload.data.candidate);
        }
      }
    } catch (error) {
      console.error('[screenshare] signal failed', error);
    }
  }

  // ---------------------------------------------------------------- peers

  private createPeer(remoteId: string, channelId: string, receive = false): RTCPeerConnection {
    const peer = new RTCPeerConnection({ iceServers: serverConfig.iceServers() });
    peer.onicecandidate = (event) => {
      if (event.candidate) api.sendScreenshareSignal(remoteId, { candidate: event.candidate.toJSON() }, channelId);
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
        this.closePeer(remoteId);
        if (receive && screenshareRole.value === 'viewer') screenshareStatus.value = 'Connection to the presenter failed';
      }
    };
    if (receive) {
      peer.ontrack = (event) => {
        const [stream] = event.streams;
        if (stream) {
          batch(() => {
            screenshareStream.value = stream;
            screenshareStatus.value = '';
          });
        }
      };
    }
    this.peers.set(remoteId, peer);
    this.candidateQueue.set(remoteId, []);
    return peer;
  }

  private queueOrAddCandidate(remoteId: string, candidate: RTCIceCandidateInit): void {
    const peer = this.peers.get(remoteId);
    if (!peer) return;
    if (!peer.remoteDescription) {
      this.candidateQueue.get(remoteId)?.push(candidate);
      return;
    }
    peer.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => undefined);
  }

  private flushCandidates(remoteId: string): void {
    const peer = this.peers.get(remoteId);
    const queued = this.candidateQueue.get(remoteId) ?? [];
    this.candidateQueue.set(remoteId, []);
    if (!peer) return;
    for (const candidate of queued) peer.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => undefined);
  }

  private closePeer(remoteId: string): void {
    this.peers.get(remoteId)?.close();
    this.peers.delete(remoteId);
    this.candidateQueue.delete(remoteId);
  }

  private teardown(message = ''): void {
    for (const id of Array.from(this.peers.keys())) this.closePeer(id);
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    batch(() => {
      screenshareRole.value = 'idle';
      screenshareChannel.value = null;
      screenshareStream.value = null;
      screenshareStatus.value = message;
    });
  }
}

export const screenshareService = new ScreenshareService();
