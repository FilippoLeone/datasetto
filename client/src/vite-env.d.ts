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
  readonly VITE_VOICE_OPUS_BITRATE?: string;
  readonly VITE_VOICE_DTX_ENABLED?: string;
  readonly VITE_VOICE_OPUS_STEREO?: string;
  readonly VITE_VOICE_OPUS_MIN_PTIME?: string;
  readonly VITE_VOICE_OPUS_MAX_PTIME?: string;
  readonly VITE_VOICE_OPUS_MAX_PLAYBACK_RATE?: string;
  readonly VITE_VOICE_VAD_THRESHOLD?: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
 
interface DatasettoDesktopConfig {
  serverUrl?: string;
  apiBaseUrl?: string;
  hlsBaseUrl?: string;
  rtmpServerUrl?: string;
}
 
declare global {
  interface Window {
    datasettoDesktopConfig?: DatasettoDesktopConfig;
    env?: ImportMetaEnv;
  }
}

export {};
