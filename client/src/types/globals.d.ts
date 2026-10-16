/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SERVER_URL?: string;
  readonly VITE_HLS_BASE_URL?: string;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_RTMP_SERVER_URL?: string;
  readonly VITE_MOBILE_DEFAULT_SERVER_URL?: string;
  readonly VITE_MOBILE_DEFAULT_HLS_URL?: string;
  readonly VITE_MOBILE_DEFAULT_RTMP_URL?: string;
  readonly VITE_WEBRTC_ICE_SERVERS?: string;
  readonly VITE_TURN_URL?: string;
  readonly VITE_TURN_USERNAME?: string;
  readonly VITE_TURN_CREDENTIAL?: string;
  readonly VITE_SCREENSHARE_IDEAL_WIDTH?: string;
  readonly VITE_SCREENSHARE_IDEAL_HEIGHT?: string;
  readonly VITE_SCREENSHARE_IDEAL_FPS?: string;
  readonly VITE_SCREENSHARE_MAX_FPS?: string;
  readonly VITE_SCREENSHARE_MAX_BITRATE_KBPS?: string;
  readonly VITE_SCREENSHARE_ICE_SERVERS?: string;
  readonly VITE_VOICE_OPUS_BITRATE?: string;
  readonly VITE_VOICE_DTX_ENABLED?: string;
  readonly VITE_VOICE_OPUS_STEREO?: string;
  readonly VITE_VOICE_OPUS_MIN_PTIME?: string;
  readonly VITE_VOICE_OPUS_MAX_PTIME?: string;
  readonly VITE_VOICE_OPUS_MAX_PLAYBACK_RATE?: string;
  readonly VITE_VOICE_VAD_THRESHOLD?: string;
  readonly VITE_NOISE_REDUCTION_LEVEL?: string;
  readonly VITE_SITE_URL?: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Runtime configuration injected by the Electron shell (desktop/preload.js). */
interface DatasettoDesktopConfig {
  serverUrl?: string;
  apiBaseUrl?: string;
  hlsBaseUrl?: string;
  rtmpServerUrl?: string;
}

interface DesktopScreenshareSource {
  id: string;
  name: string;
  type?: 'screen' | 'window';
  display_id?: string;
}

/** Bridge exposed by desktop/preload.js through contextBridge. */
interface DesktopAPI {
  getInfo: () => Promise<{ version?: string; platform?: string }>;
  getRuntimeConfig: () => DatasettoDesktopConfig;
  showNotification: (options: { title: string; body: string; type?: string; silent?: boolean }) => Promise<unknown>;
  checkNotificationPermission: () => Promise<unknown>;
  updateVoiceActivity: (state: { connected: boolean; speaking: boolean; muted: boolean }) => void;
  pickScreenshareSource: (options?: {
    audio?: boolean;
    /** Shown in the picker's footer; older shells ignore it. `null` width/height = the display's native resolution. */
    quality?: { width: number | null; height: number | null; fps: number; label: string };
  }) => Promise<{
    success: boolean;
    source?: DesktopScreenshareSource;
    shareAudio?: boolean;
    error?: string;
  }>;
  openExternal: (url: string) => Promise<unknown>;
  getLogPath: () => Promise<string>;
  openLogFile: () => Promise<unknown>;
  log: (level: string, ...args: unknown[]) => void;

  // Added with the gaming features; shells built before them lack these members, so
  // every caller feature-detects them (see features/voice/desktopVoice.ts).

  /**
   * Register `accelerator` (an Electron accelerator such as `Control+Shift+V`) as the
   * system-wide push-to-talk key, or `null` to drop the current one. `registered` is
   * false when the system or another app already owns the combination.
   */
  setPushToTalkShortcut?: (accelerator: string | null) => Promise<DesktopShortcutStatus>;
  /** Whether `accelerator` could be registered, without changing the current registration. */
  checkPushToTalkShortcut?: (accelerator: string) => Promise<{ available: boolean }>;
  /**
   * Presses of the registered push-to-talk key, also while another window has focus.
   * The operating system repeats the press while the key is held; releases are not
   * reported (features/voice/pushToTalkHold.ts derives them). Returns an unsubscribe function.
   */
  onPushToTalkPressed?: (handler: (event: { accelerator: string; at: number }) => void) => () => void;
  /** Show or hide the always-on-top voice overlay and pick its corner of the primary display. */
  configureVoiceOverlay?: (options: { enabled: boolean; corner: DesktopOverlayCorner }) => Promise<unknown>;
  /** What the overlay shows; `null` while not in voice (the window is hidden then). */
  updateVoiceOverlay?: (state: DesktopVoiceOverlayState | null) => void;

  // Game activity ("Playing <game>"), also optional: see features/activity/desktopActivity.ts.

  /**
   * Apply the game activity settings. While `enabled`, the shell reads the names of the
   * running programs every 20 s with the operating system's own tool and reports only
   * the title matched in its catalogue or in `custom`. Resolves once a first scan ran.
   */
  configureGameActivity?: (options: DesktopGameActivityConfig) => Promise<DesktopGameActivityStatus>;
  /** Lower-cased names of the running programs for the picker (no launchers, no system processes); never sent anywhere. */
  listProcesses?: () => Promise<{ processes: string[]; error?: string }>;
  /** The matched title changed (`null`: no listed game runs, or the feature is off). Returns an unsubscribe function. */
  onGameActivity?: (handler: (event: { title: string | null }) => void) => () => void;
}

interface DesktopGameActivityConfig {
  enabled: boolean;
  /** The user's own entries: lower-cased executable name and the title to show. */
  custom: Array<{ exe: string; title: string }>;
}

interface DesktopGameActivityStatus {
  enabled: boolean;
  /** Title found by the scan that ran on configure, or null. */
  title: string | null;
  /** Games in the shell's bundled catalogue. */
  catalogueSize: number;
}

interface DesktopShortcutStatus {
  accelerator: string | null;
  registered: boolean;
  /** `taken` when the system or another app owns the key, `invalid` for an accelerator Electron rejects. */
  error?: 'taken' | 'invalid' | string;
}

type DesktopOverlayCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** Mirrors VoiceOverlayState in features/voice/voiceOverlayState.ts; desktop/overlay/renderer.js draws it. */
interface DesktopVoiceOverlayState {
  channelName: string;
  participants: Array<{
    id: string;
    name: string;
    /** Absolute URL or data URI (the overlay window cannot resolve server-relative paths). */
    avatarUrl: string | null;
    speaking: boolean;
    muted: boolean;
    deafened: boolean;
    self: boolean;
  }>;
  more: number;
  muted: boolean;
  deafened: boolean;
  pushToTalk: boolean;
  transmitting: boolean;
}

declare global {
  interface Window {
    datasettoDesktopConfig?: DatasettoDesktopConfig;
    desktopAPI?: DesktopAPI;
    env?: Partial<ImportMetaEnv>;
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }
}

export {};
