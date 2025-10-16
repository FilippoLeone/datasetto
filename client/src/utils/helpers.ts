/**
 * Storage utilities with type safety
 */

export class Storage {
  /**
   * Get an item from localStorage with type safety
   */
  static get<T>(key: string, defaultValue: T): T {
    try {
      const item = localStorage.getItem(key);
      if (item === null) return defaultValue;
      return JSON.parse(item) as T;
    } catch (error) {
      console.error(`Error reading from localStorage (${key}):`, error);
      return defaultValue;
    }
  }

  /**
   * Set an item in localStorage
   */
  static set<T>(key: string, value: T): boolean {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error(`Error writing to localStorage (${key}):`, error);
      return false;
    }
  }

  /**
   * Remove an item from localStorage
   */
  static remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error(`Error removing from localStorage (${key}):`, error);
    }
  }

  /**
   * Clear all localStorage
   */
  static clear(): void {
    try {
      localStorage.clear();
    } catch (error) {
      console.error('Error clearing localStorage:', error);
    }
  }
}

/**
 * Simple non-cryptographic hash function for password hashing
 * NOTE: This is NOT secure and should only be used for client-side storage
 */
export function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

/**
 * Generate a unique ID
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Debounce function calls
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: number | undefined;
  
  return function (this: unknown, ...args: Parameters<T>) {
    const context = this;
    
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    
    timeout = window.setTimeout(() => {
      func.apply(context, args);
    }, wait);
  };
}

/**
 * Throttle function calls
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle: boolean;
  
  return function (this: unknown, ...args: Parameters<T>) {
    const context = this;
    
    if (!inThrottle) {
      func.apply(context, args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

/**
 * Format timestamp for display
 */
export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const isLocalHost = (host?: string): boolean => {
  if (!host) return false;
  return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
};

const DEFAULT_REMOTE_SERVER = 'https://datasetto.com';
const DEFAULT_REMOTE_RTMP = 'rtmp://datasetto.com:1935/live';

const deriveHlsFromServer = (server: string): string => `${stripTrailingSlash(server)}/hls`;

const deriveRtmpFromServer = (server: string): string => {
  try {
    const parsed = new URL(server);
  return `rtmp://${parsed.hostname}:1935/live`;
  } catch {
    return DEFAULT_REMOTE_RTMP;
  }
};

const pickRemoteUrl = (candidates: Array<string | undefined>, fallback: string): string => {
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (isLocalHost(parsed.hostname)) {
        continue;
      }
      return stripTrailingSlash(value);
    } catch {
      continue;
    }
  }

  return stripTrailingSlash(fallback);
};

const isBrowserEnvironment = typeof window !== 'undefined';
const desktopRuntimeConfig = isBrowserEnvironment ? window.datasettoDesktopConfig : undefined;

type CapacitorLike = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
};

const getCapacitor = (): CapacitorLike | undefined => {
  const globalScope = globalThis as typeof globalThis & { Capacitor?: CapacitorLike };
  return globalScope.Capacitor;
};

const resolveLocalFallbacks = () => {
  const defaults = {
    server: 'http://localhost:4000',
    hls: 'http://localhost/hls',
  rtmp: 'rtmp://localhost:1935/live',
  };

  if (!isBrowserEnvironment) {
    return defaults;
  }

  const capacitor = getCapacitor();
  const isNative = capacitor?.isNativePlatform?.() === true;
  const platform = isNative ? capacitor?.getPlatform?.() : undefined;

  if (!isNative) {
    return defaults;
  }

  if (platform === 'android') {
    const remoteServer = pickRemoteUrl(
      [
        import.meta.env.VITE_MOBILE_DEFAULT_SERVER_URL,
        import.meta.env.VITE_SERVER_URL,
        desktopRuntimeConfig?.serverUrl,
      ],
      DEFAULT_REMOTE_SERVER
    );

    const remoteHls = pickRemoteUrl(
      [
        import.meta.env.VITE_MOBILE_DEFAULT_HLS_URL,
        import.meta.env.VITE_HLS_BASE_URL,
        desktopRuntimeConfig?.hlsBaseUrl,
      ],
      deriveHlsFromServer(remoteServer)
    );

    const remoteRtmp = pickRemoteUrl(
      [
        import.meta.env.VITE_MOBILE_DEFAULT_RTMP_URL,
        import.meta.env.VITE_RTMP_SERVER_URL,
        desktopRuntimeConfig?.rtmpServerUrl,
      ],
      deriveRtmpFromServer(remoteServer)
    );

    return {
      server: remoteServer,
      hls: remoteHls,
      rtmp: remoteRtmp,
    };
  }

  if (platform === 'ios') {
    // iOS simulator can still reach the host via localhost. Physical devices require explicit env URLs.
    return defaults;
  }

  return defaults;
};

export interface RuntimeConfig {
  serverUrl: string;
  apiBaseUrl: string;
  hlsBaseUrl: string;
  rtmpServerUrl: string;
  warnings: string[];
  sources: {
    serverUrl: 'env' | 'origin' | 'fallback' | 'desktop';
    apiBaseUrl: 'env' | 'origin' | 'fallback' | 'desktop';
    hlsBaseUrl: 'env' | 'origin' | 'fallback' | 'desktop';
    rtmpServerUrl: 'env' | 'origin' | 'fallback' | 'desktop';
  };
}

/**
 * Resolve runtime URLs for the client, preferring environment variables but
 * gracefully falling back to the current origin when deploying behind a domain.
 */
export function resolveRuntimeConfig(): RuntimeConfig {
  const warnings: string[] = [];
  const sources: RuntimeConfig['sources'] = {
    serverUrl: 'env',
    apiBaseUrl: 'env',
    hlsBaseUrl: 'env',
    rtmpServerUrl: 'env',
  };

  const localFallbacks = resolveLocalFallbacks();

  const origin = isBrowserEnvironment ? window.location.origin : undefined;
  const host = isBrowserEnvironment ? window.location.hostname : undefined;
  const isHttpOrigin = typeof origin === 'string' && origin.startsWith('http');
  const runningOnLocalhost = isLocalHost(host);

  const desktopServer = desktopRuntimeConfig?.serverUrl?.trim();
  const envServer = import.meta.env.VITE_SERVER_URL?.trim();
  let serverUrl = desktopServer || envServer;

  if (desktopServer) {
    sources.serverUrl = 'desktop';
  }

  if (!serverUrl) {
    if (isHttpOrigin && !runningOnLocalhost) {
      serverUrl = origin;
      sources.serverUrl = 'origin';
    } else {
      serverUrl = localFallbacks.server;
      sources.serverUrl = 'fallback';
      warnings.push(`VITE_SERVER_URL not set; using local fallback ${localFallbacks.server}.`);
    }
  }

  const desktopApi = desktopRuntimeConfig?.apiBaseUrl?.trim();
  const envApi = import.meta.env.VITE_API_BASE_URL?.trim();
  let apiBaseUrl = desktopApi || envApi || serverUrl;

  if (desktopApi) {
    sources.apiBaseUrl = 'desktop';
  } else if (envApi) {
    sources.apiBaseUrl = 'env';
  } else {
    sources.apiBaseUrl = sources.serverUrl;
    if (sources.apiBaseUrl === 'fallback') {
      warnings.push('VITE_API_BASE_URL not set; using same fallback as server URL.');
    }
  }

  const desktopHls = desktopRuntimeConfig?.hlsBaseUrl?.trim();
  const envHls = import.meta.env.VITE_HLS_BASE_URL?.trim();
  let hlsBaseUrl = desktopHls || envHls;

  if (desktopHls) {
    sources.hlsBaseUrl = 'desktop';
  }

  if (!hlsBaseUrl) {
    if (isHttpOrigin && !runningOnLocalhost) {
      hlsBaseUrl = `${stripTrailingSlash(origin)}/hls`;
      sources.hlsBaseUrl = 'origin';
    } else {
      hlsBaseUrl = localFallbacks.hls;
      sources.hlsBaseUrl = 'fallback';
      warnings.push(`VITE_HLS_BASE_URL not set; using local fallback ${localFallbacks.hls}.`);
    }
  }

  const desktopRtmp = desktopRuntimeConfig?.rtmpServerUrl?.trim();
  const envRtmp = import.meta.env.VITE_RTMP_SERVER_URL?.trim();
  let rtmpServerUrl = desktopRtmp || envRtmp;

  if (desktopRtmp) {
    sources.rtmpServerUrl = 'desktop';
  }

  if (!rtmpServerUrl) {
    if (isHttpOrigin && !runningOnLocalhost) {
      try {
        const parsed = new URL(origin);
  rtmpServerUrl = `rtmp://${parsed.hostname}/live`;
        sources.rtmpServerUrl = 'origin';
      } catch {
        rtmpServerUrl = localFallbacks.rtmp;
        sources.rtmpServerUrl = 'fallback';
        warnings.push(`Unable to derive RTMP ingest URL from origin; using fallback ${localFallbacks.rtmp}.`);
      }
    } else {
      rtmpServerUrl = localFallbacks.rtmp;
      sources.rtmpServerUrl = 'fallback';
      warnings.push(`VITE_RTMP_SERVER_URL not set; using local fallback ${localFallbacks.rtmp}.`);
    }
  }

  return {
    serverUrl: stripTrailingSlash(serverUrl),
    apiBaseUrl: stripTrailingSlash(apiBaseUrl),
    hlsBaseUrl: stripTrailingSlash(hlsBaseUrl),
    rtmpServerUrl: stripTrailingSlash(rtmpServerUrl),
    warnings,
    sources,
  };
}

/**
 * Validate environment variables and log any fallbacks that were applied.
 */
export function validateEnv(config: RuntimeConfig = resolveRuntimeConfig()): RuntimeConfig {
  config.warnings.forEach((warning) => console.warn(warning));
  return config;
}
