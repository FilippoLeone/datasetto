/*
 * Datasetto service worker: shows Web Push notifications and opens the app on click.
 * It caches nothing and has no fetch handler, so the app always loads from the network.
 * Registered from src/services/pushNotifications.ts once the user turns notifications on
 * (never inside the Electron or Capacitor shells, which notify on their own).
 */
const APP_PATH = '/app';
const ICON = '/icon-192.png';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/** Payload from server/src/services/push.ts: {title, body, url, tag, channelId}. */
const parsePayload = (event) => {
  if (!event.data) return {};
  try {
    const data = event.data.json();
    return data && typeof data === 'object' ? data : {};
  } catch {
    return { body: event.data.text() };
  }
};

self.addEventListener('push', (event) => {
  const data = parsePayload(event);
  const title = typeof data.title === 'string' && data.title ? data.title : 'Datasetto';
  const tag = typeof data.tag === 'string' && data.tag ? data.tag : undefined;
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    icon: ICON,
    badge: ICON,
    tag,
    // A newer message in the same conversation replaces the earlier notification and alerts again.
    renotify: Boolean(tag),
    timestamp: Date.now(),
    data: {
      url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : APP_PATH,
      channelId: typeof data.channelId === 'string' ? data.channelId : null,
    },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

const isAppClient = (client) => {
  try {
    const path = new URL(client.url).pathname;
    return path === APP_PATH || path.startsWith(APP_PATH + '/');
  } catch {
    return false;
  }
};

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(data.url || APP_PATH, self.location.origin);
  const channelId = data.channelId || target.searchParams.get('channel');

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const app = clients.find(isAppClient);
      if (app) {
        // The app is open somewhere: bring that window up and let it switch channels itself.
        if ('focus' in app) {
          try {
            await app.focus();
          } catch {
            /* focusing can be refused; the message below still switches the channel */
          }
        }
        app.postMessage({ type: 'push:open', channelId, url: target.href });
        return;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});

self.addEventListener('pushsubscriptionchange', (event) => {
  // The browser rotated the subscription. Re-subscribe with the same server key and tell
  // any open app window to send the new endpoint to the server; with no window open, the
  // app re-registers its subscription at the next sign-in anyway.
  event.waitUntil(
    (async () => {
      const key = event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey;
      if (!key) return;
      try {
        await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      } catch {
        return;
      }
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) client.postMessage({ type: 'push:resync' });
    })(),
  );
});
