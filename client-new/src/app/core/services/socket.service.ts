import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { Observable, Subject, fromEvent, merge } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  ChatMessage,
  Channel,
  User,
  ChannelPermissions,
  Account,
  ChannelGroup,
  SessionInfo,
  VoicePeerEvent,
} from '../models';

interface AuthResponse {
  user: User;
  account: Account;
  session: SessionInfo;
  channels?: Channel[];
  groups?: ChannelGroup[];
  isNewAccount?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class SocketService {
  private socket: Socket | null = null;
  private serverUrl: string = '';
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private isAuthenticated = false;

  // Subjects for socket events
  private connectionStatus$ = new Subject<{ connected: boolean; reconnecting: boolean }>();
  private authSuccess$ = new Subject<AuthResponse>();
  private authError$ = new Subject<{ message: string; code?: string }>();
  private channelUpdate$ = new Subject<Channel[] | { channels: Channel[]; groups?: ChannelGroup[] }>();
  private userUpdate$ = new Subject<User[]>();
  private chatMessage$ = new Subject<ChatMessage>();
  private chatHistory$ = new Subject<ChatMessage[]>();
  private voiceJoined$ = new Subject<{ channelId: string; peers: VoicePeerEvent[]; startedAt?: number | null; sessionId?: string | null }>();
  private voicePeerJoin$ = new Subject<VoicePeerEvent>();
  private voicePeerLeave$ = new Subject<{ id: string }>();
  private voiceSignal$ = new Subject<{ from: string; data: unknown }>();
  private voiceState$ = new Subject<{ id: string; muted: boolean; deafened: boolean }>();

  constructor() {}

  /**
   * Initialize socket connection
   */
  connect(serverUrl: string): void {
    if (this.socket?.connected) {
      console.warn('[SocketService] Already connected');
      return;
    }

    this.serverUrl = serverUrl;
    this.socket = io(this.serverUrl, {
      path: '/socket.io/',
      transports: ['polling', 'websocket'],
      withCredentials: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: this.maxReconnectAttempts,
      timeout: 20000,
      autoConnect: true,
    });

    this.setupSocketListeners();
  }

  /**
   * Disconnect from server
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  /**
   * Get socket ID
   */
  getId(): string | null {
    return this.socket?.id ?? null;
  }

  // Observable streams
  onConnectionStatus(): Observable<{ connected: boolean; reconnecting: boolean }> {
    return this.connectionStatus$.asObservable();
  }

  onAuthSuccess(): Observable<AuthResponse> {
    return this.authSuccess$.asObservable();
  }

  onAuthError(): Observable<{ message: string; code?: string }> {
    return this.authError$.asObservable();
  }

  onChannelUpdate(): Observable<Channel[] | { channels: Channel[]; groups?: ChannelGroup[] }> {
    return this.channelUpdate$.asObservable();
  }

  onUserUpdate(): Observable<User[]> {
    return this.userUpdate$.asObservable();
  }

  onChatMessage(): Observable<ChatMessage> {
    return this.chatMessage$.asObservable();
  }

  onChatHistory(): Observable<ChatMessage[]> {
    return this.chatHistory$.asObservable();
  }

  onVoiceJoined(): Observable<{ channelId: string; peers: VoicePeerEvent[]; startedAt?: number | null; sessionId?: string | null }> {
    return this.voiceJoined$.asObservable();
  }

  onVoicePeerJoin(): Observable<VoicePeerEvent> {
    return this.voicePeerJoin$.asObservable();
  }

  onVoicePeerLeave(): Observable<{ id: string }> {
    return this.voicePeerLeave$.asObservable();
  }

  onVoiceSignal(): Observable<{ from: string; data: unknown }> {
    return this.voiceSignal$.asObservable();
  }

  onVoiceState(): Observable<{ id: string; muted: boolean; deafened: boolean }> {
    return this.voiceState$.asObservable();
  }

  // Auth methods
  login(username: string, password: string): Observable<AuthResponse> {
    return new Observable(observer => {
      if (!this.socket) {
        observer.error(new Error('Socket not connected'));
        return;
      }

      const successHandler = (data: AuthResponse) => {
        observer.next(data);
        observer.complete();
      };

      const errorHandler = (error: { message: string; code?: string }) => {
        observer.error(new Error(error.message || 'Login failed'));
      };

      this.socket.once('auth:success', successHandler);
      this.socket.once('auth:error', errorHandler);
      this.socket.emit('auth:login', { username, password });

      return () => {
        this.socket?.off('auth:success', successHandler);
        this.socket?.off('auth:error', errorHandler);
      };
    });
  }

  register(username: string, password: string, displayName?: string): Observable<AuthResponse> {
    return new Observable(observer => {
      if (!this.socket) {
        observer.error(new Error('Socket not connected'));
        return;
      }

      const successHandler = (data: AuthResponse) => {
        observer.next(data);
        observer.complete();
      };

      const errorHandler = (error: { message: string; code?: string }) => {
        observer.error(new Error(error.message || 'Registration failed'));
      };

      this.socket.once('auth:success', successHandler);
      this.socket.once('auth:error', errorHandler);
      
      const payload: any = { username, password };
      if (displayName) {
        payload.profile = { displayName };
      }
      
      this.socket.emit('auth:register', payload);

      return () => {
        this.socket?.off('auth:success', successHandler);
        this.socket?.off('auth:error', errorHandler);
      };
    });
  }

  validateSession(token: string): Observable<{ user: User; account: Account }> {
    return new Observable(observer => {
      if (!this.socket) {
        observer.error(new Error('Socket not connected'));
        return;
      }

      // If already authenticated, don't send duplicate auth request
      if (this.isAuthenticated) {
        console.warn('[SocketService] ⚠️ Already authenticated, skipping session validation');
        observer.error(new Error('Already authenticated'));
        return;
      }

      const successHandler = (data: AuthResponse) => {
        observer.next({ user: data.user, account: data.account });
        observer.complete();
      };

      const errorHandler = (error: { message: string; code?: string }) => {
        // If error is "already authenticated", treat it as success
        if (error.message?.includes('already authenticated')) {
          console.warn('[SocketService] ⚠️ Session already validated');
          observer.error(new Error('Already authenticated'));
        } else {
          observer.error(new Error(error.message || 'Session validation failed'));
        }
      };

      this.socket.once('auth:success', successHandler);
      this.socket.once('auth:error', errorHandler);
      this.socket.emit('auth:session', { token });

      return () => {
        this.socket?.off('auth:success', successHandler);
        this.socket?.off('auth:error', errorHandler);
      };
    });
  }

  logout(): Observable<void> {
    return new Observable(observer => {
      if (!this.socket) {
        observer.complete();
        return;
      }

      this.socket.emit('auth:logout');
      this.isAuthenticated = false;
      observer.complete();
    });
  }

  updateAccount(account: Partial<Account>): Observable<{ account: Account; user?: User }> {
    return new Observable(observer => {
      if (!this.socket) {
        observer.error(new Error('Socket not connected'));
        return;
      }

      const successHandler = (data: { account: Account; user?: User }) => {
        observer.next(data);
        observer.complete();
      };

      const errorHandler = (error: { message: string; code?: string }) => {
        observer.error(new Error(error.message || 'Update failed'));
      };

      this.socket.once('account:updated', successHandler);
      this.socket.once('account:error', errorHandler);
      this.socket.emit('account:update', account);

      return () => {
        this.socket?.off('account:updated', successHandler);
        this.socket?.off('account:error', errorHandler);
      };
    });
  }

  // Channel methods
  joinChannel(channelId: string): void {
    this.socket?.emit('channel:join', channelId);
  }

  createChannel(name: string, type: 'text' | 'voice' | 'stream', groupId?: string): void {
    this.socket?.emit('channels:create', { name, type, groupId });
  }

  deleteChannel(channelId: string): void {
    this.socket?.emit('channels:delete', channelId);
  }

  requestChannelsList(): void {
    this.socket?.emit('channels:list');
  }

  // Chat methods
  sendMessage(message: string): void {
    this.socket?.emit('chat', message);
  }

  deleteMessage(messageId: string): void {
    this.socket?.emit('chat:delete', messageId);
  }

  // Voice methods
  joinVoiceChannel(channelId: string): void {
    this.socket?.emit('voice:join', channelId);
  }

  leaveVoiceChannel(): void {
    this.socket?.emit('voice:leave');
  }

  updateVoiceState(payload: { muted: boolean; deafened: boolean }): void {
    this.socket?.emit('voice:state', payload);
  }

  sendSignal(to: string, data: unknown): void {
    this.socket?.emit('voice:signal', { to, data });
  }

  // Admin methods
  requestAccountList(): void {
    this.socket?.emit('admin:accounts:list');
  }

  updateAccountRoles(accountId: string, roles: string[]): void {
    this.socket?.emit('admin:accounts:updateRoles', { accountId, roles });
  }

  disableAccount(accountId: string, reason?: string): void {
    this.socket?.emit('admin:accounts:disable', { accountId, reason });
  }

  enableAccount(accountId: string): void {
    this.socket?.emit('admin:accounts:enable', { accountId });
  }

  requestChannelPermissions(channelId: string): void {
    this.socket?.emit('admin:channels:getPermissions', { channelId });
  }

  updateChannelPermissions(channelId: string, permissions: ChannelPermissions): void {
    this.socket?.emit('admin:channels:updatePermissions', { channelId, permissions });
  }

  /**
   * Setup socket event listeners
   */
  private setupSocketListeners(): void {
    if (!this.socket) return;

    // Remove all existing listeners to prevent duplicates
    this.socket.removeAllListeners();

    // Connection events
    this.socket.on('connect', () => {
      console.log('[SocketService] ✅ Connected', this.socket?.id);
      this.reconnectAttempts = 0;
      this.connectionStatus$.next({ connected: true, reconnecting: false });
    });

    this.socket.on('disconnect', (reason: string) => {
      console.log('[SocketService] ❌ Disconnected:', reason);
      this.isAuthenticated = false;
      this.connectionStatus$.next({ connected: false, reconnecting: false });
    });

    this.socket.on('connect_error', (error: Error) => {
      console.error('[SocketService] ⚠️ Connection error:', error.message);
      this.reconnectAttempts++;
      this.connectionStatus$.next({ connected: false, reconnecting: true });
    });

    // Auth events
    this.socket.on('auth:success', (data: AuthResponse) => {
      console.log('[SocketService] ✅ Auth success:', data.account.username);
      this.isAuthenticated = true;
      this.authSuccess$.next(data);
    });

    this.socket.on('auth:error', (data: { message: string; code?: string }) => {
      // Don't treat "already authenticated" as an error if we have a session
      if (data.message?.includes('already authenticated')) {
        console.warn('[SocketService] ⚠️ Socket already authenticated, ignoring duplicate auth attempt');
        this.isAuthenticated = true;
        return;
      }
      console.error('[SocketService] ❌ Auth error:', data.message);
      this.isAuthenticated = false;
      this.authError$.next(data);
    });

    // Channel events
    this.socket.on('presence', (users: User[]) => {
      this.userUpdate$.next(users);
    });

    this.socket.on('channels:data', (channels: Channel[]) => {
      this.channelUpdate$.next(channels);
    });

    this.socket.on('channels:update', (data: Channel[] | { channels: Channel[]; groups?: ChannelGroup[] }) => {
      this.channelUpdate$.next(data);
    });

    // Chat events
    this.socket.on('chat', (message: ChatMessage) => {
      this.chatMessage$.next(message);
    });

    this.socket.on('chat:history', (messages: ChatMessage[]) => {
      this.chatHistory$.next(messages);
    });

    // Voice events
    this.socket.on('voice:joined', (data: { channelId: string; peers: VoicePeerEvent[]; startedAt?: number | null; sessionId?: string | null }) => {
      this.voiceJoined$.next(data);
    });

    this.socket.on('voice:peer-join', (data: VoicePeerEvent) => {
      this.voicePeerJoin$.next(data);
    });

    this.socket.on('voice:peer-leave', (data: { id: string }) => {
      this.voicePeerLeave$.next(data);
    });

    this.socket.on('voice:signal', (data: { from: string; data: unknown }) => {
      this.voiceSignal$.next(data);
    });

    this.socket.on('voice:state', (data: { id: string; muted: boolean; deafened: boolean }) => {
      this.voiceState$.next(data);
    });
  }
}
