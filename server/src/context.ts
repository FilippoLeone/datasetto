import type { AppConfig } from './config.js';
import type { DB } from './db/index.js';
import { logger, type Logger } from './logger.js';
import { AccountService } from './services/accounts.js';
import { AvatarService } from './services/avatars.js';
import { ChannelService } from './services/channels.js';
import { LeaderboardService } from './services/leaderboard.js';
import { MessageService } from './services/messages.js';
import { ModerationService } from './services/moderation.js';
import { PresenceService } from './services/presence.js';
import { SearchService } from './services/search.js';
import { PushService, type PushServiceOptions } from './services/push.js';
import { SessionService } from './services/sessions.js';
import { SettingsService } from './services/settings.js';
import { TurnService } from './services/turn.js';
import { HlsTicketService } from './services/hlsTickets.js';
import { InviteService } from './services/invites.js';
import { LinkPreviewService, type LinkPreviewOptions } from './services/linkPreviews.js';
import { UploadService } from './services/uploads.js';
import { UsageService } from './services/usage.js';

/** Fan-out helpers implemented by the socket layer once it exists. */
export interface Broadcaster {
  channels(): void;
  users(): void;
  screenshare(channelId: string, targetSocketId?: string | null): void;
  /** Toast for everyone currently in a channel. */
  notifyChannel(channelId: string, notification: { type: 'info' | 'success' | 'warning' | 'error'; message: string }): void;
  /** Emit to every authenticated socket allowed to view the channel (not only the ones currently in it). */
  toChannelViewers(channelId: string, event: string, payload: unknown): void;
  /** Emit to every connected socket of one account. */
  toAccount(accountId: string, event: string, payload: unknown): void;
}

export interface AppContext {
  config: AppConfig;
  log: Logger;
  db: DB;
  accounts: AccountService;
  avatars: AvatarService;
  invites: InviteService;
  sessions: SessionService;
  settings: SettingsService;
  channels: ChannelService;
  messages: MessageService;
  uploads: UploadService;
  linkPreviews: LinkPreviewService;
  search: SearchService;
  moderation: ModerationService;
  presence: PresenceService;
  push: PushService;
  turn: TurnService;
  leaderboard: LeaderboardService;
  hlsTickets: HlsTicketService;
  usage: UsageService;
  broadcast: Broadcaster;
  startedAt: number;
}

const noopBroadcaster: Broadcaster = {
  channels: () => undefined,
  users: () => undefined,
  screenshare: () => undefined,
  notifyChannel: () => undefined,
  toChannelViewers: () => undefined,
  toAccount: () => undefined,
};

export interface ContextOptions {
  /** Test hook: capture push deliveries instead of calling the push services. */
  push?: PushServiceOptions;
  /** Test hook: fake DNS or transport for link previews. */
  linkPreviews?: LinkPreviewOptions;
}

export const createContext = (config: AppConfig, db: DB, options: ContextOptions = {}): AppContext => {
  const channels = new ChannelService(db, config);
  channels.seedDefaults();
  const invites = new InviteService(db);
  const settings = new SettingsService(db);
  const uploads = new UploadService(
    db,
    { dataDir: config.storage.dataDir, maxBytes: config.uploads.maxBytes, previewMaxPx: config.uploads.previewMaxPx },
    settings.secret('mediaTicketSecret'),
  );

  return {
    config,
    log: logger,
    db,
    accounts: new AccountService(db, config, invites),
    avatars: new AvatarService(config.storage.dataDir),
    invites,
    sessions: new SessionService(db, config.sessions.ttlMs),
    settings,
    channels,
    messages: new MessageService(db, config, uploads),
    uploads,
    linkPreviews: new LinkPreviewService(db, options.linkPreviews),
    search: new SearchService(db),
    moderation: new ModerationService(db),
    presence: new PresenceService(),
    push: new PushService(db, config.push, logger, options.push),
    turn: new TurnService(config.turn),
    leaderboard: new LeaderboardService(db),
    hlsTickets: new HlsTicketService(config.streaming.ticketSecret),
    usage: new UsageService(db),
    broadcast: noopBroadcaster,
    startedAt: Date.now(),
  };
};
