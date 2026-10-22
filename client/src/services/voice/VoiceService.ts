/**
 * WebRTC voice communication service
 */
import type { EventMap, ScreenQuality, StreamMetadata } from '@/types/protocol';
import { EventEmitter } from '@/lib/EventEmitter';
import { Storage } from '@/lib/storage';
import { isNativeAudioRoutingAvailable, selectNativeAudioRoute } from '@/services/native/NativeAudioRouteService';
import { config } from '@/config';
import { serverConfig } from '@/services/ServerConfigService';
import { DEFAULT_SCREEN_QUALITY, applyScreenEncoding, applyScreenQualityToStream, captureScreen, isCancelError, screenAudioNotice } from '@/services/screenCapture';
import { captureCamera } from './cameraCapture';
import { OFF_STATUS, type CameraBlurLevel, type CameraBlurStatus } from './backgroundBlur';
import { CameraEffects } from './cameraEffects';
import { PeerAudioManager, type PeerAudioPreference } from './PeerAudioManager';
import { iceRestartDelay, isOfferStale, needsOwnOffer, resolveOfferCollision, type PendingOffer } from './negotiation';

export type { PeerAudioPreference } from './PeerAudioManager';

const parseNumberEnv = (
  value: string | undefined,
  fallback: number,
  bounds?: { min?: number; max?: number }
): number => {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  if (typeof bounds?.min === 'number' && parsed < bounds.min) {
    return fallback;
  }

  if (typeof bounds?.max === 'number' && parsed > bounds.max) {
    return fallback;
  }

  return parsed;
};

const parseBooleanEnv = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
};

/** ICE servers are provided by the server (ephemeral TURN credentials) with a build-time fallback. */
const getIceServers = (): RTCIceServer[] => serverConfig.iceServers();
/** ICE restarts without TURN after which the "configure a TURN server" warning shows (they keep going). */
const ICE_RESTART_MAX_ATTEMPTS = 3;
const OPUS_BITRATE_MIN = 6000;
const OPUS_BITRATE_MAX = 128000;
// 128 kbps Opus is transparent for speech and fine for music; the settings dialog can lower it.
const OPUS_TARGET_BITRATE = Math.round(
  parseNumberEnv(config.VOICE_OPUS_BITRATE, 128000, {
    min: OPUS_BITRATE_MIN,
    max: OPUS_BITRATE_MAX,
  })
);
/**
 * Data-saver voice (linkConstraint.ts): the cap per voice stream while this device's link,
 * or the peer's, is constrained.
 */
export const CONSTRAINED_VOICE_BITRATE = 24000;
/** Packet overhead of one voice stream: 50 packets/s x 62 B of IP, UDP, RTP, header extensions and the SRTP tag. */
export const VOICE_PACKET_OVERHEAD_BPS = 25000;
const DEFAULT_DTX_ENABLED = parseBooleanEnv(config.VOICE_DTX_ENABLED, true);
const DEFAULT_VAD_THRESHOLD = parseNumberEnv(config.VOICE_VAD_THRESHOLD, 0.07, {
  min: 0.01,
  max: 0.5,
});
const DEFAULT_OPUS_STEREO = parseBooleanEnv(config.VOICE_OPUS_STEREO, false);
const DEFAULT_OPUS_MIN_PTIME = Math.round(
  parseNumberEnv(config.VOICE_OPUS_MIN_PTIME, 10, { min: 3, max: 20 })
);
const DEFAULT_OPUS_MAX_PTIME = Math.round(
  parseNumberEnv(config.VOICE_OPUS_MAX_PTIME, 20, { min: 20, max: 60 })
);
const DEFAULT_OPUS_MAX_PLAYBACK_RATE = Math.round(
  parseNumberEnv(config.VOICE_OPUS_MAX_PLAYBACK_RATE, 48000, {
    min: 32000,
    max: 48000,
  })
);
const isTurnConfigured = (): boolean => serverConfig.turnConfigured();

/** The DTLS fingerprint of an SDP (first `a=fingerprint:` line); null when there is none. */
export const dtlsFingerprint = (sdp: string | undefined): string | null => {
  const match = sdp?.match(/^a=fingerprint:(\S+\s+\S+)/m);
  return match ? match[1].toLowerCase() : null;
};

const clampNumber = (value: number, min: number, max: number, fallback: number): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  if (value < min) {
    return fallback;
  }

  if (value > max) {
    return fallback;
  }

  return value;
};

const normalizeVoiceBitrate = (value: number): number => {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) {
    return OPUS_TARGET_BITRATE;
  }

  if (rounded < OPUS_BITRATE_MIN) {
    return OPUS_BITRATE_MIN;
  }

  if (rounded > OPUS_BITRATE_MAX) {
    return OPUS_BITRATE_MAX;
  }

  return rounded;
};

interface VoiceCodecOptions {
  stereo?: boolean;
  maxPtime?: number;
  minPtime?: number;
  maxPlaybackRate?: number;
}

/** Where an old client kept per-socket volume settings; socket ids never repeat, so the file is dead weight. */
const LEGACY_PEER_PREFERENCE_STORAGE_KEY = 'datasetto.voice.peerPreferences.v1';
const STATS_POLLING_INTERVAL_MS = 2000;
const CONNECTION_QUALITY_HISTORY_SIZE = 5;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const DEFAULT_PEER_VOLUME = 1;
const MAX_PEER_VOLUME = 2;


export type ConnectionQuality = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';

export interface PeerConnectionStats {
  peerId: string;
  quality: ConnectionQuality;
  roundTripTime: number | null;
  packetLoss: number | null;
  jitter: number | null;
  bitrate: number | null;
  /** The browser's estimate of what this connection may send, in bit/s (`availableOutgoingBitrate`). */
  availableOutgoingBitrate: number | null;
  timestamp: number;
}

type RemoteVideoTrackInfo = {
  track: MediaStreamTrack;
  stream: MediaStream;
  onTrackEnded: () => void;
  onStreamRemove: (event: MediaStreamTrackEvent) => void;
};

/** Senders for one peer: the camera track, the screen's video and (when captured) its audio. */
type PeerVideoSenders = { camera?: RTCRtpSender; screen?: RTCRtpSender; screenAudio?: RTCRtpSender };


export class VoiceService extends EventEmitter<EventMap> {
  private peers: Map<string, RTCPeerConnection> = new Map();
  private peerManagers: Map<string, PeerAudioManager> = new Map();
  private iceRestartTimers: Map<string, number> = new Map();
  private iceRestartAttempts: Map<string, number> = new Map();
  private localStream: MediaStream | null = null;
  /** What the call sends as the camera: the camera's own track, or its blurred copy. */
  private localVideoStream: MediaStream | null = null;
  /** The camera as captured. */
  private cameraSource: MediaStream | null = null;
  private cameraStarting: Promise<MediaStream> | null = null;
  private cameraEffects: CameraEffects | null = null;
  private cameraBlur: CameraBlurLevel = 'off';
  private localScreenStream: MediaStream | null = null;
  private remoteVideoElements: Map<string, HTMLVideoElement> = new Map();
  private videoSenders: Map<string, PeerVideoSenders> = new Map();
  private screenQuality: ScreenQuality = DEFAULT_SCREEN_QUALITY;
  private remoteVideoTracks: Map<string, { camera?: RemoteVideoTrackInfo; screen?: RemoteVideoTrackInfo }> = new Map();
  private streamMetadata: Map<string, Map<string, 'camera' | 'screen'>> = new Map();
  /** What each friend said about clipping their screen (absent: allowed). */
  private remoteScreenClips: Map<string, boolean> = new Map();
  /** The voice stream of every friend we hear, for the clip mixer. */
  private remoteAudio: Map<string, MediaStream> = new Map();
  /** Whether friends may clip our screen share; sent with the screen's metadata. */
  private shareClipsAllowed = true;
  private audioContext: AudioContext | null = null;
  private outputVolume = 1;
  private outputDeviceId = '';
  private peerAudioPreferences: Map<string, PeerAudioPreference> = new Map();
  private deafened = false;
  private turnWarningShown = false;
  private voiceBitrate = OPUS_TARGET_BITRATE;
  private dtxEnabled = DEFAULT_DTX_ENABLED;
  private vadThreshold = DEFAULT_VAD_THRESHOLD;
  private opusStereo = DEFAULT_OPUS_STEREO;
  private opusMinPtime = DEFAULT_OPUS_MIN_PTIME;
  private opusMaxPtime = DEFAULT_OPUS_MAX_PTIME;
  private opusMaxPlaybackRate = DEFAULT_OPUS_MAX_PLAYBACK_RATE;
  private statsPollingHandle: number | null = null;
  private peerStatsHistory: Map<string, PeerConnectionStats[]> = new Map();
  private lastStatsTimestamp: Map<string, number> = new Map();
  /** Our unanswered offer to each peer (negotiation.ts): its id, when it went out, whether it was probably lost. */
  private pendingOffers: Map<string, PendingOffer> = new Map();
  private offerSeq = 0;
  /** False while the socket is down or the room is not rejoined yet: offers made then are lost. */
  private signallingUp = true;
  /** Who yields when both sides offer at once; the voice manager decides from the account ids. */
  private politeFor: (peerId: string) => boolean = () => true;
  /**
   * Old socket id -> the id the same connection lives under now (see rekeyPeer).
   * Callbacks created with the old id look the current one up when they fire.
   */
  private aliases: Map<string, string> = new Map();
  /** Our own link is constrained (data-saver voice): every voice sender is capped. */
  private linkConstrained = false;
  /** Peers that said their link is constrained (`voice:link`): our sender to them is capped. */
  private peerLinkConstrained: Map<string, boolean> = new Map();

  constructor(
    voiceBitrate = OPUS_TARGET_BITRATE,
    dtxEnabled = DEFAULT_DTX_ENABLED,
    vadThreshold = DEFAULT_VAD_THRESHOLD
  ) {
    super();
    this.voiceBitrate = normalizeVoiceBitrate(voiceBitrate);
    this.dtxEnabled = Boolean(dtxEnabled);
    this.vadThreshold = clampNumber(vadThreshold, 0.01, 0.5, DEFAULT_VAD_THRESHOLD);

    // Per-person volume lives in state/peerAudio.ts (keyed by account) and is pushed in with
    // setPeerAudio; the old per-socket file cannot be mapped to anyone and is dropped.
    Storage.remove(LEGACY_PEER_PREFERENCE_STORAGE_KEY);

    if (typeof window !== 'undefined') {
      const unlock = () => {
        this.tryResumeAudioContext();
        window.removeEventListener('click', unlock);
        window.removeEventListener('touchend', unlock);
        window.removeEventListener('keydown', unlock);
      };

      const options = { passive: true } as AddEventListenerOptions;
      window.addEventListener('click', unlock, options);
      window.addEventListener('touchend', unlock, options);
      window.addEventListener('keydown', unlock, options);
    }
  }

  /**
   * Set local audio stream
   */
  setLocalStream(stream: MediaStream | null): void {
    this.localStream = stream ?? null;

    // Update all existing peers with new stream
    for (const [peerId, pc] of this.peers.entries()) {
      void this.replaceAudioTrack(peerId, pc);
    }
  }

  /**
   * Replace audio track on a peer connection
   */
  private async replaceAudioTrack(
    peerId: string,
    pc: RTCPeerConnection
  ): Promise<void> {
    const sender = this.voiceSender(peerId, pc);
    const newTrack = this.localStream?.getAudioTracks()[0];

    if (newTrack) {
      if (sender) {
        try {
          await sender.replaceTrack(newTrack);
          this.applySenderQualityHints(sender, peerId);
        } catch (error) {
          console.error(`Error replacing track for peer ${peerId}:`, error);
        }
      } else if (this.localStream) {
        // No sender yet, add the track
        const newSender = pc.addTrack(newTrack, this.localStream);
        this.applySenderQualityHints(newSender, peerId);
      }
    } else if (sender) {
      try {
        pc.removeTrack(sender);
      } catch (error) {
        console.error(`Error removing track for peer ${peerId}:`, error);
      }
    }
  }

  /**
   * Create a peer connection
   */
  private createPeerConnection(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: getIceServers() });

    // The connection may outlive the socket id it was created under (rekeyPeer).
    const current = () => this.resolve(peerId);

    // ICE candidate handler
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.emit('voice:ice-candidate', {
          peerId: current(),
          candidate: event.candidate,
        } as never);
      }
    };

    pc.onicecandidateerror = (event) => {
      if (import.meta.env.DEV) {
        console.warn(`[VoiceService] ICE candidate error for ${current()}:`, event);
      }
    };

    // Connection state monitoring
    pc.onconnectionstatechange = () => {
      const id = current();
      console.log(`Peer ${id} connection state: ${pc.connectionState}`);

      if (pc.connectionState === 'failed') {
        // Once per outage; the restarts that follow keep going quietly.
        if (!this.iceRestartAttempts.has(id)) {
          this.emit('notification', {
            id: `peer-failed-${id}`,
            type: 'warning',
            message: 'Voice connection issue detected',
            duration: 3000,
          });
        }
        this.scheduleIceRestart(id, 'connection-state-failed');
      }

      if (pc.connectionState === 'connected') {
        this.resetIceRecovery(id);
      }
    };

    pc.oniceconnectionstatechange = () => {
      const id = current();
      const state = pc.iceConnectionState;
      if (import.meta.env.DEV) {
        console.log(`[VoiceService] ICE state for ${id}: ${state}`);
      }

      if (state === 'disconnected' || state === 'failed') {
        if (typeof pc.restartIce === 'function') {
          try {
            pc.restartIce();
          } catch (error) {
            if (import.meta.env.DEV) {
              console.warn(`[VoiceService] Failed to call restartIce for ${id}:`, error);
            }
          }
        }

        this.scheduleIceRestart(id, `ice-state-${state}`);
      } else if (state === 'connected' || state === 'completed') {
        this.resetIceRecovery(id);
      }
    };

    // Track received handler
    pc.ontrack = (event) => {
      const id = current();
      const track = event.track;
      const stream = event.streams[0];
      console.log(`Received ${track.kind} track from peer ${id}`);

      if (track.kind === 'audio') {
        if (this.isScreenStream(id, stream)) {
          // Screen-share sound travels in the screen's stream and plays through its video tile.
          console.log(`[VoiceService] Screen audio from ${id}`);
        } else {
          this.handleRemoteTrack(id, stream);
        }
      } else if (track.kind === 'video') {
        this.handleRemoteVideoTrack(id, track, stream);
      }
    };

    return pc;
  }

  /** The id a connection created under `peerId` lives under now. */
  private resolve(peerId: string): string {
    let id = peerId;
    for (let hops = 0; hops < 50; hops += 1) {
      const next = this.aliases.get(id);
      if (!next) break;
      id = next;
    }
    return id;
  }

  /**
   * The same person is back on a new socket after a reconnect and their media session
   * is unchanged: keep the live connection (audio never stopped) and move everything
   * filed under the old id to the new one.
   */
  rekeyPeer(from: string, to: string): boolean {
    if (from === to) return true;
    const pc = this.peers.get(from);
    if (!pc) return false;
    // Anything that might already sit under the new id (it never should) is dropped first.
    if (this.peers.has(to)) this.removePeer(to);

    const move = <T>(map: Map<string, T>) => {
      const value = map.get(from);
      map.delete(from);
      if (value !== undefined) map.set(to, value);
    };
    move(this.peers);
    move(this.peerManagers);
    move(this.iceRestartTimers);
    move(this.iceRestartAttempts);
    move(this.pendingOffers);
    // An offer still waiting for its answer went to the old socket, which is gone.
    const pending = this.pendingOffers.get(to);
    if (pending) pending.lost = true;
    move(this.remoteVideoElements);
    move(this.videoSenders);
    move(this.remoteVideoTracks);
    move(this.streamMetadata);
    move(this.remoteScreenClips);
    move(this.remoteAudio);
    move(this.peerStatsHistory);
    move(this.lastStatsTimestamp);
    move(this.peerAudioPreferences);
    move(this.peerLinkConstrained);
    this.peerManagers.get(to)?.rename(to);
    this.aliases.delete(to);
    this.aliases.set(from, to);
    return true;
  }

  /** How the media path to a peer is doing, for the rejoin logic (features/voice/peerReconcile.ts). */
  peerHealth(peerId: string): 'connected' | 'connecting' | 'broken' | 'missing' {
    const pc = this.peers.get(peerId);
    if (!pc) return 'missing';
    if (pc.connectionState === 'closed' || pc.connectionState === 'failed') return 'broken';
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') return 'broken';
    if (pc.connectionState === 'connected') return 'connected';
    return 'connecting';
  }

  /** Renegotiate the transport with an ICE restart now (our or their network changed while the socket was down). */
  async restartIce(peerId: string): Promise<void> {
    const timer = this.iceRestartTimers.get(peerId);
    if (timer) {
      clearTimeout(timer);
      this.iceRestartTimers.delete(peerId);
    }
    this.iceRestartAttempts.delete(peerId);
    await this.performIceRestart(peerId, 'rejoin');
  }

  /** Who yields when both sides offer at once (negotiation.ts); the voice manager decides from the account ids. */
  setPolitePeer(polite: (peerId: string) => boolean): void {
    this.politeFor = polite;
  }

  /**
   * Whether offers reach the room right now. While the socket is down (or the room is not
   * rejoined yet) whatever we offer is lost; once signalling is back those offers go out again.
   */
  setSignallingUp(up: boolean): void {
    this.signallingUp = up;
    if (!up) {
      for (const pending of this.pendingOffers.values()) pending.lost = true;
      return;
    }
    for (const peerId of Array.from(this.peers.keys())) void this.resendLostOffer(peerId);
  }

  /**
   * Our unanswered offer to this peer was probably lost (made while the socket was down, or
   * sent to a socket id that is gone): make a fresh one, with an ICE restart when the
   * transport is broken. Without it a camera added in that offer would never be negotiated.
   */
  async resendLostOffer(peerId: string): Promise<void> {
    const pc = this.peers.get(peerId);
    const pending = this.pendingOffers.get(peerId);
    if (!pc || !pending?.lost || !this.signallingUp || pc.signalingState !== 'have-local-offer') return;
    try {
      await this.createAndSendOffer(peerId, pc, this.peerHealth(peerId) === 'broken' ? { iceRestart: true } : {});
    } catch (error) {
      console.error(`[VoiceService] Could not offer again to ${peerId}:`, error);
    }
  }

  /**
   * A peer says what a stream of theirs is. Usually arrives before or with the track
   * (a track that came first was classified from its settings). A screen carries the
   * sharer's clip permission; it may change while the share runs.
   */
  handleStreamMetadata(data: { from: string; metadata: StreamMetadata }): void {
    const { from, metadata } = data;
    if (!metadata || typeof metadata.streamId !== 'string' || (metadata.type !== 'camera' && metadata.type !== 'screen')) return;
    if (!this.streamMetadata.has(from)) {
      this.streamMetadata.set(from, new Map());
    }
    this.streamMetadata.get(from)!.set(metadata.streamId, metadata.type);
    if (metadata.type === 'screen') {
      const allowed = metadata.allowClips !== false;
      if (this.remoteScreenClips.get(from) !== allowed) {
        this.remoteScreenClips.set(from, allowed);
        this.emit('video:remote:clips', { peerId: from, allowed } as never);
      }
    }
  }

  /** Whether the friend behind `peerId` lets their screen be clipped (unknown or older clients: yes). */
  remoteScreenClipsAllowed(peerId: string): boolean {
    return this.remoteScreenClips.get(peerId) !== false;
  }

  /** Let friends clip our screen share or not; a running share tells every peer at once. */
  setShareClipsAllowed(allowed: boolean): void {
    if (this.shareClipsAllowed === allowed) return;
    this.shareClipsAllowed = allowed;
    const stream = this.localScreenStream;
    if (!stream) return;
    for (const [peerId, senders] of this.videoSenders) {
      if (senders.screen) this.sendStreamMetadata(peerId, 'screen', stream);
    }
  }

  /** The voice streams of the friends we hear right now (the clip mixer records them when asked). */
  remoteAudioStreams(): MediaStream[] {
    return Array.from(this.remoteAudio.values());
  }

  private sendStreamMetadata(peerId: string, type: 'camera' | 'screen', stream: MediaStream): void {
    const metadata: StreamMetadata = { streamId: stream.id, type };
    if (type === 'screen') metadata.allowClips = this.shareClipsAllowed;
    this.emit('voice:send-stream-metadata', { to: peerId, metadata } as never);
  }

  /** A stream the peer announced as its screen, or one that already carries video (the microphone stream never does). */
  private isScreenStream(peerId: string, stream: MediaStream): boolean {
    if (this.streamMetadata.get(peerId)?.get(stream.id) === 'screen') return true;
    if (this.remoteVideoTracks.get(peerId)?.screen?.stream.id === stream.id) return true;
    return stream.getVideoTracks().length > 0;
  }

  /**
   * Handle incoming remote video track
   */
  private handleRemoteVideoTrack(peerId: string, track: MediaStreamTrack, stream: MediaStream): void {
    // Check if we have metadata for this stream
    const metadata = this.streamMetadata.get(peerId)?.get(stream.id);
    
    let streamType: 'camera' | 'screen';

    if (metadata) {
      streamType = metadata;
    } else {
      // Fallback: Determine if this is camera or screen share based on track settings
      const settings = track.getSettings();
      // Note: Removed width > 1280 check as it misclassifies 1080p webcams
      const isScreenShare = settings.displaySurface !== undefined || 
                            track.contentHint === 'detail';
      
      streamType = isScreenShare ? 'screen' : 'camera';
    }
    
    console.log(`[VoiceService] Remote video track from ${peerId}: ${streamType} (metadata: ${metadata})`);
    
    console.log(`[VoiceService] Remote video track from ${peerId}: ${streamType}`);

    if (!this.remoteVideoTracks.has(peerId)) {
      this.remoteVideoTracks.set(peerId, {});
    }

    const onTrackEnded = () => {
      this.handleRemoteVideoTrackRemoval(this.resolve(peerId), streamType);
    };

    const onStreamRemove = (event: MediaStreamTrackEvent) => {
      if (event.track === track) {
        this.handleRemoteVideoTrackRemoval(this.resolve(peerId), streamType);
      }
    };

    const peerTracks = this.remoteVideoTracks.get(peerId)!;
    peerTracks[streamType] = {
      track,
      stream,
      onTrackEnded,
      onStreamRemove,
    };

    track.addEventListener('ended', onTrackEnded);
    stream.addEventListener('removetrack', onStreamRemove);
    
    this.emit('video:remote:track', {
      peerId,
      streamType,
      stream,
      track,
    } as never);
  }

  private handleRemoteVideoTrackRemoval(peerId: string, streamType: 'camera' | 'screen'): void {
    const tracks = this.remoteVideoTracks.get(peerId);
    const info = tracks?.[streamType];
    if (!tracks || !info) {
      return;
    }

    info.track.removeEventListener('ended', info.onTrackEnded);
    info.stream.removeEventListener('removetrack', info.onStreamRemove);

    delete tracks[streamType];

    if (!tracks.camera && !tracks.screen) {
      this.remoteVideoTracks.delete(peerId);
    }

    this.emit('video:remote:track:removed', {
      peerId,
      streamType,
    } as never);
  }

  private clearRemoteVideoTracks(peerId: string): void {
    const tracks = this.remoteVideoTracks.get(peerId);
    if (!tracks) {
      return;
    }

    if (tracks.camera) {
      this.handleRemoteVideoTrackRemoval(peerId, 'camera');
    }
    if (tracks.screen) {
      this.handleRemoteVideoTrackRemoval(peerId, 'screen');
    }
  }

  /**
   * Handle incoming remote audio track
   */
  private handleRemoteTrack(peerId: string, stream: MediaStream): void {
    this.attachRemoteAudio(peerId, stream);
  }

  /**
   * Play a peer's voice stream through its own gain node, applying what I have set for
   * that person. Called for every remote audio track; public for the unit tests.
   */
  attachRemoteAudio(peerId: string, stream: MediaStream): void {
    const context = this.ensureAudioContext();
    if (!context) {
      console.warn(`[VoiceService] No AudioContext available for peer ${peerId}`);
      return;
    }

    let manager = this.peerManagers.get(peerId);
    if (!manager) {
      manager = new PeerAudioManager(
        peerId,
        context,
        (speaking) => this.emit('voice:speaking', { id: this.resolve(peerId), speaking }),
        this.vadThreshold
      );
      this.peerManagers.set(peerId, manager);
    }

    manager.attachStream(stream, this.outputDeviceId);
    this.applyPeerAudioState(peerId);
    this.remoteAudio.set(peerId, stream);
    this.emit('voice:remote-audio', { peerId, stream } as never);
  }

  /**
   * Restart ICE on a broken transport, and keep at it while it stays broken: after 2 s, 4 s,
   * 8 s, then every 10 s (negotiation.ts), until the connection is back or the peer is gone.
   * A phone in a tunnel or between two networks has nothing to connect over for a while.
   */
  private scheduleIceRestart(peerId: string, reason: string): void {
    const pc = this.peers.get(peerId);
    if (!pc || pc.connectionState === 'closed') {
      return;
    }

    if (this.iceRestartTimers.has(peerId)) {
      return;
    }

    const timer = window.setTimeout(() => {
      // The peer may have moved to a new socket id meanwhile (rekeyPeer moved this timer).
      const id = this.resolve(peerId);
      this.iceRestartTimers.delete(id);
      void this.performIceRestart(id, reason);
    }, iceRestartDelay(this.iceRestartAttempts.get(peerId) ?? 0));

    this.iceRestartTimers.set(peerId, timer);
  }

  /** Their offer arrived (maybe their own ICE restart): give it time before ours, if one is due, goes out. */
  private postponeIceRestart(peerId: string): void {
    const timer = this.iceRestartTimers.get(peerId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.iceRestartTimers.delete(peerId);
    this.scheduleIceRestart(peerId, 'retry');
  }

  private transportUp(pc: RTCPeerConnection): boolean {
    return pc.connectionState === 'connected' && (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed');
  }

  private resetIceRecovery(peerId: string): void {
    const timer = this.iceRestartTimers.get(peerId);
    if (timer) {
      clearTimeout(timer);
      this.iceRestartTimers.delete(peerId);
    }
    if (this.iceRestartAttempts.has(peerId)) {
      this.iceRestartAttempts.delete(peerId);
    }
  }

  private async performIceRestart(peerId: string, reason: string): Promise<void> {
    const pc = this.peers.get(peerId);
    if (!pc || pc.connectionState === 'closed') {
      return;
    }

    if (this.transportUp(pc)) {
      // Back by itself while we waited.
      this.resetIceRecovery(peerId);
      return;
    }

    if (pc.signalingState === 'have-local-offer' && !isOfferStale(this.pendingOffers.get(peerId), Date.now())) {
      // An offer of ours is still on its way; replacing it now would only make its answer useless.
      this.scheduleIceRestart(peerId, reason);
      return;
    }

    const attempts = (this.iceRestartAttempts.get(peerId) ?? 0) + 1;
    this.iceRestartAttempts.set(peerId, attempts);

    if (import.meta.env.DEV) {
      console.info(`[VoiceService] Performing ICE restart for ${peerId} (attempt ${attempts}) due to ${reason}`);
    }
    if (attempts === ICE_RESTART_MAX_ATTEMPTS && !isTurnConfigured()) {
      this.warnMissingTurn(peerId, new Error('ICE restarts are not getting through'));
    }

    try {
      if (typeof pc.restartIce === 'function') {
        try {
          pc.restartIce();
        } catch (error) {
          if (import.meta.env.DEV) {
            console.warn(`[VoiceService] restartIce call failed before offer for ${peerId}:`, error);
          }
        }
      }

      await this.createAndSendOffer(peerId, pc, { iceRestart: true });
    } catch (error) {
      console.error(`[VoiceService] ICE restart offer failed for ${peerId}:`, error);
      if (!isTurnConfigured()) {
        this.warnMissingTurn(peerId, error);
      }
    }

    // The next try is set up now and dropped as soon as the connection is back.
    this.scheduleIceRestart(this.resolve(peerId), 'retry');
  }

  private async createAndSendOffer(peerId: string, pc: RTCPeerConnection, options: RTCOfferOptions = {}): Promise<void> {
    const offer = await pc.createOffer(options);
    const enhancedOffer = this.enhanceOpusSdp(offer);
    await pc.setLocalDescription(enhancedOffer);

    const local = pc.localDescription ?? enhancedOffer;
    const normalized: RTCSessionDescriptionInit = {
      type: local.type,
      sdp: local.sdp,
    };

    // The answer echoes the id, so an answer to an older offer of ours can be told apart.
    const target = this.resolve(peerId);
    const offerId = ++this.offerSeq;
    this.pendingOffers.set(target, { id: offerId, at: Date.now(), lost: !this.signallingUp });

    this.emit('voice:offer', {
      peerId: target,
      offer: normalized,
      offerId,
    } as never);
  }

  private warnMissingTurn(peerId: string, error: unknown): void {
    if (this.turnWarningShown) {
      return;
    }

    this.turnWarningShown = true;

    this.emit('notification', {
      id: `turn-warning-${peerId}`,
      type: 'warning',
      message: 'Voice connection failed. Configure a TURN server for better NAT traversal.',
      duration: 8000,
    });

    if (import.meta.env.DEV) {
      console.warn('[VoiceService] ICE failure without TURN configuration:', error);
    }
  }

  /**
   * Setup speaking detection for a remote peer
   */


  private ensureAudioContext(): AudioContext | null {
    if (typeof window === 'undefined') {
      return null;
    }

    const AudioContextCtor = window.AudioContext || (window as never)['webkitAudioContext'];
    if (!AudioContextCtor) {
      return null;
    }

    if (!this.audioContext) {
      this.audioContext = new AudioContextCtor();

      // Apply output device if already selected
      if (this.outputDeviceId && typeof (this.audioContext as any).setSinkId === 'function') {
        (this.audioContext as any).setSinkId(this.outputDeviceId).catch((error: unknown) => {
          console.warn('[VoiceService] Error setting initial AudioContext output device:', error);
        });
      }
    }

    this.tryResumeAudioContext();
    return this.audioContext;
  }

  private tryResumeAudioContext(): void {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch((error) => {
        console.warn('[VoiceService] Unable to auto-resume AudioContext:', error);
      });
    }
  }

  /**
   * Prepare audio playback for voice channels.
   * Should be called on user interaction (e.g., joining a voice channel)
   * to unlock audio on mobile/desktop platforms.
   */
  prepareAudioPlayback(): void {
    // Ensure AudioContext is created and resumed
    const context = this.ensureAudioContext();
    if (context) {
      console.log(`[VoiceService] AudioContext state: ${context.state}`);
    }

    // On mobile/Electron, try to play a silent audio to unlock audio playback
    // This helps with autoplay restrictions
    try {
      const silentAudio = document.createElement('audio');
      silentAudio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
      silentAudio.volume = 0.001;
      silentAudio.play().then(() => {
        silentAudio.remove();
        console.log('[VoiceService] Audio playback unlocked');
      }).catch(() => {
        silentAudio.remove();
      });
    } catch (error) {
      // Ignore errors - this is just a best-effort unlock
    }

    // Also try to resume any existing audio elements
    for (const manager of this.peerManagers.values()) {
      manager.resume();
    }
  }

  /**
   * Create and send an offer to a peer
   */
  async createOffer(peerId: string): Promise<void> {
    let pc = this.peers.get(peerId);
    
    if (!pc) {
      pc = this.createPeerConnection(peerId);
      this.peers.set(peerId, pc);
    }

    // Ensure local audio track is attached without duplicating senders
    await this.replaceAudioTrack(peerId, pc);

    // Add video tracks if they exist
    if (this.localVideoStream) {
      this.addVideoTrackToPeer(peerId, pc, 'camera', this.localVideoStream);
    }
    if (this.localScreenStream) {
      this.addVideoTrackToPeer(peerId, pc, 'screen', this.localScreenStream);
    }

    try {
      await this.createAndSendOffer(peerId, pc);
    } catch (error) {
      console.error(`Error creating offer for ${peerId}:`, error);
      throw error;
    }
  }

  /**
   * Handle incoming offer
   */
  async handleOffer(
    peerId: string,
    offer: RTCSessionDescriptionInit,
    offerId?: number
  ): Promise<void> {
    let pc = this.peers.get(peerId);

    // An offer from a connection the peer rebuilt (new DTLS certificate) cannot be applied to
    // the connection we still hold for them: start over on our side too.
    if (pc && pc.remoteDescription?.sdp) {
      const previous = dtlsFingerprint(pc.remoteDescription.sdp);
      const next = dtlsFingerprint(offer.sdp);
      if (previous && next && previous !== next) {
        if (import.meta.env.DEV) console.info(`[VoiceService] ${peerId} offers from a new connection; rebuilding ours`);
        this.removePeer(peerId);
        pc = undefined;
      }
    }

    if (!pc) {
      pc = this.createPeerConnection(peerId);
      this.peers.set(peerId, pc);
    }

    try {
      // Our own offer is unanswered: both sides offered at once (both restarted ICE after a
      // drop), or ours was lost while the socket was down. One side yields (negotiation.ts);
      // when it is us, ours is taken back, without which setRemoteDescription throws.
      if (pc.signalingState === 'have-local-offer') {
        if (resolveOfferCollision(this.politeFor(peerId), this.pendingOffers.get(peerId), Date.now()) === 'ignore') {
          if (import.meta.env.DEV) console.info(`[VoiceService] ${peerId} offered while ours is out; ours stands`);
          return;
        }
        await pc.setLocalDescription({ type: 'rollback' });
        this.pendingOffers.delete(peerId);
      }
      await pc.setRemoteDescription(new RTCSessionDescription(offer));

      // Reuse existing sender when renegotiating to avoid InvalidAccessError
      await this.replaceAudioTrack(peerId, pc);

      // Add video tracks if they exist
      if (this.localVideoStream) {
        this.addVideoTrackToPeer(peerId, pc, 'camera', this.localVideoStream);
      }
      if (this.localScreenStream) {
        this.addVideoTrackToPeer(peerId, pc, 'screen', this.localScreenStream);
      }

      const answer = await pc.createAnswer();
      const enhancedAnswer = this.enhanceOpusSdp(answer);
      await pc.setLocalDescription(enhancedAnswer);
      this.applyScreenSenderEncoding(peerId);
      this.reapplyVoiceSender(peerId, pc);

      const local = pc.localDescription ?? enhancedAnswer;
      this.emit('voice:answer', {
        peerId,
        answer: {
          type: local.type,
          sdp: local.sdp,
        },
        ...(offerId !== undefined ? { offerId } : {}),
      } as never);

      // Their offer may be their own ICE restart: let it finish before ours, if one is due.
      this.postponeIceRestart(peerId);
      // An answer only covers what the offer listed. When we send something it did not (our
      // camera, on a connection they rebuilt after we reconnected), we offer it ourselves now.
      if (typeof pc.getTransceivers === 'function' && needsOwnOffer(pc.getTransceivers())) {
        await this.createAndSendOffer(peerId, pc);
      }
    } catch (error) {
      console.error(`Error handling offer from ${peerId}:`, error);
      throw error;
    }
  }

  /**
   * Handle incoming answer
   */
  async handleAnswer(
    peerId: string,
    answer: RTCSessionDescriptionInit,
    offerId?: number
  ): Promise<void> {
    const pc = this.peers.get(peerId);

    if (!pc) {
      console.error(`No peer connection found for ${peerId}`);
      return;
    }

    if (pc.signalingState !== 'have-local-offer') {
      // The answer to an offer we took back when theirs crossed it.
      if (import.meta.env.DEV) console.info(`[VoiceService] Answer from ${peerId} to an offer we took back; ignored`);
      return;
    }
    const pending = this.pendingOffers.get(peerId);
    if (typeof offerId === 'number' && pending && pending.id !== offerId) {
      // The answer to an older offer of ours (a stalled socket delivering late); the newer one is still out.
      if (import.meta.env.DEV) console.info(`[VoiceService] Answer from ${peerId} to an older offer; ignored`);
      return;
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      this.pendingOffers.delete(peerId);
      this.applyScreenSenderEncoding(peerId);
      this.reapplyVoiceSender(peerId, pc);
    } catch (error) {
      console.error(`Error handling answer from ${peerId}:`, error);
      throw error;
    }
  }

  /**
   * Handle incoming ICE candidate
   */
  async handleIceCandidate(
    peerId: string,
    candidate: RTCIceCandidateInit
  ): Promise<void> {
    const pc = this.peers.get(peerId);
    
    if (!pc) {
      console.error(`No peer connection found for ${peerId}`);
      return;
    }

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error(`Error adding ICE candidate from ${peerId}:`, error);
    }
  }

  /**
   * Remove a peer connection
   */
  removePeer(peerId: string): void {
    // Close peer connection
    const pc = this.peers.get(peerId);
    if (pc) {
      pc.close();
      this.peers.delete(peerId);
    }

    this.resetIceRecovery(peerId);
    this.pendingOffers.delete(peerId);
    this.clearRemoteVideoTracks(peerId);

    // Clean up video senders
    this.videoSenders.delete(peerId);

    // Remove peer manager
    const manager = this.peerManagers.get(peerId);
    if (manager) {
      manager.dispose();
      this.peerManagers.delete(peerId);
    }
    if (this.remoteAudio.delete(peerId)) this.emit('voice:remote-audio', { peerId, stream: null } as never);
    this.remoteScreenClips.delete(peerId);
    // The socket id is gone for good; the setting itself lives with the account (state/peerAudio.ts).
    this.peerAudioPreferences.delete(peerId);
    for (const [from, to] of Array.from(this.aliases.entries())) {
      if (to === peerId) this.aliases.delete(from);
    }
  }

  hasPeer(peerId: string): boolean {
    return this.peers.has(peerId);
  }

  /**
   * Set output volume for all remote audios
   */
  setOutputVolume(volume: number): void {
    this.outputVolume = clamp(volume, 0, 1);

    for (const peerId of this.peerManagers.keys()) {
      this.applyPeerAudioState(peerId);
    }
  }

  /**
   * Set output device for all remote audios
   */
  async setOutputDevice(deviceId: string): Promise<void> {
    let normalizedId = deviceId ?? '';
    if (normalizedId === 'default') {
      normalizedId = '';
    }
    const nativeRouteId = normalizedId.startsWith('native:') ? normalizedId.slice(7) : null;

    // If it's a native route, try to use the native audio routing
    if (nativeRouteId !== null) {
      try {
        await selectNativeAudioRoute(nativeRouteId);
        this.outputDeviceId = normalizedId;
        return;
      } catch (error) {
        // If native routing fails, throw the error to inform the user
        throw error;
      }
    }

    // If empty string and on native platform, try to reset to default native route
    if (isNativeAudioRoutingAvailable() && normalizedId === '') {
      try {
        await selectNativeAudioRoute(null);
        this.outputDeviceId = normalizedId;
        return;
      } catch (error) {
        // If native routing fails, fall through to web audio routing
        if (import.meta.env.DEV) {
          console.warn('[VoiceService] Native audio routing failed, using web audio routing:', error);
        }
      }
    }

    // Use standard Web Audio API output device selection
    this.outputDeviceId = normalizedId;

    const promises: Promise<void>[] = [];

    // Try to set sink ID on AudioContext (for native/Web Audio API output)
    if (this.audioContext && typeof (this.audioContext as any).setSinkId === 'function') {
      promises.push(
        (this.audioContext as any).setSinkId(normalizedId).catch((error: unknown) => {
          console.warn('[VoiceService] Error setting AudioContext output device:', error);
        })
      );
    }

    for (const manager of this.peerManagers.values()) {
      promises.push(manager.setSinkId(normalizedId));
    }

    await Promise.all(promises);
  }

  /**
   * Update voice quality settings
   */
  updateVoiceSettings(
    voiceBitrate: number,
    dtxEnabled: boolean,
    vadThreshold?: number,
    options?: Partial<VoiceCodecOptions>
  ): void {
    this.voiceBitrate = normalizeVoiceBitrate(voiceBitrate);
    this.dtxEnabled = Boolean(dtxEnabled);
    
    if (vadThreshold !== undefined) {
      const nextThreshold = clampNumber(vadThreshold, 0.01, 0.5, this.vadThreshold);
      this.vadThreshold = nextThreshold;
      
      // Update all existing speaking monitors with new threshold
      for (const manager of this.peerManagers.values()) {
        manager.setThreshold(nextThreshold);
      }
    }

    if (options) {
      if (options.stereo !== undefined) {
        this.opusStereo = Boolean(options.stereo);
      }

      if (options.maxPtime !== undefined) {
        this.opusMaxPtime = Math.round(
          clampNumber(options.maxPtime, 20, 60, this.opusMaxPtime)
        );
      }

      if (options.minPtime !== undefined) {
        this.opusMinPtime = Math.round(
          clampNumber(options.minPtime, 3, 20, this.opusMinPtime)
        );
      }

      if (options.maxPlaybackRate !== undefined) {
        this.opusMaxPlaybackRate = Math.round(
          clampNumber(options.maxPlaybackRate, 32000, 48000, this.opusMaxPlaybackRate)
        );
      }
    }

    this.applyVoiceSenderHints();
  }

  /**
   * Data-saver voice for our own link: cap every voice sender at 24 kbps, or lift the cap.
   * Applied with setParameters, so nothing is renegotiated; the next offer or answer also
   * asks the peers for the same (`maxaveragebitrate`).
   */
  setLinkConstrained(constrained: boolean): void {
    if (this.linkConstrained === constrained) return;
    this.linkConstrained = constrained;
    this.applyVoiceSenderHints();
  }

  /** A peer said its link is constrained (`voice:link`): cap only our sender to that peer. */
  setPeerLinkConstrained(peerId: string, constrained: boolean): void {
    const id = this.resolve(peerId);
    if ((this.peerLinkConstrained.get(id) ?? false) === constrained) return;
    if (constrained) this.peerLinkConstrained.set(id, true);
    else this.peerLinkConstrained.delete(id);
    const pc = this.peers.get(id);
    if (pc) this.reapplyVoiceSender(id, pc);
  }

  /** The peer left the room: drop what it said about its link. */
  forgetPeerLink(peerId: string): void {
    this.peerLinkConstrained.delete(this.resolve(peerId));
  }

  /** The bitrate cap of our voice sender to `peerId`. */
  voiceSenderBitrate(peerId: string): number {
    const capped = this.linkConstrained || this.peerLinkConstrained.get(this.resolve(peerId)) === true;
    return capped ? Math.min(this.voiceBitrate, CONSTRAINED_VOICE_BITRATE) : this.voiceBitrate;
  }

  /** The microphone's sender on a connection (the screen share's audio is a second audio sender; never treat it as the voice). */
  private voiceSender(peerId: string, pc: RTCPeerConnection): RTCRtpSender | undefined {
    const screenAudio = this.videoSenders.get(peerId)?.screenAudio;
    return pc.getSenders().find((s) => s !== screenAudio && s.track?.kind === 'audio');
  }

  private applyVoiceSenderHints(): void {
    for (const [peerId, pc] of this.peers.entries()) this.reapplyVoiceSender(peerId, pc);
  }

  /**
   * The voice sender's limits again, once a negotiation completed: on the answering side the
   * sender only gets its encoding during the answer, and setParameters before that does not
   * stick, so a cap set then would be lost.
   */
  private reapplyVoiceSender(peerId: string, pc: RTCPeerConnection): void {
    const sender = this.voiceSender(peerId, pc);
    if (sender) this.applySenderQualityHints(sender, peerId);
  }

  /**
   * Deafen (mute all remote peers)
   */
  setDeafened(deafened: boolean): void {
    this.deafened = deafened;

    for (const peerId of this.peerManagers.keys()) {
      this.applyPeerAudioState(peerId);
    }
  }

  /**
   * Get connection stats for a peer
   */
  async getStats(peerId: string): Promise<RTCStatsReport | null> {
    const pc = this.peers.get(peerId);
    return pc ? await pc.getStats() : null;
  }

  /**
   * Start monitoring connection quality for all peers
   */
  startStatsMonitoring(): void {
    if (this.statsPollingHandle !== null) {
      return;
    }

    this.statsPollingHandle = window.setInterval(() => {
      void this.pollConnectionStats();
    }, STATS_POLLING_INTERVAL_MS);
  }

  /**
   * Stop monitoring connection quality
   */
  stopStatsMonitoring(): void {
    if (this.statsPollingHandle !== null) {
      window.clearInterval(this.statsPollingHandle);
      this.statsPollingHandle = null;
    }
  }

  /**
   * Get the current connection quality for a peer
   */
  getPeerConnectionQuality(peerId: string): ConnectionQuality {
    const history = this.peerStatsHistory.get(peerId);
    if (!history || history.length === 0) {
      return 'unknown';
    }
    return history[history.length - 1].quality;
  }

  /**
   * Get the latest stats for a peer
   */
  getPeerStats(peerId: string): PeerConnectionStats | null {
    const history = this.peerStatsHistory.get(peerId);
    if (!history || history.length === 0) {
      return null;
    }
    return history[history.length - 1];
  }

  /**
   * Get overall connection quality across all peers
   */
  getOverallConnectionQuality(): ConnectionQuality {
    if (this.peers.size === 0) {
      return 'unknown';
    }

    const qualities = Array.from(this.peers.keys()).map((peerId) =>
      this.getPeerConnectionQuality(peerId)
    );

    const qualityScore: Record<ConnectionQuality, number> = {
      excellent: 4,
      good: 3,
      fair: 2,
      poor: 1,
      unknown: 0,
    };

    const knownQualities = qualities.filter((q) => q !== 'unknown');
    if (knownQualities.length === 0) {
      return 'unknown';
    }

    const avgScore = knownQualities.reduce((sum, q) => sum + qualityScore[q], 0) / knownQualities.length;

    if (avgScore >= 3.5) return 'excellent';
    if (avgScore >= 2.5) return 'good';
    if (avgScore >= 1.5) return 'fair';
    return 'poor';
  }

  private async pollConnectionStats(): Promise<void> {
    let estimate = 0;
    let need = 0;
    let measured = 0;
    const statsPromises = Array.from(this.peers.entries()).map(async ([peerId, pc]) => {
      try {
        const stats = await this.gatherPeerStats(peerId, pc);
        if (stats) {
          this.recordPeerStats(peerId, stats);
          this.emit('voice:stats', stats as never);
          if (stats.availableOutgoingBitrate !== null && this.voiceSender(peerId, pc)) {
            measured += 1;
            estimate += stats.availableOutgoingBitrate;
            need += this.voiceSenderBitrate(peerId) + VOICE_PACKET_OVERHEAD_BPS;
          }
        }
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn(`[VoiceService] Failed to gather stats for ${peerId}:`, error);
        }
      }
    });

    await Promise.allSettled(statsPromises);
    // Does the call's voice fit what the browser thinks it may send? (data-saver voice)
    this.emit('voice:bandwidth', (measured > 0 ? { estimate, need } : null) as never);
  }

  private async gatherPeerStats(
    peerId: string,
    pc: RTCPeerConnection
  ): Promise<PeerConnectionStats | null> {
    const report = await pc.getStats();
    let rtt: number | null = null;
    let packetLoss: number | null = null;
    let jitter: number | null = null;
    let bitrate: number | null = null;
    let availableOutgoingBitrate: number | null = null;

    const lastTs = this.lastStatsTimestamp.get(peerId) ?? 0;
    let currentBytesReceived = 0;
    let currentTimestamp = 0;

    report.forEach((stat) => {
      if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
        if (typeof stat.currentRoundTripTime === 'number') {
          rtt = stat.currentRoundTripTime * 1000; // Convert to ms
        }
        if (stat.nominated !== false && typeof stat.availableOutgoingBitrate === 'number') {
          availableOutgoingBitrate = stat.availableOutgoingBitrate;
        }
      }

      if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
        if (typeof stat.packetsLost === 'number' && typeof stat.packetsReceived === 'number') {
          const total = stat.packetsLost + stat.packetsReceived;
          packetLoss = total > 0 ? (stat.packetsLost / total) * 100 : 0;
        }
        if (typeof stat.jitter === 'number') {
          jitter = stat.jitter * 1000; // Convert to ms
        }
        if (typeof stat.bytesReceived === 'number' && typeof stat.timestamp === 'number') {
          currentBytesReceived = stat.bytesReceived;
          currentTimestamp = stat.timestamp;
        }
      }
    });

    // Calculate bitrate from bytes received
    if (currentTimestamp > lastTs && currentBytesReceived > 0) {
      const timeDelta = (currentTimestamp - lastTs) / 1000; // seconds
      if (timeDelta > 0) {
        const prevStats = this.peerStatsHistory.get(peerId);
        const prevBytes = prevStats?.length
          ? (prevStats[prevStats.length - 1] as PeerConnectionStats & { _bytesReceived?: number })?._bytesReceived ?? 0
          : 0;
        const bytesDelta = currentBytesReceived - prevBytes;
        if (bytesDelta >= 0) {
          bitrate = (bytesDelta * 8) / timeDelta; // bits per second
        }
      }
    }

    this.lastStatsTimestamp.set(peerId, currentTimestamp);

    const quality = this.calculateConnectionQuality(rtt, packetLoss, jitter);

    const stats: PeerConnectionStats & { _bytesReceived?: number } = {
      peerId,
      quality,
      roundTripTime: rtt,
      packetLoss,
      jitter,
      bitrate,
      availableOutgoingBitrate,
      timestamp: Date.now(),
      _bytesReceived: currentBytesReceived,
    };

    return stats;
  }

  private calculateConnectionQuality(
    rtt: number | null,
    packetLoss: number | null,
    jitter: number | null
  ): ConnectionQuality {
    // Score based on RTT (< 50ms excellent, < 150ms good, < 300ms fair, otherwise poor)
    let rttScore = 4;
    if (rtt !== null) {
      if (rtt > 300) rttScore = 1;
      else if (rtt > 150) rttScore = 2;
      else if (rtt > 50) rttScore = 3;
    }

    // Score based on packet loss (< 1% excellent, < 3% good, < 5% fair, otherwise poor)
    let lossScore = 4;
    if (packetLoss !== null) {
      if (packetLoss > 5) lossScore = 1;
      else if (packetLoss > 3) lossScore = 2;
      else if (packetLoss > 1) lossScore = 3;
    }

    // Score based on jitter (< 20ms excellent, < 50ms good, < 100ms fair, otherwise poor)
    let jitterScore = 4;
    if (jitter !== null) {
      if (jitter > 100) jitterScore = 1;
      else if (jitter > 50) jitterScore = 2;
      else if (jitter > 20) jitterScore = 3;
    }

    const avgScore = (rttScore + lossScore + jitterScore) / 3;

    if (avgScore >= 3.5) return 'excellent';
    if (avgScore >= 2.5) return 'good';
    if (avgScore >= 1.5) return 'fair';
    return 'poor';
  }

  private recordPeerStats(peerId: string, stats: PeerConnectionStats): void {
    let history = this.peerStatsHistory.get(peerId);
    if (!history) {
      history = [];
      this.peerStatsHistory.set(peerId, history);
    }

    history.push(stats);
    if (history.length > CONNECTION_QUALITY_HISTORY_SIZE) {
      history.shift();
    }
  }

  /**
   * Cleanup all connections
   */
  dispose(): void {
    this.stopStatsMonitoring();
    this.peerStatsHistory.clear();
    this.lastStatsTimestamp.clear();
    this.pendingOffers.clear();
    this.signallingUp = true;

    // Stop video streams
    this.stopCamera();
    this.stopScreenShare();

    // Remove all peers
    for (const peerId of Array.from(this.peers.keys())) {
      this.removePeer(peerId);
    }

    // Close audio context
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.localStream = null;
    this.localVideoStream = null;
    this.localScreenStream = null;
    this.peers.clear();
    this.peerManagers.clear();
    this.remoteVideoElements.clear();
    this.videoSenders.clear();
    this.remoteVideoTracks.clear();
    this.aliases.clear();
    this.peerLinkConstrained.clear();
  }

  // ==================== VIDEO METHODS ====================

  /**
   * Get available video input devices
   */
  async getVideoDevices(): Promise<MediaDeviceInfo[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((device) => device.kind === 'videoinput');
    } catch (error) {
      console.error('[VoiceService] Failed to enumerate devices:', error);
      return [];
    }
  }

  /** Background blur of the camera (services/voice/cameraEffects.ts), created on first use. */
  private effects(): CameraEffects {
    if (!this.cameraEffects) {
      const effects = new CameraEffects();
      effects.on('status', (status) => this.emit('video:camera:blur', status as never));
      // Blur gave up (the device could not keep up, or it failed): send the camera as it is.
      effects.on('fallback', () => void this.refreshCameraTrack());
      this.cameraEffects = effects;
    }
    return this.cameraEffects;
  }

  /** What the call sends for this camera at the current blur level: the camera, or its blurred copy. */
  private cameraOutput(source: MediaStreamTrack): Promise<MediaStreamTrack> {
    if (this.cameraBlur === 'off' && !this.cameraEffects) return Promise.resolve(source);
    return this.effects().apply(source, this.cameraBlur);
  }

  /**
   * Background blur level. A running camera switches at once: the sent track is replaced
   * in every connection (replaceTrack), so nothing is renegotiated and the camera keeps running.
   */
  async setCameraBlur(level: CameraBlurLevel): Promise<void> {
    if (this.cameraBlur === level) return;
    this.cameraBlur = level;
    await this.refreshCameraTrack();
  }

  getCameraBlurStatus(): CameraBlurStatus {
    return this.cameraEffects?.status ?? OFF_STATUS;
  }

  /** The device id of the camera as captured (the blurred copy has none). */
  getCameraDeviceId(): string | undefined {
    return this.cameraSource?.getVideoTracks()[0]?.getSettings().deviceId;
  }

  private async refreshCameraTrack(): Promise<void> {
    const source = this.cameraSource?.getVideoTracks()[0];
    if (!source || source.readyState === 'ended') return;
    const track = await this.cameraOutput(source);
    // The camera changed or went off while the blur was starting.
    if (this.cameraSource?.getVideoTracks()[0] !== source) return;
    await this.sendCameraTrack(track);
  }

  /** Puts `track` into the sent camera stream and every peer's camera sender. */
  private async sendCameraTrack(track: MediaStreamTrack): Promise<void> {
    const stream = this.localVideoStream;
    if (!stream) return;
    const current = stream.getVideoTracks()[0];
    if (current === track) return;
    if (current) stream.removeTrack(current);
    stream.addTrack(track);
    const pending: Promise<void>[] = [];
    for (const [peerId, senders] of this.videoSenders) {
      if (!senders.camera) continue;
      pending.push(senders.camera.replaceTrack(track).catch((error) => console.error(`[VoiceService] Failed to replace the camera track for ${peerId}:`, error)));
    }
    await Promise.all(pending);
    // A new stream object, so the local preview attaches the new track.
    this.emit('video:camera:track', { stream: new MediaStream([track]) } as never);
  }

  private watchCameraSource(source: MediaStream): MediaStreamTrack | undefined {
    const track = source.getVideoTracks()[0];
    if (track) {
      track.contentHint = 'motion';
      track.addEventListener('ended', () => this.handleCameraTrackEnded(source));
    }
    return track;
  }

  /**
   * Switch camera to a specific device
   */
  async switchCamera(deviceId: string): Promise<MediaStream> {
    if (!this.localVideoStream || !this.cameraSource) {
      return this.startCamera(deviceId);
    }

    try {
      // The new camera is opened before the old one is stopped so a failed flip keeps the picture.
      const newSource = await captureCamera({ deviceId });
      const newTrack = this.watchCameraSource(newSource);
      if (!newTrack) {
        throw new Error('No video track found in new stream');
      }
      const previous = this.cameraSource;
      this.cameraSource = newSource;
      // With blur on, the blurred track stays the same and only its input changes.
      const sent = await this.cameraOutput(newTrack);
      previous.getTracks().forEach((track) => track.stop());
      await this.sendCameraTrack(sent);
      return this.localVideoStream ?? newSource;
    } catch (error) {
      console.error('[VoiceService] Failed to switch camera:', error);
      throw error;
    }
  }

  /**
   * Start camera and add video track to all peers. Constraints, retries and the
   * user-facing error text live in cameraCapture.ts (throws a CameraError). With
   * background blur on, the blurred copy is what is sent from the first frame on.
   */
  startCamera(deviceId?: string): Promise<MediaStream> {
    if (this.localVideoStream) {
      return Promise.resolve(this.localVideoStream);
    }
    if (!this.cameraStarting) {
      this.cameraStarting = this.openCamera(deviceId).finally(() => {
        this.cameraStarting = null;
      });
    }
    return this.cameraStarting;
  }

  private async openCamera(deviceId?: string): Promise<MediaStream> {
    try {
      const source = await captureCamera({ deviceId });
      this.cameraSource = source;
      const track = this.watchCameraSource(source);
      const sent = track ? await this.cameraOutput(track) : null;
      if (this.cameraSource !== source) {
        // Turned off while the blur was starting.
        return source;
      }
      const stream = new MediaStream(sent ? [sent] : []);
      this.localVideoStream = stream;

      // Add video track to all existing peers
      await this.addVideoTrackToAllPeers('camera', stream);

      this.emit('video:camera:started', { stream } as never);
      return stream;
    } catch (error) {
      console.error('[VoiceService] Failed to start camera:', error);
      throw error;
    }
  }

  /**
   * Stop camera and remove video track from all peers
   */
  stopCamera(): void {
    const sent = this.localVideoStream;
    if (sent || this.cameraSource) {
      this.cameraEffects?.stop();
      this.cameraSource?.getTracks().forEach((track) => track.stop());
      sent?.getTracks().forEach((track) => track.stop());
      if (sent) this.removeVideoTrackFromAllPeers('camera');
      this.cameraSource = null;
      this.localVideoStream = null;
    }
    this.emit('video:camera:stopped', undefined as never);
  }

  /**
   * Start screen sharing (video plus system audio when the user allows it) and add it to all peers
   */
  async startScreenShare(): Promise<MediaStream> {
    if (this.localScreenStream) {
      return this.localScreenStream;
    }

    try {
      const capture = await captureScreen(this.screenQuality);
      const stream = capture.stream;
      this.localScreenStream = stream;

      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        this.handleScreenTrackEnded();
      });

      // Add the screen's tracks to all existing peers
      await this.addVideoTrackToAllPeers('screen', stream);

      this.emit('video:screen:started', { stream, hasAudio: capture.hasAudio, audioNotice: screenAudioNotice(capture) } as never);
      return stream;
    } catch (error) {
      if (!isCancelError(error)) {
        console.error('[VoiceService] Failed to start screen share:', error);
      }
      throw error;
    }
  }

  /**
   * Stop screen sharing and remove from all peers
   */
  stopScreenShare(): void {
    if (this.localScreenStream) {
      this.localScreenStream.getTracks().forEach((track) => track.stop());
      this.removeVideoTrackFromAllPeers('screen');
      this.localScreenStream = null;
    }
    this.emit('video:screen:stopped', undefined as never);
  }

  /**
   * Change the screen share preset; a running share is re-encoded in place.
   */
  setScreenQuality(quality: ScreenQuality): void {
    this.screenQuality = quality;
    if (!this.localScreenStream) {
      return;
    }
    applyScreenQualityToStream(this.localScreenStream, quality);
    for (const peerId of this.videoSenders.keys()) {
      this.applyScreenSenderEncoding(peerId);
    }
  }

  /**
   * Get camera stream
   */
  getCameraStream(): MediaStream | null {
    return this.localVideoStream;
  }

  /**
   * Get screen share stream
   */
  getScreenStream(): MediaStream | null {
    return this.localScreenStream;
  }

  /**
   * Check if camera is active
   */
  isCameraActive(): boolean {
    return this.localVideoStream !== null;
  }

  /**
   * Check if screen share is active
   */
  isScreenShareActive(): boolean {
    return this.localScreenStream !== null;
  }

  /**
   * Add a camera or screen stream to a specific peer. The screen's audio track
   * (system audio) rides along as a second audio sender. The peer is told which
   * stream this is before the offer reaches it, so late joiners classify it too.
   */
  private addVideoTrackToPeer(peerId: string, pc: RTCPeerConnection, type: 'camera' | 'screen', stream: MediaStream): void {
    const track = stream.getVideoTracks()[0];
    if (!track) return;

    try {
      if (!this.videoSenders.has(peerId)) {
        this.videoSenders.set(peerId, {});
      }
      const senders = this.videoSenders.get(peerId)!;

      if (!senders[type]) {
        senders[type] = pc.addTrack(track, stream);
        if (type === 'screen') {
          applyScreenEncoding(senders[type]!, this.screenQuality);
        }
      }

      if (type === 'screen') {
        const audio = stream.getAudioTracks()[0];
        if (audio && !senders.screenAudio) {
          senders.screenAudio = pc.addTrack(audio, stream);
          applyScreenEncoding(senders.screenAudio, this.screenQuality);
        }
      }

      this.sendStreamMetadata(peerId, type, stream);
    } catch (error) {
      console.error(`[VoiceService] Failed to add ${type} track to peer ${peerId}:`, error);
    }
  }

  /**
   * Add video track to all connected peers
   */
  private async addVideoTrackToAllPeers(type: 'camera' | 'screen', stream: MediaStream): Promise<void> {
    for (const [peerId, pc] of this.peers) {
      this.addVideoTrackToPeer(peerId, pc, type, stream);

      // Renegotiate connection
      await this.createAndSendOffer(peerId, pc);
    }
  }

  /**
   * Remove video track (and, for the screen, its audio track) from all connected peers
   */
  private removeVideoTrackFromAllPeers(type: 'camera' | 'screen'): void {
    for (const [peerId, pc] of this.peers) {
      const senders = this.videoSenders.get(peerId);
      if (!senders) continue;

      const removable: RTCRtpSender[] = [];
      if (senders[type]) removable.push(senders[type]!);
      if (type === 'screen' && senders.screenAudio) removable.push(senders.screenAudio);
      if (removable.length === 0) continue;

      try {
        for (const sender of removable) {
          pc.removeTrack(sender);
        }
        delete senders[type];
        if (type === 'screen') delete senders.screenAudio;

        // Renegotiate connection (it may be closing: the call is being left)
        this.createAndSendOffer(peerId, pc).catch((error) => {
          if (pc.signalingState !== 'closed') console.error(`[VoiceService] Could not renegotiate the ${type} removal with ${peerId}:`, error);
        });
      } catch (error) {
        console.error(`[VoiceService] Failed to remove ${type} track from peer ${peerId}:`, error);
      }
    }
  }

  /**
   * Encoder caps for the screen senders of a peer. Called when the senders are
   * created and again after each negotiation, because parameters set on a
   * sender that is not negotiated yet do not always stick.
   */
  private applyScreenSenderEncoding(peerId: string): void {
    const senders = this.videoSenders.get(peerId);
    if (!senders) return;
    if (senders.screen) applyScreenEncoding(senders.screen, this.screenQuality);
    if (senders.screenAudio) applyScreenEncoding(senders.screenAudio, this.screenQuality);
  }

  /**
   * Handle camera track ended (user stopped via browser UI, or the camera was unplugged)
   */
  private handleCameraTrackEnded(source: MediaStream): void {
    if (source !== this.cameraSource) return;
    this.stopCamera();
  }

  /**
   * Handle screen track ended (user stopped via browser UI)
   */
  private handleScreenTrackEnded(): void {
    const stream = this.localScreenStream;
    this.localScreenStream = null;
    stream?.getTracks().forEach((track) => track.stop());
    this.removeVideoTrackFromAllPeers('screen');
    this.emit('video:screen:stopped', undefined as never);
  }

  // --------------------------------------------------------- what I hear of each person

  /**
   * What this peer plays at for me (volume 0..2 and "mute for me"). The service keeps it
   * per socket id for as long as the peer is here; features/voice/voiceManager.ts pushes the
   * account's remembered setting (state/peerAudio.ts) in whenever a peer or a setting changes.
   */
  getPeerAudioPreference(peerId: string): PeerAudioPreference {
    const pref = this.peerAudioPreferences.get(peerId);
    return {
      muted: pref?.muted ?? false,
      volume: this.normalizePeerVolume(pref?.volume),
    };
  }

  /**
   * Set what I hear of this peer. Applied at once to their gain node when their audio is
   * already playing, remembered for the moment it starts otherwise. No signalling, no change
   * to their stream: it is my side only. A no-op when nothing changed.
   */
  setPeerAudio(peerId: string, pref: PeerAudioPreference): void {
    const next: PeerAudioPreference = { muted: Boolean(pref.muted), volume: this.normalizePeerVolume(pref.volume) };
    const current = this.peerAudioPreferences.get(peerId);
    if (current && current.muted === next.muted && current.volume === next.volume) return;
    this.peerAudioPreferences.set(peerId, next);
    this.applyPeerAudioState(peerId);
  }

  /** The gain a peer's voice currently plays at for me, or null while their audio is not attached. */
  peerGain(peerId: string): number | null {
    return this.peerManagers.get(peerId)?.gain() ?? null;
  }

  private applyPeerAudioState(peerId: string): void {
    const manager = this.peerManagers.get(peerId);
    if (!manager) {
      return;
    }

    const pref = this.peerAudioPreferences.get(peerId);
    const localMuted = pref?.muted ?? false;
    const localVolume = this.normalizePeerVolume(pref?.volume);

    manager.applyState(this.deafened, localMuted, localVolume, this.outputVolume);
  }

  private normalizePeerVolume(volume: number | undefined): number {
    const numeric = typeof volume === 'number' ? volume : DEFAULT_PEER_VOLUME;
    if (!Number.isFinite(numeric)) {
      return DEFAULT_PEER_VOLUME;
    }

    return clamp(numeric, 0, MAX_PEER_VOLUME);
  }

  private applySenderQualityHints(sender: RTCRtpSender, peerId: string): void {
    const track = sender.track;
    if (track) {
      track.contentHint = 'speech';
    }

    try {
      const parameters = sender.getParameters();

      if (!parameters.encodings || parameters.encodings.length === 0) {
        parameters.encodings = [{}];
      }

      const maxBitrate = this.voiceSenderBitrate(peerId);
      for (const encoding of parameters.encodings) {
        encoding.maxBitrate = maxBitrate;
        encoding.priority = 'high';
        (encoding as RTCRtpEncodingParameters & { dtx?: boolean }).dtx = this.dtxEnabled;
      }

      parameters.degradationPreference = 'maintain-framerate';

      void sender.setParameters(parameters).catch((error) => {
        if (import.meta.env.DEV) {
          console.warn('[VoiceService] Failed to apply RTP sender parameters:', error);
        }
      });
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[VoiceService] Failed to read RTP sender parameters:', error);
      }
    }
  }

  private enhanceOpusSdp(desc: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
    if (!desc.sdp) {
      return desc;
    }

    const lines = desc.sdp.split(/\r?\n/);
    let opusPayloadId: string | null = null;

    for (const line of lines) {
      if (line.startsWith('a=rtpmap:') && line.includes('opus/48000')) {
        const parts = line.split(' ');
        if (parts.length > 0) {
          opusPayloadId = parts[0].split(':')[1] ?? null;
          break;
        }
      }
    }

    if (opusPayloadId) {
      const fmtpIndex = lines.findIndex((line) => line.startsWith(`a=fmtp:${opusPayloadId}`));
      if (fmtpIndex !== -1) {
        const [prefix, paramString = ''] = lines[fmtpIndex].split(' ', 2);
        const params = new Map<string, string>();

        if (paramString) {
          paramString.split(';').forEach((pair) => {
            const [key, value] = pair.split('=');
            if (key) params.set(key.trim(), value?.trim() ?? '');
          });
        }

        // Apply Opus settings
        if (this.opusStereo) {
          params.set('stereo', '1');
          params.set('sprop-stereo', '1');
        } else {
          params.delete('stereo');
          params.delete('sprop-stereo');
        }

        params.set('minptime', this.opusMinPtime.toString());
        params.set('maxptime', this.opusMaxPtime.toString());
        params.set('maxplaybackrate', this.opusMaxPlaybackRate.toString());
        params.set('usedtx', this.dtxEnabled ? '1' : '0');
        // Ask the remote encoder for the same bitrate we cap our own sender at (RFC 7587);
        // with data-saver voice on our side, that is the 24 kbps cap.
        const receiveBitrate = this.linkConstrained ? Math.min(this.voiceBitrate, CONSTRAINED_VOICE_BITRATE) : this.voiceBitrate;
        params.set('maxaveragebitrate', receiveBitrate.toString());

        const newParams = Array.from(params.entries())
          .map(([k, v]) => (v ? `${k}=${v}` : k))
          .join('; ');

        lines[fmtpIndex] = `${prefix} ${newParams}`;
      }
    }

    return {
      type: desc.type,
      sdp: lines.join('\r\n'),
    };
  }

  /**
   * Diagnostic method to test ICE/TURN connectivity
   * Can be called from browser console: app.voice.runDiagnostics()
   */
  async runDiagnostics(): Promise<{
    iceServers: RTCIceServer[];
    turnConfigured: boolean;
    candidates: { type: string; protocol: string; address: string }[];
    hasRelay: boolean;
    connectionTest: string;
  }> {
    console.log('[VoiceService Diagnostics] Starting connectivity test...');
    console.log('[VoiceService Diagnostics] ICE Servers:', getIceServers());
    console.log('[VoiceService Diagnostics] TURN configured:', isTurnConfigured());

    const candidates: { type: string; protocol: string; address: string }[] = [];
    let hasRelay = false;
    let connectionTest = 'pending';

    try {
      const testPc = new RTCPeerConnection({ iceServers: getIceServers() });
      const dc = testPc.createDataChannel('diagnostics');

      const gatheringComplete = new Promise<void>((resolve) => {
        testPc.onicecandidate = (event) => {
          if (event.candidate) {
            const c = event.candidate;
            const candidateInfo = {
              type: c.type || 'unknown',
              protocol: c.protocol || 'unknown',
              address: c.address || c.candidate?.split(' ')[4] || 'unknown',
            };
            candidates.push(candidateInfo);
            console.log(`[VoiceService Diagnostics] ICE Candidate: ${c.type} ${c.protocol} ${candidateInfo.address}`);
            
            if (c.type === 'relay') {
              hasRelay = true;
              console.log('[VoiceService Diagnostics] ✓ TURN relay candidate found!');
            }
          } else {
            // null candidate means gathering is complete
            resolve();
          }
        };

        testPc.onicegatheringstatechange = () => {
          if (testPc.iceGatheringState === 'complete') {
            resolve();
          }
        };
      });

      await testPc.createOffer().then((offer) => testPc.setLocalDescription(offer));

      // Wait for gathering with timeout
      await Promise.race([
        gatheringComplete,
        new Promise<void>((resolve) => setTimeout(resolve, 10000)),
      ]);

      dc.close();
      testPc.close();

      if (candidates.length === 0) {
        connectionTest = 'failed - no candidates gathered';
      } else if (!hasRelay && isTurnConfigured()) {
        connectionTest = 'warning - TURN configured but no relay candidates (TURN may be unreachable)';
      } else if (hasRelay) {
        connectionTest = 'success - relay candidates available';
      } else {
        connectionTest = 'partial - only host/srflx candidates (may fail behind strict NAT)';
      }
    } catch (error) {
      connectionTest = `error - ${(error as Error).message}`;
    }

    const result = {
      iceServers: getIceServers(),
      turnConfigured: isTurnConfigured(),
      candidates,
      hasRelay,
      connectionTest,
    };

    console.log('[VoiceService Diagnostics] Results:', result);
    console.log('[VoiceService Diagnostics] Summary:', connectionTest);

    if (!hasRelay && isTurnConfigured()) {
      console.warn(
        '[VoiceService Diagnostics] ⚠️ TURN server appears unreachable.\n' +
        'If using Cloudflare tunnel, TURN cannot work through it.\n' +
        'Options:\n' +
        '1. Port forward UDP 3478 and 49160-49200 directly\n' +
        '2. Use an external TURN service\n' +
        '3. Set TURN_EXTERNAL_IP to your public IP'
      );
    }

    return result;
  }
}
