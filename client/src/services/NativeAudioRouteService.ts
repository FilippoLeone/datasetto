export type NativeAudioRouteType = 'speaker' | 'earpiece' | 'bluetooth' | 'wired' | 'other';

export interface NativeAudioRoute {
  id: string;
  label: string;
  type: NativeAudioRouteType;
  selected: boolean;
}

interface AudioRoutePlugin {
  listRoutes(): Promise<{ routes: NativeAudioRoute[] }>;
  setRoute(options: { id?: string }): Promise<void>;
}

let pluginPromise: Promise<AudioRoutePlugin | null> | null = null;

async function loadPlugin(): Promise<AudioRoutePlugin | null> {
  if (pluginPromise) {
    return pluginPromise;
  }

  pluginPromise = (async () => {
    try {
      const { Capacitor, registerPlugin } = await import('@capacitor/core');

      if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('AudioRoute')) {
        return null;
      }

      return registerPlugin<AudioRoutePlugin>('AudioRoute');
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[NativeAudioRouteService] Unable to load AudioRoute plugin:', error);
      }
      return null;
    }
  })();

  return pluginPromise;
}

export function isNativeAudioRoutingAvailable(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const globalScope = globalThis as unknown as {
    Capacitor?: {
      isNativePlatform?: () => boolean;
      isPluginAvailable?: (name: string) => boolean;
    };
  };

  const maybeCapacitor = globalScope.Capacitor;
  if (!maybeCapacitor || typeof maybeCapacitor.isNativePlatform !== 'function') {
    return false;
  }

  if (!maybeCapacitor.isNativePlatform()) {
    return false;
  }

  if (typeof maybeCapacitor.isPluginAvailable === 'function') {
    try {
      return maybeCapacitor.isPluginAvailable('AudioRoute');
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[NativeAudioRouteService] Error checking plugin availability:', error);
      }
      return false;
    }
  }

  // Assume available when running natively if API is missing; loadPlugin will validate before use.
  return true;
}

export async function fetchNativeAudioRoutes(): Promise<NativeAudioRoute[]> {
  const plugin = await loadPlugin();
  if (!plugin) {
    return [];
  }

  try {
    const result = await plugin.listRoutes();
    if (!result || !Array.isArray(result.routes)) {
      return [];
    }

    return result.routes.filter((route): route is NativeAudioRoute =>
      typeof route?.id === 'string' &&
      typeof route?.label === 'string' &&
      typeof route?.type === 'string'
    );
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('[NativeAudioRouteService] Failed to fetch routes:', error);
    }
    return [];
  }
}

export async function selectNativeAudioRoute(routeId: string | null): Promise<void> {
  const plugin = await loadPlugin();
  if (!plugin) {
    throw new Error('Native audio routing is not available on this platform.');
  }

  try {
    await plugin.setRoute({ id: routeId ?? '' });
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('[NativeAudioRouteService] Failed to set audio route:', error);
    }
    throw error instanceof Error ? error : new Error('Unable to change audio route.');
  }
}
