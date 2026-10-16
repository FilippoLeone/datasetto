import { newId } from '../core/ids.js';
import type {
  ActiveStream,
  ChannelRecord,
  ChannelView,
  ConnectedUser,
  MinigameSummary,
  PublicAccount,
  ScreenshareSession,
  VoiceParticipant,
  VoiceRoom,
} from '../types.js';

export interface VoicePeer {
  id: string;
  name: string;
  muted: boolean;
  deafened: boolean;
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
  currentChannel?: string | null;
  email?: string | null;
  bio?: string | null;
}

export interface ScreenshareView {
  channelId: string;
  active: boolean;
  hostId: string | null;
  hostName: string | null;
  startedAt: number | null;
  viewerCount: number;
}

export interface StartStreamInput {
  accountId: string | null;
  displayName: string | null;
  clientId: string | null;
  sourceIp: string | null;
}

/**
 * All runtime (non-persistent) state: who is connected, which room they are
 * in, live streams, screenshares and minigame summaries. Lives in memory and
 * is rebuilt naturally as clients reconnect after a restart.
 */
export class PresenceService {
  private readonly users = new Map<string, ConnectedUser>();
  private readonly socketsByAccount = new Map<string, Set<string>>();
  private readonly channelMembers = new Map<string, Set<string>>();
  private readonly voiceRooms = new Map<string, VoiceRoom>();
  private readonly screenshares = new Map<string, ScreenshareSession>();
  private readonly liveStreams = new Map<string, ActiveStream>();
  private readonly minigames = new Map<string, MinigameSummary>();

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
    this.minigames.delete(channelId);
    for (const user of this.users.values()) {
      if (user.currentChannel === channelId) user.currentChannel = null;
      if (user.voiceChannel === channelId) user.voiceChannel = null;
    }
  }

  // ---------------------------------------------------------------- voice

  joinVoice(socketId: string, channelId: string): VoiceParticipant | null {
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
      name: user.displayName,
      muted: existing?.muted ?? false,
      deafened: existing?.deafened ?? false,
      joinedAt: existing?.joinedAt ?? Date.now(),
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
        name: participant.name,
        muted: participant.muted,
        deafened: participant.deafened,
      }));
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

  startScreenshare(
    channelId: string,
    host: { hostId: string; accountId: string | null; displayName: string | null },
  ): ScreenshareSession {
    const existing = this.screenshares.get(channelId);
    if (existing && existing.hostId !== host.hostId) {
      throw new Error('Channel already has an active screenshare');
    }
    const session: ScreenshareSession = existing ?? {
      channelId,
      hostId: host.hostId,
      accountId: host.accountId,
      displayName: host.displayName,
      startedAt: Date.now(),
      viewers: new Set(),
    };
    this.screenshares.set(channelId, session);
    return session;
  }

  stopScreenshare(channelId: string): ScreenshareSession | null {
    const session = this.screenshares.get(channelId) ?? null;
    this.screenshares.delete(channelId);
    return session;
  }

  getScreenshare(channelId: string): ScreenshareSession | null {
    return this.screenshares.get(channelId) ?? null;
  }

  addScreenshareViewer(channelId: string, viewerId: string): boolean {
    const session = this.screenshares.get(channelId);
    if (!session || session.hostId === viewerId) return false;
    session.viewers.add(viewerId);
    return true;
  }

  removeScreenshareViewer(channelId: string, viewerId: string): boolean {
    return this.screenshares.get(channelId)?.viewers.delete(viewerId) ?? false;
  }

  screenshareView(channelId: string): ScreenshareView {
    const session = this.screenshares.get(channelId);
    return {
      channelId,
      active: Boolean(session),
      hostId: session?.hostId ?? null,
      hostName: session?.displayName ?? null,
      startedAt: session?.startedAt ?? null,
      viewerCount: session?.viewers.size ?? 0,
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

  // ------------------------------------------------------------ minigames

  setMinigame(channelId: string, summary: MinigameSummary | null): void {
    if (summary) this.minigames.set(channelId, { ...summary });
    else this.minigames.delete(channelId);
  }

  getMinigame(channelId: string): MinigameSummary | null {
    return this.minigames.get(channelId) ?? null;
  }

  // ----------------------------------------------------------------- view

  channelView(channel: ChannelRecord, memberCount = 0): ChannelView {
    const stream = this.liveStreams.get(channel.id);
    const room = this.voiceRooms.get(channel.id);
    const share = this.screenshares.get(channel.id);
    const minigame = this.minigames.get(channel.id);

    return {
      id: channel.id,
      name: channel.name,
      type: channel.type,
      groupId: channel.groupId,
      topic: channel.topic,
      visibility: channel.visibility,
      hasPassword: channel.joinPasswordHash !== null,
      memberCount,
      count: channel.type === 'voice' ? (room?.participants.size ?? 0) : this.channelMemberCount(channel.id),
      isLive: Boolean(stream),
      liveStartedAt: stream?.startedAt ?? null,
      liveDisplayName: stream?.displayName ?? null,
      voiceStartedAt: channel.type === 'voice' ? (room?.startedAt ?? null) : null,
      voiceSessionId: channel.type === 'voice' ? (room?.sessionId ?? null) : null,
      currentMinigame: channel.type === 'voice' && minigame ? { ...minigame } : null,
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
