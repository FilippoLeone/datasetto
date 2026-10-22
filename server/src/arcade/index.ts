/**
 * The Arcade on the server (docs/arcade/platform.md). `createArcade` is wired once by
 * socket/index.ts; the entry point stops it with the other components and shutdown.ts calls
 * `onRestarting()` before the sockets close.
 *
 * With nothing open the Arcade runs no timers at all: the scheduler starts with the first live
 * action match, table clocks run only during a hand, and the daily job is one unref'd timer.
 */
import type { Server as HttpServer } from 'node:http';
import type { Server } from 'socket.io';
import type { AppContext } from '../context.js';
import type { SocketContext } from '../socket/context.js';
import { systemClock, type Clock } from './clock.js';
import { DEFS, GAME_IDS, TABLE_PROTO, type GameId } from './core/version.js';
import { gameAvailable, gameSettingsParsers } from './games.js';
import { registerArcadeHandlers } from './handlers.js';
import { registerLegacyHandlers } from './legacy.js';
import { loadSettings, type ArcadeSettings } from './settings.js';

export interface ArcadePublicConfig {
  enabled: boolean;
  games: Record<GameId, boolean>;
  proto: { lamplight: number };
  defs: { glimmer: number };
}

export interface Arcade {
  stop(): Promise<void>;
  onRestarting(): Promise<void>;
  /** After auth:success: arcade:activity:all and arcade:wallet. */
  onAuthenticated(sctx: SocketContext): void;
  /** An account left a voice channel: its seats there start their grace rules. */
  onVoiceLeft(accountId: string, channelId: string): void;
  onSocketGone(sctx: SocketContext): void;
  publicConfig(): ArcadePublicConfig;
  /** Register the Arcade's main-socket events on a new connection (called by socket/index.ts). */
  register(sctx: SocketContext): void;
}

export interface ArcadeOptions {
  clock?: Clock;
}

export const createArcade = (ctx: AppContext, http: HttpServer, io: Server, opts: ArcadeOptions = {}): Arcade => {
  void http;
  void io;
  const clock = opts.clock ?? systemClock;
  const settings = (): ArcadeSettings => loadSettings(ctx.db, gameSettingsParsers());
  let current = settings();

  const publicConfig = (): ArcadePublicConfig => {
    const games = {} as Record<GameId, boolean>;
    for (const game of GAME_IDS) games[game] = current.enabled && current.games[game] && gameAvailable(game);
    return { enabled: current.enabled, games, proto: { lamplight: TABLE_PROTO.lamplight }, defs: { glimmer: DEFS.glimmer } };
  };

  return {
    register(sctx) {
      registerLegacyHandlers(sctx);
      registerArcadeHandlers(sctx, { clock, settings: () => current });
    },
    onAuthenticated() {
      current = settings();
    },
    onVoiceLeft() {},
    onSocketGone() {},
    publicConfig,
    async onRestarting() {},
    async stop() {},
  };
};
