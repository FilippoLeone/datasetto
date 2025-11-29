/**
 * Video streaming service for voice channels
 * Handles camera and screen sharing via WebRTC
 */
import type { EventMap } from '@/types';
import { EventEmitter } from '@/utils';

export type VideoStreamType = 'camera' | 'screen';

export interface VideoTrackInfo {
  peerId: string;
  streamType: VideoStreamType;
  stream: MediaStream;
  track: MediaStreamTrack;
}

export interface LocalVideoState {
  camera: {
    enabled: boolean;
    stream: MediaStream | null;
    deviceId: string | null;
  };
  screen: {
    enabled: boolean;
    stream: MediaStream | null;
  };
}

const VIDEO_CONSTRAINTS_CAMERA: MediaTrackConstraints = {
  width: { ideal: 1280, max: 1920 },
  height: { ideal: 720, max: 1080 },
  frameRate: { ideal: 30, max: 60 },
  facingMode: 'user',
};

const VIDEO_CONSTRAINTS_SCREEN: MediaTrackConstraints = {
  width: { ideal: 1920, max: 2560 },
  height: { ideal: 1080, max: 1440 },
  frameRate: { ideal: 30, max: 60 },
};

export class VideoService extends EventEmitter<EventMap> {
  private localState: LocalVideoState = {
    camera: { enabled: false, stream: null, deviceId: null },
    screen: { enabled: false, stream: null },
  };

  private peerVideoTracks: Map<string, Map<VideoStreamType, VideoTrackInfo>> = new Map();
  private videoSenders: Map<string, Map<VideoStreamType, RTCRtpSender>> = new Map();

  constructor() {
    super();
  }

  /**
   * Get available video input devices
   */
  async getVideoDevices(): Promise<MediaDeviceInfo[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput');
    } catch (error) {
      console.error('[VideoService] Failed to enumerate video devices:', error);
      return [];
    }
  }

  /**
   * Start camera video
   */
  async startCamera(deviceId?: string): Promise<MediaStream> {
    if (this.localState.camera.stream) {
      // Already have camera stream
      return this.localState.camera.stream;
    }

    const constraints: MediaStreamConstraints = {
      video: {
        ...VIDEO_CONSTRAINTS_CAMERA,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
      audio: false, // Audio is handled by VoiceService
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.localState.camera.stream = stream;
      this.localState.camera.enabled = true;
      this.localState.camera.deviceId = deviceId || null;

      // Listen for track ended (user stopped sharing via browser UI)
      const track = stream.getVideoTracks()[0];
      if (track) {
        track.addEventListener('ended', () => {
          this.handleCameraTrackEnded();
        });
      }

      this.emit('video:camera:started', { stream } as never);
      return stream;
    } catch (error) {
      console.error('[VideoService] Failed to start camera:', error);
      throw error;
    }
  }

  /**
   * Stop camera video
   */
  stopCamera(): void {
    if (this.localState.camera.stream) {
      this.localState.camera.stream.getTracks().forEach((track) => track.stop());
      this.localState.camera.stream = null;
    }
    this.localState.camera.enabled = false;
    this.localState.camera.deviceId = null;

    this.emit('video:camera:stopped', undefined as never);
  }

  /**
   * Start screen sharing
   */
  async startScreenShare(): Promise<MediaStream> {
    if (this.localState.screen.stream) {
      return this.localState.screen.stream;
    }

    try {
      const mediaDevices = navigator.mediaDevices as MediaDevices & {
        getDisplayMedia?: (constraints?: MediaStreamConstraints) => Promise<MediaStream>;
      };

      if (!mediaDevices.getDisplayMedia) {
        throw new Error('Screen sharing is not supported in this browser');
      }

      const stream = await mediaDevices.getDisplayMedia({
        video: VIDEO_CONSTRAINTS_SCREEN,
        audio: true, // Include system audio if available
      });

      this.localState.screen.stream = stream;
      this.localState.screen.enabled = true;

      // Listen for track ended (user stopped sharing via browser UI)
      const track = stream.getVideoTracks()[0];
      if (track) {
        track.addEventListener('ended', () => {
          this.handleScreenTrackEnded();
        });
      }

      this.emit('video:screen:started', { stream } as never);
      return stream;
    } catch (error) {
      console.error('[VideoService] Failed to start screen share:', error);
      throw error;
    }
  }

  /**
   * Stop screen sharing
   */
  stopScreenShare(): void {
    if (this.localState.screen.stream) {
      this.localState.screen.stream.getTracks().forEach((track) => track.stop());
      this.localState.screen.stream = null;
    }
    this.localState.screen.enabled = false;

    this.emit('video:screen:stopped', undefined as never);
  }

  /**
   * Get local camera stream
   */
  getCameraStream(): MediaStream | null {
    return this.localState.camera.stream;
  }

  /**
   * Get local screen stream
   */
  getScreenStream(): MediaStream | null {
    return this.localState.screen.stream;
  }

  /**
   * Check if camera is active
   */
  isCameraActive(): boolean {
    return this.localState.camera.enabled && this.localState.camera.stream !== null;
  }

  /**
   * Check if screen share is active
   */
  isScreenShareActive(): boolean {
    return this.localState.screen.enabled && this.localState.screen.stream !== null;
  }

  /**
   * Add video track to a peer connection
   */
  addVideoTrackToPeer(
    peerId: string,
    pc: RTCPeerConnection,
    stream: MediaStream,
    streamType: VideoStreamType
  ): RTCRtpSender | null {
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      console.warn('[VideoService] No video track in stream');
      return null;
    }

    try {
      // Set content hint for better encoding
      videoTrack.contentHint = streamType === 'screen' ? 'motion' : 'motion';

      const sender = pc.addTrack(videoTrack, stream);

      // Store sender for later removal
      if (!this.videoSenders.has(peerId)) {
        this.videoSenders.set(peerId, new Map());
      }
      this.videoSenders.get(peerId)!.set(streamType, sender);

      return sender;
    } catch (error) {
      console.error(`[VideoService] Failed to add video track to peer ${peerId}:`, error);
      return null;
    }
  }

  /**
   * Remove video track from a peer connection
   */
  removeVideoTrackFromPeer(
    peerId: string,
    pc: RTCPeerConnection,
    streamType: VideoStreamType
  ): void {
    const peerSenders = this.videoSenders.get(peerId);
    if (!peerSenders) return;

    const sender = peerSenders.get(streamType);
    if (sender) {
      try {
        pc.removeTrack(sender);
      } catch (error) {
        console.error(`[VideoService] Failed to remove video track from peer ${peerId}:`, error);
      }
      peerSenders.delete(streamType);
    }
  }

  /**
   * Handle incoming video track from a peer
   */
  handleRemoteVideoTrack(
    peerId: string,
    track: MediaStreamTrack,
    stream: MediaStream,
    streamType: VideoStreamType
  ): void {
    if (!this.peerVideoTracks.has(peerId)) {
      this.peerVideoTracks.set(peerId, new Map());
    }

    const trackInfo: VideoTrackInfo = {
      peerId,
      streamType,
      stream,
      track,
    };

    this.peerVideoTracks.get(peerId)!.set(streamType, trackInfo);

    this.emit('video:remote:track', trackInfo as never);
  }

  /**
   * Get remote video tracks for a peer
   */
  getPeerVideoTracks(peerId: string): Map<VideoStreamType, VideoTrackInfo> | undefined {
    return this.peerVideoTracks.get(peerId);
  }

  /**
   * Remove all video tracks for a peer
   */
  removePeerVideoTracks(peerId: string): void {
    const tracks = this.peerVideoTracks.get(peerId);
    if (tracks) {
      for (const streamType of tracks.keys()) {
        this.emit('video:remote:track:removed', { peerId, streamType } as never);
      }
      this.peerVideoTracks.delete(peerId);
    }
    this.videoSenders.delete(peerId);
  }

  /**
   * Get local video state
   */
  getLocalState(): LocalVideoState {
    return { ...this.localState };
  }

  /**
   * Handle camera track ended
   */
  private handleCameraTrackEnded(): void {
    this.localState.camera.enabled = false;
    this.localState.camera.stream = null;
    this.emit('video:camera:stopped', undefined as never);
  }

  /**
   * Handle screen track ended
   */
  private handleScreenTrackEnded(): void {
    this.localState.screen.enabled = false;
    this.localState.screen.stream = null;
    this.emit('video:screen:stopped', undefined as never);
  }

  /**
   * Cleanup all resources
   */
  dispose(): void {
    this.stopCamera();
    this.stopScreenShare();
    this.peerVideoTracks.clear();
    this.videoSenders.clear();
  }
}
