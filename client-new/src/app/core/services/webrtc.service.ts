import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

interface PeerConnection {
  connection: RTCPeerConnection;
  userId: string;
  stream?: MediaStream;
}

interface ConnectedUser {
  userId: string;
  userName: string;
  stream: MediaStream;
  isSpeaking: boolean;
  isMuted: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class WebRTCService {
  private peerConnections = new Map<string, PeerConnection>();
  private localStream: MediaStream | null = null;
  
  // Observables for state management
  private connectedUsersSubject = new BehaviorSubject<ConnectedUser[]>([]);
  public connectedUsers$ = this.connectedUsersSubject.asObservable();

  private isConnectedSubject = new BehaviorSubject<boolean>(false);
  public isConnected$ = this.isConnectedSubject.asObservable();

  // ICE servers configuration (using Google's public STUN server)
  private iceServers: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  };

  constructor() {
    console.log('WebRTC Service initialized');
  }

  /**
   * Get local audio stream from microphone
   */
  async getLocalStream(): Promise<MediaStream> {
    if (this.localStream) {
      return this.localStream;
    }

    try {
      // Request audio with echo cancellation and noise suppression
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000
        },
        video: false
      });

      console.log('Local audio stream obtained:', this.localStream);
      return this.localStream;
    } catch (error) {
      console.error('Error accessing microphone:', error);
      throw new Error('Could not access microphone. Please check permissions.');
    }
  }

  /**
   * Create a peer connection for a specific user
   */
  async createPeerConnection(
    userId: string,
    onIceCandidate: (candidate: RTCIceCandidate) => void,
    onTrack: (stream: MediaStream) => void
  ): Promise<RTCPeerConnection> {
    const peerConnection = new RTCPeerConnection(this.iceServers);

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('ICE candidate generated for', userId);
        onIceCandidate(event.candidate);
      }
    };

    // Handle incoming tracks (remote audio)
    peerConnection.ontrack = (event) => {
      console.log('Received remote track from', userId);
      if (event.streams && event.streams[0]) {
        onTrack(event.streams[0]);
      }
    };

    // Handle connection state changes
    peerConnection.onconnectionstatechange = () => {
      console.log(`Connection state with ${userId}:`, peerConnection.connectionState);
      
      if (peerConnection.connectionState === 'disconnected' || 
          peerConnection.connectionState === 'failed') {
        this.removePeerConnection(userId);
      }
    };

    // Add local stream tracks to the connection
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, this.localStream!);
      });
    }

    // Store the peer connection
    this.peerConnections.set(userId, {
      connection: peerConnection,
      userId
    });

    return peerConnection;
  }

  /**
   * Create and send an offer to a peer
   */
  async createOffer(userId: string): Promise<RTCSessionDescriptionInit> {
    const peer = this.peerConnections.get(userId);
    if (!peer) {
      throw new Error(`No peer connection found for user ${userId}`);
    }

    const offer = await peer.connection.createOffer();
    await peer.connection.setLocalDescription(offer);
    
    console.log('Created offer for', userId);
    return offer;
  }

  /**
   * Handle received offer and create answer
   */
  async handleOffer(
    userId: string,
    offer: RTCSessionDescriptionInit
  ): Promise<RTCSessionDescriptionInit> {
    const peer = this.peerConnections.get(userId);
    if (!peer) {
      throw new Error(`No peer connection found for user ${userId}`);
    }

    await peer.connection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peer.connection.createAnswer();
    await peer.connection.setLocalDescription(answer);

    console.log('Created answer for', userId);
    return answer;
  }

  /**
   * Handle received answer
   */
  async handleAnswer(userId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    const peer = this.peerConnections.get(userId);
    if (!peer) {
      throw new Error(`No peer connection found for user ${userId}`);
    }

    await peer.connection.setRemoteDescription(new RTCSessionDescription(answer));
    console.log('Set remote description (answer) for', userId);
  }

  /**
   * Handle received ICE candidate
   */
  async handleIceCandidate(userId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const peer = this.peerConnections.get(userId);
    if (!peer) {
      console.warn(`No peer connection found for user ${userId}, ignoring ICE candidate`);
      return;
    }

    try {
      await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
      console.log('Added ICE candidate for', userId);
    } catch (error) {
      console.error('Error adding ICE candidate:', error);
    }
  }

  /**
   * Add remote stream for a user
   */
  addRemoteStream(userId: string, userName: string, stream: MediaStream): void {
    const peer = this.peerConnections.get(userId);
    if (peer) {
      peer.stream = stream;
    }

    // Update connected users list
    const users = this.connectedUsersSubject.value;
    const existingUser = users.find(u => u.userId === userId);

    if (!existingUser) {
      users.push({
        userId,
        userName,
        stream,
        isSpeaking: false,
        isMuted: false
      });
      this.connectedUsersSubject.next(users);
    }
  }

  /**
   * Remove peer connection
   */
  removePeerConnection(userId: string): void {
    const peer = this.peerConnections.get(userId);
    if (peer) {
      peer.connection.close();
      this.peerConnections.delete(userId);
      
      // Update connected users list
      const users = this.connectedUsersSubject.value.filter(u => u.userId !== userId);
      this.connectedUsersSubject.next(users);
      
      console.log('Removed peer connection for', userId);
    }
  }

  /**
   * Mute/unmute local audio
   */
  setMuted(muted: boolean): void {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !muted;
      });
      console.log('Local audio', muted ? 'muted' : 'unmuted');
    }
  }

  /**
   * Check if local audio is muted
   */
  isMuted(): boolean {
    if (!this.localStream) return true;
    const audioTrack = this.localStream.getAudioTracks()[0];
    return !audioTrack?.enabled;
  }

  /**
   * Clean up all connections and streams
   */
  cleanup(): void {
    console.log('Cleaning up WebRTC connections');

    // Close all peer connections
    this.peerConnections.forEach((peer, userId) => {
      peer.connection.close();
    });
    this.peerConnections.clear();

    // Stop local stream
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }

    // Reset state
    this.connectedUsersSubject.next([]);
    this.isConnectedSubject.next(false);
  }

  /**
   * Get current peer connections count
   */
  getPeerCount(): number {
    return this.peerConnections.size;
  }

  /**
   * Set connection status
   */
  setConnected(connected: boolean): void {
    this.isConnectedSubject.next(connected);
  }
}
