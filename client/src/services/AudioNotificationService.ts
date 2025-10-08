/**
 * Audio Notification Service
 * Provides Discord-like sound effects for user interactions
 */

export type SoundEffect = 
  | 'message'
  | 'messageSent'
  | 'userJoin'
  | 'userLeave'
  | 'notification'
  | 'call'
  | 'disconnect'
  | 'mute'
  | 'unmute'
  | 'deafen'
  | 'undeafen'
  | 'ptt_on'
  | 'ptt_off'
  | 'error'
  | 'success'
  | 'hover'
  | 'click'
  | 'channelVoice'
  | 'channelStream';

export class AudioNotificationService {
  private audioContext: AudioContext | null = null;
  private sounds: Map<SoundEffect, AudioBuffer> = new Map();
  private enabled = true;
  private volume = 0.3;
  private initializing: Promise<void> | null = null;
  private unlockHandler?: () => void;

  constructor() {}

  private async ensureInitialized(): Promise<void> {
    if (this.audioContext && this.audioContext.state !== 'closed') {
      return;
    }

    if (!this.initializing) {
      this.initializing = this.initializeContext().finally(() => {
        this.initializing = null;
      });
    }

    await this.initializing;
  }

  private async initializeContext(): Promise<void> {
    if (typeof window === 'undefined') {
      return;
    }

    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextCtor) {
      console.warn('AudioNotificationService: Web Audio API not supported');
      this.enabled = false;
      return;
    }

    try {
      this.audioContext = new AudioContextCtor();
      this.attachUnlockHandlers();
      this.generateSounds();
    } catch (error) {
      console.warn('AudioNotificationService: Failed to initialize', error);
    }
  }

  private attachUnlockHandlers(): void {
    if (typeof window === 'undefined') {
      return;
    }

    if (this.unlockHandler) {
      return;
    }

    this.unlockHandler = () => {
      if (!this.audioContext) {
        return;
      }

      if (this.audioContext.state !== 'suspended') {
        this.detachUnlockHandlers();
        return;
      }

      this.audioContext
        .resume()
        .then(() => {
          if (this.audioContext && this.audioContext.state === 'running') {
            this.detachUnlockHandlers();
          }
        })
        .catch((error) => {
          if (import.meta.env.DEV) {
            console.warn('AudioNotificationService: Unable to resume AudioContext automatically', error);
          }
        });
    };

    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchend'];
    for (const event of events) {
      window.addEventListener(event, this.unlockHandler, { passive: true });
    }
  }

  private detachUnlockHandlers(): void {
    if (!this.unlockHandler || typeof window === 'undefined') {
      return;
    }

    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchend'];
    for (const event of events) {
      window.removeEventListener(event, this.unlockHandler);
    }
    this.unlockHandler = undefined;
  }

  private playBuffer(effect: SoundEffect, volumeMultiplier: number): void {
    if (!this.enabled || !this.audioContext || !this.sounds.has(effect)) {
      return;
    }

    if (this.audioContext.state === 'suspended') {
      this.audioContext
        .resume()
        .then(() => {
          if (this.audioContext?.state === 'running') {
            this.detachUnlockHandlers();
            this.playBuffer(effect, volumeMultiplier);
          }
        })
        .catch((error) => {
          if (import.meta.env.DEV) {
            console.warn('AudioNotificationService: Unable to resume AudioContext', error);
          }
        });
      return;
    }

    this.detachUnlockHandlers();

    try {
      const source = this.audioContext.createBufferSource();
      const gainNode = this.audioContext.createGain();

      source.buffer = this.sounds.get(effect)!;
      gainNode.gain.value = this.volume * volumeMultiplier;

      source.connect(gainNode);
      gainNode.connect(this.audioContext.destination);
      source.start();
    } catch (error) {
      console.warn('Failed to play sound:', effect, error);
    }
  }

  /**
   * Generate sound effects programmatically (no external files needed)
   */
  private generateSounds(): void {
    if (!this.audioContext) return;

    // Message received - gentle notification tone
    this.sounds.set('message', this.createTone(440, 0.05, 'sine', 0.2));
    
    // Message sent - confirmation beep
    this.sounds.set('messageSent', this.createTone(660, 0.04, 'sine', 0.15));
    
    // User joined - ascending tone
    this.sounds.set('userJoin', this.createAscendingTone(440, 660, 0.1, 0.2));
    
    // User left - descending tone
    this.sounds.set('userLeave', this.createDescendingTone(660, 440, 0.1, 0.2));
    
    // Notification - attention sound
    this.sounds.set('notification', this.createDoubleBeep(600, 800, 0.25));
    
    // Call connecting
    this.sounds.set('call', this.createTone(800, 0.2, 'sine', 0.25));
    
    // Disconnect
    this.sounds.set('disconnect', this.createDescendingTone(600, 200, 0.2, 0.25));
    
    // Mute/Unmute
    this.sounds.set('mute', this.createTone(300, 0.06, 'sine', 0.2));
    this.sounds.set('unmute', this.createTone(500, 0.06, 'sine', 0.2));
    
    // Deafen/Undeafen
    this.sounds.set('deafen', this.createDescendingTone(500, 300, 0.08, 0.2));
    this.sounds.set('undeafen', this.createAscendingTone(300, 500, 0.08, 0.2));
    
    // PTT
    this.sounds.set('ptt_on', this.createTone(600, 0.03, 'sine', 0.15));
    this.sounds.set('ptt_off', this.createTone(400, 0.03, 'sine', 0.15));
    
    // Error
    this.sounds.set('error', this.createErrorSound());
    
    // Success
    this.sounds.set('success', this.createSuccessSound());
    
    // UI sounds
    this.sounds.set('hover', this.createTone(800, 0.02, 'sine', 0.08));
    this.sounds.set('click', this.createTone(600, 0.03, 'sine', 0.12));

    // Channel switches
    this.sounds.set('channelVoice', this.createAscendingTone(260, 520, 0.14, 0.24));
    this.sounds.set('channelStream', this.createDoubleBeep(520, 720, 0.26));
  }

  private createTone(frequency: number, duration: number, _type: OscillatorType = 'sine', volume: number = 0.2): AudioBuffer {
    if (!this.audioContext) throw new Error('AudioContext not initialized');
    
    const ctx = this.audioContext;
    const sampleRate = ctx.sampleRate;
    const numSamples = Math.floor(sampleRate * duration);
    const buffer = ctx.createBuffer(1, numSamples, sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const envelope = Math.exp(-t * 8); // Exponential decay
      const sample = Math.sin(2 * Math.PI * frequency * t) * envelope * volume;
      data[i] = sample;
    }

    return buffer;
  }

  private createAscendingTone(startFreq: number, endFreq: number, duration: number, volume: number = 0.2): AudioBuffer {
    if (!this.audioContext) throw new Error('AudioContext not initialized');
    
    const ctx = this.audioContext;
    const sampleRate = ctx.sampleRate;
    const numSamples = Math.floor(sampleRate * duration);
    const buffer = ctx.createBuffer(1, numSamples, sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const progress = t / duration;
      const frequency = startFreq + (endFreq - startFreq) * progress;
      const envelope = 1 - progress; // Linear decay
      const sample = Math.sin(2 * Math.PI * frequency * t) * envelope * volume;
      data[i] = sample;
    }

    return buffer;
  }

  private createDescendingTone(startFreq: number, endFreq: number, duration: number, volume: number = 0.2): AudioBuffer {
    return this.createAscendingTone(startFreq, endFreq, duration, volume);
  }

  private createDoubleBeep(freq1: number, freq2: number, volume: number = 0.2): AudioBuffer {
    if (!this.audioContext) throw new Error('AudioContext not initialized');
    
    const ctx = this.audioContext;
    const sampleRate = ctx.sampleRate;
    const beepDuration = 0.08;
    const gap = 0.04;
    const totalDuration = beepDuration * 2 + gap;
    const numSamples = Math.floor(sampleRate * totalDuration);
    const buffer = ctx.createBuffer(1, numSamples, sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      let sample = 0;

      if (t < beepDuration) {
        // First beep
        const envelope = Math.exp(-(t / beepDuration) * 5);
        sample = Math.sin(2 * Math.PI * freq1 * t) * envelope * volume;
      } else if (t > beepDuration + gap) {
        // Second beep
        const t2 = t - beepDuration - gap;
        const envelope = Math.exp(-(t2 / beepDuration) * 5);
        sample = Math.sin(2 * Math.PI * freq2 * t2) * envelope * volume;
      }

      data[i] = sample;
    }

    return buffer;
  }

  private createErrorSound(): AudioBuffer {
    if (!this.audioContext) throw new Error('AudioContext not initialized');
    
    const ctx = this.audioContext;
    const sampleRate = ctx.sampleRate;
    const duration = 0.15;
    const numSamples = Math.floor(sampleRate * duration);
    const buffer = ctx.createBuffer(1, numSamples, sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const envelope = Math.exp(-t * 10);
      const sample = (Math.random() * 2 - 1) * envelope * 0.15; // White noise
      data[i] = sample;
    }

    return buffer;
  }

  private createSuccessSound(): AudioBuffer {
    return this.createAscendingTone(440, 880, 0.12, 0.22);
  }

  /**
   * Play a sound effect
   */
  public play(effect: SoundEffect, volumeMultiplier: number = 1): void {
    if (!this.enabled) {
      return;
    }

    if (this.audioContext && this.audioContext.state !== 'closed' && this.sounds.has(effect)) {
      this.playBuffer(effect, volumeMultiplier);
      return;
    }

    void this.ensureInitialized()
      .then(() => {
        this.playBuffer(effect, volumeMultiplier);
      })
      .catch((error) => {
        if (import.meta.env.DEV) {
          console.warn('AudioNotificationService: Unable to initialize audio before playback', error);
        }
      });
  }

  /**
   * Set master volume (0 to 1)
   */
  public setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
  }

  /**
   * Enable or disable sound effects
   */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Get current enabled state
   */
  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Resume audio context (required after user interaction on some browsers)
   */
  public async resume(): Promise<void> {
    await this.ensureInitialized();

    if (!this.audioContext) {
      return;
    }

    try {
      await this.audioContext.resume();
      if (this.audioContext.state === 'running') {
        this.detachUnlockHandlers();
      }
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('AudioNotificationService: Unable to resume AudioContext', error);
      }
    }
  }
}
