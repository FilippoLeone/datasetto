import { z } from 'zod';
import { MAX_ACTIVITY_LENGTH } from '../../services/presence.js';
import { handle, requireUser, type SocketContext } from '../context.js';

const activitySchema = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(MAX_ACTIVITY_LENGTH)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Title contains control characters')
    .nullable(),
});

/**
 * "Playing <game>": the desktop app tells the server which game from its list is running
 * (`presence:activity {title}`), null when none. The title is kept on the connected user
 * only (nothing is persisted), goes out with every `user:update` and disappears with the
 * socket. One report per socket per 10 s; refusals go to `presence:error`, which the
 * client ignores, so a rate-limited or malformed report is simply dropped.
 */
export const registerPresenceHandlers = (sctx: SocketContext): void => {
  const { app, socket } = sctx;

  handle(sctx, 'presence:activity', { schema: activitySchema, errorEvent: 'presence:error', code: 'ACTIVITY_FAILED', limiter: 'activity' }, ({ title }) => {
    const user = requireUser(sctx);
    if (!app.presence.setActivity(socket.id, title)) return;
    app.log.debug({ accountId: user.accountId, socketId: socket.id, title }, 'game activity updated');
    app.broadcast.users();
  });
};
