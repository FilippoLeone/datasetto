import type { StateManager } from '@/utils';
import type { SocketService, AudioNotificationService, PlayerService, AudioService, VoiceService } from '@/services';
import type { NotificationManager } from '@/components/NotificationManager';
import type { AnimationController } from '@/utils/AnimationController';
import type { AuthStateSnapshot } from './AuthController';
import type { VoicePanelController } from '@/ui/VoicePanelController';

export type ElementMap = Record<string, HTMLElement>;

export interface AuthControllerDeps {
  elements: ElementMap;
  state: StateManager;
  socket: SocketService;
  notifications: NotificationManager;
  soundFX: AudioNotificationService;
  animator: AnimationController;
  mobileClosePanels?: () => void;
  addListener: (
    element: EventTarget | null | undefined,
    event: string,
    handler: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => void;
  registerCleanup: (cleanup: () => void) => void;
  onStateChange: (snapshot: AuthStateSnapshot) => void;
  onSessionInvalidated: () => void;
  onChannelBootstrap: (channels: import('@/types').Channel[], groups?: import('@/types').ChannelGroup[]) => void;
}

export interface VideoControllerDeps {
  elements: ElementMap;
  state: StateManager;
  socket: SocketService;
  player: PlayerService;
  notifications: NotificationManager;
  soundFX: AudioNotificationService;
  hlsBaseUrl: string;
  addListener: (
    element: EventTarget | null | undefined,
    event: string,
    handler: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => void;
  registerCleanup: (cleanup: () => void) => void;
  refreshChannels: () => void;
}

export interface AdminControllerDeps {
  elements: ElementMap;
  state: StateManager;
  socket: SocketService;
  notifications: NotificationManager;
  soundFX: AudioNotificationService;
  animator: AnimationController;
  addListener: (
    element: EventTarget | null | undefined,
    event: string,
    handler: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => void;
  registerCleanup: (cleanup: () => void) => void;
}

export interface VoiceControllerDeps {
  elements: ElementMap;
  state: StateManager;
  socket: SocketService;
  audio: AudioService;
  voice: VoiceService;
  notifications: NotificationManager;
  soundFX: AudioNotificationService;
  voicePanel: VoicePanelController;
  registerCleanup: (cleanup: () => void) => void;
  refreshChannels: () => void;
  updateStreamIndicator: () => void;
  resolveUserLabel: (label?: string | null, fallback?: string) => string;
  closeMobileVoicePanel?: () => void;
}

export interface ChatControllerDeps {
  elements: ElementMap;
  socket: SocketService;
  soundFX: AudioNotificationService;
  animator: AnimationController;
  registerCleanup: (cleanup: () => void) => void;
}

export interface ChannelControllerDeps {
  elements: ElementMap;
  socket: SocketService;
  state: StateManager;
  animator: AnimationController;
  soundFX: AudioNotificationService;
  notifications: NotificationManager;
  registerCleanup: (cleanup: () => void) => void;
  isAuthenticated: () => boolean;
  hasPermission: (permissions: unknown, permission: string) => boolean;
  rolePermissions: unknown;
}

export interface SettingsControllerDeps {
  elements: ElementMap;
  state: StateManager;
  audio: AudioService;
  animator: AnimationController;
  soundFX: AudioNotificationService;
  notifications: NotificationManager;
  registerCleanup: (cleanup: () => void) => void;
  voiceSetOutputVolume: (volume: number) => void;
  voiceSetOutputDevice: (deviceId: string | null) => Promise<void> | void;
}

export interface UserListControllerDeps {
  elements: ElementMap;
  state: StateManager;
  adminControllerHandlePresenceUpdate?: () => void;
}

export interface NavigationControllerDeps {
  elements: ElementMap;
  animator: AnimationController;
  soundFX: AudioNotificationService;
  addListener: (
    element: EventTarget | null | undefined,
    event: string,
    handler: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => void;
  socketJoinChannel: (channelId: string) => void;
  stateSetChannelWithType: (channelId: string, type: 'text' | 'voice' | 'stream' | 'screenshare') => void;
  stateGetVoiceConnected: () => boolean;
  voiceJoinChannel: (channelId: string, channelName: string) => Promise<void> | void;
  chatHideChatUI: () => void;
  chatShowChatUI: () => void;
  chatClearMessages: () => void;
  videoHandleMobileChannelSwitch: (type: 'text' | 'voice' | 'stream' | 'screenshare') => void;
  videoHandleTextChannelSelected: (params: { voiceConnected: boolean }) => void;
  videoHandleVoiceChannelSelected: () => void;
  videoHandleStreamChannelSelected: (channelId: string, channelName: string) => void;
  videoHandleScreenshareChannelSelected: (channelId: string, channelName: string) => void;
  voiceRefreshInterface?: () => void;
  mobileClosePanels?: () => void;
}

export interface MinigameControllerDeps {
  elements: ElementMap;
  state: StateManager;
  socket: SocketService;
  notifications: NotificationManager;
  soundFX: AudioNotificationService;
  registerCleanup: (cleanup: () => void) => void;
  addListener: (
    element: EventTarget | null | undefined,
    event: string,
    handler: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => void;
}

