import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Store } from '@ngrx/store';
import { Observable, Subject, takeUntil, map } from 'rxjs';
import { VoicePeerEvent, User } from '../../../core/models';
import { selectVoicePeers, selectMuted, selectDeafened } from '../../../store/voice/voice.selectors';
import { selectUser } from '../../../store/auth/auth.selectors';
import * as VoiceActions from '../../../store/voice/voice.actions';
import { VoiceController } from '../../../core/controllers/voice.controller';
import { AudioService } from '../../../core/services/audio.service';
import { AvatarService } from '../../../core/services/avatar.service';

@Component({
  selector: 'app-voice-panel',
  imports: [CommonModule],
  templateUrl: './voice-panel.html',
  styleUrl: './voice-panel.css'
})
export class VoicePanel implements OnInit, OnDestroy {
  peers$: Observable<VoicePeerEvent[]>;
  isMuted$: Observable<boolean>;
  isDeafened$: Observable<boolean>;
  isPttActive$: Observable<boolean>;
  localAudioLevel$: Observable<number>;
  currentUser$: Observable<User | null>;
  connectedUsers$: Observable<any[]>;
  
  private destroy$ = new Subject<void>();
  private isMuted = false;
  private isDeafened = false;
  private remoteAudioLevels = new Map<string, number>();
  private speakingStates = new Map<string, boolean>();
  private avatarService = inject(AvatarService);

  constructor(
    private store: Store,
    private voiceController: VoiceController,
    private audioService: AudioService
  ) {
    this.peers$ = this.store.select(selectVoicePeers);
    this.isMuted$ = this.store.select(selectMuted);
    this.isDeafened$ = this.store.select(selectDeafened);
    this.currentUser$ = this.store.select(selectUser);
    
    // Subscribe to VoiceController state
    this.connectedUsers$ = this.voiceController.getVoiceState().pipe(
      map(state => state.connectedUsers)
    );
    
    // Subscribe to audio levels and PTT
    this.isPttActive$ = this.audioService.getPttActive();
    this.localAudioLevel$ = this.audioService.getLocalAudioLevel();
  }

  ngOnInit(): void {
    // Subscribe to muted/deafened state
    this.isMuted$.pipe(takeUntil(this.destroy$)).subscribe(muted => {
      this.isMuted = muted;
    });
    
    this.isDeafened$.pipe(takeUntil(this.destroy$)).subscribe(deafened => {
      this.isDeafened = deafened;
    });

    // Subscribe to voice controller state for real-time updates
    this.voiceController.getVoiceState().pipe(
      takeUntil(this.destroy$)
    ).subscribe(state => {
      // Update local state
      this.isMuted = state.isMuted;
      this.isDeafened = state.isDeafened;
      
      // Update speaking states from connected users
      state.connectedUsers.forEach(user => {
        this.speakingStates.set(user.userId, user.isSpeaking);
      });
    });

    // Subscribe to remote audio levels
    this.audioService.getRemoteAudioLevels().pipe(
      takeUntil(this.destroy$)
    ).subscribe(levels => {
      this.remoteAudioLevels = levels;
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  toggleMute(): void {
    this.voiceController.toggleMute();
  }

  toggleDeafen(): void {
    this.voiceController.toggleDeafen();
  }

  leaveVoiceChannel(): void {
    this.voiceController.leaveVoiceChannel();
  }

  // Get audio level for a specific user (0-100)
  getAudioLevel(userId: string): number {
    return this.remoteAudioLevels.get(userId) || 0;
  }

  // Check if user is speaking
  isSpeaking(userId: string): boolean {
    return this.speakingStates.get(userId) || false;
  }

  // Get audio level class for visual feedback
  getAudioLevelClass(level: number): string {
    if (level > 70) return 'audio-level-high';
    if (level > 40) return 'audio-level-medium';
    if (level > 10) return 'audio-level-low';
    return 'audio-level-silent';
  }

  // Get avatar URL for user
  getUserAvatar(username: string): string {
    return this.avatarService.getAvatarUrl(username, 32);
  }
}
