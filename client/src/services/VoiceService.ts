/**
 * WebRTC voice communication service
 */
import type { EventMap } from '@/types';
import { EventEmitter, Storage } from '@/utils';
import { isNativeAudioRoutingAvailable, selectNativeAudioRoute } from './NativeAudioRouteService';
import { isElectron, isCapacitor } from '@/utils/device';
import { config } from '@/config';

// Default ICE servers: Google STUN + Metered.ca TURN (free tier: 500MB/month)
// These are always included as baseline connectivity
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  // Google STUN servers (reliable, free, unlimited)
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Metered.ca STUN
  { urls: 'stun:stun.relay.metered.ca:80' },
  // Metered.ca TURN (free tier - 500MB/month)
  { 
    urls: 'turn:standard.relay.metered.ca:80',
    username: '990e0534ea70a2c639435b06',
    credential: 'F6Z59TCsBPkGLjSR'
  },
  { 
    urls: 'turn:standard.relay.metered.ca:80?transport=tcp',
    username: '990e0534ea70a2c639435b06',
    credential: 'F6Z59TCsBPkGLjSR'
  },
  { 
    urls: 'turn:standard.relay.metered.ca:443',
    username: '990e0534ea70a2c639435b06',
    credential: 'F6Z59TCsBPkGLjSR'
  },
  { 
    urls: 'turns:standard.relay.metered.ca:443?transport=tcp',
    username: '990e0534ea70a2c639435b06',
    credential: 'F6Z59TCsBPkGLjSR'
  },
];

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

const splitEnvList = (value: string | undefined): string[] => {
  if (!value) {
    return [];
  }

  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const ensureTurnScheme = (url: string): string => {
  if (/^turns?:/i.test(url)) {
    return url;
  }
  return `turn:${url}`;
};

const addTransportVariants = (url: string): string[] => {
  const result = new Set<string>();
  const trimmed = url.trim();
  if (!trimmed) {
    return [];
  }

  result.add(trimmed);

  const lower = trimmed.toLowerCase();
  const hasTransport = /[?&]transport=/.test(lower);

  if (lower.startsWith('turn:') && !hasTransport) {
    const separator = trimmed.includes('?') ? '&' : '?';
    result.delete(trimmed);
    result.add(`${trimmed}${separator}transport=udp`);
    result.add(`${trimmed}${separator}transport=tcp`);
  }

  if (lower.startsWith('turns:') && !hasTransport) {
    const separator = trimmed.includes('?') ? '&' : '?';
    result.add(`${trimmed}${separator}transport=tcp`);
  }

  return Array.from(result);
};

const expandIceServerUrls = (server: RTCIceServer): RTCIceServer => {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  const expanded = new Set<string>();

  for (const url of urls) {
    if (typeof url !== 'string') {
      continue;
    }

    if (/^turns?:/i.test(url.trim())) {
      const variants = addTransportVariants(url);
      variants.forEach((variant) => expanded.add(variant));
    } else {
      expanded.add(url.trim());
    }
  }

  if (expanded.size === 0) {
    return server;
  }

  const normalized = Array.from(expanded).filter(Boolean);
  normalized.sort();

  return {
    ...server,
    urls: normalized.length === 1 ? normalized[0] : normalized,
  };
};

const dedupeIceServers = (servers: RTCIceServer[]): RTCIceServer[] => {
  const seen = new Set<string>();
  const result: RTCIceServer[] = [];

  for (const server of servers) {
    const expanded = expandIceServerUrls(server);
    const urls = Array.isArray(expanded.urls) ? expanded.urls : [expanded.urls];
    const key = JSON.stringify({
      urls,
      username: expanded.username ?? '',
      credential: expanded.credential ?? '',
    });

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(expanded);
  }

  return result;
};

const resolveIceServers = (): RTCIceServer[] => {
  // Start with defaults (Google STUN + OpenRelay free TURN)
  const servers: RTCIceServer[] = [...DEFAULT_ICE_SERVERS];

  // If custom ICE servers JSON is provided, use it exclusively
  const customIce = config.WEBRTC_ICE_SERVERS;
  if (customIce) {
    try {
      const parsed = JSON.parse(customIce);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return dedupeIceServers(parsed as RTCIceServer[]);
      }
      console.warn('[VoiceService] VITE_WEBRTC_ICE_SERVERS parsed but not an array, falling back to defaults');
    } catch (error) {
      console.warn('[VoiceService] Failed to parse VITE_WEBRTC_ICE_SERVERS, falling back to defaults:', error);
    }
  }

  // Add self-hosted TURN as additional option (tried after free servers)
  // This provides fallback if free quota is exceeded
  const turnUrls = splitEnvList(config.TURN_URL);
  if (turnUrls.length > 0) {
    const username = config.TURN_USERNAME;
    const credential = config.TURN_CREDENTIAL;

    for (const turnUrl of turnUrls) {
      const normalizedUrl = ensureTurnScheme(turnUrl);
      servers.push({
        urls: normalizedUrl,
        username,
        credential,
      });
    }
  }

  console.log('[VoiceService] ICE servers configured:', servers.length, 'servers');
  return dedupeIceServers(servers);
};

const ICE_SERVERS = resolveIceServers();
const ICE_RESTART_DELAY_MS = 2000;
const ICE_RESTART_MAX_ATTEMPTS = 3;
const OPUS_BITRATE_MIN = 6000;
const OPUS_BITRATE_MAX = 128000;
const OPUS_TARGET_BITRATE = Math.round(
  parseNumberEnv(config.VOICE_OPUS_BITRATE, 64000, {
    min: OPUS_BITRATE_MIN,
    max: OPUS_BITRATE_MAX,
  })
);
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
const TURN_CONFIGURED = ICE_SERVERS.some((server) => {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  return urls.some((url) => typeof url === 'string' && url.toLowerCase().startsWith('turn:'));
});

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

export interface PeerAudioPreference {
  muted: boolean;
  volume: number;
}

interface VoiceCodecOptions {
  stereo?: boolean;
  maxPtime?: number;
  minPtime?: number;
  maxPlaybackRate?: number;
}

const PEER_PREFERENCE_STORAGE_KEY = 'datasetto.voice.peerPreferences.v1';
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
  timestamp: number;
}

type RemoteVideoTrackInfo = {
  track: MediaStreamTrack;
  stream: MediaStream;
  onTrackEnded: () => void;
  onStreamRemove: (event: MediaStreamTrackEvent) => void;
};

type DesktopScreenshareSource = {
  id: string;
  name: string;
  isScreen?: boolean;
  type?: 'screen' | 'window';
};

type DesktopScreensharePickResult = {
  success: boolean;
  source?: DesktopScreenshareSource;
  shareAudio?: boolean;
  error?: string;
};

type DesktopScreenshareBridge = {
  pickScreenshareSource?: (options?: { audio?: boolean }) => Promise<DesktopScreensharePickResult>;
};

class SpeakingMonitor {
  private interval: number | null = null;
  private history: number[] = [];
  private readonly historySize = 10;
  private isSpeaking = false;
  private speakingStartTime = 0;
  private silenceStartTime = 0;
  private readonly silenceHoldMs = 350;
  private hysteresisLow: number;
  private hysteresisHigh: number;

  constructor(
    private analyser: AnalyserNode,
    private onSpeakingChange: (speaking: boolean) => void,
    threshold: number
  ) {
    this.hysteresisHigh = threshold;
    this.hysteresisLow = threshold * 0.6;
  }

  start(): void {
    if (this.interval) return;
    this.interval = window.setInterval(() => this.check(), 50);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isSpeaking = false;
    this.history = [];
  }

  setThreshold(threshold: number): void {
    this.hysteresisHigh = threshold;
    this.hysteresisLow = threshold * 0.6;
  }

  private check(): void {
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);

    const voiceBins = Math.min(18, data.length);
    let sum = 0;
    for (let i = 0; i < voiceBins; i++) {
      sum += data[i];
    }
    const average = sum / voiceBins / 255;

    this.history.push(average);
    if (this.history.length > this.historySize) {
      this.history.shift();
    }

    const smoothed = this.history.reduce((a, b) => a + b, 0) / this.history.length;
    const now = performance.now();

    if (this.isSpeaking) {
      if (smoothed < this.hysteresisLow) {
        if (this.silenceStartTime === 0) {
          this.silenceStartTime = now;
        }
        if (now - this.silenceStartTime >= this.silenceHoldMs) {
          this.isSpeaking = false;
          this.onSpeakingChange(false);
          this.speakingStartTime = 0;
        }
      } else {
        this.silenceStartTime = 0;
      }
    } else {
      if (smoothed > this.hysteresisHigh) {
        if (this.speakingStartTime === 0) {
          this.speakingStartTime = now;
        }
        this.isSpeaking = true;
        this.onSpeakingChange(true);
        this.silenceStartTime = 0;
      }
    }
  }
}

class PeerAudioManager {
  private audioElement: HTMLAudioElement | null = null;
  private sourceNode: AudioNode | null = null;
  private gainNode: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private speakingMonitor: SpeakingMonitor | null = null;
  private mediaElementSource: MediaElementAudioSourceNode | null = null;
  
  constructor(
    private peerId: string,
    private context: AudioContext,
    private onSpeaking: (speaking: boolean) => void,
    private vadThreshold: number
  ) {}

  attachStream(stream: MediaStream, outputDeviceId: string | null) {
    this.dispose();

    this.audioElement = document.createElement('audio');
    this.audioElement.id = `audio-${this.peerId}`;
    this.audioElement.autoplay = true;
    this.audioElement.setAttribute('playsinline', 'true');
    this.audioElement.dataset.peerId = this.peerId;
    
    if (isElectron()) {
      console.log(`[PeerAudioManager] Using Electron strategy for ${this.peerId}`);
      this.audioElement.srcObject = stream;
      this.audioElement.muted = false;
      this.audioElement.volume = 1.0;
      this.audioElement.play().catch(e => console.warn(`[PeerAudioManager] Play failed:`, e));

      this.mediaElementSource = this.context.createMediaElementSource(this.audioElement);
      this.sourceNode = this.mediaElementSource;
      this.gainNode = this.context.createGain();
      this.analyserNode = this.context.createAnalyser();
      
      this.sourceNode.connect(this.gainNode);
      this.gainNode.connect(this.analyserNode);
      this.analyserNode.connect(this.context.destination);
    } 
    else if (isCapacitor()) {
      console.log(`[PeerAudioManager] Using Capacitor strategy for ${this.peerId}`);
      this.audioElement.srcObject = stream;
      this.audioElement.muted = true;
      this.audioElement.play().catch(() => {});
      
      this.sourceNode = this.context.createMediaStreamSource(stream);
      this.gainNode = this.context.createGain();
      this.analyserNode = this.context.createAnalyser();
      
      this.sourceNode.connect(this.gainNode);
      this.gainNode.connect(this.analyserNode);
      this.analyserNode.connect(this.context.destination);
    }
    else {
      console.log(`[PeerAudioManager] Using Web strategy for ${this.peerId}`);
      this.audioElement.srcObject = stream;
      this.audioElement.muted = false;
      this.audioElement.play().catch(() => {});
      
      this.sourceNode = this.context.createMediaStreamSource(stream);
      this.analyserNode = this.context.createAnalyser();
      this.sourceNode.connect(this.analyserNode);
      
      if (outputDeviceId && typeof (this.audioElement as any).setSinkId === 'function') {
        (this.audioElement as any).setSinkId(outputDeviceId).catch(console.error);
      }
    }

    if (this.analyserNode) {
      this.analyserNode.fftSize = 256;
      this.analyserNode.smoothingTimeConstant = 0.8;
      this.speakingMonitor = new SpeakingMonitor(this.analyserNode, this.onSpeaking, this.vadThreshold);
      this.speakingMonitor.start();
    }
    
    document.body.appendChild(this.audioElement);
  }

  applyState(deafened: boolean, localMuted: boolean, localVolume: number, masterVolume: number = 1) {
    const effectiveMuted = deafened || localMuted;
    const effectiveVolume = localVolume * masterVolume;
    
    if (isElectron() || isCapacitor()) {
      if (this.gainNode) {
        // For Electron/Capacitor, we use the gain node for all volume control including boost
        this.gainNode.gain.value = effectiveMuted ? 0 : effectiveVolume;
      }
    } else {
      if (this.audioElement) {
        // For Web, we clamp volume to 1.0 as HTMLMediaElement doesn't support > 1.0
        this.audioElement.volume = Math.min(effectiveVolume, 1.0);
        this.audioElement.muted = effectiveMuted;
      }
    }
  }
  
  async setSinkId(deviceId: string): Promise<void> {
    if (this.audioElement && !isElectron() && !isCapacitor() && typeof (this.audioElement as any).setSinkId === 'function') {
       return (this.audioElement as any).setSinkId(deviceId).catch(console.error);
    }
  }
  
  setThreshold(threshold: number) {
    this.vadThreshold = threshold;
    if (this.speakingMonitor) {
      this.speakingMonitor.setThreshold(threshold);
    }
  }

  resume() {
    if (this.audioElement && this.audioElement.paused && this.audioElement.srcObject) {
      this.audioElement.play().catch(() => {});
    }
  }

  dispose() {
    if (this.speakingMonitor) {
      this.speakingMonitor.stop();
      this.speakingMonitor = null;
    }
    
    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch {}
      this.sourceNode = null;
    }
    
    if (this.gainNode) {
      try { this.gainNode.disconnect(); } catch {}
      this.gainNode = null;
    }
    
    if (this.analyserNode) {
      try { this.analyserNode.disconnect(); } catch {}
      this.analyserNode = null;
    }
    
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.srcObject = null;
      this.audioElement.remove();
      this.audioElement = null;
    }
    
    this.mediaElementSource = null;
  }
}

export class VoiceService extends EventEmitter<EventMap> {
  private peers: Map<string, RTCPeerConnection> = new Map();
  private peerManagers: Map<string, PeerAudioManager> = new Map();
  private iceRestartTimers: Map<string, number> = new Map();
  private iceRestartAttempts: Map<string, number> = new Map();
  private localStream: MediaStream | null = null;
  private localVideoStream: MediaStream | null = null;
  private localScreenStream: MediaStream | null = null;
  private remoteVideoElements: Map<string, HTMLVideoElement> = new Map();
  private videoSenders: Map<string, { camera?: RTCRtpSender; screen?: RTCRtpSender }> = new Map();
  private remoteVideoTracks: Map<string, { camera?: RemoteVideoTrackInfo; screen?: RemoteVideoTrackInfo }> = new Map();
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
  private desktopBridge: DesktopScreenshareBridge | null = null;

  constructor(
    voiceBitrate = OPUS_TARGET_BITRATE,
    dtxEnabled = DEFAULT_DTX_ENABLED,
    vadThreshold = DEFAULT_VAD_THRESHOLD
  ) {
    super();
    this.voiceBitrate = normalizeVoiceBitrate(voiceBitrate);
    this.dtxEnabled = Boolean(dtxEnabled);
    this.vadThreshold = clampNumber(vadThreshold, 0.01, 0.5, DEFAULT_VAD_THRESHOLD);

    this.loadPeerAudioPreferences();

    if (typeof window !== 'undefined') {
      this.resolveDesktopBridge();
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
    const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
    const newTrack = this.localStream?.getAudioTracks()[0];

    if (newTrack) {
      if (sender) {
        try {
          await sender.replaceTrack(newTrack);
          this.applySenderQualityHints(sender);
        } catch (error) {
          console.error(`Error replacing track for peer ${peerId}:`, error);
        }
      } else if (this.localStream) {
        // No sender yet, add the track
        const newSender = pc.addTrack(newTrack, this.localStream);
        this.applySenderQualityHints(newSender);
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
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // ICE candidate handler
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.emit('voice:ice-candidate', {
          peerId,
          candidate: event.candidate,
        } as never);
      }
    };

    pc.onicecandidateerror = (event) => {
      if (import.meta.env.DEV) {
        console.warn(`[VoiceService] ICE candidate error for ${peerId}:`, event);
      }
    };

    // Connection state monitoring
    pc.onconnectionstatechange = () => {
      console.log(`Peer ${peerId} connection state: ${pc.connectionState}`);
      
      if (pc.connectionState === 'failed') {
        this.emit('notification', {
          id: `peer-failed-${peerId}`,
          type: 'warning',
          message: 'Voice connection issue detected',
          duration: 3000,
        });
        this.scheduleIceRestart(peerId, 'connection-state-failed');
      }

      if (pc.connectionState === 'connected') {
        this.resetIceRecovery(peerId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (import.meta.env.DEV) {
        console.log(`[VoiceService] ICE state for ${peerId}: ${state}`);
      }

      if (state === 'disconnected' || state === 'failed') {
        if (typeof pc.restartIce === 'function') {
          try {
            pc.restartIce();
          } catch (error) {
            if (import.meta.env.DEV) {
              console.warn(`[VoiceService] Failed to call restartIce for ${peerId}:`, error);
            }
          }
        }

        this.scheduleIceRestart(peerId, `ice-state-${state}`);
      } else if (state === 'connected' || state === 'completed') {
        this.resetIceRecovery(peerId);
      }
    };

    // Track received handler
    pc.ontrack = (event) => {
      const track = event.track;
      const stream = event.streams[0];
      console.log(`Received ${track.kind} track from peer ${peerId}`);
      
      if (track.kind === 'audio') {
        this.handleRemoteTrack(peerId, stream);
      } else if (track.kind === 'video') {
        this.handleRemoteVideoTrack(peerId, track, stream);
      }
    };

    return pc;
  }

  /**
   * Handle incoming remote video track
   */
  private handleRemoteVideoTrack(peerId: string, track: MediaStreamTrack, stream: MediaStream): void {
    // Determine if this is camera or screen share based on track settings
    const settings = track.getSettings();
    const isScreenShare = settings.displaySurface !== undefined || 
                          (settings.width && settings.width > 1280) ||
                          track.contentHint === 'detail';
    
    const streamType = isScreenShare ? 'screen' : 'camera';
    
    console.log(`[VoiceService] Remote video track from ${peerId}: ${streamType}`);

    if (!this.remoteVideoTracks.has(peerId)) {
      this.remoteVideoTracks.set(peerId, {});
    }

    const onTrackEnded = () => {
      this.handleRemoteVideoTrackRemoval(peerId, streamType);
    };

    const onStreamRemove = (event: MediaStreamTrackEvent) => {
      if (event.track === track) {
        this.handleRemoteVideoTrackRemoval(peerId, streamType);
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
        (speaking) => this.emit('voice:speaking', { id: peerId, speaking }),
        this.vadThreshold
      );
      this.peerManagers.set(peerId, manager);
    }

    manager.attachStream(stream, this.outputDeviceId);
    this.applyPeerAudioState(peerId);
  }

  private scheduleIceRestart(peerId: string, reason: string): void {
    const pc = this.peers.get(peerId);
    if (!pc || pc.connectionState === 'closed') {
      return;
    }

    if (this.iceRestartAttempts.get(peerId) ?? 0 >= ICE_RESTART_MAX_ATTEMPTS) {
      if (import.meta.env.DEV) {
        console.warn(`[VoiceService] ICE restart limit reached for ${peerId}`);
      }
      if (!TURN_CONFIGURED) {
        this.warnMissingTurn(peerId, new Error('restart attempts exhausted'));
      }
      return;
    }

    if (this.iceRestartTimers.has(peerId)) {
      return;
    }

    const timer = window.setTimeout(() => {
      this.iceRestartTimers.delete(peerId);
      void this.performIceRestart(peerId, reason);
    }, ICE_RESTART_DELAY_MS);

    this.iceRestartTimers.set(peerId, timer);
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
    if (!pc) {
      return;
    }

    const attempts = (this.iceRestartAttempts.get(peerId) ?? 0) + 1;
    if (attempts > ICE_RESTART_MAX_ATTEMPTS) {
      if (import.meta.env.DEV) {
        console.warn(`[VoiceService] Aborting ICE restart for ${peerId}; attempts exhausted.`);
      }
      return;
    }

    this.iceRestartAttempts.set(peerId, attempts);

    if (import.meta.env.DEV) {
      console.info(`[VoiceService] Performing ICE restart for ${peerId} (attempt ${attempts}) due to ${reason}`);
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
      if (!TURN_CONFIGURED) {
        this.warnMissingTurn(peerId, error);
      }
    }
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

    this.emit('voice:offer', {
      peerId,
      offer: normalized,
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
    offer: RTCSessionDescriptionInit
  ): Promise<void> {
    let pc = this.peers.get(peerId);
    
    if (!pc) {
      pc = this.createPeerConnection(peerId);
      this.peers.set(peerId, pc);
    }

    try {
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

      const local = pc.localDescription ?? enhancedAnswer;
      this.emit('voice:answer', {
        peerId,
        answer: {
          type: local.type,
          sdp: local.sdp,
        },
      } as never);
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
    answer: RTCSessionDescriptionInit
  ): Promise<void> {
    const pc = this.peers.get(peerId);
    
    if (!pc) {
      console.error(`No peer connection found for ${peerId}`);
      return;
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      this.resetIceRecovery(peerId);
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
    this.clearRemoteVideoTracks(peerId);
    
    // Clean up video senders
    this.videoSenders.delete(peerId);

    // Remove peer manager
    const manager = this.peerManagers.get(peerId);
    if (manager) {
      manager.dispose();
      this.peerManagers.delete(peerId);
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

    // Update all existing peer connections
    for (const pc of this.peers.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
      if (sender) {
        this.applySenderQualityHints(sender);
      }
    }
  }

  /**
   * Mute/unmute a specific remote peer
   */
  muteRemotePeer(peerId: string, muted: boolean): void {
    this.setPeerMuted(peerId, muted);
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
    const statsPromises = Array.from(this.peers.entries()).map(async ([peerId, pc]) => {
      try {
        const stats = await this.gatherPeerStats(peerId, pc);
        if (stats) {
          this.recordPeerStats(peerId, stats);
          this.emit('voice:stats', stats as never);
        }
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn(`[VoiceService] Failed to gather stats for ${peerId}:`, error);
        }
      }
    });

    await Promise.allSettled(statsPromises);
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

    const lastTs = this.lastStatsTimestamp.get(peerId) ?? 0;
    let currentBytesReceived = 0;
    let currentTimestamp = 0;

    report.forEach((stat) => {
      if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
        if (typeof stat.currentRoundTripTime === 'number') {
          rtt = stat.currentRoundTripTime * 1000; // Convert to ms
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

  /**
   * Switch camera to a specific device
   */
  async switchCamera(deviceId: string): Promise<MediaStream> {
    if (!this.localVideoStream) {
      return this.startCamera(deviceId);
    }

    const constraints: MediaStreamConstraints = {
      video: {
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
        frameRate: { ideal: 30, max: 60 },
        facingMode: 'user',
        deviceId: { exact: deviceId },
      },
      audio: false,
    };

    try {
      const newStream = await navigator.mediaDevices.getUserMedia(constraints);
      const newTrack = newStream.getVideoTracks()[0];

      if (!newTrack) {
        throw new Error('No video track found in new stream');
      }

      // Stop old tracks
      this.localVideoStream.getTracks().forEach((track) => track.stop());

      // Update local stream reference
      this.localVideoStream = newStream;

      newTrack.contentHint = 'motion';
      newTrack.addEventListener('ended', () => {
        this.handleCameraTrackEnded();
      });

      // Replace track in all peer connections
      const promises: Promise<void>[] = [];
      for (const senders of this.videoSenders.values()) {
        const sender = senders.camera;
        if (sender) {
          promises.push(sender.replaceTrack(newTrack));
        }
      }

      await Promise.all(promises);

      this.emit('video:camera:started', { stream: newStream } as never);
      return newStream;
    } catch (error) {
      console.error('[VoiceService] Failed to switch camera:', error);
      throw error;
    }
  }

  /**
   * Start camera and add video track to all peers
   */
  async startCamera(deviceId?: string): Promise<MediaStream> {
    if (this.localVideoStream) {
      return this.localVideoStream;
    }

    const constraints: MediaStreamConstraints = {
      video: {
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
        frameRate: { ideal: 30, max: 60 },
        facingMode: 'user',
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
      audio: false,
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.localVideoStream = stream;

      const track = stream.getVideoTracks()[0];
      if (track) {
        track.contentHint = 'motion';
        track.addEventListener('ended', () => {
          this.handleCameraTrackEnded();
        });
      }

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
    if (this.localVideoStream) {
      this.localVideoStream.getTracks().forEach((track) => track.stop());
      this.removeVideoTrackFromAllPeers('camera');
      this.localVideoStream = null;
    }
    this.emit('video:camera:stopped', undefined as never);
  }

  /**
   * Start screen sharing and add to all peers
   */
  async startScreenShare(): Promise<MediaStream> {
    if (this.localScreenStream) {
      return this.localScreenStream;
    }

    try {
      const videoConstraints: MediaTrackConstraints = {
        width: { ideal: 1920, max: 2560 },
        height: { ideal: 1080, max: 1440 },
        frameRate: { ideal: 30, max: 60 },
      };

      let stream: MediaStream | null = null;
      let desktopCancelled = false;
      const desktopBridge = this.resolveDesktopBridge();

      if (desktopBridge?.pickScreenshareSource) {
        const result = await this.requestDesktopScreenshareStream(videoConstraints, true);
        stream = result.stream;
        desktopCancelled = result.cancelled;
      }

      const mediaDevices = navigator.mediaDevices as MediaDevices & {
        getDisplayMedia?: (constraints?: MediaStreamConstraints) => Promise<MediaStream>;
      };

      if (!stream) {
        if (desktopCancelled) {
          throw this.createNotAllowedError('Screen share was cancelled');
        }

        if (!mediaDevices.getDisplayMedia) {
          throw new Error('Screen sharing is not supported in this browser');
        }

        stream = await mediaDevices.getDisplayMedia({
          video: videoConstraints,
          audio: true,
        });
      }

      this.localScreenStream = stream;

      const track = stream.getVideoTracks()[0];
      if (track) {
        track.contentHint = 'detail';
        track.addEventListener('ended', () => {
          this.handleScreenTrackEnded();
        });
      }

      // Add video track to all existing peers
      await this.addVideoTrackToAllPeers('screen', stream);

      this.emit('video:screen:started', { stream } as never);
      return stream;
    } catch (error) {
      console.error('[VoiceService] Failed to start screen share:', error);
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
   * Add video track to a specific peer
   */
  private addVideoTrackToPeer(peerId: string, pc: RTCPeerConnection, type: 'camera' | 'screen', stream: MediaStream): void {
    const track = stream.getVideoTracks()[0];
    if (!track) return;

    try {
      // Check if we already have a sender for this type
      const senders = this.videoSenders.get(peerId);
      if (senders?.[type]) {
        return;
      }

      const sender = pc.addTrack(track, stream);
      
      // Store sender for later removal
      if (!this.videoSenders.has(peerId)) {
        this.videoSenders.set(peerId, {});
      }
      this.videoSenders.get(peerId)![type] = sender;
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
   * Remove video track from all connected peers
   */
  private removeVideoTrackFromAllPeers(type: 'camera' | 'screen'): void {
    for (const [peerId, pc] of this.peers) {
      const senders = this.videoSenders.get(peerId);
      const sender = senders?.[type];
      
      if (sender) {
        try {
          pc.removeTrack(sender);
          delete senders![type];
          
          // Renegotiate connection
          void this.createAndSendOffer(peerId, pc);
        } catch (error) {
          console.error(`[VoiceService] Failed to remove ${type} track from peer ${peerId}:`, error);
        }
      }
    }
  }

  /**
   * Handle camera track ended (user stopped via browser UI)
   */
  private handleCameraTrackEnded(): void {
    this.localVideoStream = null;
    this.removeVideoTrackFromAllPeers('camera');
    this.emit('video:camera:stopped', undefined as never);
  }

  /**
   * Handle screen track ended (user stopped via browser UI)
   */
  private handleScreenTrackEnded(): void {
    this.localScreenStream = null;
    this.removeVideoTrackFromAllPeers('screen');
    this.emit('video:screen:stopped', undefined as never);
  }

  private async requestDesktopScreenshareStream(
    videoConstraints: MediaTrackConstraints,
    wantsAudio: boolean
  ): Promise<{ stream: MediaStream | null; cancelled: boolean }> {
    const desktopBridge = this.resolveDesktopBridge();
    if (!desktopBridge?.pickScreenshareSource) {
      return { stream: null, cancelled: false };
    }

    try {
      const selection = await desktopBridge.pickScreenshareSource({ audio: wantsAudio });
      if (!selection?.success || !selection.source) {
        return { stream: null, cancelled: selection?.error === 'cancelled' };
      }

      const sourceId = selection.source.id;
      const resolvedWidth = this.extractConstraintNumber(videoConstraints.width as ConstrainULongRange | number | undefined);
      const resolvedHeight = this.extractConstraintNumber(videoConstraints.height as ConstrainULongRange | number | undefined);
      const frameRateConstraint = videoConstraints.frameRate as ConstrainDoubleRange | number | undefined;
      const minFrameRate = this.extractConstraintNumber(
        typeof frameRateConstraint === 'object' ? frameRateConstraint.min : frameRateConstraint
      );
      const maxFrameRate = this.extractConstraintNumber(
        typeof frameRateConstraint === 'object' ? frameRateConstraint.max : frameRateConstraint
      );

      const mandatoryVideo = {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        ...(resolvedWidth
          ? {
              minWidth: Math.round(resolvedWidth),
              maxWidth: Math.round(resolvedWidth),
            }
          : {}),
        ...(resolvedHeight
          ? {
              minHeight: Math.round(resolvedHeight),
              maxHeight: Math.round(resolvedHeight),
            }
          : {}),
        ...(typeof minFrameRate === 'number' ? { minFrameRate: Math.round(minFrameRate) } : {}),
        ...(typeof maxFrameRate === 'number' ? { maxFrameRate: Math.round(maxFrameRate) } : {}),
      };

      const isScreen = Boolean(selection.source.isScreen || selection.source.type === 'screen');
      const enableAudio = Boolean(wantsAudio && selection.shareAudio);
      const audioConstraints: MediaTrackConstraints | boolean = enableAudio
        ? ({
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
            },
          } as unknown as MediaTrackConstraints)
        : false;

      const desktopConstraints: MediaStreamConstraints = {
        video: { mandatory: mandatoryVideo } as unknown as MediaTrackConstraints,
        audio: audioConstraints,
      };

      const stream = await navigator.mediaDevices.getUserMedia(desktopConstraints);
      return { stream, cancelled: false };
    } catch (error) {
      console.error('[VoiceService] Desktop screenshare fallback failed:', error);
      return { stream: null, cancelled: false };
    }
  }

  private extractConstraintNumber(
    value: ConstrainULongRange | ConstrainDoubleRange | number | undefined
  ): number | undefined {
    if (typeof value === 'number') {
      return value;
    }

    if (value && typeof value === 'object') {
      if (typeof value.exact === 'number') {
        return value.exact;
      }
      if (typeof value.ideal === 'number') {
        return value.ideal;
      }
      if (typeof value.max === 'number') {
        return value.max;
      }
      if (typeof value.min === 'number') {
        return value.min;
      }
    }

    return undefined;
  }

  private createNotAllowedError(message: string): Error {
    if (typeof DOMException === 'function') {
      return new DOMException(message, 'NotAllowedError');
    }

    const error = new Error(message);
    (error as Error & { name: string }).name = 'NotAllowedError';
    return error;
  }

  private resolveDesktopBridge(): DesktopScreenshareBridge | null {
    if (this.desktopBridge || typeof window === 'undefined') {
      return this.desktopBridge;
    }

    const bridge = (window as typeof window & { desktopAPI?: DesktopScreenshareBridge }).desktopAPI;
    if (bridge) {
      this.desktopBridge = bridge;
    }

    return this.desktopBridge;
  }

  getPeerAudioPreference(peerId: string): PeerAudioPreference {
    const pref = this.peerAudioPreferences.get(peerId);
    return {
      muted: pref?.muted ?? false,
      volume: this.normalizePeerVolume(pref?.volume),
    };
  }

  getAllPeerAudioPreferences(): Map<string, PeerAudioPreference> {
    return new Map(this.peerAudioPreferences);
  }

  setPeerVolume(peerId: string, volume: number): void {
    const clampedVolume = this.normalizePeerVolume(volume);
    const existing = this.peerAudioPreferences.get(peerId) ?? {
      muted: false,
      volume: DEFAULT_PEER_VOLUME,
    };
    this.peerAudioPreferences.set(peerId, { ...existing, volume: clampedVolume });
    this.applyPeerAudioState(peerId);
    this.persistPeerAudioPreferences();
  }

  setPeerMuted(peerId: string, muted: boolean): void {
    const existing = this.peerAudioPreferences.get(peerId) ?? {
      muted: false,
      volume: DEFAULT_PEER_VOLUME,
    };
    this.peerAudioPreferences.set(peerId, { ...existing, muted });
    this.applyPeerAudioState(peerId);
    this.persistPeerAudioPreferences();
  }

  clearPeerAudioPreference(peerId: string): void {
    if (this.peerAudioPreferences.delete(peerId)) {
      this.persistPeerAudioPreferences();
      this.applyPeerAudioState(peerId);
    }
  }

  private loadPeerAudioPreferences(): void {
    const stored = Storage.get<Record<string, PeerAudioPreference>>(PEER_PREFERENCE_STORAGE_KEY, {});
    if (!stored || typeof stored !== 'object') {
      return;
    }

    for (const [peerId, pref] of Object.entries(stored)) {
      if (!peerId) continue;
      const volume = this.normalizePeerVolume(pref?.volume);
      const muted = Boolean(pref?.muted);
      this.peerAudioPreferences.set(peerId, { muted, volume });
    }
  }

  private persistPeerAudioPreferences(): void {
    const serialized: Record<string, PeerAudioPreference> = {};
    for (const [peerId, pref] of this.peerAudioPreferences.entries()) {
      serialized[peerId] = {
        muted: pref.muted,
        volume: this.normalizePeerVolume(pref.volume),
      };
    }

    Storage.set(PEER_PREFERENCE_STORAGE_KEY, serialized);
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

  private applySenderQualityHints(sender: RTCRtpSender): void {
    const track = sender.track;
    if (track) {
      track.contentHint = 'speech';
    }

    try {
      const parameters = sender.getParameters();

      if (!parameters.encodings || parameters.encodings.length === 0) {
        parameters.encodings = [{}];
      }

      for (const encoding of parameters.encodings) {
        encoding.maxBitrate = this.voiceBitrate;
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
    console.log('[VoiceService Diagnostics] ICE Servers:', ICE_SERVERS);
    console.log('[VoiceService Diagnostics] TURN configured:', TURN_CONFIGURED);

    const candidates: { type: string; protocol: string; address: string }[] = [];
    let hasRelay = false;
    let connectionTest = 'pending';

    try {
      const testPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
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
      } else if (!hasRelay && TURN_CONFIGURED) {
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
      iceServers: ICE_SERVERS,
      turnConfigured: TURN_CONFIGURED,
      candidates,
      hasRelay,
      connectionTest,
    };

    console.log('[VoiceService Diagnostics] Results:', result);
    console.log('[VoiceService Diagnostics] Summary:', connectionTest);

    if (!hasRelay && TURN_CONFIGURED) {
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
