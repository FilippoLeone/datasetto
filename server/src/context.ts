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
import type { StreamWatchdog } from './services/streamWatchdog.js';
import { createBurstLogger, type BurstLogger } from './socket/burstLog.js';

/**
 * Process-level state that the health endpoint and the socket layer read:
 * whether a graceful shutdown is under way (new connections are refused, health
 * answers 503), the stream watchdog once index.ts has started it, the live socket
 * count, and the burst logger that writes one line per reconnect wave.
 */
export interface RuntimeState {
  shuttingDown: boolean;
  watchdog: StreamWatchdog | null;
  /** Set by the socket server; 0 before it exists. */
  connectedSockets: () => number;
  bursts: BurstLogger;
}

/** Fan-out helpers implemented by the socket layer once it exists. */
export interface Broadcaster {
  channels(): void;
  /** Re-send the channel list to every socket of one account (a change only they see, such as a closed conversation). */
  channelsTo(accountId: string): void;
  users(): void;
  /** `extra` rides along on the event (e.g. `endedBy` when a share ended, so viewers know whether to wait). */
  screenshare(channelId: string, targetSocketId?: string | null, extra?: Record<string, unknown>): void;
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
  runtime: RuntimeState;
  startedAt: number;
}

const noopBroadcaster: Broadcaster = {
  channels: () => undefined,
  channelsTo: () => undefined,
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
    { dataDir: config.storage.dataDir, maxBytes: config.uploads.maxBytes, videoMaxBytes: config.uploads.videoMaxBytes, previewMaxPx: config.uploads.previewMaxPx },
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
    runtime: { shuttingDown: false, watchdog: null, connectedSockets: () => 0, bursts: createBurstLogger({ log: logger }) },
    startedAt: Date.now(),
  };
};
