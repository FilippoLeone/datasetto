/**
 * Web Push for browsers (desktop browsers, Android Chrome and the installed PWA).
 *
 * The user opts in from the settings dialog: we ask for permission, register the
 * service worker (public/sw.js), subscribe with the server's VAPID public key and hand
 * the subscription to the server (`push:subscribe`). The choice is remembered per
 * browser; after every sign-in the subscription is sent again so it belongs to the
 * current login (the server drops subscriptions of ended logins). Nothing here runs
 * inside the Electron or Capacitor shells, which notify on their own.
 */
import { openChannelWhenListed } from '@/features/channels/channelActions';
import { isIOS, isNativeApp, isStandaloneDisplay } from '@/lib/device';
import { Storage } from '@/lib/storage';
import { serverConfig } from '@/services/ServerConfigService';
import { api } from '@/services/socket/api';
import { notificationPreferences, pushStatus, setNotificationPreferences, updatePushStatus, type PushPermission } from '@/state/notifications';
import { isAuthenticated } from '@/state/session';
import type { NotificationPreferences, PushAck } from '@/types/protocol';

/** Remembered per browser: the user turned notifications on here. */
const ENABLED_KEY = 'datasetto.push.v1';
export const SERVICE_WORKER_URL = '/sw.js';
const ACTIVATION_TIMEOUT_MS = 10_000;

export const pushSupported = (): boolean =>
  typeof window !== 'undefined' &&
  !isNativeApp() &&
  window.isSecureContext === true &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

const wantsPush = (): boolean => Storage.get<boolean>(ENABLED_KEY, false) === true;

const remember = (enabled: boolean): void => {
  if (enabled) Storage.set(ENABLED_KEY, true);
  else Storage.remove(ENABLED_KEY);
};

const permission = (): PushPermission => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

const errorText = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong while setting up notifications';
};

const bytesToBase64Url = (buffer: ArrayBuffer | null): string => {
  if (!buffer) return '';
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** Resolve once the registration has an active worker (ours activates at once: skipWaiting + claim). */
const awaitActive = (registration: ServiceWorkerRegistration): Promise<void> =>
  new Promise((resolve) => {
    if (registration.active) return resolve();
    const worker = registration.installing ?? registration.waiting;
    if (!worker) return resolve();
    const timer = window.setTimeout(resolve, ACTIVATION_TIMEOUT_MS);
    const onState = () => {
      if (worker.state !== 'activated' && worker.state !== 'redundant') return;
      worker.removeEventListener('statechange', onState);
      window.clearTimeout(timer);
      resolve();
    };
    worker.addEventListener('statechange', onState);
  });

const registerWorker = async (): Promise<ServiceWorkerRegistration> => {
  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  await awaitActive(registration);
  return registration;
};

/** The browser's subscription for the server's current key; a stale one (key rotated) is replaced. */
const ensureSubscription = async (registration: ServiceWorkerRegistration, serverKey: string): Promise<PushSubscription> => {
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    const existingKey = bytesToBase64Url(existing.options.applicationServerKey);
    if (!existingKey || existingKey === serverKey) return existing;
    await existing.unsubscribe();
  }
  // The key may be passed as the base64url string the server hands out.
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });
};

const registerWithServer = async (subscription: PushSubscription) => {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('The browser returned an incomplete push subscription');
  }
  return api.subscribePush({
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    userAgent: navigator.userAgent.slice(0, 512),
    // The server pushes only what this device asked for.
    preferences: { ...notificationPreferences.value },
  });
};

/**
 * Change what this device is told about. The in-app notifications read the new
 * choice at once; when Web Push is on here, the subscription is sent again so
 * the server knows too.
 */
export const updateNotificationPreferences = async (patch: Partial<NotificationPreferences>): Promise<void> => {
  setNotificationPreferences(patch);
  if (pushStatus.value.enabled && isAuthenticated.value) await syncPushSubscription();
};

const failed = (ack: PushAck): string | null => (ack.success ? null : ack.error || 'The server refused the request');

/** Where this page runs: iPhone or iPad, and whether it was opened from the Home Screen (iOS has Web Push only there). */
const platform = () => ({ ios: isIOS(), standalone: isStandaloneDisplay() });

/** Read the current situation into the status signal without changing anything. */
export const refreshPushStatus = async (): Promise<void> => {
  const native = isNativeApp();
  const supported = pushSupported();
  let enabled = false;
  if (supported && permission() === 'granted' && wantsPush()) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      enabled = Boolean(await registration?.pushManager.getSubscription());
    } catch {
      enabled = false;
    }
  }
  updatePushStatus({ ...platform(), native, supported, serverEnabled: serverConfig.pushEnabled(), permission: permission(), enabled });
};

/** Turn notifications on for this browser: permission prompt, service worker, subscription. */
export const enablePush = async (): Promise<boolean> => {
  if (!pushSupported() || !serverConfig.pushEnabled()) {
    await refreshPushStatus();
    return false;
  }
  updatePushStatus({ busy: true, error: null });
  try {
    const granted = (await Notification.requestPermission()) === 'granted';
    if (!granted) {
      updatePushStatus({ permission: permission(), enabled: false });
      return false;
    }
    const serverKey = serverConfig.pushPublicKey();
    if (!serverKey) throw new Error('The server did not provide a push key');
    const registration = await registerWorker();
    const subscription = await ensureSubscription(registration, serverKey);
    const error = failed(await registerWithServer(subscription));
    if (error) throw new Error(error);
    remember(true);
    updatePushStatus({ permission: permission(), enabled: true });
    return true;
  } catch (error) {
    updatePushStatus({ permission: permission(), enabled: false, error: errorText(error) });
    return false;
  } finally {
    updatePushStatus({ busy: false });
  }
};

/** Turn notifications off for this browser: forget the choice, tell the server, drop the subscription. */
export const disablePush = async (): Promise<void> => {
  updatePushStatus({ busy: true, error: null });
  remember(false);
  try {
    const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      try {
        await api.unsubscribePush(subscription.endpoint);
      } catch {
        /* offline: the server drops the subscription with the login, or on the first failed push */
      }
      await subscription.unsubscribe();
    }
    updatePushStatus({ enabled: false });
  } catch (error) {
    updatePushStatus({ enabled: false, error: errorText(error) });
  } finally {
    updatePushStatus({ busy: false });
  }
};

/**
 * After a sign-in (and on `push:resync` from the worker): send this browser's
 * subscription again so the server ties it to the current login. Quiet when the user
 * never opted in here.
 */
export const syncPushSubscription = async (): Promise<void> => {
  if (!pushSupported() || !wantsPush() || permission() !== 'granted' || !serverConfig.pushEnabled()) {
    await refreshPushStatus();
    return;
  }
  try {
    const serverKey = serverConfig.pushPublicKey();
    if (!serverKey) throw new Error('The server did not provide a push key');
    const registration = await registerWorker();
    const subscription = await ensureSubscription(registration, serverKey);
    const error = failed(await registerWithServer(subscription));
    updatePushStatus({ ...platform(), native: false, supported: true, serverEnabled: true, permission: 'granted', enabled: error === null, error });
  } catch (error) {
    updatePushStatus({ enabled: false, error: errorText(error) });
  }
};

/** Ask the server for a test notification to every device of this login. Resolves to an error text or null. */
export const sendTestNotification = async (): Promise<string | null> => {
  try {
    return failed(await api.sendPushTest());
  } catch (error) {
    return errorText(error);
  }
};

/** Messages from the service worker: a notification was clicked, or the subscription changed. */
export const installPushListeners = (): void => {
  if (!pushSupported()) return;
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: unknown; channelId?: unknown } | null;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'push:open' && typeof data.channelId === 'string') openChannelWhenListed(data.channelId);
    if (data.type === 'push:resync' && isAuthenticated.value) void syncPushSubscription();
  });
};
