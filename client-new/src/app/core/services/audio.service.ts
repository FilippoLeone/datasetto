import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { DeviceInfo, AudioSettings } from '../models';

@Injectable({
  providedIn: 'root'
})
export class AudioService {
  private audioContext?: AudioContext;
  private analyzerNode?: AnalyserNode;
  private audioDataArray?: Uint8Array<ArrayBuffer>;
  private animationFrameId?: number;
  
  // Voice Activity Detection
  private vadThreshold = 10; // 0-100 scale - Lowered for better sensitivity
  private isSpeakingSubject$ = new BehaviorSubject<boolean>(false);
  
  // Push-to-Talk
  private pttActive$ = new BehaviorSubject<boolean>(false);
  private pttKeyListener?: (event: KeyboardEvent) => void;
  
  // Audio levels
  private localAudioLevel$ = new BehaviorSubject<number>(0);
  private remoteAudioLevels$ = new BehaviorSubject<Map<string, number>>(new Map());
  
  // Public observables for device lists and settings
  microphones$ = new BehaviorSubject<DeviceInfo[]>([]);
  speakers$ = new BehaviorSubject<DeviceInfo[]>([]);
  settings$ = new BehaviorSubject<AudioSettings>({
    echoCancel: true,
    noiseSuppression: true,
    autoGain: true,
    micGain: 1,
    outputVol: 1,
    pttEnable: false,
    pttKey: 'Space'
  });

  constructor() {
    this.initializeAudioContext();
    this.loadDevices();
  }

  // Observable getters
  getMicrophones(): Observable<DeviceInfo[]> {
    return this.microphones$.asObservable();
  }

  getSpeakers(): Observable<DeviceInfo[]> {
    return this.speakers$.asObservable();
  }

  getSettings(): Observable<AudioSettings> {
    return this.settings$.asObservable();
  }

  // Voice Activity Detection
  getIsSpeaking(): Observable<boolean> {
    return this.isSpeakingSubject$.asObservable();
  }

  setVadThreshold(threshold: number): void {
    this.vadThreshold = Math.max(0, Math.min(100, threshold));
  }

  getVadThreshold(): number {
    return this.vadThreshold;
  }

  // Push-to-Talk
  getPttActive(): Observable<boolean> {
    return this.pttActive$.asObservable();
  }

  isPttActive(): boolean {
    return this.pttActive$.value;
  }

  setPttActive(active: boolean): void {
    this.pttActive$.next(active);
  }

  enablePtt(key: string = 'Space'): void {
    this.disablePtt(); // Remove old listener if exists

    this.pttKeyListener = (event: KeyboardEvent) => {
      if (event.code === key) {
        if (event.type === 'keydown' && !event.repeat) {
          this.setPttActive(true);
        } else if (event.type === 'keyup') {
          this.setPttActive(false);
        }
      }
    };

    window.addEventListener('keydown', this.pttKeyListener);
    window.addEventListener('keyup', this.pttKeyListener);
    
    this.updateSettings({ pttEnable: true, pttKey: key });
  }

  disablePtt(): void {
    if (this.pttKeyListener) {
      window.removeEventListener('keydown', this.pttKeyListener);
      window.removeEventListener('keyup', this.pttKeyListener);
      this.pttKeyListener = undefined;
    }
    this.setPttActive(false);
    this.updateSettings({ pttEnable: false });
  }

  // Audio level monitoring
  getLocalAudioLevel(): Observable<number> {
    return this.localAudioLevel$.asObservable();
  }

  getRemoteAudioLevels(): Observable<Map<string, number>> {
    return this.remoteAudioLevels$.asObservable();
  }

  updateRemoteAudioLevel(userId: string, level: number): void {
    const levels = this.remoteAudioLevels$.value;
    levels.set(userId, level);
    this.remoteAudioLevels$.next(new Map(levels));
  }

  removeRemoteAudioLevel(userId: string): void {
    const levels = this.remoteAudioLevels$.value;
    levels.delete(userId);
    this.remoteAudioLevels$.next(new Map(levels));
  }

  // Determine if user should be transmitting audio
  shouldTransmit(): boolean {
    const settings = this.settings$.value;
    const isVoiceActive = this.isSpeakingSubject$.value;
    const isPttActive = this.pttActive$.value;

    // If both PTT and VAD are enabled, either can activate transmission
    if (settings.pttEnable) {
      return isPttActive || isVoiceActive;
    }

    // If only VAD is enabled (PTT disabled)
    return isVoiceActive;
  }

  // Initialize Web Audio API context
  private initializeAudioContext(): void {
    try {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    } catch (error) {
      console.error('Failed to initialize AudioContext:', error);
    }
  }

  // Load available audio devices
  async loadDevices(): Promise<void> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      
      const microphones = devices
        .filter(device => device.kind === 'audioinput')
        .map(device => ({
          deviceId: device.deviceId,
          label: device.label || `Microphone ${device.deviceId.slice(0, 5)}`,
          kind: device.kind
        }));

      const speakers = devices
        .filter(device => device.kind === 'audiooutput')
        .map(device => ({
          deviceId: device.deviceId,
          label: device.label || `Speaker ${device.deviceId.slice(0, 5)}`,
          kind: device.kind
        }));

      this.microphones$.next(microphones);
      this.speakers$.next(speakers);
    } catch (error) {
      console.error('Failed to enumerate devices:', error);
    }
  }

  // Request microphone permission
  async requestMicrophonePermission(): Promise<MediaStream | null> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: this.settings$.value.echoCancel,
          noiseSuppression: this.settings$.value.noiseSuppression,
          autoGainControl: this.settings$.value.autoGain
        } 
      });
      
      // Reload devices after permission granted
      await this.loadDevices();
      
      return stream;
    } catch (error) {
      console.error('Microphone permission denied:', error);
      return null;
    }
  }

  // Update audio settings
  updateSettings(settings: Partial<AudioSettings>): void {
    const current = this.settings$.value;
    this.settings$.next({ ...current, ...settings });
    this.saveSettings();
  }

  // Save settings to localStorage
  private saveSettings(): void {
    try {
      localStorage.setItem('audio_settings', JSON.stringify(this.settings$.value));
    } catch (error) {
      console.error('Failed to save audio settings:', error);
    }
  }

  // Load settings from localStorage
  loadSettings(): void {
    try {
      const saved = localStorage.getItem('audio_settings');
      if (saved) {
        const settings = JSON.parse(saved);
        this.settings$.next(settings);
      }
    } catch (error) {
      console.error('Failed to load audio settings:', error);
    }
  }

  // Create audio analyzer for visualizations and VAD
  createAnalyzer(stream: MediaStream): AnalyserNode | null {
    if (!this.audioContext) return null;

    try {
      const source = this.audioContext.createMediaStreamSource(stream);
      const analyzer = this.audioContext.createAnalyser();
      analyzer.fftSize = 256;
      source.connect(analyzer);
      return analyzer;
    } catch (error) {
      console.error('Failed to create analyzer:', error);
      return null;
    }
  }

  // Start monitoring local audio stream for VAD and level
  startLocalAudioMonitoring(stream: MediaStream): void {
    this.stopLocalAudioMonitoring();

    const analyzer = this.createAnalyzer(stream);
    if (!analyzer) return;

    this.analyzerNode = analyzer;
    this.audioDataArray = new Uint8Array(this.analyzerNode.frequencyBinCount);

    const monitorAudio = () => {
      if (!this.analyzerNode || !this.audioDataArray) return;

      this.analyzerNode.getByteFrequencyData(this.audioDataArray);

      // Calculate average volume (0-255 scale)
      const sum = this.audioDataArray.reduce((a, b) => a + b, 0);
      const average = sum / this.audioDataArray.length;

      // Convert to 0-100 scale
      const level = Math.round((average / 255) * 100);
      this.localAudioLevel$.next(level);

      // Voice Activity Detection: compare to threshold
      const isSpeaking = level > this.vadThreshold;
      
      // Log when speaking state changes
      if (isSpeaking !== this.isSpeakingSubject$.value) {
        console.log('[AudioService] 🎤 Speaking:', isSpeaking, '| Level:', level, '| Threshold:', this.vadThreshold);
      }
      
      // Periodic logging of audio level (every 60 frames = ~1 second)
      if (Math.random() < 0.016) { // ~1/60 chance
        console.log('[AudioService] 📊 Current audio level:', level, '| Threshold:', this.vadThreshold, '| Speaking:', isSpeaking);
      }
      
      this.isSpeakingSubject$.next(isSpeaking);

      this.animationFrameId = requestAnimationFrame(monitorAudio);
    };

    monitorAudio();
  }

  // Stop monitoring local audio
  stopLocalAudioMonitoring(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = undefined;
    }
    this.analyzerNode = undefined;
    this.audioDataArray = undefined;
    this.localAudioLevel$.next(0);
    this.isSpeakingSubject$.next(false);
  }

  // Play remote audio stream
  playRemoteAudio(stream: MediaStream, userId: string): HTMLAudioElement {
    const audio = new Audio();
    audio.srcObject = stream;
    audio.autoplay = true;
    audio.volume = this.settings$.value.outputVol;

    // Monitor remote audio levels
    const remoteAnalyzer = this.createAnalyzer(stream);
    if (remoteAnalyzer) {
      const dataArray = new Uint8Array(remoteAnalyzer.frequencyBinCount);
      
      const monitorRemoteAudio = () => {
        if (!remoteAnalyzer) return;

        remoteAnalyzer.getByteFrequencyData(dataArray);
        const sum = dataArray.reduce((a, b) => a + b, 0);
        const average = sum / dataArray.length;
        const level = Math.round((average / 255) * 100);
        
        this.updateRemoteAudioLevel(userId, level);
        requestAnimationFrame(monitorRemoteAudio);
      };

      monitorRemoteAudio();
    }

    return audio;
  }

  // Play notification sound
  playNotificationSound(): void {
    if (!this.audioContext) return;

    try {
      const oscillator = this.audioContext.createOscillator();
      const gainNode = this.audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(this.audioContext.destination);

      oscillator.frequency.value = 800;
      oscillator.type = 'sine';
      
      gainNode.gain.setValueAtTime(0.3, this.audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.3);

      oscillator.start(this.audioContext.currentTime);
      oscillator.stop(this.audioContext.currentTime + 0.3);
    } catch (error) {
      console.error('Failed to play notification sound:', error);
    }
  }

  // Cleanup
  destroy(): void {
    if (this.audioContext) {
      this.audioContext.close();
    }
  }
}
