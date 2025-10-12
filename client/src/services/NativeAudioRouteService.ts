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
let corePromise: Promise<typeof import('@capacitor/core') | null> | null = null;

async function loadCapacitorCore(): Promise<typeof import('@capacitor/core') | null> {
  if (corePromise) {
    return corePromise;
  }

  corePromise = (async () => {
    try {
      return await import('@capacitor/core');
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[NativeAudioRouteService] Unable to import @capacitor/core:', error);
      }
      return null;
    }
  })();

  return corePromise;
}

async function loadPlugin(): Promise<AudioRoutePlugin | null> {
  if (pluginPromise) {
    return pluginPromise;
  }

  pluginPromise = (async () => {
    try {
      const core = await loadCapacitorCore();
      if (!core) {
        return null;
      }

      const { Capacitor, registerPlugin } = core;

      if (!Capacitor?.isNativePlatform?.()) {
        return null;
      }

      try {
        const plugin = registerPlugin<AudioRoutePlugin>('AudioRoute');
        // Test if the plugin is actually implemented by calling a method
        // This will throw if the plugin is not implemented on the native side
        const testResult = await plugin.listRoutes();
        
        if (import.meta.env.DEV) {
          console.log('[NativeAudioRouteService] AudioRoute plugin loaded successfully:', testResult);
        }
        
        return plugin;
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('[NativeAudioRouteService] AudioRoute plugin test call failed:', error);
        }
        return null;
      }
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error('[NativeAudioRouteService] Failed to load AudioRoute plugin:', error);
      }
      return null;
    }
  })();

  return pluginPromise;
}

export function isNativeAudioRoutingAvailable(): boolean {
  const globalScope = globalThis as unknown as {
    Capacitor?: {
      isNativePlatform?: () => boolean;
    };
  };

  return globalScope.Capacitor?.isNativePlatform?.() === true;
}

export async function fetchNativeAudioRoutes(): Promise<NativeAudioRoute[]> {
  const plugin = await loadPlugin();
  if (!plugin) {
    return isNativeAudioRoutingAvailable() ? fallbackRoutes() : [];
  }

  try {
    const result = await plugin.listRoutes();
    if (!result || !Array.isArray(result.routes) || result.routes.length === 0) {
      return fallbackRoutes();
    }

    const filtered = result.routes.filter((route): route is NativeAudioRoute =>
      typeof route?.id === 'string' &&
      typeof route?.label === 'string' &&
      typeof route?.type === 'string'
    );

    // Ensure speakerphone is always present as it's the default
    ensureRoutePresence(filtered, 'speakerphone', 'Speakerphone', 'speaker');
    // Don't force earpiece presence - let the plugin decide if device has one

    return filtered;
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('[NativeAudioRouteService] Failed to fetch routes:', error);
    }
    return fallbackRoutes();
  }
}

export async function selectNativeAudioRoute(routeId: string | null): Promise<void> {
  if (import.meta.env.DEV) {
    console.log('[NativeAudioRouteService] selectNativeAudioRoute called with routeId:', routeId);
  }
  
  const plugin = await loadPlugin();
  
  if (import.meta.env.DEV) {
    console.log('[NativeAudioRouteService] plugin loaded:', plugin ? 'success' : 'null');
  }
  
  if (!plugin) {
    const isNative = isNativeAudioRoutingAvailable();
    const errorMsg = isNative 
      ? 'Native audio routing plugin failed to initialize. Please check app permissions.'
      : 'Native audio routing is not available on this platform.';
    
    if (import.meta.env.DEV) {
      console.error('[NativeAudioRouteService] Plugin is null. isNative:', isNative);
    }
    
    throw new Error(errorMsg);
  }

  try {
    if (import.meta.env.DEV) {
      console.log('[NativeAudioRouteService] Calling plugin.setRoute with id:', routeId ?? '');
    }
    await plugin.setRoute({ id: routeId ?? '' });
    if (import.meta.env.DEV) {
      console.log('[NativeAudioRouteService] setRoute succeeded');
    }
  } catch (error) {
    if (import.meta.env.DEV) {
      console.error('[NativeAudioRouteService] setRoute failed:', error);
    }
    throw error instanceof Error ? error : new Error('Unable to change audio route.');
  }
}

function fallbackRoutes(): NativeAudioRoute[] {
  // Only return speakerphone as fallback - earpiece availability varies by device
  return [
    {
      id: 'speakerphone',
      label: 'Speakerphone',
      type: 'speaker',
      selected: true,
    },
  ];
}

function ensureRoutePresence(
  routes: NativeAudioRoute[],
  id: string,
  label: string,
  type: NativeAudioRouteType
): void {
  if (routes.some((route) => route.id === id)) {
    return;
  }

  routes.push({
    id,
    label,
    type,
    selected: id === 'speakerphone',
  });
}
