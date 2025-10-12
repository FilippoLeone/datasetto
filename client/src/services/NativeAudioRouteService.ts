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
        await plugin.listRoutes();
        return plugin;
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('[NativeAudioRouteService] AudioRoute plugin not implemented on this platform:', error);
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

    ensureRoutePresence(filtered, 'speakerphone', 'Speakerphone', 'speaker');
    ensureRoutePresence(filtered, 'earpiece', 'Phone Earpiece', 'earpiece');

    return filtered;
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('[NativeAudioRouteService] Failed to fetch routes:', error);
    }
    return fallbackRoutes();
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

function fallbackRoutes(): NativeAudioRoute[] {
  return [
    {
      id: 'speakerphone',
      label: 'Speakerphone',
      type: 'speaker',
      selected: true,
    },
    {
      id: 'earpiece',
      label: 'Phone Earpiece',
      type: 'earpiece',
      selected: false,
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
