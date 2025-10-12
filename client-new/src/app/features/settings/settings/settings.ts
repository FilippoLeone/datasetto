import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Store } from '@ngrx/store';
import { Subject, takeUntil } from 'rxjs';
import { AudioService } from '../../../core/services/audio.service';
import { selectUser } from '../../../store/auth/auth.selectors';
import { User, DeviceInfo, AudioSettings } from '../../../core/models';

@Component({
  selector: 'app-settings',
  imports: [CommonModule, FormsModule],
  templateUrl: '../settings.html',
  styleUrl: '../settings.css',
  standalone: true
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
    this.store.select(selectUser).pipe(takeUntil(this.destroy$)).subscribe(user => { this.user = user; });
    this.loadAudioDevices();
    this.audioService.microphones$.pipe(takeUntil(this.destroy$)).subscribe(devices => { this.microphones = devices; });
    this.audioService.speakers$.pipe(takeUntil(this.destroy$)).subscribe(devices => { this.speakers = devices; });
    this.audioService.settings$.pipe(takeUntil(this.destroy$)).subscribe(settings => { this.audioSettings = { ...settings }; });
  }

  async loadAudioDevices(): Promise<void> {
    try { await this.audioService.loadDevices(); } catch (error) { console.error('Failed to load audio devices:', error); }
  }

  onMicrophoneChange(deviceId: string): void { this.audioService.updateSettings({ micDeviceId: deviceId }); }
  onSpeakerChange(deviceId: string): void { this.audioService.updateSettings({ spkDeviceId: deviceId }); }
  onMicGainChange(): void { this.audioService.updateSettings({ micGain: this.audioSettings.micGain }); }
  onOutputVolChange(): void { this.audioService.updateSettings({ outputVol: this.audioSettings.outputVol }); }
  onEchoCancelChange(): void { this.audioService.updateSettings({ echoCancel: this.audioSettings.echoCancel }); }
  onNoiseSuppressionChange(): void { this.audioService.updateSettings({ noiseSuppression: this.audioSettings.noiseSuppression }); }
  onAutoGainChange(): void { this.audioService.updateSettings({ autoGain: this.audioSettings.autoGain }); }
  async testMicrophone(): Promise<void> { const stream = await this.audioService.requestMicrophonePermission(); if (stream) { this.audioService.createAnalyzer(stream); } }
  testSpeaker(): void { this.audioService.playNotificationSound(); }
  setActiveTab(tab: 'audio' | 'profile'): void { this.activeTab = tab; }
  ngOnDestroy(): void { this.destroy$.next(); this.destroy$.complete(); }
}
