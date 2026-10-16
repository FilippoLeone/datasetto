import { z } from 'zod';
import { AppError } from '../../errors.js';
import { channelUrl } from '../../services/messageNotifications.js';
import { handle, requireUser, type SocketContext } from '../context.js';

const ERR = 'push:error';

const subscribeSchema = z.object({
  endpoint: z.string().trim().min(1).max(2048),
  // Browsers may report an expiry; we do not use it.
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(256) }),
  userAgent: z.string().max(512).nullable().optional(),
});

const unsubscribeSchema = z.object({ endpoint: z.string().trim().min(1).max(2048) });
const visibilitySchema = z.object({ visible: z.boolean() });

/**
 * Web Push subscriptions of the signed-in account and the page-visibility heartbeat
 * that decides whether a notification is needed at all. The subscription events
 * answer through the acknowledgement when the client passes one, else on
 * `push:subscriptions`.
 */
export const registerPushHandlers = (sctx: SocketContext): void => {
  const { app, socket } = sctx;

  const requireEnabled = () => {
    if (!app.push.isEnabled()) {
      throw new AppError('Push notifications are not configured on this server', 'PUSH_DISABLED', 503);
    }
  };

  const reply = (ack: ((response: unknown) => void) | null, payload: Record<string, unknown>) => {
    if (ack) ack({ success: true, ...payload });
    else socket.emit('push:subscriptions', payload);
  };

  handle(sctx, 'push:subscribe', { schema: subscribeSchema, errorEvent: ERR, code: 'PUSH_SUBSCRIBE_FAILED' }, (payload, ack) => {
    const user = requireUser(sctx);
    requireEnabled();
    const subscription = app.push.subscribe(user.accountId, sctx.sessionTokenHash, {
      endpoint: payload.endpoint,
      keys: payload.keys,
      userAgent: payload.userAgent ?? sctx.userAgent,
    });
    app.log.info({ accountId: user.accountId, subscriptionId: subscription.id }, 'push subscription registered');
    reply(ack, { subscription, subscriptions: app.push.list(user.accountId) });
  });

  handle(sctx, 'push:unsubscribe', { schema: unsubscribeSchema, errorEvent: ERR, code: 'PUSH_UNSUBSCRIBE_FAILED' }, ({ endpoint }, ack) => {
    const user = requireUser(sctx);
    const removed = app.push.unsubscribe(user.accountId, endpoint);
    if (removed) app.log.info({ accountId: user.accountId }, 'push subscription removed');
    reply(ack, { removed, subscriptions: app.push.list(user.accountId) });
  });

  handle(sctx, 'push:list', { errorEvent: ERR, code: 'PUSH_LIST_FAILED' }, (_payload, ack) => {
    const user = requireUser(sctx);
    reply(ack, { enabled: app.push.isEnabled(), subscriptions: app.push.list(user.accountId) });
  });

  // "Does it work?" from the settings dialog: sent right away, whether or not the page is visible.
  handle(sctx, 'push:test', { errorEvent: ERR, code: 'PUSH_TEST_FAILED', limiter: 'auth' }, async (_payload, ack) => {
    const user = requireUser(sctx);
    requireEnabled();
    if (app.push.list(user.accountId).length === 0) {
      throw new AppError('No device of this login is subscribed to notifications', 'PUSH_NO_SUBSCRIPTIONS', 409);
    }
    const result = await app.push.send(
      user.accountId,
      {
        title: 'Datasetto',
        body: 'Notifications work on this device. You will hear about direct messages and @mentions while the app is hidden.',
        url: sctx.currentChannel ? channelUrl(sctx.currentChannel) : '/app',
        tag: 'test',
        channelId: sctx.currentChannel,
      },
      'test',
    );
    if (result.skipped === 'rate-limited') {
      throw new AppError('A test notification was sent a moment ago. Try again in half a minute.', 'RATE_LIMITED', 429);
    }
    if (ack) ack({ success: true, ...result });
    else socket.emit('push:tested', result);
  });

  // Heartbeat: the page says whether it is visible. Every 30 s while visible, at once on a change.
  handle(sctx, 'presence:visibility', { schema: visibilitySchema, code: 'VISIBILITY_FAILED' }, ({ visible }) => {
    app.presence.setVisibility(socket.id, visible);
  });
};
