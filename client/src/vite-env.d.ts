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
  }
}

export {};
