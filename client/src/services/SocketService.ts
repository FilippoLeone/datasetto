/**
 * Socket.IO service for real-time communication
 */
import { io, Socket } from 'socket.io-client';
import type {
  ChatMessage,
  Channel,
  User,
  EventMap,
  ChannelPermissions,
  Account,
  ChannelGroup,
  SessionInfo,
  VoicePeerEvent,
} from '@/types';
import { EventEmitter } from '@/utils';

export class SocketService extends EventEmitter<EventMap> {
  private socket: Socket | null = null;
  private serverUrl: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

  constructor(serverUrl: string) {
    super();
    this.serverUrl = serverUrl;
  }

  /**
   * Connect to the Socket.IO server
   */
  connect(): void {
    if (this.socket?.connected) {
      console.warn('Already connected');
      return;
    }

    // Add cache-busting timestamp for mobile/cloudflare to bypass cache
    const isMobile = typeof globalThis !== 'undefined' && 
      (globalThis as typeof globalThis & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() === true;
    
    // Detect if we're behind Cloudflare (check for cf-ray header or known patterns)
    const isCloudflare = document.cookie.includes('__cf') || 
      (window as Window & { __CF?: unknown }).__CF !== undefined;
    
    this.socket = io(this.serverUrl, {
      path: '/socket.io/',
      // Start with websocket for Cloudflare to avoid polling issues
      // Fall back to polling if websocket fails
      transports: isCloudflare ? ['websocket', 'polling'] : ['polling', 'websocket'],
      withCredentials: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: this.maxReconnectAttempts,
      timeout: 30000, // Increased for Cloudflare
      autoConnect: true,
      // Cloudflare-friendly options
      upgrade: true,
      forceNew: false,
      // Add cache-busting query parameter for mobile/cloudflare to bypass cache
      query: (isMobile || isCloudflare) ? { _t: Date.now() } : undefined,
    });

    this.setupSocketListeners();
  }

  /**
   * Disconnect from the server
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
   * Join a channel
   */
  joinChannel(channel: string): void {
    this.socket?.emit('channel:join', channel);
  }

  /**
   * Get the current socket identifier
   */
  getId(): string | null {
    return this.socket?.id ?? null;
  }

  /**
   * Send a chat message
   */
  sendMessage(message: string): void {
    this.socket?.emit('chat', message);
  }

  /**
   * Create a new channel
   */
  createChannel(data: { name: string; type?: string; groupId?: string | null } | string): void {
    if (typeof data === 'string') {
      // Legacy support - just name
      this.socket?.emit('channels:create', data);
    } else {
      // New format with type and groupId
      this.socket?.emit('channels:create', data);
    }
  }

  /**
   * Delete a channel
   */
  deleteChannel(name: string): void {
    this.socket?.emit('channels:delete', name);
  }

  /**
   * Request channels list
   */
  requestChannelsList(): void {
    this.socket?.emit('channels:list');
  }

  /**
   * Request the stream key for a specific channel
   */
  requestStreamKey(channelId: string, channelName?: string): void {
    const safeChannelId = channelId.trim();
    if (!safeChannelId) {
      return;
    }

    this.socket?.emit('stream:key:request', {
      channelId: safeChannelId,
      ...(channelName ? { channelName } : {}),
    });
  }

  /**
   * Screenshare helpers
   */
  startScreenshare(channelId: string): void {
    const safeChannelId = channelId?.trim();
    if (!safeChannelId) {
      return;
    }

    this.socket?.emit('screenshare:start', { channelId: safeChannelId });
  }

  stopScreenshare(channelId: string): void {
    const safeChannelId = channelId?.trim();
    if (!safeChannelId) {
      return;
    }

    this.socket?.emit('screenshare:stop', { channelId: safeChannelId });
  }

  joinScreenshareChannel(channelId: string): void {
    const safeChannelId = channelId?.trim();
    if (!safeChannelId) {
      return;
    }

    this.socket?.emit('screenshare:viewer:join', { channelId: safeChannelId });
  }

  leaveScreenshareChannel(channelId: string): void {
    const safeChannelId = channelId?.trim();
    if (!safeChannelId) {
      return;
    }

    this.socket?.emit('screenshare:viewer:leave', { channelId: safeChannelId });
  }

  sendScreenshareSignal(to: string, data: unknown, channelId?: string | null): void {
    const safeTarget = to?.trim();
    if (!safeTarget || !data) {
      return;
    }

    this.socket?.emit('screenshare:signal', {
      to: safeTarget,
      data,
      channelId: channelId ?? null,
    });
  }

  /**
   * Send WebRTC signaling data
   */
  sendSignal(to: string, data: unknown): void {
    this.socket?.emit('voice:signal', { to, data });
  }

  /**
   * Announce voice join
   */
  joinVoiceChannel(channelId: string): void {
    this.socket?.emit('voice:join', channelId);
  }

  leaveVoiceChannel(): void {
    this.socket?.emit('voice:leave');
  }

  updateVoiceState(payload: { muted: boolean; deafened: boolean }): void {
    this.socket?.emit('voice:state', payload);
  }

  /**
   * Update video state (camera/screen share enabled/disabled)
   */
  updateVideoState(payload: { type: 'camera' | 'screen'; enabled: boolean }): void {
    this.socket?.emit('voice:video:state', payload);
  }

  startVoiceMinigame(payload: { type: string }): void {
    this.socket?.emit('voice:game:start', payload);
  }

  joinVoiceMinigame(): void {
    this.socket?.emit('voice:game:join');
  }

  leaveVoiceMinigame(): void {
    this.socket?.emit('voice:game:leave');
  }

  sendVoiceMinigameInput(payload: { vector: { x: number; y: number } }): void {
    const vector = payload?.vector ?? { x: 0, y: 0 };
    const safeVector = {
      x: Number.isFinite(vector.x) ? vector.x : 0,
      y: Number.isFinite(vector.y) ? vector.y : 0,
    };
    this.socket?.emit('voice:game:input', { vector: safeVector });
  }

  endVoiceMinigame(): void {
    this.socket?.emit('voice:game:end');
  }

  /**
   * Register a new account
   */
  register(payload: {
    username: string;
    password: string;
    profile?: {
      displayName?: string;
      email?: string | null;
      bio?: string | null;
      avatarUrl?: string | null;
      metadata?: Record<string, unknown>;
    };
  }): void {
    this.socket?.emit('auth:register', payload);
  }

  /**
   * Login with username & password
   */
  login(payload: { username: string; password: string }): void {
    this.socket?.emit('auth:login', payload);
  }

  /**
   * Resume an existing session by token
   */
  resumeSession(token: string): void {
    this.socket?.emit('auth:session', { token });
  }

  /**
   * Logout current session
   */
  logout(): void {
    this.socket?.emit('auth:logout');
  }

  /**
   * Request current account details
   */
  requestAccount(): void {
    this.socket?.emit('account:get');
  }

  /**
   * Update profile or password
   */
  updateAccount(payload: {
    displayName?: string;
    email?: string | null;
    bio?: string | null;
    avatarUrl?: string | null;
    metadata?: Record<string, unknown>;
    currentPassword?: string;
    newPassword?: string;
  }): void {
    this.socket?.emit('account:update', payload);
  }

  /**
   * Admin: request all accounts
   */
  requestAccountList(): void {
    this.socket?.emit('admin:accounts:list');
  }

  /**
   * Admin: update account roles
   */
  updateAccountRoles(payload: { accountId: string; roles: string[] }): void {
    this.socket?.emit('admin:accounts:updateRoles', payload);
  }

  /**
   * Admin: disable an account
   */
  disableAccount(payload: { accountId: string; reason?: string }): void {
    this.socket?.emit('admin:accounts:disable', payload);
  }

  /**
   * Admin: re-enable an account
   */
  enableAccount(payload: { accountId: string }): void {
    this.socket?.emit('admin:accounts:enable', payload);
  }

  /**
   * Admin: load channel permissions
   */
  requestChannelPermissions(payload: { channelId: string }): void {
    this.socket?.emit('admin:channels:getPermissions', payload);
  }

  /**
   * Admin: update channel permissions
   */
  updateChannelPermissions(payload: { channelId: string; permissions: ChannelPermissions }): void {
    this.socket?.emit('admin:channels:updatePermissions', payload);
  }

  /**
   * Setup socket event listeners
   */
  private setupSocketListeners(): void {
    if (!this.socket) return;

    this.socket.io.on('reconnect_attempt', () => {
      console.log('Reconnecting to server...');
    });

    this.socket.on('connect', () => {
      console.log('Connected to server');
      this.reconnectAttempts = 0;
      this.emit('connection:status', { connected: true, reconnecting: false });
      this.emit('socket:connected', undefined as never);
    });

    this.socket.on('disconnect', (reason: string) => {
      console.log('Disconnected from server:', reason);
      this.emit('connection:status', { connected: false, reconnecting: false });
      this.emit('socket:disconnected', { reason } as never);
    });

    this.socket.on('connect_error', (error: Error) => {
      console.error('Socket connection error:', error.message);
      this.reconnectAttempts++;
      
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        console.error('Max reconnection attempts reached');
        this.emit('error', new Error('Failed to connect to server after multiple attempts'));
        this.emit('connection:failed', undefined as never);
      } else {
        this.emit('connection:status', { connected: false, reconnecting: true });
      }
    });

    this.socket.on('reconnect_attempt', () => {
      console.log('Attempting to reconnect...');
      this.emit('connection:status', { connected: false, reconnecting: true });
    });

    this.socket.on('reconnect', () => {
      console.log('Reconnected to server');
      this.emit('notification', {
        id: `reconnect-${Date.now()}`,
        type: 'success',
        message: 'Reconnected to server',
        duration: 3000,
      });
    });

    // Channel & presence events
    this.socket.on('presence', (users: User[]) => {
      this.emit('user:update', users);
    });

    this.socket.on('channels:data', (channels: Channel[]) => {
      this.emit('channel:update', channels);
    });

    this.socket.on('channels:update', (data: { channels: Channel[]; groups?: unknown[] } | Channel[]) => {
      // Pass the entire data object so App can handle both formats
      if (import.meta.env.DEV) {
        console.log('📡 Socket received channels:update:', data);
      }
      this.emit('channel:update', data);
    });

    this.socket.on('stream:key:response', (payload: {
      channelId: string;
      channelName: string;
      streamKey: string;
      streamKeyChannel?: string;
      streamKeyToken?: string;
    }) => {
      this.emit('stream:key', payload as never);
    });

    this.socket.on('stream:key:error', (payload: { channelId?: string | null; channelName?: string | null; message: string; code?: string }) => {
      this.emit('stream:key:error', payload as never);
    });

    this.socket.on('channels:permissionsUpdated', (data: { channelId: string; permissions: ChannelPermissions }) => {
      this.emit('channel:permissionsUpdated', data as never);
    });

    this.socket.on('screenshare:session', (payload) => {
      this.emit('screenshare:session', payload as never);
    });

    this.socket.on('screenshare:signal', (payload: { from: string; data: unknown; channelId?: string | null }) => {
      this.emit('screenshare:signal', payload as never);
    });

    this.socket.on('screenshare:viewer:pending', (payload: { channelId: string; viewerId: string; viewerName: string }) => {
      this.emit('screenshare:viewer:pending', payload as never);
    });

    this.socket.on('screenshare:error', (payload: { channelId?: string | null; message: string; code?: string }) => {
      this.emit('screenshare:error', payload as never);
    });

    // Auth events
    this.socket.on('auth:success', (data: {
      user: User;
      account: Account;
      session: SessionInfo;
      channels: Channel[];
      groups?: ChannelGroup[];
      isNewAccount?: boolean;
    }) => {
      console.log('✅ Authentication success:', data.account.username);
      this.emit('auth:success', data as never);
    });

    this.socket.on('auth:error', (data: { message: string; code?: string }) => {
      console.error('❌ Authentication error:', data.message, data.code);
      this.emit('auth:error', data as never);
    });

    this.socket.on('auth:loggedOut', () => {
      this.emit('auth:loggedOut', undefined as never);
    });

    // Account events
    this.socket.on('account:updated', (payload: { account: Account; user?: User }) => {
      this.emit('account:updated', payload as never);
    });

    this.socket.on('account:data', (payload: { account: Account; user?: User }) => {
      this.emit('account:data', payload as never);
    });

    this.socket.on('account:rolesUpdated', (payload: { account: Account; user?: User }) => {
      this.emit('account:rolesUpdated', payload as never);
    });

    this.socket.on('account:error', (data: { message: string; code?: string }) => {
      this.emit('account:error', data as never);
    });

    // Admin events
    this.socket.on('admin:accounts:list', (data: { accounts: Account[] }) => {
      this.emit('admin:accounts:list', data as never);
    });

    this.socket.on('admin:accounts:rolesUpdated', (data: { account: Account }) => {
      this.emit('admin:accounts:rolesUpdated', data as never);
    });

    this.socket.on('admin:accounts:disabled', (data: { account: Account }) => {
      this.emit('admin:accounts:disabled', data as never);
    });

    this.socket.on('admin:accounts:enabled', (data: { account: Account }) => {
      this.emit('admin:accounts:enabled', data as never);
    });

    this.socket.on('admin:channels:permissions', (data: { channelId: string; permissions: ChannelPermissions }) => {
      this.emit('admin:channels:permissions', data as never);
    });

    this.socket.on('admin:channels:permissionsUpdated', (data: { channelId: string; permissions: ChannelPermissions }) => {
      this.emit('admin:channels:permissionsUpdated', data as never);
    });

    this.socket.on('admin:error', (data: { message: string; code?: string }) => {
      this.emit('admin:error', data as never);
    });

    // Chat events
    this.socket.on('chat', (message: ChatMessage) => {
      this.emit('chat:message', message);
    });

    this.socket.on('chat:history', (messages: ChatMessage[]) => {
      this.emit('chat:history', messages);
    });

    this.socket.on('voice:joined', (data: { channelId: string; peers: VoicePeerEvent[]; startedAt?: number | null; sessionId?: string | null }) => {
      this.emit('voice:joined' as keyof EventMap, data as never);
    });

    // WebRTC signaling events - forward to VoiceService
    this.socket.on('voice:peer-join', (data: VoicePeerEvent) => {
      this.emit('voice:peer-join' as keyof EventMap, data as never);
    });

    this.socket.on('voice:peer-leave', (data: { id: string }) => {
      this.emit('voice:peer-leave' as keyof EventMap, data as never);
    });

    this.socket.on('voice:signal', (data: { from: string; data: unknown }) => {
      this.emit('voice:signal' as keyof EventMap, data as never);
    });

    this.socket.on('voice:state', (data: { id: string; muted: boolean; deafened: boolean }) => {
      this.emit('voice:state' as keyof EventMap, data as never);
    });

    // Video call state events
    this.socket.on('voice:video:state', (data: { id: string; type: 'camera' | 'screen'; enabled: boolean }) => {
      this.emit('voice:video:state' as keyof EventMap, data as never);
    });

    this.socket.on('voice:game:state', (data) => {
      this.emit('voice:game:state' as keyof EventMap, data as never);
    });

    this.socket.on('voice:game:update', (data) => {
      this.emit('voice:game:update' as keyof EventMap, data as never);
    });

    this.socket.on('voice:game:started', (data) => {
      this.emit('voice:game:started' as keyof EventMap, data as never);
    });

    this.socket.on('voice:game:ended', (data) => {
      this.emit('voice:game:ended' as keyof EventMap, data as never);
    });

    this.socket.on('voice:game:error', (data) => {
      this.emit('voice:game:error' as keyof EventMap, data as never);
    });
  }
}
