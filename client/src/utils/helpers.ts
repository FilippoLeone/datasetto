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

const LOCAL_SERVER_FALLBACK = 'http://localhost:4000';
const LOCAL_HLS_FALLBACK = 'http://localhost/hls';
const LOCAL_RTMP_FALLBACK = 'rtmp://localhost:1935/hls';

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const isBrowserEnvironment = typeof window !== 'undefined';

const isLocalHost = (host?: string): boolean => {
  if (!host) return false;
  return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
};

export interface RuntimeConfig {
  serverUrl: string;
  apiBaseUrl: string;
  hlsBaseUrl: string;
  rtmpServerUrl: string;
  warnings: string[];
  sources: {
    serverUrl: 'env' | 'origin' | 'fallback';
    apiBaseUrl: 'env' | 'origin' | 'fallback';
    hlsBaseUrl: 'env' | 'origin' | 'fallback';
    rtmpServerUrl: 'env' | 'origin' | 'fallback';
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

  const origin = isBrowserEnvironment ? window.location.origin : undefined;
  const host = isBrowserEnvironment ? window.location.hostname : undefined;
  const runningOnLocalhost = isLocalHost(host);

  const envServer = import.meta.env.VITE_SERVER_URL?.trim();
  let serverUrl = envServer;

  if (!serverUrl) {
    if (origin && !runningOnLocalhost) {
      serverUrl = origin;
      sources.serverUrl = 'origin';
      warnings.push('VITE_SERVER_URL not set; falling back to current origin for socket connections.');
    } else {
      serverUrl = LOCAL_SERVER_FALLBACK;
      sources.serverUrl = 'fallback';
      warnings.push(`VITE_SERVER_URL not set; using local fallback ${LOCAL_SERVER_FALLBACK}.`);
    }
  }

  const envApi = import.meta.env.VITE_API_BASE_URL?.trim();
  let apiBaseUrl = envApi || serverUrl;
  if (!envApi) {
    sources.apiBaseUrl = sources.serverUrl;
    if (sources.apiBaseUrl === 'fallback') {
      warnings.push('VITE_API_BASE_URL not set; using same fallback as server URL.');
    } else if (sources.apiBaseUrl === 'origin') {
      warnings.push('VITE_API_BASE_URL not set; using current origin for API requests.');
    }
  }

  const envHls = import.meta.env.VITE_HLS_BASE_URL?.trim();
  let hlsBaseUrl = envHls;

  if (!hlsBaseUrl) {
    if (origin && !runningOnLocalhost) {
      hlsBaseUrl = `${stripTrailingSlash(origin)}/hls`;
      sources.hlsBaseUrl = 'origin';
      warnings.push('VITE_HLS_BASE_URL not set; falling back to current origin /hls.');
    } else {
      hlsBaseUrl = LOCAL_HLS_FALLBACK;
      sources.hlsBaseUrl = 'fallback';
      warnings.push(`VITE_HLS_BASE_URL not set; using local fallback ${LOCAL_HLS_FALLBACK}.`);
    }
  }

  const envRtmp = import.meta.env.VITE_RTMP_SERVER_URL?.trim();
  let rtmpServerUrl = envRtmp;

  if (!rtmpServerUrl) {
    if (origin && !runningOnLocalhost) {
      try {
        const parsed = new URL(origin);
        rtmpServerUrl = `rtmp://${parsed.hostname}/hls`;
        sources.rtmpServerUrl = 'origin';
        warnings.push('VITE_RTMP_SERVER_URL not set; deriving RTMP ingest URL from current origin.');
      } catch {
        rtmpServerUrl = LOCAL_RTMP_FALLBACK;
        sources.rtmpServerUrl = 'fallback';
        warnings.push(`Unable to derive RTMP ingest URL from origin; using fallback ${LOCAL_RTMP_FALLBACK}.`);
      }
    } else {
      rtmpServerUrl = LOCAL_RTMP_FALLBACK;
      sources.rtmpServerUrl = 'fallback';
      warnings.push(`VITE_RTMP_SERVER_URL not set; using local fallback ${LOCAL_RTMP_FALLBACK}.`);
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
