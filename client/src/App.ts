/**
 * Main Application Controller
 * Coordinates all services and manages application lifecycle
 */
import { SocketService, AudioService, VoiceService, PlayerService, AudioNotificationService } from '@/services';
import { VoicePanelController } from '@/ui/VoicePanelController';
import { StateManager, AnimationController, hasPermission } from '@/utils';
import { NotificationManager } from '@/components/NotificationManager';
import { AuthController, type AuthStateSnapshot } from '@/controllers/AuthController';
import { AdminController } from '@/controllers/AdminController';
import { VideoController } from '@/controllers/VideoController';
import { VoiceController } from '@/controllers/VoiceController';
import { ChatController } from '@/controllers/ChatController';
import { ChannelController } from '@/controllers/ChannelController';
import { SettingsController } from '@/controllers/SettingsController';
import { UserListController } from '@/controllers/UserListController';
import { NavigationController } from '@/controllers/NavigationController';
import type {
  Channel,
  RolePermissions,
  ChannelGroup,
} from '@/types';
import { validateEnv, resolveRuntimeConfig } from '@/utils';

const RUNTIME_CONFIG = validateEnv(resolveRuntimeConfig());

const SERVER_URL = RUNTIME_CONFIG.serverUrl;
const HLS_BASE_URL = RUNTIME_CONFIG.hlsBaseUrl;
const API_BASE_URL = RUNTIME_CONFIG.apiBaseUrl;

export class App {
  // Services
  private socket: SocketService;
  private audio: AudioService;
  private voice: VoiceService;
  private player: PlayerService;
  private voicePanel: VoicePanelController;
  private state: StateManager;
  private notifications: NotificationManager;
  private soundFX: AudioNotificationService;
  private animator: AnimationController;

  // DOM Elements
  private elements: Record<string, HTMLElement> = {};

  // State
  private hasManagementAccess = false;
  private isAuthenticated = false;
  private rolePermissions: RolePermissions | null = null;
  private authController: AuthController | null = null;
  private adminController: AdminController | null = null;
  private videoController: VideoController | null = null;
  private voiceController: VoiceController | null = null;
  private chatController: ChatController | null = null;
  private channelController: ChannelController | null = null;
  private settingsController: SettingsController | null = null;
  private userListController: UserListController | null = null;
  private navigationController: NavigationController | null = null;

  // Cleanup tracking
  private eventListeners: Array<{
    element: EventTarget;
    event: string;
    handler: EventListenerOrEventListenerObject;
  }> = [];
  private cleanupCallbacks: Array<() => void> = [];

  constructor() {
    validateEnv();

    // Initialize state and notifications
    this.state = new StateManager();
    this.notifications = new NotificationManager();
    this.soundFX = new AudioNotificationService();
    this.animator = new AnimationController();

    // Initialize services
    this.socket = new SocketService(SERVER_URL);
    this.audio = new AudioService(this.state.get('settings'));
    this.voice = new VoiceService();

    // Cache DOM elements
    this.cacheElements();

    this.voicePanel = new VoicePanelController({
      panel: this.elements['voice-users-panel'],
      list: this.elements['voice-users-list'],
      count: this.elements['voice-user-count'],
      timer: this.elements['voice-session-timer'],
    });

    // Initialize player
    const videoEl = this.elements.video as HTMLVideoElement;
    const overlayEl = this.elements.playerOverlay;
    this.player = new PlayerService(videoEl, HLS_BASE_URL, overlayEl);

    this.initializeVideoController();
    this.initializeUserListController();
    this.initializeVoiceController();
    this.initializeChatController();
    this.initializeChannelController();
    this.initializeSettingsController();
    this.initializeNavigationController();
    this.initializeAdminController();
    this.initializeAuthController();

    // Setup event listeners and services
    this.setupEventListeners();
    this.setupResponsiveObservers();
    this.setupServiceEventHandlers();

    // Initialize application
    this.initialize();
  }

  private initializeAdminController(): void {
    this.adminController = new AdminController({
      elements: this.elements,
      state: this.state,
      socket: this.socket,
      notifications: this.notifications,
      soundFX: this.soundFX,
      animator: this.animator,
      addListener: (element, event, handler, options) => this.addTrackedListener(element, event, handler, options),
      registerCleanup: (cleanup) => this.cleanupCallbacks.push(cleanup),
    });

    this.adminController.initialize();
    this.adminController.updateAccessState({
      hasManagementAccess: this.hasManagementAccess,
      rolePermissions: this.rolePermissions,
    });
  }

  private initializeVideoController(): void {
    this.videoController = new VideoController({
      elements: this.elements,
      state: this.state,
      player: this.player,
      notifications: this.notifications,
      soundFX: this.soundFX,
      hlsBaseUrl: HLS_BASE_URL,
      addListener: (element, event, handler, options) => this.addTrackedListener(element, event, handler, options),
      registerCleanup: (cleanup) => this.cleanupCallbacks.push(cleanup),
      refreshChannels: () => {
        const channels = this.state.get('channels');
        this.channelController?.handleChannelsUpdate(channels);
      },
    });

    this.videoController.initialize();
  }

  private initializeVoiceController(): void {
    this.voiceController = new VoiceController({
      elements: this.elements,
      state: this.state,
      socket: this.socket,
      audio: this.audio,
      voice: this.voice,
      notifications: this.notifications,
      soundFX: this.soundFX,
      voicePanel: this.voicePanel,
      registerCleanup: (cleanup) => this.cleanupCallbacks.push(cleanup),
      refreshChannels: () => {
        const channels = this.state.get('channels');
        this.channelController?.handleChannelsUpdate(channels);
      },
      updateStreamIndicator: () => this.updateStreamIndicator(),
      resolveUserLabel: (label, fallback) => this.userListController?.resolveUserLabel(label, fallback) || 'Unknown User',
    });

    this.voiceController.initialize();
  }

  private initializeChatController(): void {
    this.chatController = new ChatController({
      elements: this.elements,
      socket: this.socket,
      soundFX: this.soundFX,
      animator: this.animator,
      registerCleanup: (cleanup) => this.cleanupCallbacks.push(cleanup),
    });

    this.chatController.initialize();
  }

  private initializeChannelController(): void {
    this.channelController = new ChannelController({
      elements: this.elements,
      socket: this.socket,
      state: this.state,
      animator: this.animator,
      soundFX: this.soundFX,
      notifications: this.notifications,
      registerCleanup: (cleanup) => this.cleanupCallbacks.push(cleanup),
      isAuthenticated: () => this.isAuthenticated,
      hasPermission: (permissions, permission) => hasPermission(permissions as RolePermissions, permission as keyof RolePermissions),
      rolePermissions: this.rolePermissions,
    });
  }

  private initializeSettingsController(): void {
    this.settingsController = new SettingsController({
      elements: this.elements,
      state: this.state,
      audio: this.audio,
      animator: this.animator,
      soundFX: this.soundFX,
      notifications: this.notifications,
      registerCleanup: (cleanup) => this.cleanupCallbacks.push(cleanup),
      voiceSetOutputVolume: (volume) => this.voice.setOutputVolume(volume),
    });

    this.settingsController.initialize();
  }

  private initializeUserListController(): void {
    this.userListController = new UserListController({
      elements: this.elements,
      state: this.state,
      adminControllerHandlePresenceUpdate: () => this.adminController?.handlePresenceUpdate(),
    });

    this.userListController.initialize();
  }

  private initializeNavigationController(): void {
    this.navigationController = new NavigationController({
      elements: this.elements,
      animator: this.animator,
      soundFX: this.soundFX,
      addListener: (element, event, handler, options) => this.addTrackedListener(element, event, handler, options),
      socketJoinChannel: (channelId) => this.socket.joinChannel(channelId),
      stateSetChannelWithType: (channelId, type) => this.state.setChannelWithType(channelId, type),
      stateGetVoiceConnected: () => this.state.get('voiceConnected'),
      chatHideChatUI: () => this.chatController?.hideChatUI(),
      chatShowChatUI: () => this.chatController?.showChatUI(),
      chatClearMessages: () => this.chatController?.clearMessages(),
      videoHandleMobileChannelSwitch: (type) => this.videoController?.handleMobileChannelSwitch(type),
      videoHandleTextChannelSelected: (params) => this.videoController?.handleTextChannelSelected(params),
      videoHandleVoiceChannelSelected: () => this.videoController?.handleVoiceChannelSelected(),
      videoHandleStreamChannelSelected: (channelName) => this.videoController?.handleStreamChannelSelected(channelName),
    });

    this.navigationController.initialize();
  }

  private initializeAuthController(): void {
    this.authController = new AuthController({
      elements: this.elements,
      state: this.state,
      socket: this.socket,
      notifications: this.notifications,
      soundFX: this.soundFX,
      animator: this.animator,
      addListener: (element, event, handler, options) => this.addTrackedListener(element, event, handler, options),
      registerCleanup: (cleanup) => this.cleanupCallbacks.push(cleanup),
      onStateChange: (snapshot) => this.handleAuthStateChange(snapshot),
      onSessionInvalidated: () => this.handleAuthSessionInvalidated(),
      onChannelBootstrap: (channels, groups) => this.handleAuthChannelBootstrap(channels, groups),
    });

    this.authController.initialize();
    this.handleAuthStateChange(this.authController.getSnapshot());
  }

  private handleAuthStateChange(snapshot: AuthStateSnapshot): void {
    this.isAuthenticated = snapshot.isAuthenticated;
    this.hasManagementAccess = snapshot.hasManagementAccess;
    this.rolePermissions = snapshot.rolePermissions;

    this.adminController?.updateAccessState({
      hasManagementAccess: this.hasManagementAccess,
      rolePermissions: this.rolePermissions,
    });
  }

  private handleAuthSessionInvalidated(): void {
    this.voiceController?.handleAuthSessionInvalidated();
  }

  private handleAuthChannelBootstrap(channels: Channel[], groups?: ChannelGroup[]): void {
    if (Array.isArray(channels) && channels.length > 0) {
      this.channelController?.handleChannelsUpdate(channels);
    }

    if (Array.isArray(groups) && groups.length > 0) {
      this.state.setChannelGroups(groups);
    }
  }

  /**
   * Cache commonly used DOM elements
   */
  private cacheElements(): void {
    const ids = [
      'channel', 'join', 'video', 'micSelect', 'spkSelect',
  'mute', 'deafen', 'msgs', 'chatForm', 'chat-input-container', 'chatInput', 'accName',
      'regModal', 'regUsername', 'regPassword', 'regConfirm',
  'passwordStrength', 'passwordStrengthFill', 'passwordStrengthLabel',
      'registerBtn', 'regCancel', 'regError', 'echoCancel', 'noiseSuppression',
      'autoGain', 'micGain', 'outputVol', 'pttEnable', 'pttKey', 'pttSetKey',
      'micLevel', 'micGainVal', 'outputVolVal', 'testMicBtn', 'presenceList',
      'playerOverlay', 'toggleSidebar', 'channelsList',
      'connectionStatus', 'app',
      'video-popout', 'video-popout-header', 'toggle-video-popout',
      'minimize-video', 'close-video', 'toggle-members',
      'user-settings-btn', 'current-channel-name',
      'user-avatar', 'user-status-text', 'voice-status-panel',
      'connected-voice-channel', 'disconnect-voice',
  'voice-users-panel', 'voice-users-list', 'voice-user-count', 'voice-session-timer',
      'text-channels', 'stream-channels', 'member-count',
      'create-text-channel', 'create-voice-channel', 'create-stream-channel',
      'createChannelModal', 'newChannelName', 'newChannelType',
      'createChannelBtn', 'createChannelCancel', 'createChannelError',
      'streamInfoModal', 'streamKeyDisplay', 'streamChannelName',
      'streamServerUrl', 'streamInfoCancel', 'streamInfoClose',
      'regTitle',
      'emojiPickerBtn', 'emojiPicker', 'emojiGrid',
      'inlineVideoContainer', 'inlineVideo', 'inlinePlayerOverlay',
  'popoutVideo', 'theaterModeToggle', 'mobileStreamTitle', 'popinVideo',
      'playPauseBtn', 'volumeBtn', 'volumeSlider', 'volumeIcon',
      'fullscreenBtn', 'toggleChatBtn', 'videoControlsBar',
      'audioSettingsModal', 'audioSettingsCancel', 'audioSettingsSave',
      'superuser-menu-btn', 'superuser-menu',
      'superuser-manage-users', 'superuser-manage-channels',
      'superuserModal', 'superuserModalClose',
      'superuserTabUsers', 'superuserTabChannels',
      'superuserUsersPanel', 'superuserChannelsPanel',
      'superuserUsersList', 'superuserChannelsList',
      'authTabLogin', 'authTabRegister', 'authTabProfile',
      'regDisplayName', 'regEmail', 'regBio',
      'regCurrentPassword', 'regNewPassword', 'regNewPasswordConfirm',
      'logoutBtn',
    ];

    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) {
        this.elements[id] = el;
      }
    }

    // Cache members list separately (has class not id)
    const membersList = document.querySelector('.members-list');
    if (membersList) {
      this.elements['members-list'] = membersList as HTMLElement;
    }
  }

  private addTrackedListener(
    element: EventTarget | null | undefined,
    event: string,
    handler: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void {
    if (!element) return;

    element.addEventListener(event, handler, options);
    this.eventListeners.push({ element, event, handler });
  }

  /**
   * Initialize the application
   */
  private async initialize(): Promise<void> {
    try {
      // Check backend availability
      await this.checkBackendHealth();

      // Load audio devices
      await this.settingsController?.loadDevices();

      // Connect to server and attempt session resume if available
      const session = this.state.get('session');

      this.socket.connect();

      // Ensure chat is hidden if we're in a voice channel
      const currentChannelType = this.state.get('currentChannelType');
      if (currentChannelType === 'voice') {
        this.chatController?.hideChatUI();
      }

      const storedAccount = this.state.get('account');
      if (!session?.token) {
        if (storedAccount) {
          this.authController?.showAuthModal('login');
          this.notifications.info('Session expired. Please log in to continue.');
        } else {
          this.authController?.showAuthModal('register');
          this.notifications.info('Welcome! Create an account to get started.');
        }
      }
    } catch (error) {
      console.error('Error initializing app:', error);
      this.soundFX.play('error', 0.5);
      this.notifications.error('Failed to initialize application');
    }
  }

  /**
   * Setup all event listeners
   */
  private setupEventListeners(): void {
    // Join channel
    this.addTrackedListener(this.elements.join, 'click', () => this.channelController?.handleJoinChannel());

    // Chat
    this.addTrackedListener(this.elements.chatForm, 'submit', (e) => {
      (e as Event).preventDefault();
      if (!this.isAuthenticated) {
        this.notifications.warning('Please log in to send messages');
        this.authController?.showAuthModal('login');
        return;
      }
      const input = this.elements.chatInput as HTMLInputElement;
      const message = input?.value?.trim();
      if (message) {
        this.chatController?.sendMessage(message);
        input.value = '';
      }
    });

    // Voice controls
  this.addTrackedListener(this.elements.mute, 'click', () => { void this.voiceController?.toggleMute(); });
  this.addTrackedListener(this.elements.deafen, 'click', () => { void this.voiceController?.toggleDeafen(); });
  this.addTrackedListener(this.elements['disconnect-voice'], 'click', () => { void this.voiceController?.disconnect({ playSound: true }); });

    // Gear icon -> Audio Settings
    const settingsBtn = document.getElementById('user-settings-btn');
    if (settingsBtn) {
      this.addTrackedListener(settingsBtn, 'click', (e) => {
        if (import.meta.env.DEV) {
          console.log('⚙️ Audio settings button clicked!');
        }
        (e as Event).stopPropagation();
        void this.settingsController?.showAudioSettingsModal();
      });
    } else if (import.meta.env.DEV) {
      console.error('❌ user-settings-btn element not found in DOM!');
    }
    
    // Avatar/Profile -> User Settings
    // Audio Settings Modal
    this.addTrackedListener(this.elements.audioSettingsCancel, 'click', () => this.settingsController?.hideAudioSettingsModal());
    this.addTrackedListener(this.elements.audioSettingsSave, 'click', () => this.settingsController?.saveAudioSettings());

    // Device selection
    this.addTrackedListener(this.elements.micSelect, 'change', () => { void this.settingsController?.handleMicChange(); });

    // Mic test (if element exists)
    this.addTrackedListener(this.elements.testMicBtn, 'click', () => { void this.settingsController?.handleTestMicToggle(); });

    // Push-to-talk
  this.addTrackedListener(this.elements.pttSetKey, 'click', () => this.settingsController?.handlePttSetKey());
  this.addTrackedListener(window, 'keydown', (e) => { void this.handleKeyDown(e as KeyboardEvent); });
  this.addTrackedListener(window, 'keyup', (e) => { void this.handleKeyUp(e as KeyboardEvent); });

    // Sidebar toggle
  this.addTrackedListener(this.elements.toggleSidebar, 'click', () => this.toggleSidebar());
  this.addTrackedListener(this.elements['toggle-members'], 'click', () => this.toggleMembersPanel());

    // Channel creation
    this.addTrackedListener(this.elements['create-text-channel'], 'click', () => this.channelController?.showCreateChannelModal('text'));
    this.addTrackedListener(this.elements['create-voice-channel'], 'click', () => this.channelController?.showCreateChannelModal('voice'));
    this.addTrackedListener(this.elements['create-stream-channel'], 'click', () => this.channelController?.showCreateChannelModal('stream'));
    this.addTrackedListener(this.elements['createChannelBtn'], 'click', () => this.channelController?.handleCreateChannel());
    this.addTrackedListener(this.elements['createChannelCancel'], 'click', () => this.channelController?.hideCreateChannelModal());

    // Emoji picker
    this.addTrackedListener(this.elements.emojiPickerBtn, 'click', (e) => {
      (e as Event).stopPropagation();
      this.chatController?.toggleEmojiPicker();
    });
    
    // Close emoji picker when clicking outside
    const emojiClickHandler = (e: Event) => {
      const target = e.target as HTMLElement;
      if (this.elements.emojiPicker && 
          !this.elements.emojiPicker.contains(target) && 
          target !== this.elements.emojiPickerBtn) {
        this.chatController?.hideEmojiPicker();
      }
    };
    this.addTrackedListener(document, 'click', emojiClickHandler);
  }
  /**
   * Setup service event handlers
   */
  private setupServiceEventHandlers(): void {
    // Note: Socket event listeners are only set up once during initialization
    // The socket service handles reconnection internally without re-adding listeners
    
    // Socket events
    this.socket.on('user:update', (users) => this.userListController?.handleUsersUpdate(users));
    this.socket.on('channel:update', (channels) => {
      this.channelController?.handleChannelsUpdate(channels);
      this.voiceController?.handleChannelsUpdate(Array.isArray(channels) ? channels : channels.channels);
      this.adminController?.handleChannelsUpdate(Array.isArray(channels) ? channels : channels.channels);
    });
    this.socket.on('chat:message', (message) => this.chatController?.handleChatMessage(message));
    this.socket.on('chat:history', (messages) => this.chatController?.handleChatHistory(messages));
    this.socket.on('connection:status', ({ connected, reconnecting }) => {
      this.voiceController?.handleConnectionStatusChange({ connected, reconnecting });
      this.state.setConnected(connected);
      this.updateConnectionStatus(connected, reconnecting);
    });
    this.socket.on('notification', (notif) => {
      this.notifications.show(notif.message, notif.type, notif.duration);
      // Check if this is a superuser promotion notification
      if (notif.message?.includes('promoted to Superuser')) {
        this.hasManagementAccess = true;
        if (import.meta.env.DEV) {
          console.log('✅ User promoted to superuser');
        }
        this.adminController?.updateAccessState({
          hasManagementAccess: this.hasManagementAccess,
          rolePermissions: this.rolePermissions,
        });
        // Refresh channel list to show stream key buttons
        setTimeout(() => this.socket.requestChannelsList(), 500);
      }
    });
    this.socket.on('error', (error) => {
      const details = error as { message?: string; code?: string };
      this.soundFX.play('error', 0.5);
      if (details?.message) {
        this.notifications.error(details.message);
      }

      if (details?.code) {
        this.voiceController?.handleServerError(details.code);
      }
    });

    // WebRTC signaling - delegated to VoiceController
    // (VoiceController sets up its own event listeners for voice events)

    // Audio events - delegated to VoiceController
    this.audio.on('mic:level', (level: unknown) => {
      this.voiceController?.handleMicLevel(level as number);
    });
  }

  /**
   * Setup settings change listeners
   */
  /**
   * Handle send chat message
   */

  /**
   * Handle key down
   */
  private async handleKeyDown(e: KeyboardEvent): Promise<void> {
    if (e.code === 'Escape') {
      const app = this.elements.app;
      if (app && (app.classList.contains('sidebar-open') || app.classList.contains('members-open'))) {
        e.preventDefault();
        app.classList.remove('sidebar-open', 'members-open');
        return;
      }

      if (this.adminController?.handleEscape()) {
        e.preventDefault();
        return;
      }
    }

    // Check if SettingsController is capturing a key for PTT binding
    if (this.settingsController?.capturePttKey(e)) {
      return;
    }

    // Video player keyboard shortcuts (only when not typing in input)
    const target = e.target as HTMLElement;
    const isTyping = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || 
                     target.isContentEditable || target.closest('[contenteditable="true"]');
    
    if (!isTyping) {
      this.videoController?.handlePlaybackShortcut(e);
    }

    // Handle PTT via VoiceController
    await this.voiceController?.handleKeyDown(e);
  }

  /**
   * Handle key up
   */
  private async handleKeyUp(e: KeyboardEvent): Promise<void> {
    // Handle PTT via VoiceController
    await this.voiceController?.handleKeyUp(e);
  }



  /**
   * Handle users update
   */
  // UI Update Methods

  private updateStreamIndicator(): void {
    this.videoController?.updateStreamWatchingIndicator();
  }

  private updateConnectionStatus(connected: boolean, reconnecting: boolean): void {
    const statusEl = this.elements.connectionStatus;
    if (!statusEl) return;

    statusEl.classList.toggle('connected', connected);
    statusEl.classList.toggle('reconnecting', reconnecting);

    const text = statusEl.querySelector('.text');
    
    if (text) {
      if (reconnecting) {
        text.textContent = 'Reconnecting...';
      } else if (connected) {
        text.textContent = 'Connected';
      } else {
        text.textContent = 'Disconnected';
      }
    }
  }



  private toggleSidebar(): void {
    const app = this.elements.app;
    if (!app) return;

    if (this.isMobileLayout()) {
      return;
    }

    if (window.matchMedia('(max-width: 1024px)').matches) {
      this.soundFX.play('click', 0.4);
      app.classList.toggle('sidebar-open');
      if (app.classList.contains('sidebar-open')) {
        app.classList.remove('members-open');
      }
    }
  }

  private toggleMembersPanel(): void {
    const app = this.elements.app;
    if (!app) return;

    if (this.isMobileLayout()) {
      return;
    }

    if (window.matchMedia('(max-width: 1024px)').matches) {
      this.soundFX.play('click', 0.4);
      app.classList.toggle('members-open');
      if (app.classList.contains('members-open')) {
        app.classList.remove('sidebar-open');
      }
    }
  }

  private setupResponsiveObservers(): void {
    const app = this.elements.app;
    if (!app) return;

    const breakpoint = window.matchMedia('(max-width: 1024px)');
    const resetPanels = (): void => {
      if (!breakpoint.matches) {
        app.classList.remove('sidebar-open', 'members-open');
      }
    };

    resetPanels();

    const handleChange = (event: MediaQueryListEvent): void => {
      if (!event.matches) {
        app.classList.remove('sidebar-open', 'members-open');
      }
    };

    breakpoint.addEventListener('change', handleChange);
    this.cleanupCallbacks.push(() => breakpoint.removeEventListener('change', handleChange));

    const mobileBreakpoint = window.matchMedia('(max-width: 768px)');
    const handleMobileChange = (event: MediaQueryListEvent): void => {
      this.videoController?.handleMobileBreakpointChange(event);
    };

    mobileBreakpoint.addEventListener('change', handleMobileChange);
    this.cleanupCallbacks.push(() => mobileBreakpoint.removeEventListener('change', handleMobileChange));
  }

  private isMobileLayout(): boolean {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  /**
   * Check backend health and update connection status
   */
  private async checkBackendHealth(): Promise<void> {
    try {
      const response = await fetch(`${API_BASE_URL}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      
      if (response.ok) {
        const data = await response.json();
        console.log('✅ Backend health check passed:', data);
      } else {
        console.warn('⚠️ Backend health check failed:', response.status);
      }
    } catch (error) {
      // Silently fail - backend might not be ready yet or CORS not configured
      console.warn('⚠️ Backend health check failed:', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  /**
   * Check if a stream is live
   */


  /**
   * Cleanup all resources and event listeners
   * Call this before page unload or component unmount
   */
  public cleanup(): void {
    if (import.meta.env.DEV) {
      console.log('🧹 Cleaning up App resources...');
    }

    this.videoController?.closeInlineVideo();
    this.videoController?.closePopout();

    // Remove all tracked event listeners
    for (const { element, event, handler } of this.eventListeners) {
      try {
        element.removeEventListener(event, handler);
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error('Error removing event listener:', error);
        }
      }
    }
    this.eventListeners = [];

    // Run all cleanup callbacks
    for (const callback of this.cleanupCallbacks) {
      try {
        callback();
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error('Error in cleanup callback:', error);
        }
      }
    }
    this.cleanupCallbacks = [];

    // Cleanup services (services will implement their own cleanup if needed)
    try {
      // Disconnect socket
      this.socket?.disconnect?.();
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error('Error cleaning up services:', error);
      }
    }

    if (import.meta.env.DEV) {
      console.log('✅ App cleanup complete');
    }
  }
}
