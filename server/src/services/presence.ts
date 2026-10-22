import { newId } from '../core/ids.js';
import type {
  ActiveStream,
  ChannelRecord,
  ChannelView,
  ConnectedUser,
  PublicAccount,
  ScreenshareSession,
  ScreenshareViewer,
  VoiceParticipant,
  VoiceRoom,
} from '../types.js';

/**
 * A visible page heartbeats every 30 s (client/src/services/visibilityHeartbeat.ts);
 * after this long without one it is treated as hidden.
 */
export const VISIBILITY_STALE_MS = 90_000;

/** Longest game title accepted from `presence:activity`. */
export const MAX_ACTIVITY_LENGTH = 64;

export interface VoicePeer {
  id: string;
  accountId: string;
  name: string;
  muted: boolean;
  deafened: boolean;
  rtcSessionId: string | null;
}

export interface PublicUser {
  id: string;
  accountId: string;
  username: string;
  displayName: string;
  name: string;
  roles: string[];
  isSuperuser: boolean;
  avatarUrl: string | null;
  voiceChannel: string | null;
  /** "Playing <title>": the game the user's desktop app reports, or null. */
  activity: string | null;
  currentChannel?: string | null;
  email?: string | null;
  bio?: string | null;
}

export interface ScreenshareView {
  channelId: string;
  active: boolean;
  hostId: string | null;
  hostAccountId: string | null;
  hostName: string | null;
  /** The host's media session id: viewers keep their connection while it stays the same. */
  rtcSessionId: string | null;
  startedAt: number | null;
  viewerCount: number;
  /** Viewers may save clips of this share on their own device (true while nobody is sharing). */
  allowClips: boolean;
}

export interface StartScreenshareInput {
  hostId: string;
  accountId: string | null;
  displayName: string | null;
  rtcSessionId?: string | null;
  /** Omitted by clients older than clips: viewers may clip. */
  allowClips?: boolean | null;
}

export interface StartStreamInput {
  accountId: string | null;
  displayName: string | null;
  clientId: string | null;
  sourceIp: string | null;
}

/**
 * All runtime (non-persistent) state: who is connected, which room they are
 * in, live streams and screenshares. Lives in memory and
 * is rebuilt naturally as clients reconnect after a restart.
 */
export class PresenceService {
  private readonly users = new Map<string, ConnectedUser>();
  private readonly socketsByAccount = new Map<string, Set<string>>();
  private readonly channelMembers = new Map<string, Set<string>>();
  private readonly voiceRooms = new Map<string, VoiceRoom>();
  private readonly screenshares = new Map<string, ScreenshareSession>();
  private readonly liveStreams = new Map<string, ActiveStream>();

  // ---------------------------------------------------------------- users

  addUser(socketId: string, account: PublicAccount): ConnectedUser {
    const now = Date.now();
    const user: ConnectedUser = {
      id: socketId,
      accountId: account.id,
      username: account.username,
      displayName: account.displayName,
      name: account.displayName,
      roles: [...account.roles],
      isSuperuser: account.roles.includes('superuser'),
      email: account.email,
      bio: account.bio,
      avatarUrl: account.avatarUrl,
      currentChannel: null,
      voiceChannel: null,
      connectedAt: now,
      lastActivity: now,
      visible: true,
      visibleAt: now,
      activity: null,
    };
    this.users.set(socketId, user);
    if (!this.socketsByAccount.has(account.id)) this.socketsByAccount.set(account.id, new Set());
    this.socketsByAccount.get(account.id)!.add(socketId);
    return user;
  }

  removeUser(socketId: string): ConnectedUser | null {
    const user = this.users.get(socketId);
    if (!user) return null;
    this.users.delete(socketId);
    const sockets = this.socketsByAccount.get(user.accountId);
    if (sockets) {
      sockets.delete(socketId);
      if (sockets.size === 0) this.socketsByAccount.delete(user.accountId);
    }
    for (const members of this.channelMembers.values()) members.delete(socketId);
    return user;
  }

  getUser(socketId: string | null | undefined): ConnectedUser | null {
    if (!socketId) return null;
    return this.users.get(socketId) ?? null;
  }

  getSocketsByAccount(accountId: string): string[] {
    return Array.from(this.socketsByAccount.get(accountId) ?? []);
  }

  onlineCount(): number {
    return this.users.size;
  }

  /** Apply account changes (display name, roles) to every connected socket of that account. */
  syncAccount(account: PublicAccount): ConnectedUser[] {
    const updated: ConnectedUser[] = [];
    for (const socketId of this.getSocketsByAccount(account.id)) {
      const user = this.users.get(socketId);
      if (!user) continue;
      user.displayName = account.displayName;
      user.name = account.displayName;
      user.roles = [...account.roles];
      user.isSuperuser = account.roles.includes('superuser');
      user.email = account.email;
      user.bio = account.bio;
      user.avatarUrl = account.avatarUrl;
      if (user.voiceChannel) {
        const participant = this.voiceRooms.get(user.voiceChannel)?.participants.get(socketId);
        if (participant) participant.name = account.displayName;
      }
      updated.push(user);
    }
    return updated;
  }

  touch(socketId: string): void {
    const user = this.users.get(socketId);
    if (user) user.lastActivity = Date.now();
  }

  /** The page behind this socket reports itself visible or hidden (`presence:visibility`). */
  setVisibility(socketId: string, visible: boolean, now = Date.now()): boolean {
    const user = this.users.get(socketId);
    if (!user) return false;
    user.visible = visible;
    user.visibleAt = now;
    return true;
  }

  /**
   * The game this socket's desktop app reports (`presence:activity`); null clears it.
   * Returns whether anything changed, so callers broadcast only then. Nothing is
   * persisted: the entry goes with the socket (removeUser).
   */
  setActivity(socketId: string, title: string | null): boolean {
    const user = this.users.get(socketId);
    if (!user) return false;
    const next = title ? title.slice(0, MAX_ACTIVITY_LENGTH) : null;
    if (user.activity === next) return false;
    user.activity = next;
    return true;
  }

  /**
   * Is the account looking at the app on any device? A socket counts when its page
   * says it is visible and either said so or did anything within `staleMs`: a tab
   * that stopped heartbeating (laptop asleep, frozen background tab) no longer counts.
   * No sockets at all means away.
   */
  isAttending(accountId: string, now = Date.now(), staleMs = VISIBILITY_STALE_MS): boolean {
    for (const socketId of this.getSocketsByAccount(accountId)) {
      const user = this.users.get(socketId);
      if (!user || !user.visible) continue;
      if (now - Math.max(user.visibleAt, user.lastActivity) <= staleMs) return true;
    }
    return false;
  }

  exportUser(socketId: string): PublicUser | null {
    const user = this.users.get(socketId);
    if (!user) return null;
    return {
      id: user.id,
      accountId: user.accountId,
      username: user.username,
      displayName: user.displayName,
      name: user.displayName,
      roles: [...user.roles],
      isSuperuser: user.isSuperuser,
      avatarUrl: user.avatarUrl,
      email: user.email,
      bio: user.bio,
      currentChannel: user.currentChannel,
      voiceChannel: user.voiceChannel,
      activity: user.activity,
    };
  }

  /** Global presence list (no emails or bios). */
  exportUsers(): PublicUser[] {
    return Array.from(this.users.values()).map((user) => ({
      id: user.id,
      accountId: user.accountId,
      username: user.username,
      displayName: user.displayName,
      name: user.displayName,
      roles: [...user.roles],
      isSuperuser: user.isSuperuser,
      avatarUrl: user.avatarUrl,
      voiceChannel: user.voiceChannel,
      activity: user.activity,
    }));
  }

  // ------------------------------------------------------------- channels

  joinChannel(socketId: string, channelId: string): void {
    const user = this.users.get(socketId);
    if (!user) return;
    if (!this.channelMembers.has(channelId)) this.channelMembers.set(channelId, new Set());
    this.channelMembers.get(channelId)!.add(socketId);
    user.currentChannel = channelId;
  }

  leaveChannel(socketId: string, channelId: string): void {
    this.channelMembers.get(channelId)?.delete(socketId);
    const user = this.users.get(socketId);
    if (user && user.currentChannel === channelId) user.currentChannel = null;
  }

  channelMemberCount(channelId: string): number {
    return this.channelMembers.get(channelId)?.size ?? 0;
  }

  channelMembersOf(channelId: string): string[] {
    return Array.from(this.channelMembers.get(channelId) ?? []);
  }

  forgetChannel(channelId: string): void {
    this.channelMembers.delete(channelId);
    this.voiceRooms.delete(channelId);
    this.screenshares.delete(channelId);
    this.liveStreams.delete(channelId);
    for (const user of this.users.values()) {
      if (user.currentChannel === channelId) user.currentChannel = null;
      if (user.voiceChannel === channelId) user.voiceChannel = null;
    }
  }

  // ---------------------------------------------------------------- voice

  joinVoice(socketId: string, channelId: string, rtcSessionId: string | null = null): VoiceParticipant | null {
    const user = this.users.get(socketId);
    if (!user) return null;

    let room = this.voiceRooms.get(channelId);
    if (!room) {
      room = { channelId, sessionId: newId('vs', 12), startedAt: Date.now(), participants: new Map() };
      this.voiceRooms.set(channelId, room);
    }

    const existing = room.participants.get(socketId);
    const participant: VoiceParticipant = {
      id: socketId,
      accountId: user.accountId,
      name: user.displayName,
      muted: existing?.muted ?? false,
      deafened: existing?.deafened ?? false,
      joinedAt: existing?.joinedAt ?? Date.now(),
      rtcSessionId: rtcSessionId ?? existing?.rtcSessionId ?? null,
    };
    room.participants.set(socketId, participant);
    user.voiceChannel = channelId;
    return participant;
  }

  /** Remove the socket from its voice room; returns the channel it left. */
  leaveVoice(socketId: string): string | null {
    const user = this.users.get(socketId);
    const channelId = user?.voiceChannel ?? this.findVoiceRoomOf(socketId);
    if (!channelId) return null;

    const room = this.voiceRooms.get(channelId);
    room?.participants.delete(socketId);
    if (room && room.participants.size === 0) this.voiceRooms.delete(channelId);
    if (user) user.voiceChannel = null;
    return channelId;
  }

  private findVoiceRoomOf(socketId: string): string | null {
    for (const room of this.voiceRooms.values()) {
      if (room.participants.has(socketId)) return room.channelId;
    }
    return null;
  }

  voiceRoom(channelId: string): VoiceRoom | null {
    return this.voiceRooms.get(channelId) ?? null;
  }

  voicePeers(channelId: string, excludeSocketId: string | null = null): VoicePeer[] {
    const room = this.voiceRooms.get(channelId);
    if (!room) return [];
    return Array.from(room.participants.values())
      .filter((participant) => participant.id !== excludeSocketId)
      .map((participant) => ({
        id: participant.id,
        accountId: participant.accountId,
        name: participant.name,
        muted: participant.muted,
        deafened: participant.deafened,
        rtcSessionId: participant.rtcSessionId,
      }));
  }

  /** Other sockets of the same account sitting in this voice room (a reconnect's dead predecessor, a second tab). */
  voiceSeatsOfAccount(channelId: string, accountId: string, exceptSocketId: string): string[] {
    const room = this.voiceRooms.get(channelId);
    if (!room) return [];
    return Array.from(room.participants.values())
      .filter((participant) => participant.accountId === accountId && participant.id !== exceptSocketId)
      .map((participant) => participant.id);
  }

  updateVoiceState(socketId: string, state: { muted: boolean; deafened: boolean }): boolean {
    const user = this.users.get(socketId);
    if (!user?.voiceChannel) return false;
    const participant = this.voiceRooms.get(user.voiceChannel)?.participants.get(socketId);
    if (!participant) return false;
    participant.muted = state.muted;
    participant.deafened = state.deafened;
    return true;
  }

  // ---------------------------------------------------------- screenshare

  /**
   * Start a share, or take the seat over: the same account on another socket (a
   * reconnect, a second tab) replaces the host id and keeps the viewers; another
   * account is refused while the share is on. Returns the socket id replaced, if any.
   */
  startScreenshare(channelId: string, host: StartScreenshareInput): { session: ScreenshareSession; previousHostId: string | null } {
    const existing = this.screenshares.get(channelId);
    if (existing) {
      if (existing.hostId === host.hostId) {
        if (host.rtcSessionId !== undefined) existing.rtcSessionId = host.rtcSessionId;
        if (typeof host.allowClips === 'boolean') existing.allowClips = host.allowClips;
        return { session: existing, previousHostId: null };
      }
      if (existing.accountId === null || existing.accountId !== host.accountId) {
        throw new Error('Channel already has an active screenshare');
      }
      const previousHostId = existing.hostId;
      existing.hostId = host.hostId;
      existing.displayName = host.displayName;
      if (host.rtcSessionId !== undefined) existing.rtcSessionId = host.rtcSessionId;
      if (typeof host.allowClips === 'boolean') existing.allowClips = host.allowClips;
      // The host's own other socket cannot be a viewer of its share.
      existing.viewers.delete(host.hostId);
      return { session: existing, previousHostId };
    }
    const session: ScreenshareSession = {
      channelId,
      hostId: host.hostId,
      accountId: host.accountId,
      displayName: host.displayName,
      startedAt: Date.now(),
      rtcSessionId: host.rtcSessionId ?? null,
      allowClips: host.allowClips ?? true,
      viewers: new Map(),
    };
    this.screenshares.set(channelId, session);
    return { session, previousHostId: null };
  }

  /** The host changed whether viewers may clip the running share; false when nobody shares there. */
  setScreenshareClips(channelId: string, allowClips: boolean): boolean {
    const session = this.screenshares.get(channelId);
    if (!session) return false;
    session.allowClips = allowClips;
    return true;
  }

  stopScreenshare(channelId: string): ScreenshareSession | null {
    const session = this.screenshares.get(channelId) ?? null;
    this.screenshares.delete(channelId);
    return session;
  }

  getScreenshare(channelId: string): ScreenshareSession | null {
    return this.screenshares.get(channelId) ?? null;
  }

  /**
   * Seat a viewer. A seat the same account already holds through another socket
   * (its reconnect's dead predecessor, a second tab) moves to this socket; the
   * replaced socket id is returned so it can be told.
   */
  addScreenshareViewer(channelId: string, viewer: ScreenshareViewer): { seated: boolean; replacedViewerId: string | null } {
    const session = this.screenshares.get(channelId);
    if (!session || session.hostId === viewer.id) return { seated: false, replacedViewerId: null };
    let replacedViewerId: string | null = null;
    for (const seat of session.viewers.values()) {
      if (seat.id !== viewer.id && seat.accountId === viewer.accountId) replacedViewerId = seat.id;
    }
    if (replacedViewerId) session.viewers.delete(replacedViewerId);
    session.viewers.set(viewer.id, { ...viewer, holding: viewer.holding.map((held) => ({ ...held })) });
    return { seated: true, replacedViewerId };
  }

  removeScreenshareViewer(channelId: string, viewerId: string): boolean {
    return this.screenshares.get(channelId)?.viewers.delete(viewerId) ?? false;
  }

  screenshareViewers(channelId: string): ScreenshareViewer[] {
    return Array.from(this.screenshares.get(channelId)?.viewers.values() ?? []);
  }

  screenshareView(channelId: string): ScreenshareView {
    const session = this.screenshares.get(channelId);
    return {
      channelId,
      active: Boolean(session),
      hostId: session?.hostId ?? null,
      hostAccountId: session?.accountId ?? null,
      hostName: session?.displayName ?? null,
      rtcSessionId: session?.rtcSessionId ?? null,
      startedAt: session?.startedAt ?? null,
      viewerCount: session?.viewers.size ?? 0,
      allowClips: session?.allowClips ?? true,
    };
  }

  /** Screenshare channels this socket is hosting or viewing. */
  screensharesInvolving(socketId: string): { hosting: string[]; viewing: string[] } {
    const hosting: string[] = [];
    const viewing: string[] = [];
    for (const session of this.screenshares.values()) {
      if (session.hostId === socketId) hosting.push(session.channelId);
      else if (session.viewers.has(socketId)) viewing.push(session.channelId);
    }
    return { hosting, viewing };
  }

  // -------------------------------------------------------------- streams

  startStream(channelId: string, input: StartStreamInput): ActiveStream {
    const existing = this.liveStreams.get(channelId);
    if (existing && existing.clientId && input.clientId && existing.clientId !== input.clientId) {
      throw new Error('Channel already has an active stream');
    }
    const stream: ActiveStream = {
      channelId,
      sessionId: newId('stream', 16),
      accountId: input.accountId,
      displayName: input.displayName,
      clientId: input.clientId,
      sourceIp: input.sourceIp,
      startedAt: Date.now(),
    };
    this.liveStreams.set(channelId, stream);
    return stream;
  }

  endStream(channelId: string): ActiveStream | null {
    const stream = this.liveStreams.get(channelId) ?? null;
    this.liveStreams.delete(channelId);
    return stream;
  }

  getStream(channelId: string): ActiveStream | null {
    return this.liveStreams.get(channelId) ?? null;
  }

  listStreams(): ActiveStream[] {
    return Array.from(this.liveStreams.values());
  }

  // ----------------------------------------------------------------- view

  channelView(channel: ChannelRecord, memberCount = 0): ChannelView {
    const stream = this.liveStreams.get(channel.id);
    const room = this.voiceRooms.get(channel.id);
    const share = this.screenshares.get(channel.id);

    return {
      id: channel.id,
      name: channel.name,
      type: channel.type,
      groupId: channel.groupId,
      topic: channel.topic,
      visibility: channel.visibility,
      hasPassword: channel.joinPasswordHash !== null,
      memberCount,
      lastMessageAt: channel.lastMessageAt,
      linkPreviews: channel.linkPreviews,
      count: channel.type === 'voice' ? (room?.participants.size ?? 0) : this.channelMemberCount(channel.id),
      isLive: Boolean(stream),
      liveStartedAt: stream?.startedAt ?? null,
      liveDisplayName: stream?.displayName ?? null,
      voiceStartedAt: channel.type === 'voice' ? (room?.startedAt ?? null) : null,
      voiceSessionId: channel.type === 'voice' ? (room?.sessionId ?? null) : null,
      ...(channel.type === 'screenshare' && share
        ? {
            screenshareStartedAt: share.startedAt,
            screenshareHostName: share.displayName,
            screenshareHostId: share.hostId,
            screenshareViewerCount: share.viewers.size,
          }
        : { screenshareViewerCount: 0 }),
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
    };
  }
}
