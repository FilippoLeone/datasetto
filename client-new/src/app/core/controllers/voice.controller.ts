import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, Subject, take } from 'rxjs';
import { Store } from '@ngrx/store';
import { SocketService } from '../services/socket.service';
import { WebRTCService } from '../services/webrtc.service';
import { AudioService } from '../services/audio.service';
import { selectUser } from '../../store/auth/auth.selectors';

export interface VoiceState {
  channelId: string | null;
  isConnected: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  connectedUsers: Array<{
    userId: string;
    username: string;
    isSpeaking: boolean;
    isMuted: boolean;
    isDeafened: boolean;
  }>;
}

@Injectable({
  providedIn: 'root'
})
export class VoiceController {
  private voiceState$ = new BehaviorSubject<VoiceState>({
    channelId: null,
    isConnected: false,
    isMuted: false,
    isDeafened: false,
    connectedUsers: []
  });

  private localStream?: MediaStream;
  private remoteAudioElements = new Map<string, HTMLAudioElement>();

  constructor(
    private socketService: SocketService,
    private webrtcService: WebRTCService,
    private audioService: AudioService,
    private store: Store
  ) {
    this.setupWebRTCListeners();
    this.setupSocketListeners();
    this.setupAudioListeners();
  }

  // Observable getters
  getVoiceState(): Observable<VoiceState> {
    return this.voiceState$.asObservable();
  }

  getCurrentVoiceState(): VoiceState {
    return this.voiceState$.value;
  }

  // Join a voice channel
  async joinVoiceChannel(channelId: string): Promise<void> {
    try {
      // Get local audio stream
      this.localStream = await this.webrtcService.getLocalStream();
      if (!this.localStream) {
        throw new Error('Failed to get local audio stream');
      }

      // Start audio monitoring for VAD and levels
      this.audioService.startLocalAudioMonitoring(this.localStream);

      // Get current user info from store
      let currentUser: any = null;
      this.store.select(selectUser).pipe(take(1)).subscribe(user => {
        currentUser = user;
      });

      // Notify server
      this.socketService.joinVoiceChannel(channelId);

      // Update state
      this.updateVoiceState({ 
        channelId, 
        isConnected: true 
      });

      // Add current user to connected users list
      if (currentUser) {
        // Use same name format as chat messages (displayName || username)
        const displayName = currentUser.displayName || currentUser.username;
        this.addConnectedUser(currentUser.id, displayName);
      }

      console.log('[VoiceController] ✅ Joined voice channel:', channelId);
    } catch (error) {
      console.error('[VoiceController] ❌ Failed to join voice channel:', error);
      throw error;
    }
  }

  // Leave the current voice channel
  leaveVoiceChannel(): void {
    const state = this.voiceState$.value;
    
    if (!state.channelId) {
      console.warn('[VoiceController] ⚠️ Not in a voice channel');
      return;
    }

    // Stop local stream
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = undefined;
    }

    // Stop audio monitoring
    this.audioService.stopLocalAudioMonitoring();

    // Close all peer connections
    this.webrtcService.cleanup();

    // Stop all remote audio
    this.remoteAudioElements.forEach(audio => {
      audio.pause();
      audio.srcObject = null;
    });
    this.remoteAudioElements.clear();

    // Notify server
    this.socketService.leaveVoiceChannel();

    // Update state
    this.updateVoiceState({
      channelId: null,
      isConnected: false,
      connectedUsers: []
    });

    console.log('[VoiceController] ✅ Left voice channel');
  }

  // Toggle mute
  toggleMute(): void {
    const state = this.voiceState$.value;
    const newMutedState = !state.isMuted;

    this.webrtcService.setMuted(newMutedState);
    this.socketService.updateVoiceState({ 
      muted: newMutedState, 
      deafened: state.isDeafened 
    });

    this.updateVoiceState({ isMuted: newMutedState });
    console.log('[VoiceController] 🔇 Mute:', newMutedState);
  }

  // Toggle deafen (mute output)
  toggleDeafen(): void {
    const state = this.voiceState$.value;
    const newDeafenedState = !state.isDeafened;

    // Deafening also mutes
    if (newDeafenedState) {
      this.webrtcService.setMuted(true);
      this.remoteAudioElements.forEach(audio => audio.volume = 0);
    } else {
      this.webrtcService.setMuted(state.isMuted);
      const volume = this.audioService.getSettings().pipe().subscribe(settings => {
        this.remoteAudioElements.forEach(audio => audio.volume = settings.outputVol);
      });
    }

    this.socketService.updateVoiceState({ 
      muted: newDeafenedState || state.isMuted, 
      deafened: newDeafenedState 
    });

    this.updateVoiceState({ 
      isDeafened: newDeafenedState,
      isMuted: newDeafenedState || state.isMuted
    });

    console.log('[VoiceController] 🔇 Deafen:', newDeafenedState);
  }

  // Setup WebRTC event listeners
  private setupWebRTCListeners(): void {
    // When a peer connection is established
    this.webrtcService.connectedUsers$.subscribe(users => {
      console.log('[VoiceController] 👥 Connected users updated:', users.length);
    });

    // When connection state changes
    this.webrtcService.isConnected$.subscribe(isConnected => {
      console.log('[VoiceController] 🔗 WebRTC connection:', isConnected);
    });
  }

  // Setup Socket.IO event listeners
  private setupSocketListeners(): void {
    // When successfully joined voice channel
    this.socketService.onVoiceJoined().subscribe(async ({ channelId, peers }) => {
      console.log('[VoiceController] ✅ Voice joined:', channelId, 'Peers:', peers.length);

      // Create peer connections for existing users
      for (const peer of peers) {
        await this.handlePeerJoin(peer.id, peer.name);
      }
    });

    // When a peer joins the voice channel
    this.socketService.onVoicePeerJoin().subscribe(async (peer) => {
      console.log('[VoiceController] 👤 Peer joined:', peer.name);
      await this.handlePeerJoin(peer.id, peer.name);
    });

    // When a peer leaves the voice channel
    this.socketService.onVoicePeerLeave().subscribe(({ id }) => {
      console.log('[VoiceController] 👤 Peer left:', id);
      this.handlePeerLeave(id);
    });

    // WebRTC signaling
    this.socketService.onVoiceSignal().subscribe(async ({ from, data }) => {
      await this.handleSignal(from, data);
    });

    // Voice state updates (mute/deafen)
    this.socketService.onVoiceState().subscribe(({ id, muted, deafened }) => {
      this.updatePeerState(id, { isMuted: muted, isDeafened: deafened });
    });
  }

  // Setup audio service listeners
  private setupAudioListeners(): void {
    // Monitor local speaking state
    this.audioService.getIsSpeaking().subscribe(isSpeaking => {
      // Update local user speaking state in connected users list
      this.store.select(selectUser).pipe(take(1)).subscribe(user => {
        if (user && this.voiceState$.value.isConnected) {
          console.log('[VoiceController] 🎤 Local speaking state:', isSpeaking, 'for user:', user.displayName || user.username);
          this.updatePeerState(user.id, { isSpeaking });
        }
      });
    });

    // Monitor PTT state
    this.audioService.getPttActive().subscribe(isPttActive => {
      console.log('[VoiceController] 🎤 PTT Active:', isPttActive);
      
      // When PTT or voice activation triggers, ensure we're transmitting
      if (!this.localStream) return;
      
      const shouldTransmit = this.audioService.shouldTransmit();
      this.webrtcService.setMuted(!shouldTransmit);
    });
  }

  // Handle peer joining
  private async handlePeerJoin(userId: string, username: string): Promise<void> {
    if (!this.localStream) {
      console.error('[VoiceController] ❌ No local stream available');
      return;
    }

    try {
      // Create peer connection with callbacks
      const peerConnection = await this.webrtcService.createPeerConnection(
        userId,
        (candidate) => {
          // ICE candidate callback
          this.socketService.sendSignal(userId, {
            type: 'ice-candidate',
            candidate: candidate
          });
        },
        (stream) => {
          // Remote stream callback
          console.log('[VoiceController] 🎵 Received remote track from:', userId);
          
          // Play remote audio
          const audioElement = this.audioService.playRemoteAudio(stream, userId);
          this.remoteAudioElements.set(userId, audioElement);
          
          // Add to connected users
          this.addConnectedUser(userId, username);
        }
      );

      // Add local stream to peer connection
      if (this.localStream) {
        this.localStream.getTracks().forEach(track => {
          peerConnection.addTrack(track, this.localStream!);
        });
      }

      // Create and send offer
      const offer = await this.webrtcService.createOffer(userId);
      this.socketService.sendSignal(userId, {
        type: 'offer',
        sdp: offer
      });

    } catch (error) {
      console.error('[VoiceController] ❌ Failed to handle peer join:', error);
    }
  }

  // Handle peer leaving
  private handlePeerLeave(userId: string): void {
    // Stop remote audio
    const audioElement = this.remoteAudioElements.get(userId);
    if (audioElement) {
      audioElement.pause();
      audioElement.srcObject = null;
      this.remoteAudioElements.delete(userId);
    }

    // Remove audio level monitoring
    this.audioService.removeRemoteAudioLevel(userId);

    // Remove from connected users
    this.removeConnectedUser(userId);
  }

  // Handle WebRTC signaling
  private async handleSignal(from: string, data: any): Promise<void> {
    try {
      if (data.type === 'offer') {
        // Handle incoming offer
        if (!this.localStream) {
          console.error('[VoiceController] ❌ No local stream for answer');
          return;
        }

        // First create the peer connection for this user (if it doesn't exist)
        const existingPeer = this.webrtcService['peerConnections'].get(from);
        if (!existingPeer) {
          await this.webrtcService.createPeerConnection(
            from,
            (candidate) => {
              this.socketService.sendSignal(from, {
                type: 'ice-candidate',
                candidate: candidate
              });
            },
            (stream) => {
              console.log('[VoiceController] 🎵 Received remote track from:', from);
              const audioElement = this.audioService.playRemoteAudio(stream, from);
              this.remoteAudioElements.set(from, audioElement);
            }
          );

          // Add local stream
          if (this.localStream) {
            const peer = this.webrtcService['peerConnections'].get(from);
            if (peer) {
              this.localStream.getTracks().forEach(track => {
                peer.connection.addTrack(track, this.localStream!);
              });
            }
          }
        }

        // Handle the offer and create answer
        const answer = await this.webrtcService.handleOffer(from, data.sdp);
        
        // Send answer
        this.socketService.sendSignal(from, {
          type: 'answer',
          sdp: answer
        });

      } else if (data.type === 'answer') {
        // Handle answer
        await this.webrtcService.handleAnswer(from, data.sdp);

      } else if (data.type === 'ice-candidate') {
        // Handle ICE candidate
        await this.webrtcService.handleIceCandidate(from, data.candidate);
      }

    } catch (error) {
      console.error('[VoiceController] ❌ Failed to handle signal:', error);
    }
  }

  // Update voice state
  private updateVoiceState(partial: Partial<VoiceState>): void {
    const current = this.voiceState$.value;
    this.voiceState$.next({ ...current, ...partial });
  }

  // Add connected user
  private addConnectedUser(userId: string, username: string): void {
    const state = this.voiceState$.value;
    
    // Check if user already exists
    const exists = state.connectedUsers.some(u => u.userId === userId);
    if (exists) return;

    const updatedUsers = [
      ...state.connectedUsers,
      {
        userId,
        username,
        isSpeaking: false,
        isMuted: false,
        isDeafened: false
      }
    ];

    this.updateVoiceState({ connectedUsers: updatedUsers });
  }

  // Remove connected user
  private removeConnectedUser(userId: string): void {
    const state = this.voiceState$.value;
    const updatedUsers = state.connectedUsers.filter(u => u.userId !== userId);
    this.updateVoiceState({ connectedUsers: updatedUsers });
  }

  // Update peer state
  private updatePeerState(userId: string, updates: Partial<{ isMuted: boolean; isDeafened: boolean; isSpeaking: boolean }>): void {
    const state = this.voiceState$.value;
    const updatedUsers = state.connectedUsers.map(user => 
      user.userId === userId ? { ...user, ...updates } : user
    );
    this.updateVoiceState({ connectedUsers: updatedUsers });
  }
}
