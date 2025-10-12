/**
 * WebRTC voice communication service
 */
import type { EventMap } from '@/types';
import { EventEmitter, Storage } from '@/utils';
import { isNativeAudioRoutingAvailable, selectNativeAudioRoute } from './NativeAudioRouteService';

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

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
  const servers: RTCIceServer[] = [...DEFAULT_ICE_SERVERS];

  const customIce = import.meta.env.VITE_WEBRTC_ICE_SERVERS;
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

  const turnUrls = splitEnvList(import.meta.env.VITE_TURN_URL);
  if (turnUrls.length > 0) {
    const username = import.meta.env.VITE_TURN_USERNAME;
    const credential = import.meta.env.VITE_TURN_CREDENTIAL;

    for (const turnUrl of turnUrls) {
      const normalizedUrl = ensureTurnScheme(turnUrl);
      servers.push({
        urls: normalizedUrl,
        username,
        credential,
      });
    }
  }

  return dedupeIceServers(servers);
};

const ICE_SERVERS = resolveIceServers();
const ICE_RESTART_DELAY_MS = 2000;
const ICE_RESTART_MAX_ATTEMPTS = 3;
const OPUS_TARGET_BITRATE = 96000;
const TURN_CONFIGURED = ICE_SERVERS.some((server) => {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  return urls.some((url) => typeof url === 'string' && url.toLowerCase().startsWith('turn:'));
});

export interface PeerAudioPreference {
  muted: boolean;
  volume: number;
}

const PEER_PREFERENCE_STORAGE_KEY = 'datasetto.voice.peerPreferences.v1';
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

export class VoiceService extends EventEmitter<EventMap> {
  private peers: Map<string, RTCPeerConnection> = new Map();
  private remoteAudios: Map<string, HTMLAudioElement> = new Map();
  private remoteMonitors: Map<string, SpeakingMonitor> = new Map();
  private iceRestartTimers: Map<string, number> = new Map();
  private iceRestartAttempts: Map<string, number> = new Map();
  private localStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private outputVolume = 1;
  private outputDeviceId = '';
  private peerAudioPreferences: Map<string, PeerAudioPreference> = new Map();
  private deafened = false;
  private turnWarningShown = false;

  constructor() {
    super();

    this.loadPeerAudioPreferences();

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
      console.log(`Received track from peer ${peerId}`);
      this.handleRemoteTrack(peerId, event.streams[0]);
    };

    return pc;
  }

  /**
   * Handle incoming remote audio track
   */
  private handleRemoteTrack(peerId: string, stream: MediaStream): void {
    // Create or reuse audio element
    let audioElement = this.remoteAudios.get(peerId);
    
    if (!audioElement) {
    audioElement = document.createElement('audio');
    audioElement.id = `audio-${peerId}`;
    audioElement.autoplay = true;
  audioElement.setAttribute('playsinline', 'true');
    audioElement.muted = false;
      audioElement.defaultPlaybackRate = 1;
      audioElement.playbackRate = 1;
      const pitchSafeElement = audioElement as HTMLAudioElement & {
        preservesPitch?: boolean;
        mozPreservesPitch?: boolean;
        webkitPreservesPitch?: boolean;
      };
      pitchSafeElement.preservesPitch = true;
      pitchSafeElement.mozPreservesPitch = true;
      pitchSafeElement.webkitPreservesPitch = true;
    audioElement.volume = this.computeEffectiveVolume(1);
    audioElement.dataset.peerId = peerId;
      
      // Set output device if available
      if (this.outputDeviceId && typeof audioElement.setSinkId === 'function') {
        audioElement.setSinkId(this.outputDeviceId).catch(console.error);
      }

      document.body.appendChild(audioElement);
      this.remoteAudios.set(peerId, audioElement);
    }

    audioElement.srcObject = stream;
    this.applyPeerAudioState(peerId);
    const playResult = audioElement.play();
    if (playResult instanceof Promise) {
      playResult.catch((error) => {
        console.warn(`[VoiceService] Unable to autoplay remote audio for peer ${peerId}:`, error);
      });
    }

    // Setup speaking detection
    this.setupSpeakingDetection(peerId, stream);
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
  private setupSpeakingDetection(peerId: string, stream: MediaStream): void {
    try {
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || (window as never)['webkitAudioContext'])();
      }

      this.tryResumeAudioContext();

      const source = this.audioContext.createMediaStreamSource(stream);
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      
      source.connect(analyser);

      const monitor = new SpeakingMonitor(analyser, (speaking) => {
        this.emit('voice:speaking', { id: peerId, speaking });
      });

      monitor.start();
      this.remoteMonitors.set(peerId, monitor);
    } catch (error) {
      console.error(`Error setting up speaking detection for ${peerId}:`, error);
    }
  }

  private tryResumeAudioContext(): void {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch((error) => {
        console.warn('[VoiceService] Unable to auto-resume AudioContext:', error);
      });
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

    // Add local tracks
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        const sender = pc.addTrack(track, this.localStream);
        this.applySenderQualityHints(sender);
      }
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

      if (this.localStream) {
        for (const track of this.localStream.getAudioTracks()) {
          const sender = pc.addTrack(track, this.localStream);
          this.applySenderQualityHints(sender);
        }
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

    // Remove audio element
    const audio = this.remoteAudios.get(peerId);
    if (audio) {
      audio.remove();
      this.remoteAudios.delete(peerId);
    }

    // Stop speaking monitor
    const monitor = this.remoteMonitors.get(peerId);
    if (monitor) {
      monitor.stop();
      this.remoteMonitors.delete(peerId);
    }
  }

  /**
   * Set output volume for all remote audios
   */
  setOutputVolume(volume: number): void {
    this.outputVolume = clamp(volume, 0, 1);

    for (const peerId of this.remoteAudios.keys()) {
      this.applyPeerAudioState(peerId);
    }
  }

  /**
   * Set output device for all remote audios
   */
  async setOutputDevice(deviceId: string): Promise<void> {
    const normalizedId = deviceId ?? '';
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

    for (const audio of this.remoteAudios.values()) {
      if (typeof audio.setSinkId === 'function') {
        promises.push(
          audio.setSinkId(normalizedId).catch((error) => {
            console.error('Error setting output device:', error);
          })
        );
      }
    }

    await Promise.all(promises);
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

    for (const peerId of this.remoteAudios.keys()) {
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
   * Cleanup all connections
   */
  dispose(): void {
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
    this.peers.clear();
    this.remoteAudios.clear();
    this.remoteMonitors.clear();
  }

  getPeerAudioPreference(peerId: string): PeerAudioPreference {
    const pref = this.peerAudioPreferences.get(peerId);
    return {
      muted: pref?.muted ?? false,
      volume: clamp(pref?.volume ?? 1, 0, 1),
    };
  }

  getAllPeerAudioPreferences(): Map<string, PeerAudioPreference> {
    return new Map(this.peerAudioPreferences);
  }

  setPeerVolume(peerId: string, volume: number): void {
    const clampedVolume = clamp(volume, 0, 1);
    const existing = this.peerAudioPreferences.get(peerId) ?? { muted: false, volume: 1 };
    this.peerAudioPreferences.set(peerId, { ...existing, volume: clampedVolume });
    this.applyPeerAudioState(peerId);
    this.persistPeerAudioPreferences();
  }

  setPeerMuted(peerId: string, muted: boolean): void {
    const existing = this.peerAudioPreferences.get(peerId) ?? { muted: false, volume: 1 };
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
      const volume = clamp(pref?.volume ?? 1, 0, 1);
      const muted = Boolean(pref?.muted);
      this.peerAudioPreferences.set(peerId, { muted, volume });
    }
  }

  private persistPeerAudioPreferences(): void {
    const serialized: Record<string, PeerAudioPreference> = {};
    for (const [peerId, pref] of this.peerAudioPreferences.entries()) {
      serialized[peerId] = { muted: pref.muted, volume: clamp(pref.volume, 0, 1) };
    }

    Storage.set(PEER_PREFERENCE_STORAGE_KEY, serialized);
  }

  private applyPeerAudioState(peerId: string): void {
    const audio = this.remoteAudios.get(peerId);
    if (!audio) {
      return;
    }

    const pref = this.peerAudioPreferences.get(peerId);
    const localMuted = pref?.muted ?? false;
    const localVolume = clamp(pref?.volume ?? 1, 0, 1);

    audio.muted = this.deafened || localMuted;
    audio.volume = this.computeEffectiveVolume(localVolume);
    audio.dataset.localMuted = String(localMuted);
    audio.dataset.localVolume = localVolume.toString();
    audio.dataset.deafened = String(this.deafened);
  }

  private computeEffectiveVolume(localVolume: number): number {
    const clampedLocal = clamp(localVolume, 0, 1);
    return clamp(Number((clampedLocal * this.outputVolume).toFixed(4)), 0, 1);
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
        encoding.maxBitrate = OPUS_TARGET_BITRATE;
        encoding.priority = 'high';
        (encoding as RTCRtpEncodingParameters & { dtx?: boolean }).dtx = false;
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
          for (const token of paramString.split(';')) {
            const trimmed = token.trim();
            if (!trimmed) continue;
            const [key, value] = trimmed.split('=');
            if (key) {
              params.set(key, value ?? '');
            }
          }
        }

    params.set('stereo', '1');
    params.set('sprop-stereo', '1');
    params.set('useinbandfec', '1');
    params.set('cbr', '0');
    params.set('dtx', '0');
        params.set('maxaveragebitrate', String(OPUS_TARGET_BITRATE));
        params.set('maxplaybackrate', '48000');
        params.set('minptime', '10');
        params.set('maxptime', '60');

        const rebuilt = Array.from(params.entries())
          .map(([key, value]) => (value ? `${key}=${value}` : key))
          .join(';');

        lines[fmtpIndex] = `${prefix} ${rebuilt}`.trim();
      }
    }

    if (!lines.some((line) => line.startsWith('a=ptime:'))) {
      const audioSectionIndex = lines.findIndex((line) => line.startsWith('m=audio'));
      const insertionIndex = audioSectionIndex !== -1 ? audioSectionIndex + 1 : lines.length;
      lines.splice(insertionIndex, 0, 'a=ptime:20');
    }

    return { ...desc, sdp: lines.join('\r\n') };
  }
}

/**
 * Speaking detection monitor
 */
class SpeakingMonitor {
  private analyser: AnalyserNode;
  private callback: (speaking: boolean) => void;
  private rafId: number | null = null;
  private threshold = 0.07;
  private isSpeaking = false;

  constructor(analyser: AnalyserNode, callback: (speaking: boolean) => void) {
    this.analyser = analyser;
    this.callback = callback;
  }

  start(): void {
    if (this.rafId !== null) return;

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    const check = () => {
      this.analyser.getByteTimeDomainData(dataArray);

      let peak = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const value = Math.abs(dataArray[i] - 128) / 128;
        if (value > peak) peak = value;
      }

      const speaking = peak > this.threshold;

      if (speaking !== this.isSpeaking) {
        this.isSpeaking = speaking;
        this.callback(speaking);
      }

      this.rafId = requestAnimationFrame(check);
    };

    this.rafId = requestAnimationFrame(check);
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
