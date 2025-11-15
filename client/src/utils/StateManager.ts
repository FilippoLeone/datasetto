/**
 * Centralized application state management
 */
import type {
  AppState,
  Account,
  AudioSettings,
  User,
  Channel,
  EventMap,
  SessionInfo,
  ChannelPermissions,
  VoiceMinigameState,
} from '@/types';
import { EventEmitter, Storage } from '@/utils';

const STORAGE_KEYS = {
  AUTH: 'rtmpdisc.auth.v1',
  SETTINGS: 'rtmpdisc.settings.v1',
};

const VOICE_BITRATE_MIN = 6000;
const VOICE_BITRATE_MAX = 128000;

const parseNumberEnv = (
  value: string | undefined,
  fallback: number,
  bounds?: { min?: number; max?: number }
): number => {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  if (typeof bounds?.min === 'number' && parsed < bounds.min) {
    return fallback;
  }

  if (typeof bounds?.max === 'number' && parsed > bounds.max) {
    return fallback;
  }

  return parsed;
};

const parseBooleanEnv = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
};

const DEFAULT_VOICE_BITRATE = Math.round(
  parseNumberEnv(import.meta.env.VITE_VOICE_OPUS_BITRATE, 64000, {
    min: VOICE_BITRATE_MIN,
    max: VOICE_BITRATE_MAX,
  })
);
const DEFAULT_DTX_ENABLED = parseBooleanEnv(import.meta.env.VITE_VOICE_DTX_ENABLED, true);
const DEFAULT_VAD_THRESHOLD = parseNumberEnv(import.meta.env.VITE_VOICE_VAD_THRESHOLD, 0.07, {
  min: 0.01,
  max: 0.5,
});

const DEFAULT_SETTINGS: AudioSettings = {
  echoCancel: true,
  noiseSuppression: true,
  autoGain: true,
  micGain: 1,
  outputVol: 1,
  pttEnable: false,
  pttKey: '',
  voiceBitrate: DEFAULT_VOICE_BITRATE,
  dtx: DEFAULT_DTX_ENABLED, // Discontinuous transmission on to save bandwidth
  latencyHint: 'interactive', // Lowest latency for real-time chat
  vadThreshold: DEFAULT_VAD_THRESHOLD, // Voice activity detection threshold
};

const DEFAULT_STATE: AppState = {
  currentChannel: 'lobby',
  currentChannelType: 'text',
  activeVoiceChannelId: null,
  activeVoiceChannelName: null,
  streamingMode: false,
  account: null,
  session: null,
  settings: DEFAULT_SETTINGS,
  users: [],
  channels: [],
  channelPermissions: {},
  accounts: [],
  channelGroups: [],
  connected: false,
  voiceConnected: false,
  muted: false,
  deafened: false,
  voiceSessionStartedAt: null,
  voiceSessionId: null,
  voiceMinigame: null,
};

type PersistedAuth = {
  account: Account | null;
  session: SessionInfo | null;
};

export class StateManager extends EventEmitter<EventMap> {
  private state: AppState;

  constructor() {
    super();
    
    // Load persisted data
    const persistedAuth = Storage.get<PersistedAuth>(STORAGE_KEYS.AUTH, {
      account: null,
      session: null,
    });
    const settings = Storage.get<AudioSettings>(STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS);

    this.state = {
      ...DEFAULT_STATE,
      account: persistedAuth?.account ?? null,
      session: persistedAuth?.session ?? null,
      settings,
    };
  }

  /**
   * Get current state
   */
  getState(): Readonly<AppState> {
    return { ...this.state };
  }

  /**
   * Get specific state value
   */
  get<K extends keyof AppState>(key: K): AppState[K] {
    return this.state[key];
  }

  /**
   * Update state and emit change event
   */
  private updateState(updates: Partial<AppState>): void {
    this.state = { ...this.state, ...updates };
    this.emit('state:change', this.state);
  }

  /**
   * Set current channel
   */
  setChannel(channel: string): void {
    this.updateState({ currentChannel: channel });
  }

  /**
   * Set account info
   */
  setAccount(account: Account | null, session?: SessionInfo | null): void {
    this.setAuth(account, session ?? this.state.session);
  }

  /**
   * Set authentication state (account + session)
   */
  setAuth(account: Account | null, session: SessionInfo | null): void {
    const payload: PersistedAuth = {
      account: account ? { ...account } : null,
      session: session ? { ...session } : null,
    };

    this.updateState({ account: payload.account, session: payload.session });
    Storage.set(STORAGE_KEYS.AUTH, payload);
  }

  /**
   * Update stored account details without altering session
   */
  updateAccount(account: Account): void {
    const payload: PersistedAuth = {
      account: { ...account },
      session: this.state.session ? { ...this.state.session } : null,
    };

    this.updateState({ account: payload.account });
    Storage.set(STORAGE_KEYS.AUTH, payload);
  }

  /**
   * Update session information while preserving account
   */
  updateSession(session: SessionInfo | null): void {
    const payload: PersistedAuth = {
      account: this.state.account ? { ...this.state.account } : null,
      session: session ? { ...session } : null,
    };

    this.updateState({ session: payload.session });
    Storage.set(STORAGE_KEYS.AUTH, payload);
  }

  /**
   * Clear account (logout)
   */
  clearAccount(): void {
    this.setAuth(null, null);
  }

  /**
   * Get username (or 'guest' if not set)
   */
  getUsername(): string {
    const account = this.state.account;
    if (!account) {
      return 'guest';
    }
    return account.displayName || account.username;
  }

  /**
   * Update audio settings
   */
  updateSettings(updates: Partial<AudioSettings>): void {
    const settings = { ...this.state.settings, ...updates };
    this.updateState({ settings });
    Storage.set(STORAGE_KEYS.SETTINGS, settings);
  }

  /**
   * Set users in current channel
   */
  setUsers(users: User[]): void {
    this.updateState({ users });
    this.emit('user:update', users);
  }

  /**
   * Set available channels
   */
  setChannels(channels: Channel[]): void {
    this.updateState({ channels });
    this.emit('channel:update', channels);
  }

  setChannelGroups(channelGroups: import('@/types').ChannelGroup[]): void {
    this.updateState({ channelGroups: [...channelGroups] });
  }

  /**
   * Track permissions for a specific channel
   */
  setChannelPermissions(channelId: string, permissions: ChannelPermissions): void {
    const channelPermissions = { ...this.state.channelPermissions, [channelId]: permissions };
    this.updateState({ channelPermissions });
  }

  /**
   * Remove stored permissions when channel is deleted
   */
  removeChannelPermissions(channelId: string): void {
    if (!(channelId in this.state.channelPermissions)) {
      return;
    }

    const { [channelId]: _removed, ...rest } = this.state.channelPermissions;
    this.updateState({ channelPermissions: rest });
  }

  /**
   * Cache account list for admin views
   */
  setAccountsList(accounts: Account[]): void {
    this.updateState({ accounts: [...accounts] });
  }

  /**
   * Set connection status
   */
  setConnected(connected: boolean): void {
    this.updateState({ connected });
  }

  /**
   * Set voice connection status
   */
  setVoiceConnected(voiceConnected: boolean): void {
    this.updateState({ voiceConnected });
  }

  setVoiceSession(startedAt: number | null, sessionId: string | null): void {
    this.updateState({
      voiceSessionStartedAt: startedAt,
      voiceSessionId: sessionId,
    });
  }

  setVoiceMinigameState(minigame: VoiceMinigameState | null): void {
    this.updateState({ voiceMinigame: minigame });
  }

  /**
   * Set muted state
   */
  setMuted(muted: boolean): void {
    this.updateState({ muted });
  }

  /**
   * Set deafened state
   */
  setDeafened(deafened: boolean): void {
    this.updateState({ deafened });
  }

  /**
   * Toggle mute
   */
  toggleMute(): boolean {
    const muted = !this.state.muted;
    this.setMuted(muted);
    return muted;
  }

  /**
   * Toggle output mute (deafen state)
   */
  toggleDeafen(): boolean {
    const deafened = !this.state.deafened;
    this.setDeafened(deafened);
    return deafened;
  }

  /**
   * Set channel and type together
   */
  setChannelWithType(channel: string, type: 'text' | 'voice' | 'stream' | 'screenshare'): void {
    this.updateState({ 
      currentChannel: channel,
      currentChannelType: type 
    });
  }

  /**
   * Track the active voice channel separately from viewed channel
   */
  setActiveVoiceChannel(channelId: string | null, channelName: string | null = null): void {
    this.updateState({
      activeVoiceChannelId: channelId,
      activeVoiceChannelName: channelName,
    });
  }

  /**
   * Toggle streaming mode
   */
  toggleStreamingMode(): boolean {
    const streamingMode = !this.state.streamingMode;
    this.updateState({ streamingMode });
    return streamingMode;
  }

  /**
   * Set streaming mode
   */
  setStreamingMode(streamingMode: boolean): void {
    this.updateState({ streamingMode });
  }

  /**
   * Clear all data
   */
  reset(): void {
    Storage.clear();
    this.state = DEFAULT_STATE;
    this.emit('state:change', this.state);
  }
}
