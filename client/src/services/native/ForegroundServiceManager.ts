import type { ForegroundServicePlugin } from '@capawesome-team/capacitor-android-foreground-service';

let pluginPromise: Promise<ForegroundServicePlugin | null> | null = null;
let serviceActive = false;
let channelInitialized = false;

async function loadPlugin(): Promise<ForegroundServicePlugin | null> {
  if (!pluginPromise) {
    pluginPromise = (async () => {
      try {
        const { Capacitor } = await import('@capacitor/core');
        if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
          return null;
        }
        if (!Capacitor.isPluginAvailable('ForegroundService')) {
          return null;
        }
        const module = await import('@capawesome-team/capacitor-android-foreground-service');
        return module.ForegroundService;
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('[ForegroundServiceManager] Unable to load plugin:', error);
        }
        return null;
      }
    })();
  }
  return pluginPromise;
}

export async function ensureForegroundServiceForVoice(): Promise<void> {
  const plugin = await loadPlugin();
  if (!plugin) {
    return;
  }

  try {
    const { Importance, ServiceType } = await import('@capawesome-team/capacitor-android-foreground-service');

    if (!channelInitialized) {
      try {
        await plugin.createNotificationChannel({
          id: 'datasetto_voice',
          name: 'Voice chat',
          description: 'Keeps Datasetto voice chat active in the background.',
          importance: Importance.Default,
        });
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('[ForegroundServiceManager] Unable to create notification channel:', error);
        }
      }
      channelInitialized = true;
    }

    const permission = await plugin.checkPermissions().catch(() => null);
    if (!permission || permission.display !== 'granted') {
      await plugin.requestPermissions().catch((error) => {
        if (import.meta.env.DEV) {
          console.warn('[ForegroundServiceManager] Notification permission request failed:', error);
        }
      });
    }

    await plugin.startForegroundService({
      id: 1001,
      title: 'Datasetto voice chat',
      body: 'Your microphone stays live while Datasetto runs in the background.',
      smallIcon: 'ic_stat_datasetto',
      silent: true,
      notificationChannelId: 'datasetto_voice',
      serviceType: ServiceType.Microphone,
    });

    serviceActive = true;
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('[ForegroundServiceManager] Failed to start foreground service:', error);
    }
  }
}

export async function stopForegroundServiceForVoice(): Promise<void> {
  const plugin = await loadPlugin();
  if (!plugin || !serviceActive) {
    return;
  }

  try {
    await plugin.stopForegroundService();
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('[ForegroundServiceManager] Failed to stop foreground service:', error);
    }
  } finally {
    serviceActive = false;
  }
}
