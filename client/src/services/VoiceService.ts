/**
 * WebRTC voice communication service
 */
import type { EventMap } from '@/types';
import { EventEmitter, Storage } from '@/utils';

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const resolveIceServers = (): RTCIceServer[] => {
  const servers: RTCIceServer[] = [...DEFAULT_ICE_SERVERS];

  const customIce = import.meta.env.VITE_WEBRTC_ICE_SERVERS;
  if (customIce) {
    try {
      const parsed = JSON.parse(customIce);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as RTCIceServer[];
      }
      console.warn('[VoiceService] VITE_WEBRTC_ICE_SERVERS parsed but not an array, falling back to defaults');
    } catch (error) {
      console.warn('[VoiceService] Failed to parse VITE_WEBRTC_ICE_SERVERS, falling back to defaults:', error);
    }
  }

  const turnUrl = import.meta.env.VITE_TURN_URL;
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: import.meta.env.VITE_TURN_USERNAME,
      credential: import.meta.env.VITE_TURN_CREDENTIAL,
    });
  }

  return servers;
};

const ICE_SERVERS = resolveIceServers();

export interface PeerAudioPreference {
  muted: boolean;
  volume: number;
}

const PEER_PREFERENCE_STORAGE_KEY = 'twiscord.voice.peerPreferences.v1';
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

export class VoiceService extends EventEmitter<EventMap> {
  private peers: Map<string, RTCPeerConnection> = new Map();
  private remoteAudios: Map<string, HTMLAudioElement> = new Map();
  private remoteMonitors: Map<string, SpeakingMonitor> = new Map();
  private localStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private outputVolume = 1;
  private outputDeviceId = '';
  private peerAudioPreferences: Map<string, PeerAudioPreference> = new Map();
  private deafened = false;

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
        } catch (error) {
          console.error(`Error replacing track for peer ${peerId}:`, error);
        }
      } else if (this.localStream) {
        // No sender yet, add the track
        pc.addTrack(newTrack, this.localStream);
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
        pc.addTrack(track, this.localStream);
      }
    }

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      this.emit('voice:offer', {
        peerId,
        offer: pc.localDescription!,
      } as never);
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

      // Add local tracks
      if (this.localStream) {
        for (const track of this.localStream.getAudioTracks()) {
          pc.addTrack(track, this.localStream);
        }
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this.emit('voice:answer', {
        peerId,
        answer: pc.localDescription!,
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
    this.outputDeviceId = deviceId;

    const promises: Promise<void>[] = [];
    
    for (const audio of this.remoteAudios.values()) {
      if (typeof audio.setSinkId === 'function') {
        promises.push(
          audio.setSinkId(deviceId).catch((error) => {
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
