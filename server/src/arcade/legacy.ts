/**
 * Old-shell stub (platform.md §14 item 16), kept for 3 releases after the Arcade ships, then removed
 * with its test (plan.md §4.4 PR 10). Desktop and Android builds from before the Arcade still offer
 * the old games: starting or joining one answers with a toast they already know how to show. Every
 * other old game event is ignored without an error. These event names are never reused.
 */
import { handle, type SocketContext } from '../socket/context.js';

export const LEGACY_MESSAGE = 'Games moved to the Arcade. Update the app to play.';

const LEGACY_EVENTS = ['voice:game:start', 'voice:game:join'] as const;

export const registerLegacyHandlers = (sctx: SocketContext): void => {
  for (const event of LEGACY_EVENTS) {
    handle(sctx, event, { code: 'GAME_MOVED', requireAuth: false, limiter: 'arcade', refusal: 'arcade' }, () => {
      sctx.socket.emit('voice:game:error', { message: LEGACY_MESSAGE });
    });
  }
};
