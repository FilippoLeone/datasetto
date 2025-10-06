/**
 * Main Application Controller
 * Coordinates all services and manages application lifecycle
 */
import { SocketService, AudioService, VoiceService, PlayerService, AudioNotificationService } from '@/services';
import { VoicePanelController, getAvatarColor, type VoicePanelEntry } from '@/ui/VoicePanelController';
import { StateManager, AnimationController, mergeRolePermissions, hasPermission } from '@/utils';
import { generateIdenticonSvg } from '@/utils/avatarGenerator';
import { NotificationManager } from '@/components/NotificationManager';
import type {
  ChatMessage,
  User,
  Channel,
  Account,
  SessionInfo,
  RoleName,
  RolePermissions,
  ChannelGroup,
  VoicePeerEvent,
} from '@/types';
import { formatTime, validateEnv, resolveRuntimeConfig } from '@/utils';

const RUNTIME_CONFIG = validateEnv(resolveRuntimeConfig());

const SERVER_URL = RUNTIME_CONFIG.serverUrl;
const HLS_BASE_URL = RUNTIME_CONFIG.hlsBaseUrl;
const API_BASE_URL = RUNTIME_CONFIG.apiBaseUrl;
const RTMP_SERVER_URL = import.meta.env.VITE_RTMP_SERVER_URL || 'rtmp://127.0.0.1:1935/hls';

const LOCAL_SPEAKING_THRESHOLD = 0.08;
const LOCAL_SPEAKING_RELEASE_MS = 300;

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
  private pttActive = false;
  private captureNextKey = false;
  private inlineHls: any = null; // HLS instance for inline video
  private streamRetryTimer: number | null = null;
  private isSuperuser = false;
  private hasManagementAccess = false;
  private isAuthenticated = false;
  private currentRoles: RoleName[] = [];
  private rolePermissions: RolePermissions | null = null;
  private authMode: 'login' | 'register' | 'profile' = 'register';
  private sessionResumePending = false;
  private authSubmitting = false;
  private voiceUsers: Map<string, { id: string; name: string; muted?: boolean; deafened?: boolean; speaking?: boolean }> = new Map();
  private pendingVoiceJoin: { id: string; name: string } | null = null;
  private isDragging = false;
  private dragOffset = { x: 0, y: 0 };
  private isMinimized = false;
  private superuserMenuVisible = false;
  private activeSuperuserTab: 'users' | 'channels' = 'users';
  private loadingAccounts = false;
  private localSpeaking = false;
  private localSpeakingLastPeak = 0;
  private voiceSessionStart: number | null = null;
  private voiceSessionId: string | null = null;
  private voiceSessionTimerHandle: number | null = null;
  private voiceChannelTimerHandle: number | null = null;
  private wasMutedBeforeDeafen: boolean | null = null;
  private mobileStreamMode = false;

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

    // Setup event listeners and services
    this.setupEventListeners();
    this.setupResponsiveObservers();
    this.setupServiceEventHandlers();

    // Initialize application
    this.initialize();
  }

  /**
   * Cache commonly used DOM elements
   */
  private cacheElements(): void {
    const ids = [
      'channel', 'join', 'video', 'micSelect', 'spkSelect',
      'mute', 'deafen', 'msgs', 'chatForm', 'chatInput', 'accName',
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
      
      // Update UI with current state
      this.updateSettingsUI();

      // Load devices
      await this.loadDevices();

      // Reset auth-dependent UI until authentication succeeds
      this.applyPermissions(null);
      this.updateAccountUI();

      // Connect to server and attempt session resume if available
      const session = this.state.get('session');
      if (session?.token) {
        this.sessionResumePending = true;
      }

      this.socket.connect();

      // Ensure chat is hidden if we're in a voice channel
      const currentChannelType = this.state.get('currentChannelType');
      if (currentChannelType === 'voice') {
        this.hideChatUI();
      }

      const storedAccount = this.state.get('account');
      if (!session?.token) {
        if (storedAccount) {
          this.showAuthModal('login');
          this.notifications.info('Session expired. Please log in to continue.');
        } else {
          this.showAuthModal('register');
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
    this.addTrackedListener(this.elements.join, 'click', () => this.handleJoinChannel());

    // Chat
    this.addTrackedListener(this.elements.chatForm, 'submit', (e) => {
      (e as Event).preventDefault();
      this.handleSendMessage();
    });

    // Voice controls
  this.addTrackedListener(this.elements.mute, 'click', () => { void this.handleToggleMute(); });
  this.addTrackedListener(this.elements.deafen, 'click', () => { void this.handleToggleDeafen(); });
  this.addTrackedListener(this.elements['disconnect-voice'], 'click', () => this.handleVoiceDisconnect());

    // Account & Settings
  this.addTrackedListener(this.elements.registerBtn, 'click', () => this.handleAuthSubmit());
  this.addTrackedListener(this.elements.regCancel, 'click', () => this.hideAuthModal());
  this.addTrackedListener(this.elements.logoutBtn, 'click', () => this.handleLogout());

    const passwordInput = this.elements.regPassword as HTMLInputElement | undefined;
    if (passwordInput) {
      this.addTrackedListener(passwordInput, 'input', (event) => {
        const target = event.target as HTMLInputElement;
        this.updatePasswordStrength(target.value);
      });
      this.updatePasswordStrength(passwordInput.value ?? '');
    }

    const authTabLogin = document.getElementById('authTabLogin');
    if (authTabLogin) {
      this.addTrackedListener(authTabLogin, 'click', () => this.setAuthMode('login'));
    }

    const authTabRegister = document.getElementById('authTabRegister');
    if (authTabRegister) {
      this.addTrackedListener(authTabRegister, 'click', () => this.setAuthMode('register'));
    }

    const authTabProfile = document.getElementById('authTabProfile');
    if (authTabProfile) {
      this.addTrackedListener(authTabProfile, 'click', () => this.setAuthMode('profile'));
    }
    
    // Gear icon -> Audio Settings
    const settingsBtn = document.getElementById('user-settings-btn');
    if (settingsBtn) {
      this.addTrackedListener(settingsBtn, 'click', (e) => {
        if (import.meta.env.DEV) {
          console.log('⚙️ Audio settings button clicked!');
        }
        (e as Event).stopPropagation();
        this.showAudioSettingsModal();
      });
    } else if (import.meta.env.DEV) {
      console.error('❌ user-settings-btn element not found in DOM!');
    }
    
    // Avatar/Profile -> User Settings
    const userAvatar = document.getElementById('user-avatar');
    const userInfo = document.querySelector('.user-info');
    
    this.addTrackedListener(userAvatar, 'click', () => {
      if (import.meta.env.DEV) {
        console.log('👤 User avatar clicked!');
      }
      this.showAuthModal(this.isAuthenticated ? 'profile' : 'register');
    });
    
    this.addTrackedListener(userInfo, 'click', () => {
      if (import.meta.env.DEV) {
        console.log('ℹ️ User info clicked!');
      }
      this.showAuthModal(this.isAuthenticated ? 'profile' : 'register');
    });

    const superuserMenuBtn = this.elements['superuser-menu-btn'] as HTMLButtonElement | undefined;
    if (superuserMenuBtn) {
      this.addTrackedListener(superuserMenuBtn, 'click', (e) => {
        (e as Event).preventDefault();
        (e as Event).stopPropagation();
        this.toggleSuperuserMenu();
      });
    }

    this.addTrackedListener(this.elements['superuser-manage-users'], 'click', (e) => {
      (e as Event).preventDefault();
      this.toggleSuperuserMenu(false);
      this.openSuperuserModal('users');
    });

    this.addTrackedListener(this.elements['superuser-manage-channels'], 'click', (e) => {
      (e as Event).preventDefault();
      this.toggleSuperuserMenu(false);
      this.openSuperuserModal('channels');
    });

    this.addTrackedListener(this.elements['superuserModalClose'], 'click', () => this.closeSuperuserModal());
    this.addTrackedListener(this.elements['superuserTabUsers'], 'click', () => this.switchSuperuserTab('users'));
    this.addTrackedListener(this.elements['superuserTabChannels'], 'click', () => this.switchSuperuserTab('channels'));
    this.addTrackedListener(this.elements['superuserModal'], 'click', (e) => {
      if (e.target === this.elements['superuserModal']) {
        this.closeSuperuserModal();
      }
    });
    this.addTrackedListener(this.elements['superuserUsersList'], 'click', (e) => this.handleSuperuserUsersListClick(e as MouseEvent));
    this.addTrackedListener(this.elements['superuserChannelsList'], 'click', (e) => this.handleSuperuserChannelsListClick(e as MouseEvent));
    this.addTrackedListener(document, 'click', (e) => this.handleDocumentClick(e as MouseEvent));

    // Audio Settings Modal
    this.addTrackedListener(this.elements.audioSettingsCancel, 'click', () => this.hideAudioSettingsModal());
    this.addTrackedListener(this.elements.audioSettingsSave, 'click', () => this.saveAudioSettings());

    // Device selection
    this.addTrackedListener(this.elements.micSelect, 'change', () => this.handleMicChange());

    // Settings
    this.setupSettingsListeners();

    // Mic test (if element exists)
    this.addTrackedListener(this.elements.testMicBtn, 'click', () => this.handleTestMicToggle());

    // Push-to-talk
  this.addTrackedListener(this.elements.pttSetKey, 'click', () => this.handlePttSetKey());
  this.addTrackedListener(window, 'keydown', (e) => { void this.handleKeyDown(e as KeyboardEvent); });
  this.addTrackedListener(window, 'keyup', (e) => { void this.handleKeyUp(e as KeyboardEvent); });

    // Sidebar toggle
  this.addTrackedListener(this.elements.toggleSidebar, 'click', () => this.toggleSidebar());
  this.addTrackedListener(this.elements['toggle-members'], 'click', () => this.toggleMembersPanel());

    // Video popout controls
    this.addTrackedListener(this.elements['toggle-video-popout'], 'click', () => this.toggleVideoPopout());
    this.addTrackedListener(this.elements['minimize-video'], 'click', () => this.minimizeVideo());
    this.addTrackedListener(this.elements['close-video'], 'click', () => this.closeVideo());

    // Video popout drag functionality
    this.setupVideoPopoutDrag();

    // Channel switching
    this.setupChannelListeners();

    // Channel creation
    this.addTrackedListener(this.elements['create-text-channel'], 'click', () => this.showCreateChannelModal('text'));
    this.addTrackedListener(this.elements['create-voice-channel'], 'click', () => this.showCreateChannelModal('voice'));
    this.addTrackedListener(this.elements['create-stream-channel'], 'click', () => this.showCreateChannelModal('stream'));
    this.addTrackedListener(this.elements['createChannelBtn'], 'click', () => this.handleCreateChannel());
    this.addTrackedListener(this.elements['createChannelCancel'], 'click', () => this.hideCreateChannelModal());

    // Stream info modal
    this.addTrackedListener(this.elements['streamInfoCancel'], 'click', () => this.hideStreamInfoModal());
    this.addTrackedListener(this.elements['streamInfoClose'], 'click', () => this.hideStreamInfoModal());

    // Emoji picker
    this.addTrackedListener(this.elements.emojiPickerBtn, 'click', (e) => {
      (e as Event).stopPropagation();
      this.toggleEmojiPicker();
    });
    
    // Close emoji picker when clicking outside
    const emojiClickHandler = (e: Event) => {
      const target = e.target as HTMLElement;
      if (this.elements.emojiPicker && 
          !this.elements.emojiPicker.contains(target) && 
          target !== this.elements.emojiPickerBtn) {
        this.hideEmojiPicker();
      }
    };
    this.addTrackedListener(document, 'click', emojiClickHandler);

    // Initialize emoji grid
    this.initializeEmojiPicker();

    // Inline video controls
    // Theater mode is now the default - toggle button closes the video
    this.addTrackedListener(this.elements.theaterModeToggle, 'click', () => this.toggleTheaterMode());

    // Video player controls
    this.addTrackedListener(this.elements.playPauseBtn, 'click', () => this.togglePlayPause());
    this.addTrackedListener(this.elements.volumeBtn, 'click', () => this.toggleMuteVideo());
    this.addTrackedListener(this.elements.volumeSlider, 'input', (e) => this.handleVolumeChange(e as Event));
    this.addTrackedListener(this.elements.fullscreenBtn, 'click', () => this.toggleFullscreen());
    this.addTrackedListener(this.elements.toggleChatBtn, 'click', () => this.toggleChatVisibility());
    
    // Video element events
    const inlineVideo = this.elements.inlineVideo as HTMLVideoElement;
    if (inlineVideo) {
      this.addTrackedListener(inlineVideo, 'play', () => this.updatePlayPauseButton(false));
      this.addTrackedListener(inlineVideo, 'pause', () => this.updatePlayPauseButton(true));
      this.addTrackedListener(inlineVideo, 'volumechange', () => this.updateVolumeDisplay());
      this.addTrackedListener(inlineVideo, 'click', () => this.togglePlayPause());
    }
    
    // Listen for fullscreen changes (handles Escape key)
    this.addTrackedListener(document, 'fullscreenchange', () => this.handleFullscreenChange());
  }

  /**
   * Handle fullscreen change events (including Escape key)
   */
  private handleFullscreenChange(): void {
    const container = this.elements.inlineVideoContainer as HTMLElement;
    if (!container) return;

    // If we're NOT in fullscreen anymore, clean up the fullscreen class
    if (!document.fullscreenElement) {
      container.classList.remove('fullscreen');
      const btn = this.elements.fullscreenBtn;
      if (btn) {
        const icon = btn.querySelector('.icon');
        if (icon) icon.textContent = '⛶';
      }
    }
  }

  /**
   * Setup service event handlers
   */
  private setupServiceEventHandlers(): void {
    // Note: Socket event listeners are only set up once during initialization
    // The socket service handles reconnection internally without re-adding listeners
    
    // Socket events
    this.socket.on('user:update', (users) => this.handleUsersUpdate(users));
    this.socket.on('channel:update', (channels) => this.handleChannelsUpdate(channels));
    this.socket.on('chat:message', (message) => this.handleChatMessage(message));
    this.socket.on('chat:history', (messages) => this.handleChatHistory(messages));
    this.socket.on('socket:connected', () => this.handleSocketConnected());
    this.socket.on('socket:disconnected', ({ reason }) => this.handleSocketDisconnected(reason));
    this.socket.on('connection:status', ({ connected, reconnecting }) => {
      const wasVoiceActive = this.state.get('voiceConnected') || Boolean(this.pendingVoiceJoin);

      if (!connected && wasVoiceActive) {
        this.resetVoiceState();

        if (reconnecting) {
          if (import.meta.env.DEV) {
            console.log('⚠️ Voice resources released while attempting to reconnect');
          }
        } else {
          this.notifications.warning('Voice disconnected due to network issues');
        }
      }

      this.state.setConnected(connected);
      this.updateConnectionStatus(connected, reconnecting);
    });
    this.socket.on('auth:success', (data) => this.handleAuthSuccess(data));
    this.socket.on('auth:error', (error) => this.handleAuthError(error));
    this.socket.on('auth:loggedOut', () => this.handleAuthLoggedOut());
    this.socket.on('account:updated', (payload) => this.handleAccountUpdated(payload));
    this.socket.on('account:data', (payload) => this.handleAccountData(payload));
    this.socket.on('account:rolesUpdated', (payload) => this.handleAccountRolesUpdated(payload));
    this.socket.on('account:error', (error) => this.handleAccountError(error));
    this.socket.on('admin:accounts:list', (data) => this.handleAdminAccountsList(data.accounts));
    this.socket.on('admin:accounts:rolesUpdated', (data) => this.handleAdminAccountUpdate(data.account, 'roles'));
    this.socket.on('admin:accounts:disabled', (data) => this.handleAdminAccountUpdate(data.account, 'disabled'));
    this.socket.on('admin:accounts:enabled', (data) => this.handleAdminAccountUpdate(data.account, 'enabled'));
    this.socket.on('admin:error', (error) => this.handleAdminError(error));
    this.socket.on('notification', (notif) => {
      this.notifications.show(notif.message, notif.type, notif.duration);
      // Check if this is a superuser promotion notification
      if (notif.message?.includes('promoted to Superuser')) {
        this.isSuperuser = true;
        this.hasManagementAccess = true;
        if (import.meta.env.DEV) {
          console.log('✅ User promoted to superuser');
        }
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

      if (details?.code === 'VOICE_JOIN_FAILED') {
        this.resetVoiceState();
      }
    });

    // WebRTC signaling
  this.socket.on('voice:joined', (data) => this.handleVoiceJoined(data as never));
  this.socket.on('voice:peer-join', (data) => this.handleVoicePeerJoin(data as never));
  this.socket.on('voice:peer-leave', (data) => this.handleVoicePeerLeave(data as never));
  this.socket.on('voice:signal', (data) => this.handleVoiceSignal(data as never));
  this.socket.on('voice:state', (data) => this.handleVoicePeerState(data as never));

    // Voice events
    this.voice.on('voice:offer', (data: unknown) => {
      const { peerId, offer } = data as { peerId: string; offer: RTCSessionDescriptionInit };
      this.socket.sendSignal(peerId, { sdp: offer });
    });
    this.voice.on('voice:answer', (data: unknown) => {
      const { peerId, answer } = data as { peerId: string; answer: RTCSessionDescriptionInit };
      this.socket.sendSignal(peerId, { sdp: answer });
    });
    this.voice.on('voice:ice-candidate', (data: unknown) => {
      const { peerId, candidate } = data as { peerId: string; candidate: RTCIceCandidateInit };
      this.socket.sendSignal(peerId, { candidate });
    });
    this.voice.on('voice:speaking', (data) => {
      const { id, speaking } = data as { id: string; speaking: boolean };
      this.updateSpeakingIndicator(id, speaking);
    });

    // Audio events
    this.audio.on('mic:level', (level: unknown) => {
      this.updateMicLevel(level as number);
    });

    // State changes
    this.state.on('state:change', () => {
      this.updateMuteButtons();
    });
  }

  /**
   * Setup settings change listeners
   */
  private setupSettingsListeners(): void {
    // Checkbox settings (voice processing, PTT)
    const checkboxIds = ['echoCancel', 'noiseSuppression', 'autoGain', 'pttEnable'];
    for (const id of checkboxIds) {
      this.elements[id]?.addEventListener('change', async () => {
        await this.handleSettingChange(id);
      });
    }

    // Range slider settings (gain, volume)
    const micGainInput = this.elements.micGain as HTMLInputElement;
    const outputVolInput = this.elements.outputVol as HTMLInputElement;

    if (micGainInput) {
      micGainInput.addEventListener('input', () => {
        const val = parseFloat(micGainInput.value);
        if (this.elements.micGainVal) {
          this.elements.micGainVal.textContent = `${val.toFixed(1)}x`;
        }
      });
      micGainInput.addEventListener('change', async () => {
        await this.handleSettingChange('micGain');
      });
    }

    if (outputVolInput) {
      outputVolInput.addEventListener('input', () => {
        const val = parseFloat(outputVolInput.value);
        if (this.elements.outputVolVal) {
          this.elements.outputVolVal.textContent = `${Math.round(val * 100)}%`;
        }
      });
      outputVolInput.addEventListener('change', async () => {
        await this.handleSettingChange('outputVol');
      });
    }

    // Device selection dropdowns
    const micSelect = this.elements.micSelect as HTMLSelectElement;
    const spkSelect = this.elements.spkSelect as HTMLSelectElement;

    if (micSelect) {
      micSelect.addEventListener('change', async () => {
        const deviceId = micSelect.value;
        this.state.updateSettings({ micDeviceId: deviceId });
        this.notifications.success('Microphone changed');
        
        // If currently testing, restart with new device
        const testBtn = this.elements.testMicBtn as HTMLButtonElement;
        if (testBtn && testBtn.getAttribute('data-testing') === 'true') {
          this.audio.stopLocalStream();
          try {
            await this.audio.getLocalStream(true); // Force new stream
            this.notifications.info('Test restarted with new device');
          } catch (error) {
            console.error('Error switching microphone:', error);
            this.notifications.error('Failed to switch microphone');
          }
        }
      });
    }

    if (spkSelect) {
      spkSelect.addEventListener('change', () => {
        const deviceId = spkSelect.value;
        this.state.updateSettings({ spkDeviceId: deviceId });
        this.notifications.success('Speaker changed');
        // TODO: Apply speaker device to audio output
      });
    }

    // PTT Key binding
    const pttSetKeyBtn = this.elements.pttSetKey as HTMLButtonElement;
    const pttKeyInput = this.elements.pttKey as HTMLInputElement;

    if (pttSetKeyBtn && pttKeyInput) {
      pttSetKeyBtn.addEventListener('click', () => {
        pttKeyInput.value = 'Press any key...';
        pttKeyInput.classList.add('recording');
        
        const keyHandler = (e: KeyboardEvent) => {
          e.preventDefault();
          pttKeyInput.value = e.code;
          pttKeyInput.classList.remove('recording');
          this.state.updateSettings({ pttKey: e.code });
          this.notifications.success(`PTT key set to ${e.code}`);
          document.removeEventListener('keydown', keyHandler);
        };
        
        document.addEventListener('keydown', keyHandler, { once: true });
      });
    }
  }

  /**
   * Handle join channel
   */
  private handleJoinChannel(): void {
    const channelInput = this.elements.channel as HTMLInputElement;
    const channel = channelInput?.value?.trim() || 'lobby';
    
    this.state.setChannel(channel);
    this.socket.joinChannel(channel);
    this.player.loadChannel(channel);
    
    if (this.elements.streamKey) {
      this.elements.streamKey.textContent = channel;
    }
  }

  /**
   * Handle send chat message
   */
  private handleSendMessage(): void {
    if (!this.isAuthenticated) {
      this.notifications.warning('Please log in to send messages');
      this.showAuthModal('login');
      return;
    }

    const input = this.elements.chatInput as HTMLInputElement;
    const message = input?.value?.trim();
    
    if (!message) return;
    
    this.socket.sendMessage(message);
    this.soundFX.play('messageSent', 0.6);
    input.value = '';
  }

  /**
   * Handle toggle mute
   */
  private async handleToggleMute(): Promise<void> {
    // Can't unmute while deafened (Discord logic)
    const state = this.state.getState();
    if (state.deafened && state.muted) {
      this.notifications.warning('Cannot unmute while deafened');
      return;
    }

    const muted = this.state.toggleMute();
    if (muted) {
      this.setLocalSpeaking(false);
    }
    await this.syncMicrophoneState();
    this.announceVoiceState();

    this.soundFX.play(muted ? 'mute' : 'unmute');
    this.updateMuteButtons();
    this.renderVoiceUsers();
  }

  /**
   * Handle toggle deafen
   */
  private async handleToggleDeafen(): Promise<void> {
    const { deafened: currentlyDeafened, muted: currentlyMuted } = this.state.getState();

    if (!currentlyDeafened) {
      this.wasMutedBeforeDeafen = currentlyMuted;
    }

    const deafened = this.state.toggleDeafen();
    this.voice.setDeafened(deafened);

    if (deafened) {
      this.setLocalSpeaking(false);
    } else {
      const shouldRestoreMute = this.wasMutedBeforeDeafen ?? false;
      this.state.setMuted(shouldRestoreMute);
      this.wasMutedBeforeDeafen = null;
    }

    await this.syncMicrophoneState();
    this.announceVoiceState();

    this.soundFX.play(deafened ? 'deafen' : 'undeafen');
    this.updateMuteButtons();
    this.renderVoiceUsers();
  }

  private async syncMicrophoneState(forceRestart = false): Promise<void> {
    const { muted, deafened } = this.state.getState();
    const shouldDisable = muted || deafened;
    const isVoiceSessionActive = this.state.get('voiceConnected') || Boolean(this.pendingVoiceJoin);

    if (shouldDisable) {
      this.audio.setMuted(true);
      if (this.audio.hasActiveStream()) {
        this.audio.stopLocalStream();
      }
      if (isVoiceSessionActive) {
        this.voice.setLocalStream(null);
      }
      this.setLocalSpeaking(false);
      this.announceVoiceState();
      return;
    }

    if (!isVoiceSessionActive) {
      return;
    }

    try {
      const stream = await this.audio.getLocalStream(forceRestart);
      this.audio.setMuted(false);
      this.voice.setLocalStream(stream);
    } catch (error) {
      console.error('Error enabling microphone:', error);
      this.state.setMuted(true);
      this.updateMuteButtons();
      this.renderVoiceUsers();
      this.announceVoiceState();
      this.notifications.error('Failed to enable microphone. Please check permissions.');
    }
  }

  /**
   * Handle authentication form submission based on current mode
   */
  private handleAuthSubmit(): void {
    if (this.authSubmitting) {
      return;
    }

    const usernameInput = this.elements.regUsername as HTMLInputElement | undefined;
    const passwordInput = this.elements.regPassword as HTMLInputElement | undefined;
    const confirmInput = this.elements.regConfirm as HTMLInputElement | undefined;
    const displayNameInput = this.elements.regDisplayName as HTMLInputElement | undefined;
    const emailInput = this.elements.regEmail as HTMLInputElement | undefined;
    const bioInput = this.elements.regBio as HTMLTextAreaElement | undefined;
    const currentPasswordInput = this.elements.regCurrentPassword as HTMLInputElement | undefined;
    const newPasswordInput = this.elements.regNewPassword as HTMLInputElement | undefined;
    const newPasswordConfirmInput = this.elements.regNewPasswordConfirm as HTMLInputElement | undefined;
    const errorEl = this.elements.regError;

    if (errorEl) {
      errorEl.textContent = '';
    }

    const showError = (message: string): void => {
      if (errorEl) {
        errorEl.textContent = message;
      }
      this.soundFX.play('error', 0.5);
    };

    const mode = this.authMode;
    const emailLoginRaw = usernameInput?.value?.trim() ?? '';
    const emailLoginNormalized = emailLoginRaw.toLowerCase();
    const password = passwordInput?.value ?? '';
    const confirm = confirmInput?.value ?? '';
  const fallbackDisplayName = this.scrubIdentifierForDisplay(emailLoginRaw) || emailLoginRaw;
  const displayName = displayNameInput?.value?.trim() || fallbackDisplayName;
    const contactEmail = emailInput?.value?.trim() || null;
    const bio = bioInput?.value?.trim() || null;
    const currentPassword = currentPasswordInput?.value ?? '';
    const newPassword = newPasswordInput?.value ?? '';
    const newPasswordConfirm = newPasswordConfirmInput?.value ?? '';

    if (mode === 'login') {
      if (emailLoginNormalized.length === 0) {
        showError('Email is required');
        return;
      }
      if (!this.isValidEmail(emailLoginRaw)) {
        showError('Enter a valid email address');
        return;
      }
      if (password.length === 0) {
        showError('Password is required');
        return;
      }

      this.setAuthSubmitting(true);
      this.socket.login({ username: emailLoginNormalized, password });
      return;
    }

    if (mode === 'register') {
      if (!this.isValidEmail(emailLoginRaw)) {
        showError('Enter a valid email address');
        return;
      }

      if (emailLoginRaw.length > 254) {
        showError('Email must be 254 characters or less');
        return;
      }

      if (password.trim().length < 8) {
        showError('Password must be at least 8 characters long');
        return;
      }

      if (password !== confirm) {
        showError('Passwords do not match');
        return;
      }

      this.setAuthSubmitting(true);
      this.socket.register({
        username: emailLoginNormalized,
        password,
        profile: {
          displayName: displayName || fallbackDisplayName,
          email: contactEmail,
          bio,
        },
      });
      return;
    }

    // Profile update mode
    const updates: Parameters<SocketService['updateAccount']>[0] = {};
  updates.displayName = displayName || undefined;
  updates.email = contactEmail;
    updates.bio = bio;

    if (newPassword) {
      if (newPassword.length < 8) {
        showError('New password must be at least 8 characters long');
        return;
      }

      if (newPassword !== newPasswordConfirm) {
        showError('New passwords do not match');
        return;
      }

      if (!currentPassword) {
        showError('Current password is required to change password');
        return;
      }

      updates.currentPassword = currentPassword;
      updates.newPassword = newPassword;
    }

    this.setAuthSubmitting(true);
    this.socket.updateAccount(updates);
  }

  private handleLogout(): void {
    if (!this.isAuthenticated) {
      this.setAuthMode('login');
      this.showAuthModal('login');
      return;
    }

    this.setLogoutSubmitting(true);
    this.socket.logout();
  }

  private setLogoutSubmitting(inProgress: boolean): void {
    const logoutBtn = this.elements.logoutBtn as HTMLButtonElement | undefined;
    if (!logoutBtn) return;

    logoutBtn.disabled = inProgress;
    logoutBtn.textContent = inProgress ? 'Logging Out…' : 'Log Out';
  }

  private setAuthSubmitting(submitting: boolean): void {
    this.authSubmitting = submitting;
    const button = this.elements.registerBtn as HTMLButtonElement | undefined;
    if (button) {
      button.disabled = submitting;
      button.textContent = this.getAuthButtonLabel(submitting);
    }
  }

  private getAuthButtonLabel(isLoading = false): string {
    if (isLoading) {
      if (this.authMode === 'login') return 'Logging In…';
      if (this.authMode === 'register') return 'Registering…';
      return 'Saving…';
    }

    if (this.authMode === 'login') return 'Log In';
    if (this.authMode === 'register') return 'Create Account';
    return 'Save Changes';
  }

  private showAuthModal(mode: 'login' | 'register' | 'profile'): void {
    const modal = this.elements.regModal;
    if (!modal) {
      return;
    }

    this.setAuthMode(mode);
    modal.style.display = 'flex';
    this.animator.openModal(modal);
    this.soundFX.play('click', 0.4);
  }

  private hideAuthModal(): void {
    const modal = this.elements.regModal;
    if (!modal) return;

    this.animator.closeModal(modal);
  }

  private setAuthMode(mode: 'login' | 'register' | 'profile'): void {
    if (this.authMode === mode) {
      // Still reset form state when reusing the same mode
      this.authMode = mode;
    } else {
      this.authMode = mode;
    }

    this.setAuthSubmitting(false);
    this.clearAuthErrors();

  const title = document.getElementById('settings-modal-title');
  const subtitle = document.getElementById('settings-modal-subtitle');
  const modeHint = document.getElementById('auth-mode-hint');
  const cancelBtn = this.elements.regCancel as HTMLButtonElement | undefined;
  const logoutBtn = this.elements.logoutBtn as HTMLButtonElement | undefined;

    if (title) {
      if (mode === 'login') {
        title.textContent = 'Log In';
      } else if (mode === 'register') {
        title.textContent = 'Create Account';
      } else {
        title.textContent = 'User Settings';
      }
    }

    if (subtitle) {
      if (!this.isAuthenticated && (mode === 'login' || mode === 'register')) {
        subtitle.style.display = 'block';
        subtitle.textContent = mode === 'login'
          ? 'Enter your credentials to continue'
          : 'Password is required to create an account';
      } else {
        subtitle.style.display = 'none';
      }
    }

    if (modeHint) {
      if (mode === 'login') {
        modeHint.textContent = 'Log back in to pick up where you left off.';
      } else if (mode === 'register') {
        modeHint.textContent = 'Create a new account to join the conversation.';
      } else {
        modeHint.textContent = 'Review and update the details other members see.';
      }
    }

    if (cancelBtn) {
      if (!this.isAuthenticated && (mode === 'login' || mode === 'register')) {
        cancelBtn.style.display = 'none';
      } else {
        cancelBtn.style.display = '';
      }
    }

    if (logoutBtn) {
      if (mode === 'profile' && this.isAuthenticated) {
        logoutBtn.style.display = '';
        this.setLogoutSubmitting(false);
      } else {
        this.setLogoutSubmitting(false);
        logoutBtn.style.display = 'none';
      }
    }

    this.updateAuthTabs();
    this.updateAuthFormVisibility();
    const account = this.state.get('account');
    if (mode === 'profile') {
      this.populateAuthForm(account);
    } else if (mode === 'login' && account) {
      // Prefill email for convenience if stored
      this.populateAuthForm({ ...account });
    } else {
      this.populateAuthForm(null);
    }
    this.updateAuthActionButton();
  }

  private updateAuthTabs(): void {
    const tabLogin = document.getElementById('authTabLogin');
    const tabRegister = document.getElementById('authTabRegister');
    const tabProfile = document.getElementById('authTabProfile');

    const activate = (tab: HTMLElement | null, active: boolean) => {
      if (!tab) return;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.setAttribute('tabindex', active ? '0' : '-1');
    };

    activate(tabLogin, this.authMode === 'login');
    activate(tabRegister, this.authMode === 'register');
    activate(tabProfile, this.authMode === 'profile');

    if (tabProfile) {
      tabProfile.style.display = this.isAuthenticated ? '' : 'none';
    }
  }

  private updateAuthActionButton(): void {
    const button = this.elements.registerBtn as HTMLButtonElement | undefined;
    if (!button) return;
    button.textContent = this.getAuthButtonLabel(this.authSubmitting);
  }

  private updateAuthFormVisibility(): void {
    const usernameGroup = (this.elements.regUsername as HTMLInputElement | undefined)?.closest('.form-group') as HTMLElement | null;
    const passwordGroup = (this.elements.regPassword as HTMLInputElement | undefined)?.closest('.form-group') as HTMLElement | null;
    const confirmGroup = (this.elements.regConfirm as HTMLInputElement | undefined)?.closest('.form-group') as HTMLElement | null;
    const displayNameGroup = (this.elements.regDisplayName as HTMLInputElement | undefined)?.closest('.form-group') as HTMLElement | null;
    const emailGroup = (this.elements.regEmail as HTMLInputElement | undefined)?.closest('.form-group') as HTMLElement | null;
    const bioGroup = (this.elements.regBio as HTMLTextAreaElement | undefined)?.closest('.form-group') as HTMLElement | null;
    const currentPasswordGroup = (this.elements.regCurrentPassword as HTMLInputElement | undefined)?.closest('.form-group') as HTMLElement | null;
    const newPasswordGroup = (this.elements.regNewPassword as HTMLInputElement | undefined)?.closest('.form-group') as HTMLElement | null;
    const newPasswordConfirmGroup = (this.elements.regNewPasswordConfirm as HTMLInputElement | undefined)?.closest('.form-group') as HTMLElement | null;

    const show = (el: HTMLElement | null | undefined, visible: boolean) => {
      if (!el) return;
      el.style.display = visible ? '' : 'none';
    };

    show(usernameGroup, true);

    if (this.authMode === 'login') {
      show(passwordGroup, true);
      show(confirmGroup, false);
      show(displayNameGroup, false);
      show(emailGroup, false);
      show(bioGroup, false);
      show(currentPasswordGroup, false);
      show(newPasswordGroup, false);
      show(newPasswordConfirmGroup, false);
    } else if (this.authMode === 'register') {
      show(passwordGroup, true);
      show(confirmGroup, true);
      show(displayNameGroup, true);
      show(emailGroup, false);
      show(bioGroup, false);
      show(currentPasswordGroup, false);
      show(newPasswordGroup, false);
      show(newPasswordConfirmGroup, false);
    } else {
      show(passwordGroup, false);
      show(confirmGroup, false);
      show(displayNameGroup, true);
      show(emailGroup, true);
      show(bioGroup, true);
      show(currentPasswordGroup, true);
      show(newPasswordGroup, true);
      show(newPasswordConfirmGroup, true);
    }

    const usernameInput = this.elements.regUsername as HTMLInputElement | undefined;
    if (usernameInput) {
      usernameInput.disabled = this.authMode === 'profile';
    }

    const passwordInput = this.elements.regPassword as HTMLInputElement | undefined;
    this.updatePasswordStrength(this.authMode === 'register' ? (passwordInput?.value ?? '') : '');
  }

  private updatePasswordStrength(password: string): void {
    const container = this.elements.passwordStrength as HTMLElement | undefined;
    const fill = this.elements.passwordStrengthFill as HTMLElement | undefined;
    const label = this.elements.passwordStrengthLabel as HTMLElement | undefined;

    if (!container || !fill || !label) {
      return;
    }

    if (this.authMode !== 'register') {
      container.classList.remove('visible');
      container.dataset.level = '';
      fill.style.width = '0%';
      label.textContent = 'Start typing to check strength';
      return;
    }

    if (!password) {
      container.classList.remove('visible');
      container.dataset.level = '';
      fill.style.width = '0%';
      label.textContent = 'Start typing to check strength';
      return;
    }

    const { level, percentage, descriptor } = this.evaluatePasswordStrength(password);
    container.dataset.level = level;
    container.classList.add('visible');
    fill.style.width = `${percentage}%`;
    label.textContent = descriptor;
  }

  private evaluatePasswordStrength(password: string): {
    level: 'weak' | 'fair' | 'good' | 'strong';
    percentage: number;
    descriptor: string;
  } {
    let score = 0;

    if (password.length >= 8) {
      score += 1;
    }

    if (password.length >= 12) {
      score += 1;
    }

    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) {
      score += 1;
    }

    if (/\d/.test(password)) {
      score += 1;
    }

    if (/[^A-Za-z0-9]/.test(password)) {
      score += 1;
    }

    score = Math.min(score, 4);

    switch (score) {
      case 0:
        return {
          level: 'weak',
          percentage: 20,
          descriptor: 'Too weak — add more characters',
        };
      case 1:
        return {
          level: 'weak',
          percentage: 35,
          descriptor: 'Weak — mix upper, lower, numbers, and symbols',
        };
      case 2:
        return {
          level: 'fair',
          percentage: 55,
          descriptor: 'Fair — add more variety for strength',
        };
      case 3:
        return {
          level: 'good',
          percentage: 80,
          descriptor: 'Good — almost there!',
        };
      default:
        return {
          level: 'strong',
          percentage: 100,
          descriptor: 'Strong password!'
        };
    }
  }

  private isValidEmail(value: string): boolean {
    if (!value) {
      return false;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return false;
    }

    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
  }

  private scrubIdentifierForDisplay(identifier: string): string {
    const trimmed = identifier.trim();
    if (!trimmed) {
      return '';
    }

    if (trimmed.includes('@')) {
      const [local] = trimmed.split('@');
      return local || trimmed;
    }

    return trimmed;
  }

  private populateAuthForm(account: Account | null): void {
    const usernameInput = this.elements.regUsername as HTMLInputElement | undefined;
    const passwordInput = this.elements.regPassword as HTMLInputElement | undefined;
    const confirmInput = this.elements.regConfirm as HTMLInputElement | undefined;
    const displayNameInput = this.elements.regDisplayName as HTMLInputElement | undefined;
    const emailInput = this.elements.regEmail as HTMLInputElement | undefined;
    const bioInput = this.elements.regBio as HTMLTextAreaElement | undefined;
    const currentPasswordInput = this.elements.regCurrentPassword as HTMLInputElement | undefined;
    const newPasswordInput = this.elements.regNewPassword as HTMLInputElement | undefined;
    const newPasswordConfirmInput = this.elements.regNewPasswordConfirm as HTMLInputElement | undefined;

    if (usernameInput) {
      if (this.authMode === 'profile') {
        usernameInput.value = account?.username ?? '';
      } else if (this.authMode === 'login') {
        usernameInput.value = account?.username ?? '';
      } else {
        usernameInput.value = '';
      }
    }

    if (displayNameInput) {
      if (this.authMode === 'profile') {
        const preferred = account?.displayName && account.displayName.trim().length > 0
          ? account.displayName
          : this.scrubIdentifierForDisplay(account?.username ?? '');
        displayNameInput.value = preferred || '';
      } else {
        displayNameInput.value = '';
      }
    }

    if (emailInput) {
      emailInput.value = this.authMode === 'profile' && account?.email ? account.email : '';
    }

    if (bioInput) {
      bioInput.value = this.authMode === 'profile' && account?.bio ? account.bio : '';
    }

    const inputsToClear = [passwordInput, confirmInput, currentPasswordInput, newPasswordInput, newPasswordConfirmInput];
    inputsToClear.forEach((input) => {
      if (input) {
        input.value = '';
      }
    });

    this.updatePasswordStrength('');
  }

  private clearAuthErrors(): void {
    const errorEl = this.elements.regError;
    if (errorEl) {
      errorEl.textContent = '';
    }
  }

  private handleSocketConnected(): void {
    if (import.meta.env.DEV) {
      console.log('🔌 Socket connected to backend');
    }

    const storedSession = this.state.get('session');
    if (!this.isAuthenticated && storedSession?.token) {
      this.sessionResumePending = true;
    }

    if (this.sessionResumePending && storedSession?.token) {
      this.socket.resumeSession(storedSession.token);
    }
  }

  private handleSocketDisconnected(reason: string): void {
    if (import.meta.env.DEV) {
      console.warn('🔌 Socket disconnected from backend', reason);
    }

    this.sessionResumePending = Boolean(this.state.get('session')?.token);
    this.setAuthSubmitting(false);
  }

  private handleAuthSuccess(payload: {
    user: User;
    account: Account;
    session: SessionInfo;
    channels: Channel[];
    groups?: ChannelGroup[];
    isNewAccount?: boolean;
  }): void {
    const { account, session, channels, groups, isNewAccount } = payload;

    if (import.meta.env.DEV) {
      console.log('✅ Authentication successful', {
        username: account.username,
        roles: account.roles,
        isNewAccount,
      });
    }

    this.sessionResumePending = false;
    this.setAuthSubmitting(false);
  this.setLogoutSubmitting(false);

    this.state.setAuth(account, session);

    if (Array.isArray(channels) && channels.length) {
      this.state.setChannels(channels);
      this.updateChannelsUI(channels);
    }

    if (Array.isArray(groups) && groups.length) {
      this.state.setChannelGroups(groups);
    }

    const permissions = mergeRolePermissions(account.roles || []);
    this.applyPermissions(permissions);
    this.updateAccountUI();

    const friendlyName = account.displayName || account.username;

    if (isNewAccount) {
      this.notifications.success(`Account created! Welcome, ${friendlyName}.`);
    } else {
      this.notifications.success(`Signed in as ${friendlyName}`);
    }

    this.soundFX.play('success', 0.6);

    if (hasPermission(permissions, 'canManageUsers')) {
      this.socket.requestAccountList();
    }

    this.setAuthMode('profile');
    this.hideAuthModal();
  }

  private handleAuthError(payload: { message: string; code?: string }): void {
    const { message, code } = payload;

    if (import.meta.env.DEV) {
      console.warn('❌ Authentication error', payload);
    }

    this.sessionResumePending = false;
    this.setAuthSubmitting(false);

    if (code === 'SESSION_FAILED' || code === 'ACCOUNT_DISABLED') {
      this.state.clearAccount();
      this.applyPermissions(null);
      this.resetVoiceState();
    }

    const errorEl = this.elements.regError;
    if (errorEl) {
      errorEl.textContent = message;
    }

    this.notifications.error(message || 'Authentication failed.');
  this.setLogoutSubmitting(false);

    if (!this.isAuthenticated) {
      if (code === 'REGISTRATION_FAILED') {
        this.setAuthMode('register');
      } else {
        this.setAuthMode('login');
      }

      const modal = this.elements.regModal;
      if (!modal || modal.style.display !== 'flex') {
        this.showAuthModal(this.authMode);
      }
    }
  }

  private handleAuthLoggedOut(): void {
    if (import.meta.env.DEV) {
      console.log('ℹ️ Logged out by server');
    }

    this.sessionResumePending = false;
    this.setAuthSubmitting(false);
    this.state.clearAccount();
    this.applyPermissions(null);
    this.resetVoiceState();
    this.notifications.info('You have been logged out.');
  this.setLogoutSubmitting(false);
    this.setAuthMode('login');
    this.showAuthModal('login');
  }

  private handleAccountUpdated(payload: { account: Account; user?: User }): void {
    if (!payload?.account) return;

    this.state.updateAccount(payload.account);
    this.applyPermissions(mergeRolePermissions(payload.account.roles || []));
    this.updateAccountUI();
    this.setAuthSubmitting(false);
    this.notifications.success('Profile updated successfully.');
  }

  private handleAccountData(payload: { account: Account; user?: User }): void {
    if (!payload?.account) return;

    this.state.updateAccount(payload.account);
    this.applyPermissions(mergeRolePermissions(payload.account.roles || []));
    this.updateAccountUI();
  }

  private handleAccountRolesUpdated(payload: { account: Account; user?: User }): void {
    if (!payload?.account) return;

    const currentAccount = this.state.get('account');
    if (currentAccount && currentAccount.id === payload.account.id) {
      this.state.updateAccount(payload.account);
      this.applyPermissions(mergeRolePermissions(payload.account.roles || []));
      this.notifications.info('Your roles have been updated.');
      this.updateAccountUI();
    }
  }

  private handleAccountError(payload: { message: string; code?: string }): void {
    if (import.meta.env.DEV) {
      console.warn('⚠️ Account error received', payload);
    }

    this.setAuthSubmitting(false);

    const errorEl = this.elements.regError;
    if (errorEl) {
      errorEl.textContent = payload.message;
    }

    this.notifications.error(payload.message || 'Account update failed.');
  }

  private applyPermissions(permissions: RolePermissions | null): void {
    this.rolePermissions = permissions;
    this.isAuthenticated = Boolean(permissions);

    const account = this.state.get('account');
    this.currentRoles = permissions && account ? account.roles ?? [] : [];
    this.isSuperuser = this.currentRoles.includes('superuser');
    this.hasManagementAccess = this.isSuperuser
      || hasPermission(permissions, 'canManageUsers')
      || hasPermission(permissions, 'canManageChannelPermissions')
      || hasPermission(permissions, 'canAssignRoles')
      || hasPermission(permissions, 'canDisableAccounts');

    const toggleDisabled = (element: HTMLElement | null | undefined, disabled: boolean) => {
      if (!element) return;
      if ('disabled' in element) {
        try {
          (element as HTMLButtonElement).disabled = disabled;
        } catch {
          element.classList.toggle('is-disabled', disabled);
        }
      } else {
        element.classList.toggle('is-disabled', disabled);
      }
    };

    const chatInput = this.elements.chatInput as HTMLInputElement | undefined;
    if (chatInput) {
      chatInput.disabled = !this.isAuthenticated;
      if (this.isAuthenticated) {
        const currentChannelId = this.state.get('currentChannel');
        const channel = this.state.get('channels').find((ch) => ch.id === currentChannelId);
        chatInput.placeholder = channel ? `Message #${channel.name}` : 'Type a message';
      } else {
        chatInput.placeholder = 'Log in to send messages';
        chatInput.value = '';
      }
    }

    toggleDisabled(this.elements.mute as HTMLButtonElement, !this.isAuthenticated);
    toggleDisabled(this.elements.deafen as HTMLButtonElement, !this.isAuthenticated);
    toggleDisabled(this.elements['disconnect-voice'] as HTMLButtonElement, !this.isAuthenticated);

    const canCreateChannels = hasPermission(permissions, 'canCreateChannels');
    toggleDisabled(this.elements['create-text-channel'] as HTMLButtonElement, !canCreateChannels);
    toggleDisabled(this.elements['create-voice-channel'] as HTMLButtonElement, !canCreateChannels);
    toggleDisabled(this.elements['create-stream-channel'] as HTMLButtonElement, !canCreateChannels);

    const userStatus = this.elements['user-status-text'];
    if (userStatus) {
      const roleLabel = this.currentRoles.length > 0
        ? this.currentRoles.map((role) => role.charAt(0).toUpperCase() + role.slice(1)).join(', ')
        : 'Online';

      if (!this.isAuthenticated) {
        userStatus.textContent = 'Guest';
        userStatus.style.color = 'var(--text-muted)';
      } else if (this.isSuperuser) {
        userStatus.textContent = 'Superuser';
        userStatus.style.color = '#f48024';
      } else if (this.hasManagementAccess) {
        userStatus.textContent = roleLabel;
        userStatus.style.color = '#f48024';
      } else {
        userStatus.textContent = roleLabel;
        userStatus.style.color = '';
      }
    }

    const superuserMenuBtn = this.elements['superuser-menu-btn'] as HTMLButtonElement | undefined;
    if (superuserMenuBtn) {
      superuserMenuBtn.style.display = this.hasManagementAccess ? 'inline-flex' : 'none';
    }

    if (!this.hasManagementAccess) {
      this.toggleSuperuserMenu(false);
      this.closeSuperuserModal();
    }

    this.updateAccountUI();
    this.updateAuthTabs();
  }

  /**
   * Show create channel modal
   */
  private showCreateChannelModal(type: 'text' | 'voice' | 'stream'): void {
    const modal = this.elements.createChannelModal;
    const typeInput = this.elements.newChannelType as HTMLInputElement;
    const nameInput = this.elements.newChannelName as HTMLInputElement;
    const errorEl = this.elements.createChannelError;
    const title = document.getElementById('create-channel-title');

    if (!modal) return;

    // Set type
    if (typeInput) typeInput.value = type;
    
    // Update title
    if (title) {
      const typeLabel = type === 'text' ? 'Text' : type === 'voice' ? 'Voice' : 'Stream';
      title.textContent = `Create ${typeLabel} Channel`;
    }

    // Clear inputs
    if (nameInput) {
      nameInput.value = '';
      nameInput.focus();
    }
    if (errorEl) errorEl.textContent = '';

    modal.style.display = 'flex';
    this.animator.openModal(modal);
    this.soundFX.play('click', 0.4);
  }

  /**
   * Hide create channel modal
   */
  private hideCreateChannelModal(): void {
    const modal = this.elements.createChannelModal;
    if (!modal) return;
    
    this.animator.closeModal(modal, () => {
      modal.style.display = 'none';
    });
  }

  /**
   * Handle create channel
   */
  private handleCreateChannel(): void {
    if (!this.isAuthenticated) {
      this.notifications.warning('Please log in to create channels');
      this.hideCreateChannelModal();
      this.showAuthModal('login');
      return;
    }

    if (!hasPermission(this.rolePermissions, 'canCreateChannels')) {
      this.notifications.warning("You don't have permission to create channels");
      this.hideCreateChannelModal();
      return;
    }

    const nameInput = this.elements.newChannelName as HTMLInputElement;
    const typeInput = this.elements.newChannelType as HTMLInputElement;
    const errorEl = this.elements.createChannelError;

    const name = nameInput?.value?.trim();
    const type = typeInput?.value as 'text' | 'voice' | 'stream';
    
    if (!name) {
      if (errorEl) errorEl.textContent = 'Channel name is required';
      this.soundFX.play('error', 0.5);
      return;
    }

    if (name.length < 3 || name.length > 32) {
      if (errorEl) errorEl.textContent = 'Channel name must be 3-32 characters';
      this.soundFX.play('error', 0.5);
      return;
    }

    // Validate name format
    if (!/^[a-z0-9-]+$/i.test(name)) {
      if (errorEl) errorEl.textContent = 'Only letters, numbers, and hyphens allowed';
      this.soundFX.play('error', 0.5);
      return;
    }

    // Send create request to server
    this.socket.createChannel({ name, type, groupId: null });
    
    this.hideCreateChannelModal();
    this.soundFX.play('success', 0.6);
    this.notifications.info(`Creating ${type} channel: ${name}`);
  }

  /**
   * Show stream info modal
   */
  private showStreamInfoModal(channel: Channel | string): void {
    const modal = this.elements.streamInfoModal;
    const keyDisplay = this.elements.streamKeyDisplay;
    const channelNameDisplay = this.elements.streamChannelName;
    const serverUrlDisplay = this.elements.streamServerUrl;

    if (!modal) return;

    // Get channel name
    const channelName = typeof channel === 'string' ? channel : channel.name;

    // No more complex stream keys - just use the channel name
    if (keyDisplay) keyDisplay.textContent = channelName;
    if (channelNameDisplay) channelNameDisplay.textContent = channelName;

    // Set server URL from environment variable
    if (serverUrlDisplay) serverUrlDisplay.textContent = RTMP_SERVER_URL;

    modal.style.display = 'flex';
    this.animator.openModal(modal);
    this.soundFX.play('click', 0.4);
  }

  /**
   * Hide stream info modal
   */
  private hideStreamInfoModal(): void {
    const modal = this.elements.streamInfoModal;
    if (modal) {
      this.animator.closeModal(modal, () => {
        modal.style.display = 'none';
      });
    }
  }

  /**
   * Initialize emoji picker with common emojis
   */
  private initializeEmojiPicker(): void {
    const emojis = [
      '😀', '😂', '😍', '🥰', '😎', '🤔', '😊', '😢',
      '😭', '😡', '🥺', '😱', '🤗', '🙄', '😴', '🤤',
      '🎉', '🎊', '🎈', '🎁', '🎂', '🏆', '⭐', '✨',
      '👍', '👎', '👏', '🙌', '👋', '🤝', '💪', '🙏',
      '❤️', '💔', '💕', '💖', '💗', '💙', '💚', '💛',
      '🔥', '💯', '⚡', '💥', '💫', '✅', '❌', '❓',
      '💬', '📺', '🎵', '🎮', '🎬', '📱', '💻', '⌨️',
      '🍕', '🍔', '🍟', '🌮', '🍦', '🍰', '☕', '🍺',
    ];

    const grid = this.elements.emojiGrid;
    if (!grid) return;

    grid.innerHTML = '';
    emojis.forEach(emoji => {
      const button = document.createElement('button');
      button.className = 'emoji-btn';
      button.textContent = emoji;
      button.type = 'button';
      button.addEventListener('click', () => this.insertEmoji(emoji));
      grid.appendChild(button);
    });
  }

  /**
   * Toggle emoji picker visibility
   */
  private toggleEmojiPicker(): void {
    const picker = this.elements.emojiPicker;
    if (!picker) return;

    const isVisible = picker.style.display === 'block';
    picker.style.display = isVisible ? 'none' : 'block';
  }

  /**
   * Hide emoji picker
   */
  private hideEmojiPicker(): void {
    const picker = this.elements.emojiPicker;
    if (picker) picker.style.display = 'none';
  }

  /**
   * Insert emoji at cursor position in chat input
   */
  private insertEmoji(emoji: string): void {
    const input = this.elements.chatInput as HTMLInputElement;
    if (!input) return;

    const start = input.selectionStart || 0;
    const end = input.selectionEnd || 0;
    const text = input.value;

    // Insert emoji at cursor position
    input.value = text.substring(0, start) + emoji + text.substring(end);
    
    // Move cursor after emoji
    const newPosition = start + emoji.length;
    input.selectionStart = newPosition;
    input.selectionEnd = newPosition;
    
    // Focus input
    input.focus();
    
    // Hide picker
    this.hideEmojiPicker();
  }

  /**
   * Handle mic device change
   */
  private async handleMicChange(): Promise<void> {
    const select = this.elements.micSelect as HTMLSelectElement;
    const deviceId = select?.value;
    
    if (deviceId) {
      this.state.updateSettings({ micDeviceId: deviceId });
      await this.audio.updateSettings({ micDeviceId: deviceId });
      
      // Update voice if connected
      if (this.state.get('voiceConnected')) {
        await this.syncMicrophoneState(true);
      }
    }
  }

  /**
   * Handle setting change
   */
  private async handleSettingChange(id: string): Promise<void> {
    const element = this.elements[id];
    if (!element) return;

    const updates: Record<string, boolean | number | string> = {};

    if (element instanceof HTMLInputElement) {
      if (element.type === 'checkbox') {
        updates[id] = element.checked;
      } else if (element.type === 'range') {
        updates[id] = parseFloat(element.value);
      }
    }

    this.state.updateSettings(updates);

    // Apply changes
    if (id === 'micGain') {
      this.audio.setMicGain(updates[id] as number);
      if (this.elements.micGainVal) {
        this.elements.micGainVal.textContent = `${(updates[id] as number).toFixed(1)}x`;
      }
    } else if (id === 'outputVol') {
      this.voice.setOutputVolume(updates[id] as number);
      if (this.elements.outputVolVal) {
        this.elements.outputVolVal.textContent = `${Math.round((updates[id] as number) * 100)}%`;
      }
    } else if (['echoCancel', 'noiseSuppression', 'autoGain'].includes(id)) {
      await this.audio.updateSettings(updates);
      
      if (this.state.get('voiceConnected')) {
        await this.syncMicrophoneState(true);
      }
    }
  }

  /**
   * Handle push-to-talk key binding
   */
  private handlePttSetKey(): void {
    this.captureNextKey = true;
    const input = this.elements.pttKey as HTMLInputElement;
    if (input) input.value = 'Press a key…';
  }

  /**
   * Handle key down
   */
  private async handleKeyDown(e: KeyboardEvent): Promise<void> {
    if (e.code === 'Escape') {
      if (this.superuserMenuVisible) {
        this.toggleSuperuserMenu(false);
      }

      const app = this.elements.app;
      if (app && (app.classList.contains('sidebar-open') || app.classList.contains('members-open'))) {
        e.preventDefault();
        app.classList.remove('sidebar-open', 'members-open');
        return;
      }

      const superuserModal = this.elements['superuserModal'] as HTMLElement | undefined;
      if (superuserModal && superuserModal.style.display !== 'none') {
        e.preventDefault();
        this.closeSuperuserModal();
        return;
      }
    }

    if (this.captureNextKey) {
      e.preventDefault();
      const pttKey = e.code;
      this.state.updateSettings({ pttKey });
      const input = this.elements.pttKey as HTMLInputElement;
      if (input) input.value = pttKey;
      this.captureNextKey = false;
      return;
    }

    // Video player keyboard shortcuts (only when not typing in input)
    const target = e.target as HTMLElement;
    const isTyping = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || 
                     target.isContentEditable || target.closest('[contenteditable="true"]');
    
    if (!isTyping) {
      const container = this.elements.inlineVideoContainer as HTMLElement;
      const isVideoVisible = container && container.style.display !== 'none';
      
      if (isVideoVisible) {
        switch (e.code) {
          case 'Space':
          case 'KeyK':
            e.preventDefault();
            this.togglePlayPause();
            break;
          case 'KeyF':
            e.preventDefault();
            this.toggleFullscreen();
            break;
          case 'KeyM':
            e.preventDefault();
            this.toggleMuteVideo();
            break;
          case 'KeyC':
            e.preventDefault();
            this.toggleChatVisibility();
            break;
          case 'ArrowUp':
            e.preventDefault();
            this.adjustVolume(10);
            break;
          case 'ArrowDown':
            e.preventDefault();
            this.adjustVolume(-10);
            break;
        }
      }
    }

    const settings = this.state.get('settings');
    // Don't allow PTT if deafened
    const deafened = this.state.getState().deafened;
    if (settings.pttEnable && e.code === settings.pttKey && !this.pttActive && !deafened) {
      this.pttActive = true;
      this.state.setMuted(false);
      await this.syncMicrophoneState();
      this.announceVoiceState();
      this.soundFX.play('ptt_on', 0.4);
    }
  }

  /**
   * Handle key up
   */
  private async handleKeyUp(e: KeyboardEvent): Promise<void> {
    const settings = this.state.get('settings');
    if (settings.pttEnable && e.code === settings.pttKey && this.pttActive) {
      this.pttActive = false;
      this.state.setMuted(true);
      await this.syncMicrophoneState();
      this.announceVoiceState();
      this.soundFX.play('ptt_off', 0.4);
    }
  }

  /**
   * Handle start mic test
   */
  private async handleTestMicToggle(): Promise<void> {
    const btn = this.elements.testMicBtn as HTMLButtonElement;
    if (!btn) return;

    const isTesting = btn.getAttribute('data-testing') === 'true';

    if (isTesting) {
      // Stop testing
      this.audio.stopLocalStream();
      btn.textContent = 'Test Microphone';
      btn.setAttribute('data-testing', 'false');
      btn.classList.remove('button-danger');
      btn.classList.add('button-secondary');
      this.soundFX.play('click', 0.4);
      this.notifications.info('Microphone test stopped');
    } else {
      // Start testing
      try {
        await this.audio.getLocalStream();
        btn.textContent = 'Stop Test';
        btn.setAttribute('data-testing', 'true');
        btn.classList.remove('button-secondary');
        btn.classList.add('button-danger');
        this.soundFX.play('success', 0.5);
        this.notifications.info('Microphone test started - speak to see level');
      } catch (error) {
        console.error('Error starting mic:', error);
        this.soundFX.play('error', 0.5);
        this.notifications.error('Failed to start microphone. Please check permissions.');
      }
    }
  }

  /**
   * Reset voice-related state and release resources
   */
  private resetVoiceState(options: { playSound?: boolean; notify?: string | null } = {}): void {
    const { playSound = false, notify = null } = options;

    if (playSound) {
      this.soundFX.play('disconnect', 0.7);
    }

    this.stopVoiceSessionTimer();

    this.voice.dispose();
    this.audio.stopLocalStream();
    this.setLocalSpeaking(false);

    if (this.socket.isConnected()) {
      this.socket.leaveVoiceChannel();
    }

    this.state.setVoiceConnected(false);
    this.state.setActiveVoiceChannel(null, null);

    this.voiceUsers.clear();
    this.renderVoiceUsers();
    this.updateVoiceStatusPanel();

    this.pendingVoiceJoin = null;

    const channels = this.state.get('channels') || [];
    this.updateChannelsUI(channels);

    if (notify) {
      this.notifications.info(notify);
    }
  }

  /**
   * Handle voice disconnect
   */
  private handleVoiceDisconnect(): void {
    this.resetVoiceState({ playSound: true, notify: 'Left voice channel' });
  }

  /**
   * Setup video popout drag functionality
   */
  private setupVideoPopoutDrag(): void {
    const popout = this.elements['video-popout'];
    const header = this.elements['video-popout-header'];
    
    if (!popout || !header) return;

    header.addEventListener('mousedown', (e: MouseEvent) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      
      this.isDragging = true;
      const rect = popout.getBoundingClientRect();
      this.dragOffset.x = e.clientX - rect.left;
      this.dragOffset.y = e.clientY - rect.top;
      
      popout.style.transition = 'none';
    });

    document.addEventListener('mousemove', (e: MouseEvent) => {
      if (!this.isDragging) return;
      
      const x = e.clientX - this.dragOffset.x;
      const y = e.clientY - this.dragOffset.y;
      
      popout.style.left = `${x}px`;
      popout.style.top = `${y}px`;
      popout.style.right = 'auto';
      popout.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (this.isDragging) {
        this.isDragging = false;
        popout.style.transition = '';
      }
    });
  }

  /**
   * Toggle video popout visibility / streaming mode
   */
  private toggleVideoPopout(): void {
    const popout = this.elements['video-popout'];
    const btn = this.elements['toggle-video-popout'];
    
    if (!popout) return;
    
    // Toggle streaming mode
    const streamingMode = this.state.toggleStreamingMode();
    
    if (streamingMode) {
      // Entering streaming mode - show video prominently
      popout.classList.remove('hidden');
      if (btn) btn.textContent = '📺';
      this.notifications.info('Streaming mode enabled');
      
      // If on a stream channel, ensure video is loaded
      const channelType = this.state.get('currentChannelType');
      const channel = this.state.get('currentChannel');
      if (channelType === 'stream') {
        // Find channel name from channels list
        const channels = this.state.get('channels');
        const ch = channels.find(c => c.id === channel);
        if (ch) {
          this.player.loadChannel(ch.name);
        }
      }
    } else {
      // Exiting streaming mode - hide video for non-stream channels
      const channelType = this.state.get('currentChannelType');
      if (channelType !== 'stream') {
        popout.classList.add('hidden');
      }
      if (btn) btn.textContent = '📺';
      this.notifications.info('Streaming mode disabled');
    }
  }

  /**
   * Minimize video popout
   */
  private minimizeVideo(): void {
    const popout = this.elements['video-popout'];
    if (!popout) return;
    
    this.isMinimized = !this.isMinimized;
    popout.classList.toggle('minimized', this.isMinimized);
    
    const btn = this.elements['minimize-video'];
    if (btn) {
      btn.textContent = this.isMinimized ? '□' : '—';
      btn.setAttribute('title', this.isMinimized ? 'Restore' : 'Minimize');
    }
  }

  /**
   * Close video popout
   */
  private closeVideo(): void {
    const popout = this.elements['video-popout'];
    if (!popout) return;
    
    popout.classList.add('hidden');
    this.isMinimized = false;
    popout.classList.remove('minimized');
  }

  /**
   * Show inline video player for stream channels (theater mode)
   */
  private async showInlineVideo(channelName: string): Promise<void> {
    const container = this.elements.inlineVideoContainer as HTMLElement;
    const video = this.elements.inlineVideo as HTMLVideoElement;
    const overlay = this.elements.inlinePlayerOverlay as HTMLElement;
    
    if (!container || !video) {
      console.error('Inline video elements not found');
      return;
    }

    const mobileTitle = this.elements.mobileStreamTitle as HTMLElement | undefined;
    if (mobileTitle) {
      mobileTitle.textContent = `Live: ${channelName}`;
    }

    if (this.isMobileLayout() && !this.mobileStreamMode) {
      this.setMobileStreamMode(true);
    }

    // Clear any pending retry timers
    if (this.streamRetryTimer) {
      clearTimeout(this.streamRetryTimer);
      this.streamRetryTimer = null;
    }

    // Destroy existing HLS instance if any
    if (this.inlineHls) {
      try {
        this.inlineHls.destroy();
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error('Error destroying HLS instance:', error);
        }
      } finally {
        this.inlineHls = null;
      }
    }

    // Hide popup video
    this.closeVideo();

    // Show inline video container
    container.style.display = 'block';

    // Show loading overlay
    if (overlay) {
      overlay.style.display = 'flex';
      const msg = overlay.querySelector('.message');
      if (msg) msg.textContent = 'Checking stream...';
    }
    
    // Hide live badge initially while loading
    const liveBadge = document.querySelector('.live-indicator-badge') as HTMLElement;
    if (liveBadge) {
      liveBadge.style.display = 'none';
    }

    // Update loading message - try to load stream directly
    // Let HLS.js handle errors if stream is not available
    if (overlay) {
      const msg = overlay.querySelector('.message');
      if (msg) msg.textContent = 'Connecting to stream...';
    }

    // Load HLS stream using channel name directly
    // No more stream keys - just use the channel name
    const streamUrl = `${HLS_BASE_URL}/${channelName}/index.m3u8`;
    
    if (import.meta.env.DEV) {
      console.log('Loading inline stream:', streamUrl);
    }
    
    // Check if HLS.js is available
    if (!(window as any).Hls) {
      console.error('HLS.js not loaded! Make sure the script tag is in index.html');
      if (overlay) {
        const msg = overlay.querySelector('.message');
        if (msg) msg.textContent = 'HLS.js not loaded';
      }
      return;
    }
    
    if ((window as any).Hls.isSupported()) {
      // Destroy previous HLS instance if exists
      if (this.inlineHls) {
        this.inlineHls.destroy();
        this.inlineHls = null;
      }
      
      // Create new HLS.js instance with optimized buffering settings
      this.inlineHls = new (window as any).Hls({
        enableWorker: true,
        lowLatencyMode: false, // Disable for better buffering
        debug: false,
        maxBufferLength: 10, // Buffer up to 10 seconds
        maxMaxBufferLength: 30, // Max buffer 30 seconds
        maxBufferSize: 60 * 1000 * 1000, // 60 MB buffer
        maxBufferHole: 0.5, // Jump over small gaps
        highBufferWatchdogPeriod: 2, // Check buffer health every 2s
        nudgeOffset: 0.1, // Small nudge to recover from stalls
        nudgeMaxRetry: 5, // Retry nudging up to 5 times
        liveSyncDuration: 3, // Sync to 3 seconds from live edge
        liveMaxLatencyDuration: 10, // Max 10s behind live
        liveDurationInfinity: true, // Handle continuous streams
      });
      
      this.inlineHls.loadSource(streamUrl);
      this.inlineHls.attachMedia(video);
      
      this.inlineHls.on((window as any).Hls.Events.MANIFEST_PARSED, () => {
        console.log('✅ HLS manifest parsed successfully, playing video');
        if (overlay) overlay.style.display = 'none';
        // Show live badge when stream is available
        const liveBadge = document.querySelector('.live-indicator-badge') as HTMLElement;
        if (liveBadge) {
          liveBadge.style.display = 'flex';
        }
        
        // Update stream watching indicator now that video is loaded
        this.updateStreamWatchingIndicator();
        
        // Refresh channel list to show watching-stream indicator
        const channels = this.state.get('channels');
        if (channels) {
          this.updateChannelsUI(channels);
        }
        video.play().catch((err: Error) => {
          console.warn('Autoplay blocked:', err);
          // Show play button overlay
          if (overlay) {
            overlay.style.display = 'flex';
            const msg = overlay.querySelector('.message');
            if (msg) msg.textContent = 'Click to play';
            overlay.style.cursor = 'pointer';
            overlay.onclick = () => {
              video.play();
              overlay.style.display = 'none';
              overlay.onclick = null;
            };
          }
        });
      });
      
      this.inlineHls.on((window as any).Hls.Events.ERROR, (_event: any, data: any) => {
        console.error('❌ HLS error:', data);
        if (data.fatal) {
          if (overlay) {
            overlay.style.display = 'flex';
            const msg = overlay.querySelector('.message');
            if (msg) {
              if (data.type === (window as any).Hls.ErrorTypes.NETWORK_ERROR) {
                msg.textContent = 'Stream Offline - Waiting for stream...';
                // Auto-retry every 5 seconds for network errors
                // Clear any existing retry timer first
                if (this.streamRetryTimer) {
                  clearTimeout(this.streamRetryTimer);
                }
                this.streamRetryTimer = setTimeout(() => {
                  if (this.inlineHls && this.state.get('currentChannelType') === 'stream') {
                    console.log('🔄 Retrying stream connection...');
                    this.inlineHls.loadSource(streamUrl);
                  }
                  this.streamRetryTimer = null;
                }, 5000) as unknown as number;
              } else if (data.type === (window as any).Hls.ErrorTypes.MEDIA_ERROR) {
                msg.textContent = 'Media error - Recovering...';
                // Try to recover from media errors
                this.inlineHls?.recoverMediaError();
              } else {
                msg.textContent = 'Stream error';
              }
            }
          }
          // Hide live badge when stream is offline
          const liveBadge = document.querySelector('.live-indicator-badge') as HTMLElement;
          if (liveBadge) {
            liveBadge.style.display = 'none';
          }
        }
      });
      
      console.log('HLS.js instance created and attached');
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari on iOS/macOS)
      if (import.meta.env.DEV) {
        console.log('Using native HLS support');
      }
      video.src = streamUrl;
      video.addEventListener('loadeddata', () => {
        if (overlay) overlay.style.display = 'none';
      }, { once: true });
      video.play().catch((err: Error) => {
        console.warn('Autoplay blocked:', err);
      });
    } else {
      console.error('HLS not supported in this browser');
      if (overlay) {
        const msg = overlay.querySelector('.message');
        if (msg) msg.textContent = 'HLS not supported';
      }
    }
  }

  /**
   * Close inline video player
   */
  private closeInlineVideo(): void {
    const container = this.elements.inlineVideoContainer as HTMLElement;
    const video = this.elements.inlineVideo as HTMLVideoElement;
    
    // Clear any pending retry timers
    if (this.streamRetryTimer) {
      clearTimeout(this.streamRetryTimer);
      this.streamRetryTimer = null;
    }
    
    // Destroy HLS instance
    if (this.inlineHls) {
      try {
        this.inlineHls.destroy();
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error('Error destroying HLS instance:', error);
        }
      } finally {
        this.inlineHls = null;
      }
    }
    
    // Hide container
    if (container) container.style.display = 'none';
    
    // Stop and clear video
    if (video) {
      video.pause();
      video.src = '';
      video.load(); // Reset video element
    }
    
    // Update stream watching indicator since video is now closed
    this.updateStreamWatchingIndicator();
    
    // Refresh channel list to remove watching-stream indicator
    const channels = this.state.get('channels');
    if (channels) {
      this.updateChannelsUI(channels);
    }

    if (this.mobileStreamMode && this.isMobileLayout()) {
      this.mobileStreamMode = false;
      const app = this.elements.app;
      app?.classList.remove('mobile-stream-mode');
    }
  }



  /**
   * Close theater mode video
   */
  private toggleTheaterMode(): void {
    // Simply close the inline video - user can reopen by clicking stream channel
    this.closeInlineVideo();
  }

  /**
   * Toggle play/pause for inline video
   */
  private togglePlayPause(): void {
    const video = this.elements.inlineVideo as HTMLVideoElement;
    if (!video) return;

    if (video.paused) {
      video.play().catch((err: Error) => {
        console.warn('Cannot play video:', err);
      });
    } else {
      video.pause();
    }
  }

  /**
   * Update play/pause button icon
   */
  private updatePlayPauseButton(isPaused: boolean): void {
    const btn = this.elements.playPauseBtn;
    if (!btn) return;

    const icon = btn.querySelector('.icon');
    if (icon) {
      icon.textContent = isPaused ? '▶️' : '⏸️';
    }
    btn.setAttribute('aria-label', isPaused ? 'Play' : 'Pause');
    btn.setAttribute('title', isPaused ? 'Play' : 'Pause');
  }

  /**
   * Toggle mute/unmute for inline video
   */
  private toggleMuteVideo(): void {
    const video = this.elements.inlineVideo as HTMLVideoElement;
    if (!video) return;

    video.muted = !video.muted;
    this.updateVolumeDisplay();
  }

  /**
   * Handle volume slider change
   */
  private handleVolumeChange(event: Event): void {
    const slider = event.target as HTMLInputElement;
    const video = this.elements.inlineVideo as HTMLVideoElement;
    
    if (!video || !slider) return;

    const volume = parseInt(slider.value) / 100;
    video.volume = volume;
    video.muted = volume === 0;
  }

  /**
   * Update volume icon and slider
   */
  private updateVolumeDisplay(): void {
    const video = this.elements.inlineVideo as HTMLVideoElement;
    const icon = this.elements.volumeIcon;
    const slider = this.elements.volumeSlider as HTMLInputElement;
    
    if (!video) return;

    // Update slider
    if (slider) {
      slider.value = video.muted ? '0' : String(Math.round(video.volume * 100));
    }

    // Update icon
    if (icon) {
      if (video.muted || video.volume === 0) {
        icon.textContent = '🔇';
      } else if (video.volume < 0.5) {
        icon.textContent = '🔉';
      } else {
        icon.textContent = '🔊';
      }
    }
  }

  /**
   * Toggle fullscreen mode
   */
  private toggleFullscreen(): void {
    const container = this.elements.inlineVideoContainer as HTMLElement;
    if (!container) return;

    if (!document.fullscreenElement) {
      // Enter fullscreen
      container.requestFullscreen().then(() => {
        container.classList.add('fullscreen');
        const btn = this.elements.fullscreenBtn;
        if (btn) {
          const icon = btn.querySelector('.icon');
          if (icon) icon.textContent = '⛶';
        }
      }).catch((err: Error) => {
        console.error('Error entering fullscreen:', err);
      });
    } else {
      // Exit fullscreen
      document.exitFullscreen().then(() => {
        container.classList.remove('fullscreen');
        const btn = this.elements.fullscreenBtn;
        if (btn) {
          const icon = btn.querySelector('.icon');
          if (icon) icon.textContent = '⛶';
        }
      });
    }
  }

  /**
   * Toggle chat visibility (for fullscreen mode)
   */
  private toggleChatVisibility(): void {
    const chatMessages = this.elements.msgs;
    const chatInput = this.elements['chat-input-container'];
    const membersList = this.elements['members-list'];
    
    if (!chatMessages) return;

    // Toggle visibility
    const isHidden = chatMessages.classList.contains('hidden-in-fullscreen');
    
    if (isHidden) {
      chatMessages.classList.remove('hidden-in-fullscreen');
      chatInput?.classList.remove('hidden-in-fullscreen');
      membersList?.classList.remove('hidden-in-fullscreen');
      this.notifications.info('Chat shown');
    } else {
      chatMessages.classList.add('hidden-in-fullscreen');
      chatInput?.classList.add('hidden-in-fullscreen');
      membersList?.classList.add('hidden-in-fullscreen');
      this.notifications.info('Chat hidden');
    }
  }

  /**
   * Adjust volume by a delta
   */
  private adjustVolume(delta: number): void {
    const video = this.elements.inlineVideo as HTMLVideoElement;
    const slider = this.elements.volumeSlider as HTMLInputElement;
    
    if (!video || !slider) return;

    const currentVolume = video.muted ? 0 : Math.round(video.volume * 100);
    const newVolume = Math.max(0, Math.min(100, currentVolume + delta));
    
    video.volume = newVolume / 100;
    video.muted = newVolume === 0;
    slider.value = String(newVolume);
    
    this.updateVolumeDisplay();
  }

  /**
   * Setup channel listeners for switching
   */
  private setupChannelListeners(): void {
    // Text channels - don't load video
    this.elements['text-channels']?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const channelItem = target.closest('.channel-item');
      if (channelItem) {
        const channelId = channelItem.getAttribute('data-channel-id');
        const channelName = channelItem.getAttribute('data-channel');
        const channelType = channelItem.getAttribute('data-type') || 'text';
        if (channelId && channelName) {
          this.switchChannel(channelId, channelName, channelType as 'text' | 'voice' | 'stream');
        }
      }
    });

    // Voice channels - join voice, don't load video
    this.elements.channelsList?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      
      // Note: Join button clicks are handled by the button's own event listener
      // which calls stopPropagation(), so they won't reach here
      
      // Handle channel item clicks (for navigation only - visual selection)
      // Don't actually join voice channel, just mark as active
      const channelItem = target.closest('.channel-item');
      // Check if we're clicking the button or inside the button
      const isButtonClick = target.classList.contains('join-channel-btn') || target.closest('.join-channel-btn');
      if (channelItem && !isButtonClick) {
        const channelId = channelItem.getAttribute('data-channel-id');
        const channelName = channelItem.getAttribute('data-channel');
        if (channelId && channelName) {
          // Just update visual state - join socket room but don't connect voice
          // This allows seeing who's in the channel without joining voice
          this.socket.joinChannel(channelId);
          
          // Remove active class from all voice channels
          document.querySelectorAll('#channelsList .channel-item').forEach(item => {
            item.classList.remove('active');
          });
          // Add active class to clicked channel
          channelItem.classList.add('active');
          
          // Update current channel in state (for UI purposes)
          this.state.setChannelWithType(channelId, 'voice');
          
          // Hide chat for voice channels
          this.hideChatUI();
          
          if (import.meta.env.DEV) {
            console.log('📍 Voice channel selected (viewing, not voice connected):', channelName);
          }
        }
      }
    });

    // Stream channels - load video only
    const streamChannels = this.elements['stream-channels'];
    streamChannels?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const channelItem = target.closest('.channel-item');
      if (channelItem) {
        const channelId = channelItem.getAttribute('data-channel-id');
        const channelName = channelItem.getAttribute('data-channel');
        if (channelId && channelName) {
          this.switchChannel(channelId, channelName, 'stream');
        }
      }
    });
  }

  /**
   * Switch to a different channel
   */
  private switchChannel(channelId: string, channelName: string, type: 'text' | 'voice' | 'stream'): void {
    // Play channel switch sound
    this.soundFX.play('click', 0.5);
    
    // Animate channel switch
    const chatContent = document.querySelector('.chat-content');
    if (chatContent) {
      this.animator.animateChannelSwitch(chatContent as HTMLElement, () => {
        this.performChannelSwitch(channelId, channelName, type);
      });
    } else {
      this.performChannelSwitch(channelId, channelName, type);
    }
  }
  
  private performChannelSwitch(channelId: string, channelName: string, type: 'text' | 'voice' | 'stream'): void {
    // Remove active class from all channels
    document.querySelectorAll('.channel-item').forEach(item => {
      item.classList.remove('active');
    });
    
    // Add active class to selected channel
    const selectedChannel = document.querySelector(`[data-channel-id="${channelId}"]`);
    selectedChannel?.classList.add('active');
    
    // Update channel name in header
    const channelIcon = type === 'text' ? '#' : type === 'voice' ? '🔊' : '📺';
    if (this.elements['current-channel-name']) {
      this.elements['current-channel-name'].textContent = channelName;
    }
    
    // Update channel icon in header
    const headerIcon = document.querySelector('.chat-header .channel-icon');
    if (headerIcon) {
      headerIcon.textContent = channelIcon;
    }
    
    // Update chat visibility and input placeholder based on channel type
    const chatInput = this.elements.chatInput as HTMLInputElement;
    
    if (type === 'voice') {
      // Hide chat for voice channels
      this.hideChatUI();
    } else {
      // Show chat for text and stream channels
      this.showChatUI();
      
      if (chatInput) {
        if (type === 'text') {
          chatInput.placeholder = `Message #${channelName}`;
          chatInput.disabled = false;
        } else if (type === 'stream') {
          chatInput.placeholder = `Chat in 📺${channelName}`;
          chatInput.disabled = false;
        }
      }
    }
    
    // Update state
    this.state.setChannelWithType(channelId, type);
    
    // Clear chat messages when switching channels
    if (this.elements.msgs) {
      this.elements.msgs.innerHTML = '';
    }

    if (this.isMobileLayout()) {
      if (type === 'stream') {
        this.setMobileStreamMode(true);
      } else {
        this.setMobileStreamMode(false);
        this.closeInlineVideo();
      }
    }
    
    // Handle differently based on type
    if (type === 'text') {
      // Text channel: join for chat
      this.socket.joinChannel(channelId);
      
      // Keep inline video open if user is voice-connected (allows watching streams while in voice)
      // Only close if not voice-connected
      const voiceConnected = this.state.get('voiceConnected');
      if (!voiceConnected) {
        this.closeInlineVideo();
      }
      
      if (!this.state.get('streamingMode')) {
        this.closeVideo();
      }
    } else if (type === 'voice') {
      // Voice channel: just navigate, keep inline video if watching stream
      this.socket.joinChannel(channelId);
      
      // Keep inline video open if streaming mode or watching a stream
      // Only close popup video
      if (!this.state.get('streamingMode')) {
        this.closeVideo();
      }
    } else if (type === 'stream') {
      // Stream channel: load video stream in inline player by default (theater mode)
      // This works seamlessly with voice - users can be in voice and watch streams
      this.socket.joinChannel(channelId);
      
      // Close popup video if open
      this.closeVideo();
      
      // Show inline video (theater mode) - always use theater mode for best experience
      // The video will update if switching between different streams
      this.showInlineVideo(channelName);
      
      // Update stream watching indicator if user is in voice
      this.updateStreamWatchingIndicator();
    }
  }

  /**
   * Handle voice channel join (connect to WebRTC)
   */
  private async handleVoiceChannelJoin(channelId: string, channelName: string): Promise<void> {
    if (!this.isAuthenticated) {
      this.notifications.warning('Please log in to join voice channels');
      this.showAuthModal('login');
      return;
    }

    const channels = this.state.get('channels');
    const channel = channels.find((ch) => ch.id === channelId);

    if (!channel || channel.type !== 'voice') {
      this.notifications.error('Cannot join voice: selected channel is not a voice channel');
      return;
    }

    const activeVoiceChannelId = this.state.get('activeVoiceChannelId');
    if (this.state.get('voiceConnected') && activeVoiceChannelId === channelId) {
      this.notifications.info(`Already connected to ${channelName}`);
      return;
    }

    if (this.pendingVoiceJoin && this.pendingVoiceJoin.id === channelId) {
      this.notifications.info('Already connecting to this voice channel...');
      return;
    }

    if (this.pendingVoiceJoin && this.pendingVoiceJoin.id !== channelId) {
      this.resetVoiceState();
    }

    try {
      if (this.state.get('voiceConnected') && activeVoiceChannelId && activeVoiceChannelId !== channelId) {
        this.handleVoiceDisconnect();
      }

      if (import.meta.env.DEV) {
        console.log('🎤 Joining voice channel:', channelName);
      }

      this.pendingVoiceJoin = { id: channelId, name: channelName };

      // IMPORTANT: Join the socket room first so we can receive WebRTC signaling
      this.socket.joinChannel(channelId);

  // Align microphone state with current mute/deafen preferences
  await this.syncMicrophoneState(true);

      this.notifications.info(`Connecting to voice in ${channelName}...`);

      // Tell server we're joining voice (this triggers WebRTC peer connections)
      this.socket.joinVoiceChannel(channelId);
    } catch (error) {
      this.resetVoiceState();
      console.error('Error joining voice:', error);
      this.soundFX.play('error', 0.5);
      this.notifications.error(error instanceof Error ? error.message : 'Failed to join voice');
    }
  }

  /**
   * Handle users update
   */
  private handleUsersUpdate(users: User[]): void {
    this.state.setUsers(users);
    this.updatePresenceUI(users);
  }

  /**
   * Handle channels update
   */
  private handleChannelsUpdate(data: Channel[] | { channels: Channel[]; groups?: unknown[] }): void {
    // Handle both array format (legacy) and object format {channels, groups}
    const channels = Array.isArray(data) ? data : data.channels;
    if (import.meta.env.DEV) {
      console.log('📋 handleChannelsUpdate - Received channels:', channels);
    }
    this.state.setChannels(channels);
    this.syncVoiceSessionFromChannels(channels);
    this.updateChannelsUI(channels);

    if (this.hasManagementAccess && this.activeSuperuserTab === 'channels') {
      this.renderSuperuserChannels();
    }
  }

  /**
   * Handle chat message
   */
  private handleChatMessage(message: ChatMessage): void {
    this.appendChatMessage(message);
  }

  private handleChatHistory(messages: ChatMessage[]): void {
    // Display all historical messages
    messages.forEach((message) => {
      this.appendChatMessage(message);
    });
  }

  /**
   * Handle voice joined (receive existing peers when joining channel)
   */
  private handleVoiceJoined(data: { channelId: string; peers: VoicePeerEvent[]; startedAt?: number | null; sessionId?: string | null }): void {
    if (import.meta.env.DEV) {
      console.log('Voice joined confirmation received:', data);
    }

    const channels = this.state.get('channels');
    const channel = channels.find((ch) => ch.id === data.channelId);
    const channelName = channel?.name || this.pendingVoiceJoin?.name || data.channelId;

    this.pendingVoiceJoin = null;

    this.state.setActiveVoiceChannel(data.channelId, channelName);
    this.state.setVoiceConnected(true);

  const sessionStart = typeof data.startedAt === 'number' ? data.startedAt : Date.now();
  const sessionId = data.sessionId ?? null;
  this.startVoiceSessionTimer(sessionStart, sessionId);

    void this.syncMicrophoneState();
    this.announceVoiceState();

    this.voiceUsers.clear();
    data.peers.forEach((peer) => {
      const label = this.resolveUserLabel(peer.name, peer.id);
      this.voiceUsers.set(peer.id, {
        id: peer.id,
        name: label,
        muted: Boolean(peer.muted),
        deafened: Boolean(peer.deafened),
        speaking: false,
      });
    });

    this.updateVoiceStatusPanel();
    this.renderVoiceUsers();

    this.updateChannelsUI(channels);

    this.soundFX.play('call', 0.6);
    this.notifications.success(`Joined voice in ${channelName}`);
  }

  /**
   * Handle voice peer join
   */
  private async handleVoicePeerJoin(data: VoicePeerEvent): Promise<void> {
    try {
      this.addVoiceUser(data);
      await this.voice.createOffer(data.id);
    } catch (error) {
      console.error('Error creating offer:', error);
    }
  }

  /**
   * Handle voice peer leave
   */
  private handleVoicePeerLeave(data: { id: string }): void {
    this.removeVoiceUser(data.id);
    this.voice.removePeer(data.id);
  }

  private handleVoicePeerState(data: { id: string; muted: boolean; deafened: boolean }): void {
    const voiceUser = this.voiceUsers.get(data.id);
    if (!voiceUser) {
      return;
    }

    voiceUser.muted = data.muted;
    voiceUser.deafened = data.deafened;
    this.renderVoiceUsers();
  }

  /**
   * Handle voice signal
   */
  private async handleVoiceSignal(data: { from: string; data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } }): Promise<void> {
    try {
      if (data.data.sdp) {
        if (data.data.sdp.type === 'offer') {
          await this.voice.handleOffer(data.from, data.data.sdp);
        } else if (data.data.sdp.type === 'answer') {
          await this.voice.handleAnswer(data.from, data.data.sdp);
        }
      } else if (data.data.candidate) {
        await this.voice.handleIceCandidate(data.from, data.data.candidate);
      }
    } catch (error) {
      console.error('Error handling voice signal:', error);
    }
  }

  // UI Update Methods

  private updateAccountUI(): void {
    const account = this.state.get('account');
    const identifierFallback = this.scrubIdentifierForDisplay(account?.username ?? '');
    const displayLabel = account?.displayName && account.displayName.trim().length > 0
      ? account.displayName
      : identifierFallback || 'Guest';

    if (this.elements.accName) {
      this.elements.accName.textContent = displayLabel;
    }

    const avatarEl = this.elements['user-avatar'];
    if (avatarEl) {
      const svgMarkup = generateIdenticonSvg(displayLabel, {
        size: 48,
        label: `${displayLabel} avatar`,
      });
      avatarEl.innerHTML = svgMarkup;
      avatarEl.setAttribute('title', displayLabel);
      avatarEl.setAttribute('aria-label', `${displayLabel} avatar`);
      avatarEl.setAttribute('data-initial', displayLabel.charAt(0).toUpperCase());
      avatarEl.classList.toggle('is-superuser', this.isSuperuser);
    }

    const usernameInput = this.elements.regUsername as HTMLInputElement | undefined;
    if (usernameInput && this.authMode !== 'register') {
      usernameInput.value = account?.username || '';
    }

    if (this.authMode === 'profile') {
      const displayNameInput = this.elements.regDisplayName as HTMLInputElement | undefined;
      if (displayNameInput && !this.authSubmitting) {
        if (account?.displayName && account.displayName.trim().length > 0) {
          displayNameInput.value = account.displayName;
        } else {
          displayNameInput.value = identifierFallback;
        }
      }

      const emailInput = this.elements.regEmail as HTMLInputElement | undefined;
      if (emailInput && !this.authSubmitting) {
        emailInput.value = account?.email || '';
      }

      const bioInput = this.elements.regBio as HTMLTextAreaElement | undefined;
      if (bioInput && !this.authSubmitting) {
        bioInput.value = account?.bio || '';
      }
    }
  }

  private updateSettingsUI(): void {
    const settings = this.state.get('settings');
    
    const checkboxIds = ['echoCancel', 'noiseSuppression', 'autoGain', 'pttEnable'];
    checkboxIds.forEach(id => {
      const el = this.elements[id] as HTMLInputElement;
      if (el) el.checked = settings[id as keyof typeof settings] as boolean;
    });

    const rangeIds = ['micGain', 'outputVol'];
    rangeIds.forEach(id => {
      const el = this.elements[id] as HTMLInputElement;
      if (el) el.value = String(settings[id as keyof typeof settings]);
    });

    const pttKeyInput = this.elements.pttKey as HTMLInputElement;
    if (pttKeyInput) pttKeyInput.value = settings.pttKey;

    if (this.elements.micGainVal) {
      this.elements.micGainVal.textContent = `${settings.micGain.toFixed(1)}x`;
    }
    if (this.elements.outputVolVal) {
      this.elements.outputVolVal.textContent = `${Math.round(settings.outputVol * 100)}%`;
    }
  }

  private toggleSuperuserMenu(force?: boolean): void {
    if (!this.hasManagementAccess && force !== false) {
      return;
    }

    const desired = force !== undefined ? force : !this.superuserMenuVisible;
    const open = desired && this.hasManagementAccess;
    this.superuserMenuVisible = open;

    const menu = this.elements['superuser-menu'];
    const button = this.elements['superuser-menu-btn'] as HTMLButtonElement | undefined;

    if (menu) {
      menu.classList.toggle('is-visible', open);
      menu.setAttribute('aria-hidden', open ? 'false' : 'true');
    }

    if (button) {
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  }

  private handleDocumentClick(event: MouseEvent): void {
    if (!this.superuserMenuVisible) {
      return;
    }

    const menu = this.elements['superuser-menu'];
    const button = this.elements['superuser-menu-btn'];
    const target = event.target as Node;

    if (menu && !menu.contains(target) && button && !button.contains(target)) {
      this.toggleSuperuserMenu(false);
    }
  }

  private openSuperuserModal(tab: 'users' | 'channels' = 'users'): void {
    if (!this.hasManagementAccess) {
      return;
    }

    const modal = this.elements['superuserModal'];
    if (!modal) {
      return;
    }

    this.animator.openModal(modal);
    this.soundFX.play('click', 0.4);
    this.switchSuperuserTab(tab);
  }

  private closeSuperuserModal(): void {
    const modal = this.elements['superuserModal'];
    if (!modal || modal.style.display === 'none') {
      return;
    }

    this.animator.closeModal(modal, () => {
      this.activeSuperuserTab = 'users';
    });
  }

  private switchSuperuserTab(tab: 'users' | 'channels'): void {
    if (!this.hasManagementAccess) {
      return;
    }

    this.activeSuperuserTab = tab;

    const usersTab = this.elements['superuserTabUsers'] as HTMLButtonElement | undefined;
    const channelsTab = this.elements['superuserTabChannels'] as HTMLButtonElement | undefined;

    if (usersTab) {
      usersTab.setAttribute('aria-selected', tab === 'users' ? 'true' : 'false');
      usersTab.classList.toggle('active', tab === 'users');
    }

    if (channelsTab) {
      channelsTab.setAttribute('aria-selected', tab === 'channels' ? 'true' : 'false');
      channelsTab.classList.toggle('active', tab === 'channels');
    }

    const usersPanel = this.elements['superuserUsersPanel'] as HTMLElement | undefined;
    if (usersPanel) {
      usersPanel.hidden = tab !== 'users';
      usersPanel.classList.toggle('active', tab === 'users');
    }

    const channelsPanel = this.elements['superuserChannelsPanel'] as HTMLElement | undefined;
    if (channelsPanel) {
      channelsPanel.hidden = tab !== 'channels';
      channelsPanel.classList.toggle('active', tab === 'channels');
    }

    if (tab === 'users') {
      this.ensureAccountsLoaded();
      this.renderSuperuserUsers();
    } else {
      this.renderSuperuserChannels();
    }
  }

  private ensureAccountsLoaded(): void {
    if (!this.hasManagementAccess) {
      return;
    }

    const accounts = this.state.get('accounts') || [];
    if (accounts.length > 0 || this.loadingAccounts) {
      return;
    }

    this.loadingAccounts = true;
    this.socket.requestAccountList();

    const list = this.elements['superuserUsersList'];
    if (list) {
      list.innerHTML = '<div class="superuser-empty">Loading accounts…</div>';
    }
  }

  private renderSuperuserUsers(): void {
    const container = this.elements['superuserUsersList'] as HTMLElement | undefined;
    if (!container) {
      return;
    }

    if (!this.hasManagementAccess) {
      container.innerHTML = '';
      return;
    }

    const accounts = [...(this.state.get('accounts') ?? [])];

    if (accounts.length === 0) {
      container.innerHTML = '<div class="superuser-empty">No accounts available yet.</div>';
      return;
    }

    container.innerHTML = '';

    const currentAccountId = this.state.get('account')?.id ?? null;

    accounts.sort((a, b) => {
      const disabledDiff = (a.status === 'disabled' ? 1 : 0) - (b.status === 'disabled' ? 1 : 0);
      if (disabledDiff !== 0) {
        return disabledDiff;
      }

      const superDiff = (a.roles?.includes('superuser') ? 0 : 1) - (b.roles?.includes('superuser') ? 0 : 1);
      if (superDiff !== 0) {
        return superDiff;
      }

      return a.username.localeCompare(b.username);
    });

    accounts.forEach((account) => {
      const card = document.createElement('div');
      card.className = 'superuser-account-card';
      card.dataset.accountId = account.id;

      const info = document.createElement('div');
      info.className = 'superuser-account-info';

      const displayName = account.displayName || account.username;
      const nameEl = document.createElement('div');
      nameEl.className = 'superuser-account-name';
      nameEl.textContent = displayName;

      if (account.id === currentAccountId) {
        const you = document.createElement('span');
        you.textContent = ' (You)';
        you.style.color = 'var(--text-muted)';
        you.style.fontSize = '12px';
        nameEl.appendChild(you);
      }

      info.appendChild(nameEl);

      const meta = document.createElement('div');
      meta.className = 'superuser-account-meta';
      const usernameSpan = document.createElement('span');
      usernameSpan.textContent = `@${account.username}`;
      meta.appendChild(usernameSpan);

      if (account.createdAt) {
        const joinedSpan = document.createElement('span');
        joinedSpan.textContent = `Joined ${this.formatDate(account.createdAt)}`;
        meta.appendChild(joinedSpan);
      }

      info.appendChild(meta);

      const rolesContainer = document.createElement('div');
      rolesContainer.className = 'superuser-account-meta';
      (account.roles || []).forEach((role) => {
        const badge = document.createElement('span');
        badge.className = 'superuser-role-tag';
        if (role === 'superuser') {
          badge.classList.add('superuser');
        }
        badge.textContent = this.formatRoleLabel(role);
        rolesContainer.appendChild(badge);
      });

      if (rolesContainer.childElementCount > 0) {
        info.appendChild(rolesContainer);
      }

      const status = document.createElement('div');
      status.className = 'superuser-account-status';
      if (account.status === 'disabled') {
        status.classList.add('disabled');
        status.textContent = 'Status: Disabled';
      } else {
        status.textContent = 'Status: Active';
      }
      info.appendChild(status);

      const actions = document.createElement('div');
      actions.className = 'superuser-account-actions';

      if (account.status === 'disabled') {
        const enableBtn = document.createElement('button');
        enableBtn.type = 'button';
        enableBtn.className = 'superuser-action-btn';
        enableBtn.textContent = 'Enable';
        enableBtn.dataset.action = 'enable-account';
        enableBtn.dataset.accountId = account.id;
        actions.appendChild(enableBtn);
      } else {
        const disableBtn = document.createElement('button');
        disableBtn.type = 'button';
        disableBtn.className = 'superuser-action-btn danger';
        disableBtn.textContent = 'Disable';
        disableBtn.dataset.action = 'disable-account';
        disableBtn.dataset.accountId = account.id;

        if (account.id === currentAccountId || account.roles?.includes('superuser')) {
          disableBtn.disabled = true;
          disableBtn.title = account.id === currentAccountId
            ? 'You cannot disable your own account.'
            : 'Superuser accounts cannot be disabled from this menu.';
        }

        actions.appendChild(disableBtn);
      }

      card.appendChild(info);
      card.appendChild(actions);
      container.appendChild(card);
    });
  }

  private renderSuperuserChannels(): void {
    const container = this.elements['superuserChannelsList'] as HTMLElement | undefined;
    if (!container) {
      return;
    }

    if (!this.hasManagementAccess) {
      container.innerHTML = '';
      return;
    }

    const channels = [...(this.state.get('channels') ?? [])];

    container.innerHTML = '';

    if (channels.length === 0) {
      container.innerHTML = '<div class="superuser-empty">No channels available yet.</div>';
      return;
    }

    const canDelete = hasPermission(this.rolePermissions, 'canDeleteChannels');
    const currentChannelName = this.state.get('currentChannel');
    const activeVoiceChannelId = this.state.get('activeVoiceChannelId');

    channels.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type.localeCompare(b.type);
      }
      return a.name.localeCompare(b.name);
    });

    channels.forEach((channel) => {
      const card = document.createElement('div');
      card.className = 'superuser-channel-card';
      card.dataset.channelId = channel.id;

      const info = document.createElement('div');
      info.className = 'superuser-channel-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'superuser-channel-name';
      nameEl.textContent = channel.name;
      info.appendChild(nameEl);

      const meta = document.createElement('div');
      meta.className = 'superuser-channel-meta';

      const typeSpan = document.createElement('span');
      typeSpan.textContent = `Type: ${this.formatChannelType(channel.type)}`;
      meta.appendChild(typeSpan);

      const countSpan = document.createElement('span');
      countSpan.textContent = `Members: ${channel.count ?? 0}`;
      meta.appendChild(countSpan);

      if (channel.type === 'stream' && channel.isLive) {
        const liveSpan = document.createElement('span');
        liveSpan.textContent = 'Live now';
        meta.appendChild(liveSpan);
      }

      info.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'superuser-channel-actions';

      if (canDelete) {
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'superuser-action-btn danger';
        deleteBtn.textContent = 'Delete Channel';
        deleteBtn.dataset.action = 'delete-channel';
        deleteBtn.dataset.channelName = channel.name;
        deleteBtn.dataset.channelId = channel.id;

        if (channel.name === currentChannelName || channel.id === activeVoiceChannelId) {
          deleteBtn.disabled = true;
          deleteBtn.title = 'Leave this channel before deleting it.';
        }

        actions.appendChild(deleteBtn);
      } else {
        const hint = document.createElement('div');
        hint.className = 'superuser-account-status';
        hint.textContent = 'Insufficient permissions to delete channels.';
        actions.appendChild(hint);
      }

      card.appendChild(info);
      card.appendChild(actions);
      container.appendChild(card);
    });
  }

  private handleSuperuserUsersListClick(event: MouseEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!button) {
      return;
    }

    const accountId = button.dataset.accountId;
    if (!accountId) {
      return;
    }

    if (button.dataset.action === 'disable-account') {
      this.requestDisableAccount(accountId, button);
    } else if (button.dataset.action === 'enable-account') {
      this.requestEnableAccount(accountId, button);
    }
  }

  private handleSuperuserChannelsListClick(event: MouseEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!button) {
      return;
    }

    if (button.dataset.action === 'delete-channel') {
      const channelName = button.dataset.channelName;
      if (!channelName) {
        return;
      }

      if (!hasPermission(this.rolePermissions, 'canDeleteChannels')) {
        this.notifications.warning('You do not have permission to delete channels.');
        return;
      }

      if (!window.confirm(`Delete channel #${channelName}? This cannot be undone.`)) {
        return;
      }

      button.disabled = true;
      this.socket.deleteChannel(channelName);
      this.notifications.warning(`Deleting #${channelName}...`);
    }
  }

  private handleAdminAccountsList(accounts: Account[]): void {
    this.loadingAccounts = false;
    this.state.setAccountsList(accounts);

    if (this.hasManagementAccess && this.activeSuperuserTab === 'users') {
      this.renderSuperuserUsers();
    }
  }

  private handleAdminAccountUpdate(account: Account, reason: 'roles' | 'disabled' | 'enabled'): void {
    const existing = [...(this.state.get('accounts') ?? [])];
    const index = existing.findIndex((entry) => entry.id === account.id);

    if (index >= 0) {
      existing[index] = { ...account };
    } else {
      existing.push({ ...account });
    }

    this.state.setAccountsList(existing);

    if (this.hasManagementAccess && this.activeSuperuserTab === 'users') {
      this.renderSuperuserUsers();
    }

    const label = account.displayName || account.username;
    switch (reason) {
      case 'disabled':
        this.notifications.warning(`${label} disabled.`);
        break;
      case 'enabled':
        this.notifications.success(`${label} enabled.`);
        break;
      default:
        this.notifications.success(`${label} updated.`);
    }
  }

  private handleAdminError(error: { message?: string }): void {
    this.loadingAccounts = false;
    const message = error?.message || 'Admin action failed.';
    this.notifications.error(message);

    if (this.hasManagementAccess && this.activeSuperuserTab === 'users') {
      this.renderSuperuserUsers();
    }
  }

  private requestDisableAccount(accountId: string, control?: HTMLButtonElement): void {
    const accounts = this.state.get('accounts') ?? [];
    const account = accounts.find((entry) => entry.id === accountId);
    if (!account) {
      this.notifications.error('Account not found.');
      return;
    }

    const selfId = this.state.get('account')?.id;
    if (account.id === selfId) {
      this.notifications.warning('You cannot disable your own account.');
      return;
    }

    if (account.roles?.includes('superuser')) {
      this.notifications.warning('Superuser accounts must be managed from the server.');
      return;
    }

    const label = account.displayName || account.username;
    if (!window.confirm(`Disable ${label}? They will be unable to sign in.`)) {
      return;
    }

    if (control) {
      control.disabled = true;
    }

    this.socket.disableAccount({ accountId });
    this.notifications.warning(`Disabling ${label}...`);
  }

  private requestEnableAccount(accountId: string, control?: HTMLButtonElement): void {
    const accounts = this.state.get('accounts') ?? [];
    const account = accounts.find((entry) => entry.id === accountId);
    if (!account) {
      this.notifications.error('Account not found.');
      return;
    }

    if (control) {
      control.disabled = true;
    }

    const label = account.displayName || account.username;
    this.socket.enableAccount({ accountId });
    this.notifications.info(`Re-enabling ${label}...`);
  }

  private formatRoleLabel(role: RoleName): string {
    return role.charAt(0).toUpperCase() + role.slice(1);
  }

  private formatChannelType(type: Channel['type']): string {
    return type.charAt(0).toUpperCase() + type.slice(1);
  }

  private formatDate(timestamp: number): string {
    try {
      return new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }).format(new Date(timestamp));
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('Failed to format date:', error);
      }
      return 'Unknown';
    }
  }

  private getUserDisplayName(user: User | null | undefined): string {
    if (!user) return 'Unknown User';
    const { displayName, username, name } = user;

    const candidates = [displayName, name, username];
    for (const candidate of candidates) {
      if (candidate) {
        const trimmed = candidate.trim();
        if (trimmed.length > 0) {
          return this.scrubIdentifierForDisplay(trimmed);
        }
      }
    }

    return 'Unknown User';
  }

  private getUserInitial(user: User | null | undefined): string {
    const label = this.getUserDisplayName(user);
    const initial = label.trim().charAt(0).toUpperCase();
    return initial || 'U';
  }

  private getPresenceStatusText(user: User): string {
    if (!user) return 'Online';

    const channels = this.state.get('channels') || [];

    if (user.voiceChannel) {
      const voiceChannel = channels.find((channel) => channel.id === user.voiceChannel);
      return voiceChannel ? `In voice • ${voiceChannel.name}` : 'In voice chat';
    }

    if (user.currentChannel) {
      const currentChannel = channels.find((channel) => channel.id === user.currentChannel);
      return currentChannel ? `In #${currentChannel.name}` : 'Online';
    }

    return 'Online';
  }

  private resolveUserLabel(label?: string | null, fallback?: string): string {
    if (label) {
      const trimmed = label.trim();
      if (trimmed.length > 0) {
        return this.scrubIdentifierForDisplay(trimmed);
      }
    }

    if (fallback) {
      const trimmed = fallback.trim();
      if (trimmed.length > 0) {
        return this.scrubIdentifierForDisplay(trimmed);
      }
    }

    return 'Unknown User';
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

  private updatePresenceUI(users: User[]): void {
    // Update member count
    const memberCount = this.elements['member-count'];
    if (memberCount) {
      memberCount.textContent = users.length.toString();
    }

    if (this.elements.presenceList) {
      this.elements.presenceList.innerHTML = '';
      
      // Sort users: superusers first, then by role, then alphabetically
      const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
      const sortedUsers = [...users].sort((a, b) => {
        if (a.isSuperuser && !b.isSuperuser) return -1;
        if (!a.isSuperuser && b.isSuperuser) return 1;
        
        const roleOrder = ['admin', 'moderator', 'streamer', 'user'];
        const aRole = a.roles?.[0] || 'user';
        const bRole = b.roles?.[0] || 'user';
        const aIndex = roleOrder.indexOf(aRole);
        const bIndex = roleOrder.indexOf(bRole);
        
        if (aIndex !== bIndex) return aIndex - bIndex;
        return collator.compare(this.getUserDisplayName(a), this.getUserDisplayName(b));
      });

      sortedUsers.forEach(user => {
        const row = document.createElement('div');
        row.className = 'member-item';
        row.dataset.id = user.id;

        // Avatar
        const avatar = document.createElement('div');
        avatar.className = 'member-avatar';
        avatar.textContent = this.getUserInitial(user);
        
        // Add special styling for superusers
        if (user.isSuperuser) {
          avatar.classList.add('superuser');
        }

        // User info
        const info = document.createElement('div');
        info.className = 'member-info';

        // Name with badge
        const nameRow = document.createElement('div');
        nameRow.className = 'member-name-row';
        
        const name = document.createElement('span');
        name.className = 'member-name';
  name.textContent = this.getUserDisplayName(user);
        nameRow.appendChild(name);

        // Role badge
        if (user.isSuperuser) {
          const badge = document.createElement('span');
          badge.className = 'member-badge superuser-badge';
          badge.textContent = '👑';
          badge.title = 'Superuser';
          nameRow.appendChild(badge);
        } else if (user.roles && user.roles.length > 0) {
          const role = user.roles[0];
          if (role !== 'user') {
            const badge = document.createElement('span');
            badge.className = `member-badge ${role}-badge`;
            badge.textContent = role === 'admin' ? '⚡' : role === 'moderator' ? '🛡️' : '🎥';
            badge.title = role.charAt(0).toUpperCase() + role.slice(1);
            nameRow.appendChild(badge);
          }
        }

        info.appendChild(nameRow);

        // Status
        const status = document.createElement('div');
        status.className = 'member-status';
  status.textContent = this.getPresenceStatusText(user);

        info.appendChild(status);

        row.appendChild(avatar);
        row.appendChild(info);
        this.elements.presenceList.appendChild(row);
      });
    }
  }

  private updateChannelsUI(channels: Channel[]): void {
    const currentChannel = this.state.get('currentChannel');
    
    // Separate channels by type
    const textChannels = channels.filter(ch => ch.type === 'text');
    const voiceChannels = channels.filter(ch => ch.type === 'voice');
    const streamChannels = channels.filter(ch => ch.type === 'stream');

    if (import.meta.env.DEV) {
      console.log('🔄 updateChannelsUI - Text:', textChannels.length, 'Voice:', voiceChannels.length, 'Stream:', streamChannels.length);
      console.log('🔍 Element checks - text-channels:', !!this.elements['text-channels'], 'channelsList:', !!this.elements.channelsList, 'stream-channels:', !!this.elements['stream-channels']);
    }

    // Update text channels
    if (this.elements['text-channels']) {
      this.renderChannelList(this.elements['text-channels'], textChannels, currentChannel, 'text');
    }

    // Update voice channels
    if (this.elements.channelsList) {
      this.renderChannelList(this.elements.channelsList, voiceChannels, currentChannel, 'voice');
    }

    // Update stream channels
    if (this.elements['stream-channels']) {
      this.renderChannelList(this.elements['stream-channels'], streamChannels, currentChannel, 'stream');
    }

    this.updateVoiceChannelTimerIndicators(channels);
  }

  private renderChannelList(container: HTMLElement, channels: Channel[], currentChannelId: string, type: 'text' | 'voice' | 'stream'): void {
    if (import.meta.env.DEV) {
      console.log(`📝 renderChannelList - Type: ${type}, Channels: ${channels.length}, Container:`, container);
    }
    
    container.innerHTML = '';

    if (channels.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'channel-list-empty';
      empty.textContent = `No ${type} channels`;
      container.appendChild(empty);
      if (import.meta.env.DEV) {
        console.log(`ℹ️ No ${type} channels to display`);
      }
      return;
    }

    channels.forEach(ch => {
      const item = document.createElement('div');
      item.className = `channel-item${ch.id === currentChannelId ? ' active' : ''}`;
      
      // Add voice-connected class if user is connected to this voice channel
      const voiceConnected = this.state.get('voiceConnected');
      const activeVoiceChannelId = this.state.get('activeVoiceChannelId');
      if (type === 'voice' && voiceConnected && activeVoiceChannelId && ch.id === activeVoiceChannelId) {
        item.classList.add('voice-connected');
      }
      
      // Add watching-stream class if user is in voice AND currently viewing a stream
      const videoContainer = this.elements.inlineVideoContainer as HTMLElement;
      const isWatchingStream = videoContainer && videoContainer.style.display !== 'none';
      const currentChannelType = this.state.get('currentChannelType');
      if (type === 'voice' && voiceConnected && activeVoiceChannelId && ch.id === activeVoiceChannelId && isWatchingStream && currentChannelType === 'stream') {
        item.classList.add('watching-stream');
      }
      
      item.setAttribute('data-channel-id', ch.id);
      item.setAttribute('data-channel', ch.name);
      item.setAttribute('data-type', type);

      // Channel icon and name
      const icon = document.createElement('span');
      icon.className = 'channel-icon';
      icon.textContent = type === 'text' ? '#' : type === 'voice' ? '🔊' : '📺';

      const content = document.createElement('div');
      content.className = 'channel-content';

      const name = document.createElement('span');
      name.className = 'channel-name';
      name.textContent = ch.name;

      content.appendChild(name);

      item.appendChild(icon);
      item.appendChild(content);

      let voiceTimerEl: HTMLElement | null = null;
      if (type === 'voice') {
        voiceTimerEl = document.createElement('span');
        voiceTimerEl.className = 'voice-call-timer';
        voiceTimerEl.setAttribute('data-channel-id', ch.id);
        voiceTimerEl.style.display = 'none';
        content.appendChild(voiceTimerEl);
      }

      // User count for voice channels
      if (type === 'voice' && ch.count > 0) {
        const count = document.createElement('span');
        count.className = 'channel-count';
        count.textContent = `🗣️ ${ch.count}`;
        count.title = `${ch.count} participant${ch.count !== 1 ? 's' : ''}`;
        count.setAttribute('aria-label', `${ch.count} voice participant${ch.count !== 1 ? 's' : ''}`);
        item.appendChild(count);
      }

      container.appendChild(item);

      // Voice channel users (show underneath the channel item)
      if (type === 'voice' && ch.count > 0) {
        // Add user avatars container
        const usersContainer = document.createElement('div');
        usersContainer.className = 'voice-channel-users';
        usersContainer.setAttribute('data-channel-id', ch.id);
        
        const users = this.state.get('users') || [];
        
        // Get users in this voice channel
        const channelUsers = users.filter(u => u.voiceChannel === ch.id);
        const currentAccountId = this.state.get('account')?.id || null;

        channelUsers.forEach(user => {
          const displayName = this.getUserDisplayName(user);
          const isCurrentUser = currentAccountId ? user.accountId === currentAccountId : false;
          const userItem = this.createVoiceChannelUserItem(user.id, displayName, isCurrentUser);
          usersContainer.appendChild(userItem);
        });
        
        container.appendChild(usersContainer);
      }

      // Voice join button
      if (type === 'voice') {
  const isConnectedToThisChannel = voiceConnected && activeVoiceChannelId === ch.id;
        
        const joinBtn = document.createElement('button');
        joinBtn.type = 'button';
        joinBtn.className = 'join-voice-btn join-channel-btn';
        joinBtn.setAttribute('data-channel-id', ch.id);
        joinBtn.setAttribute('data-channel', ch.name);

        const iconSpan = document.createElement('span');
        iconSpan.className = 'join-voice-icon';
        iconSpan.setAttribute('aria-hidden', 'true');
        iconSpan.textContent = isConnectedToThisChannel ? '✓' : '🎤';

        const labelSpan = document.createElement('span');
        labelSpan.className = 'join-voice-label';
        labelSpan.textContent = isConnectedToThisChannel ? 'Connected' : 'Join';

        joinBtn.title = isConnectedToThisChannel ? 'Connected' : `Join ${ch.name}`;
        joinBtn.setAttribute('aria-label', isConnectedToThisChannel ? `Connected to ${ch.name}` : `Join ${ch.name} voice channel`);

        joinBtn.append(iconSpan, labelSpan);
        
        if (isConnectedToThisChannel) {
          joinBtn.classList.add('connected');
          joinBtn.disabled = true; // Can't join if already connected
        }
        
        // Handle join button click directly here
        joinBtn.addEventListener('click', (e) => {
          e.stopPropagation(); // Prevent channel item from handling this
          if (!isConnectedToThisChannel) {
            this.handleVoiceChannelJoin(ch.id, ch.name);
          }
        });

  item.appendChild(joinBtn);
      }

      // Viewer count for stream channels (show count if > 0)
      if (type === 'stream' && ch.count > 0) {
        const count = document.createElement('span');
        count.className = 'channel-count';
        count.textContent = `👁️ ${ch.count}`;
        count.title = `${ch.count} viewer${ch.count !== 1 ? 's' : ''}`;
        count.setAttribute('aria-label', `${ch.count} stream viewer${ch.count !== 1 ? 's' : ''}`);
        item.appendChild(count);
      }

      // Live indicator for streams (only show if actually live)
      if (type === 'stream' && ch.isLive) {
        const live = document.createElement('span');
        live.className = 'live-indicator';
        live.textContent = 'LIVE';
        item.appendChild(live);
      }

      // Info button for stream channels (only show to management roles)
      if (type === 'stream' && this.hasManagementAccess) {
        const infoBtn = document.createElement('button');
        infoBtn.className = 'stream-info-btn';
        infoBtn.textContent = '🔑';
        infoBtn.title = 'Get stream key for OBS';
        infoBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.showStreamInfoModal(ch);
        });
        item.appendChild(infoBtn);
      }

      container.appendChild(item);
    });
  }

  private appendChatMessage(message: ChatMessage): void {
    if (!this.elements.msgs) return;

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';
    
    // Avatar
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = message.from.charAt(0).toUpperCase();
    
    // Content
    const content = document.createElement('div');
    content.className = 'message-content';
    
    // Header
    const header = document.createElement('div');
    header.className = 'message-header';
    
    const author = document.createElement('span');
    author.className = 'message-author';
    author.textContent = message.from;
    
    const timestamp = document.createElement('span');
    timestamp.className = 'message-timestamp';
    timestamp.textContent = formatTime(message.ts);
    
    header.appendChild(author);
    header.appendChild(timestamp);
    
    // Text
    const text = document.createElement('div');
    text.className = 'message-text';
    text.textContent = message.text;
    
    content.appendChild(header);
    content.appendChild(text);
    
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(content);
    
    this.elements.msgs.appendChild(messageDiv);
    
    // Add animation and sound effect
    this.animator.animateMessage(messageDiv);
    this.soundFX.play('message', 0.5);
    
    this.elements.msgs.scrollTop = this.elements.msgs.scrollHeight;
  }

  private updateMicLevel(level: number): void {
    if (this.elements.micLevel) {
      const percent = Math.min(100, Math.round(level * 100));
      this.elements.micLevel.style.width = `${percent}%`;
    }

    const state = this.state.getState();
    const now = performance.now();
    const shouldTrackLocal =
      state.voiceConnected &&
      !state.muted &&
      !state.deafened &&
      this.audio.hasActiveStream();

    if (shouldTrackLocal && level > LOCAL_SPEAKING_THRESHOLD) {
      this.localSpeakingLastPeak = now;
      this.setLocalSpeaking(true);
    } else if (!shouldTrackLocal) {
      this.setLocalSpeaking(false);
    } else if (this.localSpeaking && now - this.localSpeakingLastPeak > LOCAL_SPEAKING_RELEASE_MS) {
      this.setLocalSpeaking(false);
    }
  }

  private setLocalSpeaking(speaking: boolean): void {
    if (this.localSpeaking === speaking) {
      return;
    }

    this.localSpeaking = speaking;
    if (!speaking) {
      this.localSpeakingLastPeak = 0;
    }
    this.updateSpeakingIndicator('me', speaking);
  }

  private announceVoiceState(): void {
    if (!this.state.get('voiceConnected')) {
      return;
    }

    const state = this.state.getState();
    this.socket.updateVoiceState({
      muted: state.muted,
      deafened: state.deafened,
    });
  }

  private updateSpeakingIndicator(userId: string, speaking: boolean): void {
    // Update in voice users map
    const user = this.voiceUsers.get(userId);
    if (user) {
      user.speaking = speaking;
    }

    this.voicePanel.updateSpeakingIndicator(userId, speaking);
    
    // Also update old member list if it exists
    const userRow = document.querySelector(`[data-id="${userId}"]`);
    if (userRow) {
      userRow.classList.toggle('speaking', speaking);
    }
  }

  private addVoiceUser(peer: VoicePeerEvent): void {
    const label = this.resolveUserLabel(peer.name, peer.id);
    this.voiceUsers.set(peer.id, {
      id: peer.id,
      name: label,
      muted: Boolean(peer.muted),
      deafened: Boolean(peer.deafened),
      speaking: false,
    });
    this.renderVoiceUsers();
    this.soundFX.play('userJoin', 0.6);
    this.notifications.info(`${label} joined voice`);
  }

  private removeVoiceUser(id: string): void {
    const user = this.voiceUsers.get(id);
    if (user) {
      this.soundFX.play('userLeave', 0.6);
      this.notifications.info(`${user.name} left voice`);
    }
    this.voiceUsers.delete(id);
    this.renderVoiceUsers();
  }

  private renderVoiceUsers(): void {
    const entries: VoicePanelEntry[] = [];
    const state = this.state.getState();
    const account = this.state.get('account');
    const currentUserLabel = account ? (account.displayName?.trim() || account.username) : 'You';

    if (state.voiceConnected) {
      entries.push({
        id: 'me',
        name: currentUserLabel,
        muted: state.muted,
        deafened: state.deafened,
        speaking: this.localSpeaking,
        isCurrentUser: true,
      });
    }

    for (const [id, user] of this.voiceUsers) {
      const preference = this.voice.getPeerAudioPreference(id);
      entries.push({
        id,
        name: user.name,
        muted: user.muted,
        deafened: user.deafened,
        speaking: user.speaking,
        showLocalControls: true,
        localMuted: preference.muted,
        localVolume: preference.volume,
        onLocalMuteToggle: (muted) => {
          this.voice.setPeerMuted(id, muted);
        },
        onLocalVolumeChange: (volume) => {
          this.voice.setPeerVolume(id, volume);
        },
      });
    }

    this.voicePanel.render(entries, entries.length);

    if (entries.length > 0 || state.voiceConnected) {
      this.voicePanel.show();
    } else {
      this.voicePanel.hide();
    }
  }

  private startVoiceSessionTimer(startedAt: number, sessionId: string | null): void {
    const startTime = Number.isFinite(startedAt) && startedAt > 0 ? startedAt : Date.now();

    if (this.voiceSessionTimerHandle !== null) {
      window.clearInterval(this.voiceSessionTimerHandle);
      this.voiceSessionTimerHandle = null;
    }

    this.voiceSessionStart = startTime;
    this.voiceSessionId = sessionId ?? null;
    this.state.setVoiceSession(this.voiceSessionStart, this.voiceSessionId);

    this.updateVoiceSessionTimerDisplay();
    this.voiceSessionTimerHandle = window.setInterval(() => {
      this.updateVoiceSessionTimerDisplay();
    }, 1000);
  }

  private stopVoiceSessionTimer(): void {
    if (this.voiceSessionTimerHandle !== null) {
      window.clearInterval(this.voiceSessionTimerHandle);
      this.voiceSessionTimerHandle = null;
    }

    this.voiceSessionStart = null;
    this.voiceSessionId = null;
    this.state.setVoiceSession(null, null);
    this.voicePanel.updateSessionTimer(null);
  }

  private updateVoiceSessionTimerDisplay(): void {
    if (!this.voiceSessionStart) {
      this.voicePanel.updateSessionTimer(null);
      return;
    }

    const elapsed = Date.now() - this.voiceSessionStart;
    const formatted = this.formatDuration(elapsed);
    let title: string | undefined;
    try {
      title = `Call started ${new Date(this.voiceSessionStart).toLocaleTimeString()}`;
    } catch {
      title = undefined;
    }
    this.voicePanel.updateSessionTimer(`⏱ ${formatted}`, title);
  }

  private syncVoiceSessionFromChannels(channels: Channel[]): void {
    const activeVoiceChannelId = this.state.get('activeVoiceChannelId');
    if (!activeVoiceChannelId || !this.state.get('voiceConnected')) {
      return;
    }

    const channel = channels.find((ch) => ch.id === activeVoiceChannelId);
    if (!channel) {
      return;
    }

    const startedAt = channel.voiceStartedAt ?? null;
    const sessionId = channel.voiceSessionId ?? null;

    if (sessionId && sessionId !== this.voiceSessionId) {
      this.startVoiceSessionTimer(startedAt ?? Date.now(), sessionId);
      return;
    }

    if (sessionId && this.voiceSessionStart && startedAt && startedAt !== this.voiceSessionStart) {
      this.startVoiceSessionTimer(startedAt, sessionId);
      return;
    }

    if (!sessionId && this.voiceSessionId && (channel.count ?? 0) === 0) {
      this.stopVoiceSessionTimer();
    }
  }

  private updateVoiceChannelTimerIndicators(channels: Channel[]): void {
    if (!this.elements.channelsList) {
      return;
    }

    let hasActiveTimers = false;

    channels
      .filter((channel) => channel.type === 'voice')
      .forEach((channel) => {
        const item = this.elements.channelsList?.querySelector(`.channel-item[data-channel-id="${channel.id}"]`);
        const timerEl = item?.querySelector('.voice-call-timer') as HTMLElement | null;
        if (!timerEl) {
          return;
        }

        if (channel.voiceStartedAt) {
          timerEl.dataset.voiceStart = channel.voiceStartedAt.toString();
          timerEl.style.display = 'inline-flex';
          try {
            timerEl.title = `Call started ${new Date(channel.voiceStartedAt).toLocaleTimeString()}`;
          } catch {
            timerEl.title = 'Call in progress';
          }
          hasActiveTimers = true;
        } else {
          timerEl.style.display = 'none';
          delete timerEl.dataset.voiceStart;
          timerEl.textContent = '';
          timerEl.removeAttribute('title');
        }
      });

    if (hasActiveTimers) {
      this.refreshVoiceChannelTimerElements();
      if (this.voiceChannelTimerHandle === null) {
        this.voiceChannelTimerHandle = window.setInterval(() => {
          this.refreshVoiceChannelTimerElements();
        }, 1000);
      }
    } else if (this.voiceChannelTimerHandle !== null) {
      window.clearInterval(this.voiceChannelTimerHandle);
      this.voiceChannelTimerHandle = null;
    }
  }

  private refreshVoiceChannelTimerElements(): void {
    const now = Date.now();
    document.querySelectorAll<HTMLElement>('.voice-call-timer[data-voice-start]').forEach((el) => {
      const start = Number(el.dataset.voiceStart);
      if (!Number.isFinite(start) || start <= 0) {
        el.textContent = '';
        el.style.display = 'none';
        delete el.dataset.voiceStart;
        return;
      }

      const duration = now - start;
      el.textContent = `⏱ ${this.formatDuration(duration)}`;
      el.style.display = 'inline-flex';
    });
  }

  private formatDuration(milliseconds: number): string {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const secondsPart = seconds.toString().padStart(2, '0');

    if (hours > 0) {
      const minutesPart = minutes.toString().padStart(2, '0');
      return `${hours}:${minutesPart}:${secondsPart}`;
    }

    return `${minutes}:${secondsPart}`;
  }

  /**
   * Create a compact user item for voice channel sidebar
   */
  private createVoiceChannelUserItem(id: string, name: string, isCurrentUser: boolean): HTMLElement {
    const item = document.createElement('div');
    item.className = 'voice-channel-user-item';
    item.setAttribute('data-user-id', id);
    
    // Small avatar with initials
    const avatar = document.createElement('div');
    avatar.className = 'voice-channel-user-avatar';
  avatar.style.background = getAvatarColor(name);
    avatar.textContent = name.substring(0, 1).toUpperCase();
    
    // Username
    const username = document.createElement('span');
    username.className = 'voice-channel-user-name';
    username.textContent = isCurrentUser ? `${name} (You)` : name;
    
    item.appendChild(avatar);
    item.appendChild(username);
    
    return item;
  }

  private updateMuteButtons(): void {
    const state = this.state.getState();
    
    if (this.elements.mute) {
      this.elements.mute.classList.toggle('muted', state.muted);
      this.elements.mute.setAttribute('title', state.muted ? 'Unmute' : 'Mute');
      const icon = this.elements.mute.querySelector('span');
      if (icon) icon.textContent = state.muted ? '🎤🚫' : '🎤';
    }
    
    if (this.elements.deafen) {
      this.elements.deafen.classList.toggle('deafened', state.deafened);
      this.elements.deafen.setAttribute('title', state.deafened ? 'Undeafen' : 'Deafen');
      const icon = this.elements.deafen.querySelector('span');
      if (icon) icon.textContent = state.deafened ? '🔇' : '🔊';
    }
  }

  /**
   * Update voice status panel visibility
   */
  private updateVoiceStatusPanel(): void {
    const panel = this.elements['voice-status-panel'];
    const voiceConnected = this.state.get('voiceConnected');
    
    if (import.meta.env.DEV) {
      console.log('📊 updateVoiceStatusPanel - voiceConnected:', voiceConnected, 'panel exists:', !!panel);
    }
    
    if (panel) {
      panel.style.display = voiceConnected ? 'block' : 'none';
      if (import.meta.env.DEV) {
        console.log('✅ Voice status panel display set to:', voiceConnected ? 'block' : 'none');
      }
    } else if (import.meta.env.DEV) {
      console.error('❌ Voice status panel element not found!');
    }
    
    // Update connected channel name
    const channelName = this.elements['connected-voice-channel'];
    if (channelName) {
      if (voiceConnected) {
        const activeVoiceName = this.state.get('activeVoiceChannelName');
        if (activeVoiceName) {
          channelName.textContent = activeVoiceName;
        } else {
          const activeVoiceId = this.state.get('activeVoiceChannelId');
          const channelInfo = this.state.get('channels').find((ch) => ch.id === activeVoiceId);
          channelName.textContent = channelInfo?.name || activeVoiceId || 'Voice';
        }
        if (import.meta.env.DEV) {
          console.log('✅ Voice status panel channel name set to:', channelName.textContent);
        }
      } else {
        channelName.textContent = 'Not connected';
      }
    }
    
    // Update stream watching indicator
    this.updateStreamWatchingIndicator();
  }
  
  /**
   * Update the stream watching indicator in voice status panel
   */
  private updateStreamWatchingIndicator(): void {
    const indicator = document.getElementById('watching-stream-indicator');
    if (!indicator) return;
    
    const voiceConnected = this.state.get('voiceConnected');
    const container = this.elements.inlineVideoContainer as HTMLElement;
    const isWatchingStream = container && container.style.display !== 'none';
    
    if (voiceConnected && isWatchingStream) {
      // Get the stream channel name from current channel if it's a stream
      const currentChannelType = this.state.get('currentChannelType');
      const currentChannelName = this.elements['current-channel-name']?.textContent || '';
      
      if (currentChannelType === 'stream' && currentChannelName) {
        indicator.textContent = `📺 ${currentChannelName}`;
        indicator.style.display = 'block';
      } else {
        indicator.style.display = 'none';
      }
    } else {
      indicator.style.display = 'none';
    }
  }

  /**
   * Show audio settings modal
   */
  private async showAudioSettingsModal(): Promise<void> {
    if (import.meta.env.DEV) {
      console.log('🔊 showAudioSettingsModal called');
    }

    const modal = this.elements.audioSettingsModal;
    if (!modal) {
      if (import.meta.env.DEV) {
        console.error('❌ Audio settings modal element not found!');
      }
      return;
    }

    // Populate device lists
    await this.populateDeviceLists();

    // Update UI with current settings
    this.updateSettingsUI();

    // Show modal with animation
    modal.style.display = 'flex';
    this.animator.openModal(modal);
    this.soundFX.play('click', 0.4);
  }

  /**
   * Populate device dropdown lists
   */
  private async populateDeviceLists(): Promise<void> {
    try {
      // Request permissions first to get device labels
      await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      
      const devices = await this.audio.getDevices();
      
      // Populate microphone dropdown
      const micSelect = this.elements.micSelect as HTMLSelectElement;
      if (micSelect && devices.mics.length > 0) {
        micSelect.innerHTML = '';
        devices.mics.forEach(device => {
          const option = document.createElement('option');
          option.value = device.deviceId;
          option.textContent = device.label || `Microphone ${device.deviceId.substring(0, 8)}`;
          micSelect.appendChild(option);
        });
        
        // Select current device
        const currentMic = this.state.get('settings').micDeviceId;
        if (currentMic) {
          micSelect.value = currentMic;
        }
      }

      // Populate speaker dropdown
      const spkSelect = this.elements.spkSelect as HTMLSelectElement;
      if (spkSelect && devices.speakers.length > 0) {
        spkSelect.innerHTML = '';
        devices.speakers.forEach(device => {
          const option = document.createElement('option');
          option.value = device.deviceId;
          option.textContent = device.label || `Speaker ${device.deviceId.substring(0, 8)}`;
          spkSelect.appendChild(option);
        });
        
        // Select current device
        const currentSpk = this.state.get('settings').spkDeviceId;
        if (currentSpk) {
          spkSelect.value = currentSpk;
        }
      }

      if (import.meta.env.DEV) {
        console.log('📱 Populated devices:', devices.mics.length, 'mics,', devices.speakers.length, 'speakers');
      }
    } catch (error) {
      console.error('❌ Error populating devices:', error);
      this.notifications.error('Could not load audio devices. Please check permissions.');
      
      // Set fallback options
      const micSelect = this.elements.micSelect as HTMLSelectElement;
      const spkSelect = this.elements.spkSelect as HTMLSelectElement;
      if (micSelect) micSelect.innerHTML = '<option>No microphones found</option>';
      if (spkSelect) spkSelect.innerHTML = '<option>No speakers found</option>';
    }
  }

  /**
   * Hide audio settings modal
   */
  private hideAudioSettingsModal(): void {
    const modal = this.elements.audioSettingsModal;
    if (!modal) return;
    
    // Stop mic test if running
    const testBtn = this.elements.testMicBtn as HTMLButtonElement;
    if (testBtn && testBtn.getAttribute('data-testing') === 'true') {
      this.audio.stopLocalStream();
      testBtn.textContent = 'Test Microphone';
      testBtn.setAttribute('data-testing', 'false');
      testBtn.classList.remove('button-danger');
      testBtn.classList.add('button-secondary');
      if (import.meta.env.DEV) {
        console.log('🛑 Stopped mic test when closing settings');
      }
    }
    
    this.animator.closeModal(modal);
  }

  /**
   * Save audio settings
   */
  private saveAudioSettings(): void {
    if (import.meta.env.DEV) {
      console.log('💾 Saving audio settings...');
    }

    // Settings are saved in real-time via setupSettingsListeners
    // This just closes the modal
    this.notifications.success('Audio settings saved');
    this.hideAudioSettingsModal();
    this.soundFX.play('success', 0.6);
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
      if (!event.matches && this.mobileStreamMode) {
        this.setMobileStreamMode(false);
      }
    };

    mobileBreakpoint.addEventListener('change', handleMobileChange);
    this.cleanupCallbacks.push(() => mobileBreakpoint.removeEventListener('change', handleMobileChange));
  }

  private isMobileLayout(): boolean {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  private setMobileStreamMode(enabled: boolean): void {
    const app = this.elements.app;
    if (!app) {
      return;
    }

    if (!this.isMobileLayout()) {
      this.mobileStreamMode = false;
      app.classList.remove('mobile-stream-mode');
      return;
    }

    this.mobileStreamMode = enabled;
    app.classList.toggle('mobile-stream-mode', enabled);

    if (enabled) {
      app.classList.remove('sidebar-open', 'members-open');
    }
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
   * Hide chat UI elements
   */
  private hideChatUI(): void {
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
      mainContent.classList.add('voice-mode');
    }
  }

  /**
   * Show chat UI elements
   */
  private showChatUI(): void {
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
      mainContent.classList.remove('voice-mode');
    }
  }

  private async loadDevices(): Promise<void> {
    try {
      const { mics, speakers } = await this.audio.getDevices();
      
      if (this.elements.micSelect) {
        const micSelect = this.elements.micSelect as HTMLSelectElement;
        micSelect.innerHTML = mics.map(d => 
          `<option value="${d.deviceId}">${d.label}</option>`
        ).join('');
      }

      if (this.elements.spkSelect) {
        const spkSelect = this.elements.spkSelect as HTMLSelectElement;
        spkSelect.innerHTML = speakers.map(d => 
          `<option value="${d.deviceId}">${d.label}</option>`
        ).join('');
      }
    } catch (error) {
      console.error('Error loading devices:', error);
    }
  }

  /**
   * Cleanup all resources and event listeners
   * Call this before page unload or component unmount
   */
  public cleanup(): void {
    if (import.meta.env.DEV) {
      console.log('🧹 Cleaning up App resources...');
    }

    // Clear stream retry timer
    if (this.streamRetryTimer !== null) {
      clearTimeout(this.streamRetryTimer);
      this.streamRetryTimer = null;
    }

    // Destroy HLS instances safely
    if (this.inlineHls) {
      try {
        this.inlineHls.destroy();
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error('Error destroying inline HLS:', error);
        }
      } finally {
        this.inlineHls = null;
      }
    }

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

    if (this.voiceSessionTimerHandle !== null) {
      window.clearInterval(this.voiceSessionTimerHandle);
      this.voiceSessionTimerHandle = null;
    }

    if (this.voiceChannelTimerHandle !== null) {
      window.clearInterval(this.voiceChannelTimerHandle);
      this.voiceChannelTimerHandle = null;
    }

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
