import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { DeviceInfo, AudioSettings } from '../models';

@Injectable({
  providedIn: 'root'
})
export class AudioService {
  private audioContext?: AudioContext;
  
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

  // Create audio analyzer for visualizations
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
