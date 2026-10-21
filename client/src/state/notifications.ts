import { signal } from '@preact/signals';
import { Storage } from '@/lib/storage';
import type { NotificationPreferences } from '@/types/protocol';

export type PushPermission = NotificationPermission | 'unsupported';

const PREFERENCES_KEY = 'datasetto.notifications.v1';

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = { mentions: true, dms: true };

const loadPreferences = (): NotificationPreferences => {
  const stored = Storage.get<Partial<NotificationPreferences> | null>(PREFERENCES_KEY, null);
  return {
    mentions: stored?.mentions !== false,
    dms: stored?.dms !== false,
  };
};

/**
 * What this device tells the user about: @mentions and direct messages, each on
 * its own switch (both on by default). The in-app notifications read it directly;
 * Web Push sends it along with the subscription so the server pushes only those.
 */
export const notificationPreferences = signal<NotificationPreferences>(loadPreferences());

export const setNotificationPreferences = (patch: Partial<NotificationPreferences>): NotificationPreferences => {
  const next = { ...notificationPreferences.value, ...patch };
  notificationPreferences.value = next;
  Storage.set(PREFERENCES_KEY, next);
  return next;
};

/** Where Web Push stands for this browser; shown in the settings dialog. */
export interface PushStatus {
  /** The browser can do Web Push (service worker, PushManager, Notification) in a secure context. */
  supported: boolean;
  /** Running inside the Electron or Capacitor shell, which notifies on its own. */
  native: boolean;
  /** The server has VAPID keys (`GET /api/config` → `push.enabled`). */
  serverEnabled: boolean;
  permission: PushPermission;
  /** This browser holds a subscription the server knows about. */
  enabled: boolean;
  /** A permission prompt, subscription or unsubscription is in progress. */
  busy: boolean;
  error: string | null;
}

export const DEFAULT_PUSH_STATUS: PushStatus = {
  supported: false,
  native: false,
  serverEnabled: false,
  permission: 'unsupported',
  enabled: false,
  busy: false,
  error: null,
};

export const pushStatus = signal<PushStatus>(DEFAULT_PUSH_STATUS);

export const updatePushStatus = (patch: Partial<PushStatus>): PushStatus => {
  const next = { ...pushStatus.value, ...patch };
  pushStatus.value = next;
  return next;
};

/** What the Notifications section shows: the switch position and the words around it. */
export type PushToggle = 'on' | 'off' | 'unavailable';

export interface PushStatusView {
  toggle: PushToggle;
  label: string;
  detail: string;
  /** A test notification can be sent. */
  canTest: boolean;
}

export const describePushStatus = (status: PushStatus): PushStatusView => {
  if (status.native) {
    return {
      toggle: 'unavailable',
      label: 'Handled by the app',
      detail: 'The desktop and mobile apps show their own notifications; nothing to set up here.',
      canTest: false,
    };
  }
  if (!status.supported) {
    return {
      toggle: 'unavailable',
      label: 'Not available in this browser',
      detail: 'Push notifications need a secure connection (https) and a browser with service workers.',
      canTest: false,
    };
  }
  if (!status.serverEnabled) {
    return {
      toggle: 'unavailable',
      label: 'Off on this server',
      detail: 'The server has no push keys configured (PUSH_VAPID_* in its environment).',
      canTest: false,
    };
  }
  if (status.permission === 'denied') {
    return {
      toggle: 'unavailable',
      label: 'Blocked',
      detail: 'Notifications are blocked for this site in the browser settings. Allow them there, then come back.',
      canTest: false,
    };
  }
  if (status.enabled) {
    return {
      toggle: 'on',
      label: 'On for this device',
      detail: 'Direct messages and @mentions reach this device while the app is hidden or closed.',
      canTest: true,
    };
  }
  return {
    toggle: 'off',
    label: 'Off',
    detail:
      status.permission === 'granted'
        ? 'Turn on to hear about direct messages and @mentions while the app is hidden or closed.'
        : 'Turn on to hear about direct messages and @mentions while the app is hidden or closed. The browser will ask for permission.',
    canTest: false,
  };
};
