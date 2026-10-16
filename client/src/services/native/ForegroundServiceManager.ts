import type { ForegroundServicePlugin, StartForegroundServiceOptions } from '@capawesome-team/capacitor-android-foreground-service';

// The plugin is kept inside an object on purpose: a Capacitor plugin proxy answers every
// property, so resolving a promise with the proxy itself makes the runtime look for
// `.then` and call "ForegroundService.then()", which throws on the native side.
let pluginPromise: Promise<{ plugin: ForegroundServicePlugin | null }> | null = null;
let serviceActive = false;
let channelInitialized = false;
let listenersBound = false;
/** What the notification's Leave button does; set by the voice manager. */
let leaveHandler: (() => void) | null = null;

const NOTIFICATION_ID = 1001;
const LEAVE_BUTTON_ID = 1;

export interface VoiceNotification {
  /** Name of the voice channel, shown as the notification title. */
  channelName: string;
  /** Called when the user taps Leave on the notification. */
  onLeave?: () => void;
}

/** Resolves to `{ plugin }`, never to the proxy itself (see above); callers destructure. */
function loadPlugin(): Promise<{ plugin: ForegroundServicePlugin | null }> {
  if (!pluginPromise) {
    pluginPromise = (async () => {
      try {
        const { Capacitor } = await import('@capacitor/core');
        if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
          return { plugin: null };
        }
        if (!Capacitor.isPluginAvailable('ForegroundService')) {
          return { plugin: null };
        }
        const module = await import('@capawesome-team/capacitor-android-foreground-service');
        return { plugin: module.ForegroundService };
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('[ForegroundServiceManager] Unable to load plugin:', error);
        }
        return { plugin: null };
      }
    })();
  }
  return pluginPromise;
}

/**
 * Keep an Android foreground service (and its notification) running while in
 * voice: "<channel> / Voice chat is on" with a Leave button. Calling it again
 * updates the notification, so a channel switch renames it.
 */
export async function ensureForegroundServiceForVoice(options: VoiceNotification = { channelName: 'voice' }): Promise<void> {
  const { plugin } = await loadPlugin();
  if (!plugin) {
    return;
  }
  if (options.onLeave) leaveHandler = options.onLeave;

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

    if (!listenersBound) {
      listenersBound = true;
      try {
        await plugin.addListener('buttonClicked', (event) => {
          if (event.buttonId === LEAVE_BUTTON_ID) leaveHandler?.();
        });
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('[ForegroundServiceManager] Unable to listen for notification buttons:', error);
        }
      }
    }

    const permission = await plugin.checkPermissions().catch(() => null);
    if (!permission || permission.display !== 'granted') {
      await plugin.requestPermissions().catch((error) => {
        if (import.meta.env.DEV) {
          console.warn('[ForegroundServiceManager] Notification permission request failed:', error);
        }
      });
    }

    const notification: StartForegroundServiceOptions = {
      id: NOTIFICATION_ID,
      title: options.channelName,
      body: 'Voice chat is on. Tap to come back.',
      smallIcon: 'ic_stat_datasetto',
      silent: true,
      notificationChannelId: 'datasetto_voice',
      serviceType: ServiceType.Microphone,
      buttons: [{ id: LEAVE_BUTTON_ID, title: 'Leave' }],
    };
    if (serviceActive) {
      await plugin.updateForegroundService(notification);
    } else {
      await plugin.startForegroundService(notification);
      serviceActive = true;
    }
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('[ForegroundServiceManager] Failed to start foreground service:', error);
    }
  }
}

export async function stopForegroundServiceForVoice(): Promise<void> {
  const { plugin } = await loadPlugin();
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
