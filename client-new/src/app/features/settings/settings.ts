import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Store } from '@ngrx/store';
import { Subject, takeUntil } from 'rxjs';
import { AudioService } from '../../core/services/audio.service';
import { selectUser } from '../../store/auth/auth.selectors';
import { User, DeviceInfo, AudioSettings } from '../../core/models';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './settings.html',
  styleUrl: './settings.css'
})
export class SettingsComponent implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  user: User | null = null;
  microphones: DeviceInfo[] = [];
  speakers: DeviceInfo[] = [];
  audioSettings: AudioSettings = {
    echoCancel: true,
    noiseSuppression: true,
    autoGain: true,
    micGain: 1,
    outputVol: 1,
    pttEnable: false,
    pttKey: 'Space'
  };
  activeTab: 'audio' | 'profile' = 'audio';

  constructor(private store: Store, private audioService: AudioService) {}

  ngOnInit(): void {
    this.store.select(selectUser).pipe(takeUntil(this.destroy$)).subscribe(user => this.user = user);
    this.loadAudioDevices();
    this.audioService.microphones$.pipe(takeUntil(this.destroy$)).subscribe(devices => this.microphones = devices);
    this.audioService.speakers$.pipe(takeUntil(this.destroy$)).subscribe(devices => this.speakers = devices);
    this.audioService.settings$.pipe(takeUntil(this.destroy$)).subscribe(settings => this.audioSettings = { ...settings });
  }

  async loadAudioDevices(): Promise<void> {
    try {
      await this.audioService.loadDevices();
    } catch (error) {
      console.error('Failed to load audio devices:', error);
    }
  }

  onMicrophoneChange(deviceId: string): void {
    this.audioService.updateSettings({ ...this.audioSettings, micDeviceId: deviceId });
  }

  onSpeakerChange(deviceId: string): void {
    this.audioService.updateSettings({ ...this.audioSettings, spkDeviceId: deviceId });
  }

  onMicGainChange(): void {
    this.audioService.updateSettings(this.audioSettings);
  }

  onOutputVolChange(): void {
    this.audioService.updateSettings(this.audioSettings);
  }

  onEchoCancelChange(): void {
    this.audioService.updateSettings(this.audioSettings);
  }

  onNoiseSuppressionChange(): void {
    this.audioService.updateSettings(this.audioSettings);
  }

  onAutoGainChange(): void {
    this.audioService.updateSettings(this.audioSettings);
  }

  testMicrophone(): void {
    this.audioService.requestMicrophonePermission();
  }

  testSpeaker(): void {
    this.audioService.playNotificationSound();
  }

  setActiveTab(tab: 'audio' | 'profile'): void {
    this.activeTab = tab;
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
