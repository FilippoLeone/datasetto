import { config } from '@/config';

export interface RuntimeUrls {
  /** Socket.IO server origin or `/` for same-origin. */
  serverUrl: string;
  /** REST base (no trailing slash) or `` for same-origin. */
  apiBaseUrl: string;
  /** HLS playlist base, e.g. `/hls` or `https://host/hls`. */
  hlsBaseUrl: string;
  /** RTMP ingest shown to streamers until the server provides one. */
  rtmpServerUrl: string;
}

const DEFAULT_REMOTE = 'https://datasetto.com';

const strip = (value: string): string => value.replace(/\/+$/, '');

const isLocalHost = (host: string | undefined): boolean =>
  !host || host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

const isNative = (): boolean => window.Capacitor?.isNativePlatform?.() === true;

const firstRemote = (candidates: Array<string | undefined | null>, fallback: string): string => {
  for (const value of candidates) {
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (!isLocalHost(parsed.hostname)) return strip(value);
    } catch {
      /* not absolute */
    }
  }
  return strip(fallback);
};

/**
 * Where the backend lives. Web builds served by Caddy use the page origin
 * (relative URLs); Electron and Capacitor shells need absolute URLs, which come
 * from their own config or the `VITE_*` build variables.
 */
export const resolveRuntimeUrls = (): RuntimeUrls => {
  const desktop = window.datasettoDesktopConfig;
  const origin = window.location.origin;
  const onHttp = origin.startsWith('http');
  const onLocal = isLocalHost(window.location.hostname);

  let serverUrl = desktop?.serverUrl?.trim() || config.SERVER_URL?.trim() || '';
  let hlsBaseUrl = desktop?.hlsBaseUrl?.trim() || config.HLS_BASE_URL?.trim() || '';
  let rtmpServerUrl = desktop?.rtmpServerUrl?.trim() || config.RTMP_SERVER_URL?.trim() || '';

  if (isNative()) {
    const remote = firstRemote([config.MOBILE_DEFAULT_SERVER_URL, serverUrl], DEFAULT_REMOTE);
    serverUrl = serverUrl || remote;
    hlsBaseUrl = hlsBaseUrl || firstRemote([config.MOBILE_DEFAULT_HLS_URL], remote + '/hls');
    rtmpServerUrl = rtmpServerUrl || firstRemote([config.MOBILE_DEFAULT_RTMP_URL], 'rtmp://' + new URL(remote).hostname + '/live');
  }

  if (!serverUrl) serverUrl = onHttp && !onLocal ? origin : '/';
  if (!hlsBaseUrl) hlsBaseUrl = onHttp && !onLocal ? strip(origin) + '/hls' : '/hls';
  if (!rtmpServerUrl) {
    rtmpServerUrl = onHttp && !onLocal ? 'rtmp://' + window.location.hostname + '/live' : 'rtmp://localhost/live';
  }

  const apiBaseUrl = desktop?.apiBaseUrl?.trim() || config.API_BASE_URL?.trim() || (serverUrl === '/' ? '' : strip(serverUrl));

  return {
    serverUrl: serverUrl === '/' ? '/' : strip(serverUrl),
    apiBaseUrl: strip(apiBaseUrl),
    hlsBaseUrl: strip(hlsBaseUrl),
    rtmpServerUrl: strip(rtmpServerUrl),
  };
};

export const runtimeUrls: RuntimeUrls = resolveRuntimeUrls();
