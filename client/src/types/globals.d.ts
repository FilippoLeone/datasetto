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
}

/** Bridge exposed by desktop/preload.js through contextBridge. */
interface DesktopAPI {
  getInfo: () => Promise<{ version?: string; platform?: string }>;
  getRuntimeConfig: () => DatasettoDesktopConfig;
  showNotification: (options: { title: string; body: string; type?: string; silent?: boolean }) => Promise<unknown>;
  checkNotificationPermission: () => Promise<unknown>;
  updateVoiceActivity: (state: { connected: boolean; speaking: boolean; muted: boolean }) => void;
  pickScreenshareSource: (options?: { audio?: boolean }) => Promise<{
    success: boolean;
    source?: DesktopScreenshareSource;
    shareAudio?: boolean;
    error?: string;
  }>;
  openExternal: (url: string) => Promise<unknown>;
  getLogPath: () => Promise<string>;
  openLogFile: () => Promise<unknown>;
  log: (level: string, ...args: unknown[]) => void;
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
