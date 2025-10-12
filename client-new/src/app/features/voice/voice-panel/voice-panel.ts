import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Store } from '@ngrx/store';
import { Observable, Subject, takeUntil } from 'rxjs';
import { VoicePeerEvent, User } from '../../../core/models';
import { selectVoicePeers, selectMuted, selectDeafened } from '../../../store/voice/voice.selectors';
import { selectUser } from '../../../store/auth/auth.selectors';
import * as VoiceActions from '../../../store/voice/voice.actions';

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
  currentUser$: Observable<User | null>;
  private destroy$ = new Subject<void>();
  private isMuted = false;
  private isDeafened = false;

  constructor(private store: Store) {
    this.peers$ = this.store.select(selectVoicePeers);
    this.isMuted$ = this.store.select(selectMuted);
    this.isDeafened$ = this.store.select(selectDeafened);
    this.currentUser$ = this.store.select(selectUser);
  }

  ngOnInit(): void {
    // Subscribe to muted/deafened state
    this.isMuted$.pipe(takeUntil(this.destroy$)).subscribe(muted => {
      this.isMuted = muted;
    });
    
    this.isDeafened$.pipe(takeUntil(this.destroy$)).subscribe(deafened => {
      this.isDeafened = deafened;
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  toggleMute(): void {
    this.store.dispatch(VoiceActions.setMuted({ muted: !this.isMuted }));
  }

  toggleDeafen(): void {
    this.store.dispatch(VoiceActions.setDeafened({ deafened: !this.isDeafened }));
  }

  leaveVoiceChannel(): void {
    this.store.dispatch(VoiceActions.leaveVoiceChannel());
  }
}
