import { Injectable, OnDestroy } from '@angular/core';
import { Store } from '@ngrx/store';
import { Subject } from 'rxjs';
import { AudioService } from './audio.service';
import { SocketService } from './socket.service';
import * as VoiceActions from '../../store/voice/voice.actions';

interface PeerConnection {
  peerId: string;
  connection: RTCPeerConnection;
  stream?: MediaStream;
}

@Injectable({
  providedIn: 'root'
})
export class VoiceService implements OnDestroy {
  private localStream?: MediaStream;
  private peerConnections = new Map<string, PeerConnection>();
  private destroy$ = new Subject<void>();
  
  private configuration: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  constructor(
    private audioService: AudioService,
    private socketService: SocketService,
    private store: Store
  ) {
    this.setupSocketListeners();
  }

  // Setup socket event listeners for voice signaling
  private setupSocketListeners(): void {
    // Listen for voice signals from socket
    this.socketService.onVoiceSignal().subscribe(data => {
      this.handleSignal(data.data);
    });

    this.socketService.onVoicePeerJoin().subscribe((peer: any) => {
      this.createPeerConnection(peer.id);
    });

    this.socketService.onVoicePeerLeave().subscribe((data: any) => {
      this.removePeerConnection(data.id);
    });
  }

  // Join a voice channel
  async joinChannel(channelId: string): Promise<void> {
    try {
      // Get microphone stream
      const stream = await this.audioService.requestMicrophonePermission();
      this.localStream = stream || undefined;
      
      if (!this.localStream) {
        throw new Error('Failed to get microphone access');
      }

      // Emit join event to server
      this.socketService.joinVoiceChannel(channelId);
      
      this.store.dispatch(VoiceActions.joinVoiceChannel({ channelId }));
    } catch (error) {
      console.error('Failed to join voice channel:', error);
      this.store.dispatch(VoiceActions.joinVoiceChannelFailure({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }));
    }
  }

  // Leave voice channel
  leaveChannel(): void {
    // Close all peer connections
    this.peerConnections.forEach(peer => {
      peer.connection.close();
    });
    this.peerConnections.clear();

    // Stop local stream
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = undefined;
    }

    // Notify server
    this.socketService.leaveVoiceChannel();
    this.store.dispatch(VoiceActions.leaveVoiceChannel());
  }

  // Create peer connection for new peer
  private async createPeerConnection(peerId: string): Promise<void> {
    try {
      const pc = new RTCPeerConnection(this.configuration);

      // Add local stream tracks
      if (this.localStream) {
        this.localStream.getTracks().forEach(track => {
          pc.addTrack(track, this.localStream!);
        });
      }

      // Handle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.socketService.sendSignal(peerId, {
            type: 'ice-candidate',
            candidate: event.candidate
          });
        }
      };

      // Handle remote stream
      pc.ontrack = (event) => {
        const peerData = this.peerConnections.get(peerId);
        if (peerData) {
          peerData.stream = event.streams[0];
          this.playRemoteStream(event.streams[0]);
        }
      };

      // Store peer connection
      this.peerConnections.set(peerId, { peerId, connection: pc });

      // Create and send offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      this.socketService.sendSignal(peerId, {
        type: 'offer',
        sdp: offer
      });
    } catch (error) {
      console.error('Failed to create peer connection:', error);
    }
  }

  // Handle incoming signaling messages
  private async handleSignal(data: any): Promise<void> {
    const { from, type, sdp, candidate } = data;

    let peerData = this.peerConnections.get(from);

    // Create peer connection if doesn't exist
    if (!peerData) {
      const pc = new RTCPeerConnection(this.configuration);
      peerData = { peerId: from, connection: pc };
      this.peerConnections.set(from, peerData);

      // Setup handlers
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.socketService.sendSignal(from, {
            type: 'ice-candidate',
            candidate: event.candidate
          });
        }
      };

      pc.ontrack = (event) => {
        peerData!.stream = event.streams[0];
        this.playRemoteStream(event.streams[0]);
      };

      // Add local tracks
      if (this.localStream) {
        this.localStream.getTracks().forEach(track => {
          pc.addTrack(track, this.localStream!);
        });
      }
    }

    const pc = peerData.connection;

    try {
      if (type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        this.socketService.sendSignal(from, {
          type: 'answer',
          sdp: answer
        });
      } else if (type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      } else if (type === 'ice-candidate') {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    } catch (error) {
      console.error('Failed to handle signal:', error);
    }
  }

  // Remove peer connection
  private removePeerConnection(peerId: string): void {
    const peer = this.peerConnections.get(peerId);
    if (peer) {
      peer.connection.close();
      this.peerConnections.delete(peerId);
      this.store.dispatch(VoiceActions.peerLeft({ peerId }));
    }
  }

  // Play remote audio stream
  private playRemoteStream(stream: MediaStream): void {
    const audio = new Audio();
    audio.srcObject = stream;
    audio.autoplay = true;
    audio.play().catch(err => console.error('Failed to play remote audio:', err));
  }

  // Mute/unmute local microphone
  setMuted(muted: boolean): void {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !muted;
      });
    }
    this.store.dispatch(VoiceActions.setMuted({ muted }));
  }

  // Check if currently in voice channel
  isConnected(): boolean {
    return this.localStream !== undefined;
  }

  ngOnDestroy(): void {
    this.leaveChannel();
    this.destroy$.next();
    this.destroy$.complete();
  }
}
