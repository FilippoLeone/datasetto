import type { AppConfig } from './config.js';
import type { DB } from './db/index.js';
import { logger, type Logger } from './logger.js';
import { AccountService } from './services/accounts.js';
import { ChannelService } from './services/channels.js';
import { LeaderboardService } from './services/leaderboard.js';
import { MessageService } from './services/messages.js';
import { ModerationService } from './services/moderation.js';
import { PresenceService } from './services/presence.js';
import { SessionService } from './services/sessions.js';
import { TurnService } from './services/turn.js';

/** Fan-out helpers implemented by the socket layer once it exists. */
export interface Broadcaster {
  channels(): void;
  users(): void;
  screenshare(channelId: string, targetSocketId?: string | null): void;
}

export interface AppContext {
  config: AppConfig;
  log: Logger;
  db: DB;
  accounts: AccountService;
  sessions: SessionService;
  channels: ChannelService;
  messages: MessageService;
  moderation: ModerationService;
  presence: PresenceService;
  turn: TurnService;
  leaderboard: LeaderboardService;
  broadcast: Broadcaster;
  startedAt: number;
}

const noopBroadcaster: Broadcaster = {
  channels: () => undefined,
  users: () => undefined,
  screenshare: () => undefined,
};

export const createContext = (config: AppConfig, db: DB): AppContext => {
  const channels = new ChannelService(db, config);
  channels.seedDefaults();

  return {
    config,
    log: logger,
    db,
    accounts: new AccountService(db, config),
    sessions: new SessionService(db, config.sessions.ttlMs),
    channels,
    messages: new MessageService(db, config),
    moderation: new ModerationService(db),
    presence: new PresenceService(),
    turn: new TurnService(config.turn),
    leaderboard: new LeaderboardService(db),
    broadcast: noopBroadcaster,
    startedAt: Date.now(),
  };
};
