import { Injectable, OnDestroy } from '@angular/core';
import { Store } from '@ngrx/store';
import { Subject, Observable } from 'rxjs';
import { AudioService } from './audio.service';
import { SocketService } from './socket.service';
import { VoiceController } from '../controllers/voice.controller';
import * as VoiceActions from '../../store/voice/voice.actions';

/**
 * VoiceService - Bridge/Adapter to VoiceController
 * 
 * This service now acts as a bridge to the new VoiceController
 * for backward compatibility with existing code.
 * New code should use VoiceController directly.
 * 
 * @deprecated Use VoiceController directly for new implementations
 */
@Injectable({
  providedIn: 'root'
})
export class VoiceService implements OnDestroy {
  private destroy$ = new Subject<void>();

  constructor(
    private voiceController: VoiceController,
    private audioService: AudioService,
    private socketService: SocketService,
    private store: Store
  ) {
    console.log('[VoiceService] Initialized as bridge to VoiceController');
  }

  /**
   * Join a voice channel
   * Delegates to VoiceController
   */
  async joinChannel(channelId: string): Promise<void> {
    try {
      await this.voiceController.joinVoiceChannel(channelId);
      this.store.dispatch(VoiceActions.joinVoiceChannel({ channelId }));
    } catch (error) {
      console.error('[VoiceService] Failed to join voice channel:', error);
      this.store.dispatch(VoiceActions.joinVoiceChannelFailure({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }));
      throw error;
    }
  }

  /**
   * Leave the current voice channel
   * Delegates to VoiceController
   */
  leaveChannel(): void {
    this.voiceController.leaveVoiceChannel();
    this.store.dispatch(VoiceActions.leaveVoiceChannel());
  }

  /**
   * Toggle mute state
   * Delegates to VoiceController
   */
  setMuted(muted: boolean): void {
    const currentState = this.voiceController.getCurrentVoiceState();
    if (muted !== currentState.isMuted) {
      this.voiceController.toggleMute();
    }
    this.store.dispatch(VoiceActions.setMuted({ muted }));
  }

  /**
   * Toggle deafen state
   * Delegates to VoiceController
   */
  setDeafened(deafened: boolean): void {
    const currentState = this.voiceController.getCurrentVoiceState();
    if (deafened !== currentState.isDeafened) {
      this.voiceController.toggleDeafen();
    }
    this.store.dispatch(VoiceActions.setDeafened({ deafened }));
  }

  /**
   * Check if currently in voice channel
   */
  isConnected(): boolean {
    const state = this.voiceController.getCurrentVoiceState();
    return state.isConnected;
  }

  /**
   * Get voice state observable
   */
  getVoiceState(): Observable<any> {
    return this.voiceController.getVoiceState();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
