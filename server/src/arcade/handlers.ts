/**
 * The Arcade's main-socket (table lane) events (platform.md §5.4). Every event goes through
 * handle() with a zod schema, the `arcade` limiter family and quiet refusals: acks are
 * `{ok: true, …}` or `{ok: false, code}` and nothing is emitted on `error`.
 */
import { z } from 'zod';
import { handle, type SocketContext } from '../socket/context.js';
import type { Clock } from './clock.js';
import { GAME_IDS } from './core/version.js';
import type { ArcadeSettings } from './settings.js';

export interface HandlerDeps {
  clock: Clock;
  settings(): ArcadeSettings;
}

const boardSchema = z.object({ game: z.enum(GAME_IDS as [string, ...string[]]), board: z.string().min(1).max(32) });

export const registerArcadeHandlers = (sctx: SocketContext, deps: HandlerDeps): void => {
  void deps;
  handle(sctx, 'arcade:board', { schema: boardSchema, code: 'ARCADE_BOARD', limiter: 'arcade', refusal: 'arcade' }, (_payload, ack) => {
    ack?.({ ok: false, code: 'unknown' });
  });
};
