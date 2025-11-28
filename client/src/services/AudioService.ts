/**
 * Audio management service for microphone input and processing
 */
import type { AudioSettings, DeviceInfo } from '@/types';
import { EventEmitter } from '@/utils';
import { fetchNativeAudioRoutes, isNativeAudioRoutingAvailable, selectNativeAudioRoute } from './NativeAudioRouteService';

const TARGET_SAMPLE_RATE = 48000;
const MIN_ACCEPTABLE_SAMPLE_RATE = 32000;
const FALLBACK_SAMPLE_RATE = 44100;
const DEFAULT_NOISE_REDUCTION_LEVEL = 0.35;
const NOISE_THRESHOLD_RANGE = { min: 0.008, max: 0.08 } as const;
const NOISE_REDUCTION_RANGE = { min: 0.05, max: 0.5 } as const;
const NOISE_SMOOTHING = 0.0015;
const MAX_STREAM_RETRY_ATTEMPTS = 3;
const STREAM_RETRY_DELAY_MS = 500;

const clamp = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
};

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
  private trackLifecycleCleanup: (() => void) | null = null;
  private shuttingDownStream = false;
  private noiseReducerNode: AudioWorkletNode | null = null;
  private noiseReducerModulePromise: Promise<void> | null = null;
  private streamRetryAttempts = 0;
  private degradedMode = false;
  private lastSuccessfulConstraints: MediaTrackConstraints | null = null;

  constructor(settings: AudioSettings) {
    super();
    this.settings = {
      ...settings,
      noiseReducerLevel: clamp(
        typeof settings.noiseReducerLevel === 'number' ? settings.noiseReducerLevel : DEFAULT_NOISE_REDUCTION_LEVEL,
        0,
        1
      ),
    };
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
          latencyHint: this.settings.latencyHint,
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

      // Enumerate devices - this may trigger camera permission requests on some platforms
      // Suppress console errors for missing camera hardware (common on emulators)
      const devices = await navigator.mediaDevices.enumerateDevices();

      const mics = devices
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || 'Microphone',
          kind: d.kind,
        }));

      let speakers = devices
        .filter((d) => d.kind === 'audiooutput')
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || 'Speaker',
          kind: d.kind,
        }));

      const nativeRoutes = await fetchNativeAudioRoutes();
      if (nativeRoutes.length > 0) {
        const speakerMap = new Map<string, DeviceInfo>();
        for (const speaker of speakers) {
          speakerMap.set(speaker.deviceId, speaker);
        }

        for (const route of nativeRoutes) {
          const nativeId = `native:${route.id}`;
          if (!speakerMap.has(nativeId)) {
            speakerMap.set(nativeId, {
              deviceId: nativeId,
              label: route.label,
              kind: 'audiooutput',
            });
          }
        }

        speakers = Array.from(speakerMap.values());
      }

      return { mics, speakers };
    } catch (error) {
      console.error('Error enumerating devices:', error);
      throw new Error('Failed to get audio devices. Please check permissions.');
    }
  }

  /**
   * Get audio constraints based on settings, with optional degradation
   */
  private getAudioConstraints(degraded = false): MediaTrackConstraints {
    // If we have working constraints from before, use them
    if (degraded && this.lastSuccessfulConstraints) {
      return { ...this.lastSuccessfulConstraints };
    }

    const constraints: MediaTrackConstraints = {
      echoCancellation: this.settings.echoCancel,
      noiseSuppression: this.settings.noiseSuppression,
      autoGainControl: this.settings.autoGain,
      channelCount: degraded ? 1 : ({ ideal: 2, min: 1 } as ConstrainULongRange),
      sampleRate: degraded 
        ? ({ ideal: FALLBACK_SAMPLE_RATE } as ConstrainULongRange)
        : ({ ideal: TARGET_SAMPLE_RATE, min: MIN_ACCEPTABLE_SAMPLE_RATE } as ConstrainULongRange),
      sampleSize: { ideal: 16 } as ConstrainULongRange,
    };

    if (this.settings.micDeviceId && !degraded) {
      constraints.deviceId = { exact: this.settings.micDeviceId };
    } else if (this.settings.micDeviceId && degraded) {
      // In degraded mode, use preferred device but not exact
      constraints.deviceId = { ideal: this.settings.micDeviceId };
    }

    return constraints;
  }

  /**
   * Check if currently running in degraded mode
   */
  isDegradedMode(): boolean {
    return this.degradedMode;
  }

  /**
   * Get or create local audio stream with processing
   */
  async getLocalStream(forceNew = false): Promise<MediaStream> {
    if (this.localStream && !forceNew) {
      return this.localStream;
    }

    return this.getLocalStreamWithRetry(forceNew);
  }

  /**
   * Get local stream with automatic retry and graceful degradation
   */
  private async getLocalStreamWithRetry(forceNew: boolean): Promise<MediaStream> {
    this.streamRetryAttempts = 0;
    let lastError: Error | null = null;

    while (this.streamRetryAttempts < MAX_STREAM_RETRY_ATTEMPTS) {
      try {
        const shouldDegrade = this.streamRetryAttempts > 0;
        const stream = await this.attemptGetLocalStream(forceNew, shouldDegrade);
        
        // Success - remember these constraints worked
        this.lastSuccessfulConstraints = this.getAudioConstraints(shouldDegrade);
        this.degradedMode = shouldDegrade;
        this.streamRetryAttempts = 0;
        
        if (shouldDegrade) {
          this.emit('stream:degraded', { 
            reason: 'constraints',
            message: 'Using reduced audio quality due to device limitations'
          });
        }
        
        return stream;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.streamRetryAttempts++;
        
        // Check if this is a retriable error
        if (!this.isRetriableError(error)) {
          throw this.mapGetUserMediaError(error);
        }
        
        if (this.streamRetryAttempts < MAX_STREAM_RETRY_ATTEMPTS) {
          if (import.meta.env.DEV) {
            console.warn(`[AudioService] Stream attempt ${this.streamRetryAttempts} failed, retrying with degraded constraints...`, error);
          }
          await this.delay(STREAM_RETRY_DELAY_MS * this.streamRetryAttempts);
        }
      }
    }

    // All retries exhausted
    throw this.mapGetUserMediaError(lastError);
  }

  private isRetriableError(error: unknown): boolean {
    if (!(error instanceof DOMException)) {
      return false;
    }
    
    // These errors might be recoverable with different constraints
    const retriableErrors = [
      'OverconstrainedError',
      'ConstraintNotSatisfiedError',
      'NotReadableError',
      'TrackStartError',
      'AbortError',
    ];
    
    return retriableErrors.includes(error.name);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async attemptGetLocalStream(_forceNew: boolean, degraded: boolean): Promise<MediaStream> {
    try {
      this.assertMicrophoneSupport();

      // Stop existing stream if any
      if (this.localStream || this.rawStream) {
        this.stopLocalStream();
      }

      // Get raw stream from microphone
      const rawStream = await navigator.mediaDevices.getUserMedia({
        audio: this.getAudioConstraints(degraded),
      });

      this.rawStream = rawStream;
      this.registerTrackLifecycleHandlers(rawStream.getAudioTracks()[0] ?? null);

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

      let processingNode: AudioNode = source;
      processingNode = await this.maybeInsertNoiseReducer(ctx, processingNode);

      // Create gain node for volume control
      this.micGainNode = ctx.createGain();
      this.micGainNode.gain.value = this.settings.micGain;

      // Create analyser for visualization
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.8;

      // Connect processing chain to analyser
      processingNode.connect(this.micGainNode);
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
    this.shuttingDownStream = true;
    this.cleanupTrackLifecycleHandlers();

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

    this.teardownNoiseReducer();

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
    this.shuttingDownStream = false;
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
    const prevNoiseLevel = this.settings.noiseReducerLevel ?? DEFAULT_NOISE_REDUCTION_LEVEL;
    const prevNoiseSuppression = this.settings.noiseSuppression;

    this.settings = { ...this.settings, ...settings };

    let noiseLevelChanged = false;
    if (settings.noiseReducerLevel !== undefined) {
      const clampedLevel = clamp(
        settings.noiseReducerLevel ?? DEFAULT_NOISE_REDUCTION_LEVEL,
        0,
        1
      );
      this.settings.noiseReducerLevel = clampedLevel;
      noiseLevelChanged = clampedLevel !== prevNoiseLevel;
    }

    const noiseSuppressionChanged =
      settings.noiseSuppression !== undefined && settings.noiseSuppression !== prevNoiseSuppression;

    // If device or constraints changed, restart stream
    const deviceChanged = oldDeviceId !== this.settings.micDeviceId;
    const constraintsChanged = 
      settings.echoCancel !== undefined ||
      settings.noiseSuppression !== undefined ||
      settings.autoGain !== undefined ||
      settings.latencyHint !== undefined;

    if ((deviceChanged || constraintsChanged) && this.localStream) {
      await this.getLocalStream(true);
    }

    // Update gain if changed
    if (settings.micGain !== undefined && this.micGainNode) {
      this.micGainNode.gain.value = settings.micGain;
    }

    const canReconfigureNoiseReducer = Boolean(this.audioContext && this.sourceNode && this.micGainNode);
    if (canReconfigureNoiseReducer && (noiseLevelChanged || noiseSuppressionChanged)) {
      await this.reconfigureNoiseReducer();
    } else if (noiseLevelChanged && this.noiseReducerNode) {
      this.updateNoiseReducerConfig();
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

  private async loadNoiseReducerModule(ctx: AudioContext): Promise<void> {
    if (!ctx.audioWorklet) {
      throw new Error('AudioWorklet not supported');
    }

    if (!this.noiseReducerModulePromise) {
      this.noiseReducerModulePromise = ctx.audioWorklet.addModule(
        new URL('../audio/worklets/noise-gate-processor.js', import.meta.url)
      );
    }

    try {
      await this.noiseReducerModulePromise;
    } catch (error) {
      this.noiseReducerModulePromise = null;
      throw error;
    }
  }

  private shouldUseNoiseReducer(): boolean {
    const level = this.settings.noiseReducerLevel ?? 0;
    return Boolean(this.settings.noiseSuppression && level > 0.05);
  }

  private buildNoiseReducerConfig(level = this.settings.noiseReducerLevel ?? DEFAULT_NOISE_REDUCTION_LEVEL) {
    const normalized = clamp(level, 0, 1);
    const threshold =
      NOISE_THRESHOLD_RANGE.min + normalized * (NOISE_THRESHOLD_RANGE.max - NOISE_THRESHOLD_RANGE.min);
    const reduction =
      NOISE_REDUCTION_RANGE.max - normalized * (NOISE_REDUCTION_RANGE.max - NOISE_REDUCTION_RANGE.min);

    return {
      threshold,
      reduction,
      smoothing: NOISE_SMOOTHING,
    };
  }

  private async maybeInsertNoiseReducer(ctx: AudioContext, upstream: AudioNode): Promise<AudioNode> {
    this.teardownNoiseReducer();

    const level = clamp(this.settings.noiseReducerLevel ?? DEFAULT_NOISE_REDUCTION_LEVEL, 0, 1);
    if (!ctx.audioWorklet || !this.shouldUseNoiseReducer()) {
      return upstream;
    }

    try {
      await this.loadNoiseReducerModule(ctx);
      const config = this.buildNoiseReducerConfig(level);
      const node = new AudioWorkletNode(ctx, 'noise-gate-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCountMode: 'max',
        processorOptions: config,
      });
      this.noiseReducerNode = node;
      upstream.connect(node);
      node.port.postMessage({ type: 'configure', ...config });
      return node;
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[AudioService] Noise reducer unavailable, continuing without it:', error);
      }
      this.noiseReducerModulePromise = null;
      return upstream;
    }
  }

  private teardownNoiseReducer(): void {
    if (!this.noiseReducerNode) {
      return;
    }

    try {
      if (this.sourceNode) {
        try {
          this.sourceNode.disconnect(this.noiseReducerNode);
        } catch (error) {
          if (import.meta.env.DEV) {
            console.warn('[AudioService] Failed to detach noise reducer from source during teardown:', error);
          }
        }
      }
      this.noiseReducerNode.disconnect();
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[AudioService] Failed to disconnect noise reducer node:', error);
      }
    }

    this.noiseReducerNode = null;
  }

  private async reconfigureNoiseReducer(): Promise<void> {
    if (!this.audioContext || !this.sourceNode || !this.micGainNode) {
      return;
    }

    const shouldEnable = this.shouldUseNoiseReducer();
    const hasNode = Boolean(this.noiseReducerNode);

    if (shouldEnable && !hasNode) {
      try {
        await this.loadNoiseReducerModule(this.audioContext);
        const config = this.buildNoiseReducerConfig();
        const node = new AudioWorkletNode(this.audioContext, 'noise-gate-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCountMode: 'max',
          processorOptions: config,
        });

        try {
          this.sourceNode.disconnect(this.micGainNode);
        } catch (error) {
          if (import.meta.env.DEV) {
            console.warn('[AudioService] Direct mic path was not connected during noise reducer insertion:', error);
          }
        }

        this.sourceNode.connect(node);
        node.connect(this.micGainNode);
        node.port.postMessage({ type: 'configure', ...config });
        this.noiseReducerNode = node;
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('[AudioService] Unable to add noise reducer dynamically:', error);
        }
        this.noiseReducerNode = null;
        this.noiseReducerModulePromise = null;
      }
      return;
    }

    if (!shouldEnable && hasNode) {
      const node = this.noiseReducerNode;
      try {
        if (this.sourceNode) {
          try {
            this.sourceNode.disconnect(node as AudioNode);
          } catch (error) {
            if (import.meta.env.DEV) {
              console.warn('[AudioService] Failed to detach noise reducer from source:', error);
            }
          }
        }
        node?.disconnect();
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('[AudioService] Error while removing noise reducer node:', error);
        }
      }

      this.noiseReducerNode = null;

      try {
        this.sourceNode.connect(this.micGainNode);
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('[AudioService] Unable to restore direct mic chain after removing noise reducer:', error);
        }
      }
      return;
    }

    if (shouldEnable && hasNode) {
      this.updateNoiseReducerConfig();
    }
  }

  private updateNoiseReducerConfig(): void {
    if (!this.noiseReducerNode) {
      return;
    }

    const config = this.buildNoiseReducerConfig();
    this.noiseReducerNode.port.postMessage({ type: 'configure', ...config });
  }

  private registerTrackLifecycleHandlers(track: MediaStreamTrack | null): void {
    this.cleanupTrackLifecycleHandlers();

    if (!track) {
      return;
    }

    const handleEnded = () => {
      this.handleMicrophoneTrackInterruption('ended');
    };

    const handleMute = () => {
      if (track.muted) {
        this.handleMicrophoneTrackInterruption('muted');
      }
    };

    const handleUnmute = () => {
      if (import.meta.env.DEV) {
        console.debug('[AudioService] Microphone track unmuted after interruption');
      }
    };

    track.addEventListener('ended', handleEnded);
    track.addEventListener('mute', handleMute);
    track.addEventListener('unmute', handleUnmute);

    this.trackLifecycleCleanup = () => {
      track.removeEventListener('ended', handleEnded);
      track.removeEventListener('mute', handleMute);
      track.removeEventListener('unmute', handleUnmute);
      this.trackLifecycleCleanup = null;
    };
  }

  private cleanupTrackLifecycleHandlers(): void {
    if (this.trackLifecycleCleanup) {
      this.trackLifecycleCleanup();
      this.trackLifecycleCleanup = null;
    }
  }

  private handleMicrophoneTrackInterruption(reason: 'ended' | 'muted'): void {
    if (this.shuttingDownStream) {
      return;
    }

    if (import.meta.env.DEV) {
      console.warn(`[AudioService] Microphone track ${reason}; attempting recovery`);
    }

    this.emit('stream:interrupted', { reason });
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
    let normalizedId = deviceId ?? '';
    if (normalizedId === 'default') {
      normalizedId = '';
    }
    const nativeRouteId = normalizedId.startsWith('native:') ? normalizedId.slice(7) : null;

    if ((nativeRouteId !== null || normalizedId === '') && isNativeAudioRoutingAvailable()) {
      await selectNativeAudioRoute(nativeRouteId);
      return;
    }

    if (typeof audioElement.setSinkId === 'function') {
      try {
        await audioElement.setSinkId(normalizedId);
      } catch (error) {
        console.error('Error setting output device:', error);
        throw new Error('Failed to change output device');
      }
    } else if (import.meta.env.DEV) {
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
    if (isNativeAudioRoutingAvailable()) {
      return true;
    }

    if (typeof document === 'undefined') {
      return false;
    }

    const audio = document.createElement('audio');
    return typeof (audio as HTMLMediaElement & { setSinkId?: unknown }).setSinkId === 'function';
  }
}
