/**
 * Audio management service for microphone input and processing
 */
import type { AudioSettings, DeviceInfo } from '@/types';
import { EventEmitter } from '@/utils';

const TARGET_SAMPLE_RATE = 48000;
const MIN_ACCEPTABLE_SAMPLE_RATE = 32000;

export const MICROPHONE_PERMISSION_HELP_TEXT =
  'Microphone permission is blocked. Enable access in your browser or system settings, then reload. On iOS Safari: Settings → Safari → Camera & Microphone. On Android Chrome: Settings → Site Settings → Microphone.';

export class AudioService extends EventEmitter {
  private audioContext: AudioContext | null = null;
  private localStream: MediaStream | null = null;
  private rawStream: MediaStream | null = null;
  private micGainNode: GainNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;
  private analyser: AnalyserNode | null = null;
  private meterAnimationId: number | null = null;
  private settings: AudioSettings;

  constructor(settings: AudioSettings) {
    super();
    this.settings = settings;
  }

  async getMicrophonePermissionStatus(): Promise<PermissionState | 'unsupported'> {
    if (typeof navigator === 'undefined' || !('permissions' in navigator)) {
      return 'unsupported';
    }

    try {
      const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      return status.state;
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[AudioService] Unable to read microphone permission status:', error);
      }
      return 'unsupported';
    }
  }

  /**
   * Initialize audio context
   */
  private initAudioContext(forceNew = false): AudioContext {
    if (forceNew && this.audioContext) {
      try {
        void this.audioContext.close();
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('[AudioService] Failed to close existing AudioContext before reinitializing:', error);
        }
      }
      this.audioContext = null;
    }

    if (!this.audioContext) {
      const AudioContextCtor = window.AudioContext || (window as never)['webkitAudioContext'];
      try {
        this.audioContext = new AudioContextCtor({
          sampleRate: TARGET_SAMPLE_RATE,
          latencyHint: 'interactive',
        } as AudioContextOptions);
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('[AudioService] Unable to create AudioContext at preferred sample rate, falling back to default:', error);
        }
        this.audioContext = new AudioContextCtor();
      }

      if (this.audioContext.sampleRate < MIN_ACCEPTABLE_SAMPLE_RATE && import.meta.env.DEV) {
        console.warn(
          `[AudioService] AudioContext running at low sample rate (${this.audioContext.sampleRate}Hz). Voice quality may degrade, attempting automatic recovery.`
        );
      }
    }

    return this.audioContext;
  }

  /**
   * Get list of available audio devices
   */
  async getDevices(): Promise<{ mics: DeviceInfo[]; speakers: DeviceInfo[] }> {
    try {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
        throw new Error('Audio device enumeration is not supported in this browser.');
      }

      const devices = await navigator.mediaDevices.enumerateDevices();
      
      const mics = devices
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || 'Microphone',
          kind: d.kind,
        }));

      const speakers = devices
        .filter((d) => d.kind === 'audiooutput')
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || 'Speaker',
          kind: d.kind,
        }));

      return { mics, speakers };
    } catch (error) {
      console.error('Error enumerating devices:', error);
      throw new Error('Failed to get audio devices. Please check permissions.');
    }
  }

  /**
   * Get audio constraints based on settings
   */
  private getAudioConstraints(): MediaTrackConstraints {
    const constraints: MediaTrackConstraints = {
      echoCancellation: this.settings.echoCancel,
      noiseSuppression: this.settings.noiseSuppression,
      autoGainControl: this.settings.autoGain,
      channelCount: { ideal: 2, min: 1 } as ConstrainULongRange,
	sampleRate: { ideal: TARGET_SAMPLE_RATE, min: MIN_ACCEPTABLE_SAMPLE_RATE } as ConstrainULongRange,
	sampleSize: { ideal: 16 } as ConstrainULongRange,
    };

    if (this.settings.micDeviceId) {
      constraints.deviceId = { exact: this.settings.micDeviceId };
    }

    return constraints;
  }

  /**
   * Get or create local audio stream with processing
   */
  async getLocalStream(forceNew = false): Promise<MediaStream> {
    if (this.localStream && !forceNew) {
      return this.localStream;
    }

    try {
      this.assertMicrophoneSupport();

      // Stop existing stream if any
      if (this.localStream || this.rawStream) {
        this.stopLocalStream();
      }

      // Get raw stream from microphone
      const rawStream = await navigator.mediaDevices.getUserMedia({
        audio: this.getAudioConstraints(),
      });

      this.rawStream = rawStream;

      let ctx = this.initAudioContext();

      await this.alignInputStreamSampleRate(rawStream, ctx).catch((error) => {
        if (import.meta.env.DEV) {
          console.warn('[AudioService] Failed to normalize microphone sample rate:', error);
        }
      });

      if (ctx.sampleRate < MIN_ACCEPTABLE_SAMPLE_RATE) {
        ctx = this.initAudioContext(true);
      }

      const source = ctx.createMediaStreamSource(rawStream);
      this.sourceNode = source;

      // Create gain node for volume control
      this.micGainNode = ctx.createGain();
      this.micGainNode.gain.value = this.settings.micGain;

      // Create analyser for visualization
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.8;

      // Connect: source -> gain -> analyser
      source.connect(this.micGainNode);
      this.micGainNode.connect(this.analyser);

      // Create destination for processed stream
      const destination = ctx.createMediaStreamDestination();
      this.destinationNode = destination;
      this.micGainNode.connect(destination);

      this.localStream = destination.stream;

      // Start meter visualization
      this.startMeterVisualization();

      // Notify listeners that a new processed stream is ready
      this.emit('stream:active', this.localStream);

      return this.localStream;
    } catch (error) {
      console.error('Error getting local stream:', error);
      throw this.mapGetUserMediaError(error);
    }
  }

  hasActiveStream(): boolean {
    return Boolean(this.localStream || this.rawStream);
  }

  private async alignInputStreamSampleRate(stream: MediaStream, ctx: AudioContext): Promise<void> {
    const track = stream.getAudioTracks()[0];
    if (!track) {
      return;
    }

    const settings = track.getSettings();
    const currentSampleRate = settings.sampleRate ?? ctx.sampleRate;

    if (currentSampleRate && currentSampleRate >= MIN_ACCEPTABLE_SAMPLE_RATE) {
      return;
    }

    try {
      await track.applyConstraints({
        sampleRate: { ideal: TARGET_SAMPLE_RATE, min: MIN_ACCEPTABLE_SAMPLE_RATE },
        channelCount: { ideal: 2, min: 1 },
      });
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[AudioService] Unable to increase microphone sample rate via constraints:', error);
      }
    }

    const updatedSettings = track.getSettings();
    if ((updatedSettings.sampleRate ?? ctx.sampleRate) < MIN_ACCEPTABLE_SAMPLE_RATE) {
      if (import.meta.env.DEV) {
        console.warn(
          `[AudioService] Microphone sample rate remains low (${updatedSettings.sampleRate ?? 'unknown'} Hz).`
        );
      }
    }
  }

  /**
   * Stop local audio stream
   */
  stopLocalStream(): void {
    if (this.destinationNode) {
      try {
        this.destinationNode.disconnect();
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('Error disconnecting destination node:', error);
        }
      }
      this.destinationNode = null;
    }

    if (this.micGainNode) {
      try {
        this.micGainNode.disconnect();
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('Error disconnecting gain node:', error);
        }
      }
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('Error disconnecting source node:', error);
        }
      }
      this.sourceNode = null;
    }

    if (this.analyser) {
      try {
        this.analyser.disconnect();
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('Error disconnecting analyser node:', error);
        }
      }
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }

    if (this.rawStream) {
      this.rawStream.getTracks().forEach((track) => track.stop());
      this.rawStream = null;
    }

    if (this.meterAnimationId !== null) {
      cancelAnimationFrame(this.meterAnimationId);
      this.meterAnimationId = null;
    }

    this.micGainNode = null;
    this.analyser = null;
  }

  /**
   * Update mic gain
   */
  setMicGain(gain: number): void {
    this.settings.micGain = gain;
    if (this.micGainNode) {
      this.micGainNode.gain.value = gain;
    }
  }

  /**
   * Update audio settings and restart stream if needed
   */
  async updateSettings(settings: Partial<AudioSettings>): Promise<void> {
    const oldDeviceId = this.settings.micDeviceId;
    this.settings = { ...this.settings, ...settings };

    // If device or constraints changed, restart stream
    const deviceChanged = oldDeviceId !== this.settings.micDeviceId;
    const constraintsChanged = 
      settings.echoCancel !== undefined ||
      settings.noiseSuppression !== undefined ||
      settings.autoGain !== undefined;

    if ((deviceChanged || constraintsChanged) && this.localStream) {
      await this.getLocalStream(true);
    }

    // Update gain if changed
    if (settings.micGain !== undefined && this.micGainNode) {
      this.micGainNode.gain.value = settings.micGain;
    }
  }

  /**
   * Get current audio level (0-1)
   */
  getAudioLevel(): number {
    if (!this.analyser) return 0;

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(dataArray);

    let peak = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const value = Math.abs(dataArray[i] - 128) / 128;
      if (value > peak) peak = value;
    }

    return peak;
  }

  /**
   * Start visualizing mic level
   */
  private startMeterVisualization(): void {
    if (this.meterAnimationId !== null) {
      cancelAnimationFrame(this.meterAnimationId);
    }

    const update = () => {
      if (!this.analyser) return;

      const level = this.getAudioLevel();
      this.emit('mic:level', level);

      this.meterAnimationId = requestAnimationFrame(update);
    };

    this.meterAnimationId = requestAnimationFrame(update);
  }

  /**
   * Mute/unmute local stream
   */
  setMuted(muted: boolean): void {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    }
  }

  /**
   * Set output volume for an audio element
   */
  setOutputVolume(audioElement: HTMLAudioElement, volume: number): void {
    try {
      audioElement.volume = Math.max(0, Math.min(1, volume));
    } catch (error) {
      console.error('Error setting volume:', error);
    }
  }

  /**
   * Set output device (speaker) for an audio element
   */
  async setOutputDevice(audioElement: HTMLAudioElement, deviceId: string): Promise<void> {
    if (typeof audioElement.setSinkId === 'function') {
      try {
        await audioElement.setSinkId(deviceId);
      } catch (error) {
        console.error('Error setting output device:', error);
        throw new Error('Failed to change output device');
      }
    } else {
      console.warn('setSinkId not supported in this browser');
    }
  }

  /**
   * Cleanup
   */
  dispose(): void {
    this.stopLocalStream();
    
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.clear();
  }

  private assertMicrophoneSupport(): void {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
      throw new Error('Microphone access is only available in supported browsers.');
    }

    if (!window.isSecureContext) {
      throw new Error('Microphone access requires a secure connection (HTTPS). Please reload the app using https://');
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new Error('Microphone access is not supported in this browser. Try the latest versions of Chrome, Safari, or Firefox.');
    }
  }

  private mapGetUserMediaError(error: unknown): Error {
    if (error instanceof DOMException) {
      switch (error.name) {
        case 'NotAllowedError':
        case 'SecurityError':
          return new Error(MICROPHONE_PERMISSION_HELP_TEXT);
        case 'NotFoundError':
        case 'DevicesNotFoundError':
          return new Error('No microphone was detected. Connect a microphone or check that it is enabled, then try again.');
        case 'NotReadableError':
        case 'TrackStartError':
        case 'HardwareError':
          return new Error('Your microphone is currently in use by another app. Close other apps that use the mic, then try again.');
        case 'OverconstrainedError':
        case 'ConstraintNotSatisfiedError':
          return new Error('The selected microphone is unavailable. Reset your input device in audio settings and retry.');
        case 'AbortError':
          return new Error('Microphone initialization was interrupted. Please try again.');
        default:
          return new Error(`Failed to access microphone (${error.name}). Please check your device settings.`);
      }
    }

    if (error instanceof Error) {
      return new Error(`Failed to access microphone: ${error.message}`);
    }

    return new Error('Failed to access microphone. Please check permissions and device settings.');
  }

  supportsOutputDeviceSelection(): boolean {
    if (typeof document === 'undefined') {
      return false;
    }

    const audio = document.createElement('audio');
    return typeof (audio as HTMLMediaElement & { setSinkId?: unknown }).setSinkId === 'function';
  }
}
