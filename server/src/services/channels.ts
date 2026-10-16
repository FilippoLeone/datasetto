import bcrypt from 'bcryptjs';
import type { AppConfig } from '../config.js';
import { extractStreamKeyToken, generateStreamKeyToken, newId } from '../core/ids.js';
import { rolesHavePermission } from '../core/roles.js';
import {
  channelNameSchema,
  channelPasswordSchema,
  channelTopicSchema,
  channelTypeSchema,
  channelVisibilitySchema,
  type PermissionsInput,
} from '../core/validation.js';
import { parseJson, type DB } from '../db/index.js';
import { AppError, notFound } from '../errors.js';
import {
  PERMISSION_ACTIONS,
  type ChannelGroupRecord,
  type ChannelMemberRecord,
  type ChannelPermissions,
  type ChannelRecord,
  type ChannelType,
  type ChannelVisibility,
  type CreatableChannelType,
  type PermissionAction,
  type PermissionEntry,
} from '../types.js';

const ALL_ROLES = '*';
const PASSWORD_ROUNDS = 10;

export const DEFAULT_GROUPS: Record<CreatableChannelType, string> = {
  text: 'Text Channels',
  voice: 'Voice Channels',
  stream: 'Live Streams',
  screenshare: 'Screenshare Rooms',
};

export const DEFAULT_CHANNELS: Record<CreatableChannelType, string[]> = {
  text: ['general', 'announcements'],
  voice: ['lobby', 'room-1'],
  stream: ['main-stream'],
  screenshare: ['team-share'],
};

export interface AccessSubject {
  accountId: string | null;
  roles: readonly string[];
  isSuperuser: boolean;
}

export interface CreateChannelInput {
  name: string;
  type: CreatableChannelType;
  groupId?: string | null;
  permissions?: PermissionsInput | null;
  topic?: string | null;
  visibility?: ChannelVisibility | null;
  /** Already hashed with {@link ChannelService.hashPassword}. */
  joinPasswordHash?: string | null;
  /** Account that becomes the first member of a private channel. */
  creatorAccountId?: string | null;
}

export interface UpdateChannelInput {
  topic?: string | null;
  visibility?: ChannelVisibility;
  /** `null` removes the password; omit to keep it. */
  joinPasswordHash?: string | null;
}

interface ChannelRow {
  id: string;
  name: string;
  type: string;
  group_id: string | null;
  topic: string | null;
  visibility: string;
  join_password_hash: string | null;
  stream_key: string | null;
  permissions: string;
  position: number;
  created_at: number;
  updated_at: number;
  last_message_at: number | null;
}

interface GroupRow {
  id: string;
  name: string;
  type: string;
  collapsed: number;
  position: number;
  created_at: number;
}

interface MemberRow {
  channel_id: string;
  account_id: string;
  added_by: string | null;
  joined_at: number;
}

export const createDefaultPermissions = (): ChannelPermissions => ({
  view: { roles: [ALL_ROLES], accounts: [] },
  chat: { roles: [ALL_ROLES], accounts: [] },
  voice: { roles: [ALL_ROLES], accounts: [] },
  stream: { roles: [ALL_ROLES], accounts: [] },
  manage: { roles: ['admin'], accounts: [] },
});

const normalizeStringList = (value: unknown, fallback: string[], lowercase: boolean): string[] => {
  if (value === undefined || value === null) return [...fallback];
  const list = Array.isArray(value) ? value : [value];
  if (Array.isArray(value) && value.length === 0) return [];
  const normalized = Array.from(
    new Set(
      list
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => (lowercase ? entry.trim().toLowerCase() : entry.trim()))
        .filter(Boolean),
    ),
  );
  if (normalized.length === 0) return [...fallback];
  if (lowercase && (normalized.includes(ALL_ROLES) || normalized.includes('@all'))) return [ALL_ROLES];
  return normalized;
};

export const clonePermissions = (source: Partial<ChannelPermissions> = {}): ChannelPermissions => {
  const base = createDefaultPermissions();
  const result = {} as ChannelPermissions;
  for (const action of PERMISSION_ACTIONS) {
    const entry = source[action] ?? base[action];
    result[action] = { roles: [...(entry.roles ?? [])], accounts: [...(entry.accounts ?? [])] };
  }
  return result;
};

export const normalizePermissions = (
  input: PermissionsInput | Partial<ChannelPermissions> | null | undefined,
  existing: ChannelPermissions = createDefaultPermissions(),
): ChannelPermissions => {
  const result = clonePermissions(existing);
  const source = (input ?? {}) as Record<string, unknown>;

  for (const action of PERMISSION_ACTIONS) {
    const raw = source[action] as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== 'object') continue;
    const current = result[action];
    result[action] = {
      roles: normalizeStringList(raw.roles ?? raw.allowRoles, current.roles, true),
      accounts: normalizeStringList(raw.accounts ?? raw.allowAccounts, current.accounts, false),
    };
  }

  if (Array.isArray(source.allowedStreamers) && source.allowedStreamers.length > 0) {
    result.stream.accounts = normalizeStringList(source.allowedStreamers, result.stream.accounts, false);
  }

  if (source.superuserOnly === true) {
    for (const action of PERMISSION_ACTIONS) {
      result[action].roles = ['superuser'];
    }
  }

  return result;
};

const rowToChannel = (row: ChannelRow): ChannelRecord => ({
  id: row.id,
  name: row.name,
  type: row.type as ChannelType,
  groupId: row.group_id,
  topic: row.topic,
  visibility: row.visibility === 'private' ? 'private' : 'public',
  joinPasswordHash: row.join_password_hash,
  streamKey: row.stream_key,
  permissions: clonePermissions(parseJson<Partial<ChannelPermissions>>(row.permissions, {})),
  position: row.position,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastMessageAt: row.last_message_at ?? null,
});

const rowToGroup = (row: GroupRow): ChannelGroupRecord => ({
  id: row.id,
  name: row.name,
  type: row.type as CreatableChannelType,
  collapsed: Boolean(row.collapsed),
  position: row.position,
  createdAt: row.created_at,
});

const rowToMember = (row: MemberRow): ChannelMemberRecord => ({
  channelId: row.channel_id,
  accountId: row.account_id,
  addedBy: row.added_by,
  joinedAt: row.joined_at,
});

/**
 * Persistent channel catalogue. Everything is cached in memory and written
 * through to SQLite, so reads are synchronous and cheap.
 */
export class ChannelService {
  private readonly channels = new Map<string, ChannelRecord>();
  private readonly groups = new Map<string, ChannelGroupRecord>();
  /** Members of private channels, keyed by channel id then account id. */
  private readonly members = new Map<string, Map<string, ChannelMemberRecord>>();
  private readonly stmts;

  constructor(
    private readonly db: DB,
    private readonly config: AppConfig,
  ) {
    this.stmts = {
      allChannels: db.prepare('SELECT * FROM channels ORDER BY position ASC, created_at ASC'),
      allGroups: db.prepare('SELECT * FROM channel_groups ORDER BY position ASC, created_at ASC'),
      allMembers: db.prepare('SELECT * FROM channel_members ORDER BY joined_at ASC'),
      insertChannel: db.prepare(`
        INSERT INTO channels (id, name, type, group_id, topic, visibility, join_password_hash, stream_key, permissions, position, created_at, updated_at)
        VALUES (@id, @name, @type, @group_id, @topic, @visibility, @join_password_hash, @stream_key, @permissions, @position, @created_at, @updated_at)
      `),
      insertGroup: db.prepare(`
        INSERT INTO channel_groups (id, name, type, collapsed, position, created_at)
        VALUES (@id, @name, @type, @collapsed, @position, @created_at)
      `),
      deleteChannel: db.prepare('DELETE FROM channels WHERE id = ?'),
      updatePermissions: db.prepare('UPDATE channels SET permissions = ?, updated_at = ? WHERE id = ?'),
      updateStreamKey: db.prepare('UPDATE channels SET stream_key = ?, updated_at = ? WHERE id = ?'),
      updateMeta: db.prepare('UPDATE channels SET topic = ?, visibility = ?, join_password_hash = ?, updated_at = ? WHERE id = ?'),
      touchActivity: db.prepare('UPDATE channels SET last_message_at = ? WHERE id = ?'),
      insertMember: db.prepare(`
        INSERT INTO channel_members (channel_id, account_id, added_by, joined_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(channel_id, account_id) DO NOTHING
      `),
      deleteMember: db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND account_id = ?'),
    };
    this.load();
  }

  private load(): void {
    this.channels.clear();
    this.groups.clear();
    this.members.clear();
    for (const row of this.stmts.allGroups.all() as GroupRow[]) {
      const group = rowToGroup(row);
      this.groups.set(group.id, group);
    }
    for (const row of this.stmts.allChannels.all() as ChannelRow[]) {
      const channel = rowToChannel(row);
      this.channels.set(channel.id, channel);
    }
    for (const row of this.stmts.allMembers.all() as MemberRow[]) {
      const member = rowToMember(row);
      if (!this.channels.has(member.channelId)) continue;
      this.membersOf(member.channelId).set(member.accountId, member);
    }
  }

  private membersOf(channelId: string): Map<string, ChannelMemberRecord> {
    let map = this.members.get(channelId);
    if (!map) {
      map = new Map();
      this.members.set(channelId, map);
    }
    return map;
  }

  /** Hash a join password for storage; compare with {@link verifyPassword}. */
  static async hashPassword(password: unknown): Promise<string> {
    const parsed = channelPasswordSchema.parse(password);
    return bcrypt.hash(parsed, PASSWORD_ROUNDS);
  }

  /** Create the default groups and channels when the catalogue is empty. */
  seedDefaults(): boolean {
    if (this.channels.size > 0) return false;
    this.db.transaction(() => {
      for (const type of Object.keys(DEFAULT_GROUPS) as CreatableChannelType[]) {
        const group = this.getOrCreateGroupForType(type);
        for (const name of DEFAULT_CHANNELS[type]) {
          this.create({ name, type, groupId: group.id });
        }
      }
    })();
    return true;
  }

  list(): ChannelRecord[] {
    return Array.from(this.channels.values()).sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  }

  listGroups(): ChannelGroupRecord[] {
    return Array.from(this.groups.values()).sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  }

  count(): number {
    return this.channels.size;
  }

  get(id: string | null | undefined): ChannelRecord | null {
    if (!id) return null;
    return this.channels.get(id) ?? null;
  }

  require(id: string | null | undefined): ChannelRecord {
    const channel = this.get(id);
    if (!channel) throw notFound('Channel');
    return channel;
  }

  getByName(name: string | null | undefined): ChannelRecord | null {
    if (!name) return null;
    const needle = name.trim().toLowerCase();
    for (const channel of this.channels.values()) {
      if (channel.name.toLowerCase() === needle) return channel;
    }
    return null;
  }

  /** Resolve by id first, then by name (admin UIs send either). */
  resolve(idOrName: string | null | undefined): ChannelRecord | null {
    return this.get(idOrName) ?? this.getByName(idOrName);
  }

  getByStreamKey(value: string | null | undefined): ChannelRecord | null {
    const token = extractStreamKeyToken(value);
    if (!token) return null;
    for (const channel of this.channels.values()) {
      if (channel.streamKey && channel.streamKey === token) return channel;
    }
    return null;
  }

  getGroup(id: string | null | undefined): ChannelGroupRecord | null {
    if (!id) return null;
    return this.groups.get(id) ?? null;
  }

  getOrCreateGroupForType(type: CreatableChannelType): ChannelGroupRecord {
    for (const group of this.groups.values()) {
      if (group.type === type) return group;
    }
    return this.createGroup(DEFAULT_GROUPS[type], type);
  }

  createGroup(name: string, type: CreatableChannelType, collapsed = false): ChannelGroupRecord {
    const group: ChannelGroupRecord = {
      id: newId('group-' + type, 8),
      name: name.trim().slice(0, 64) || DEFAULT_GROUPS[type],
      type,
      collapsed,
      position: this.groups.size,
      createdAt: Date.now(),
    };
    this.stmts.insertGroup.run({
      id: group.id,
      name: group.name,
      type: group.type,
      collapsed: group.collapsed ? 1 : 0,
      position: group.position,
      created_at: group.createdAt,
    });
    this.groups.set(group.id, group);
    return group;
  }

  /** Channels that count against MAX_CHANNELS (direct messages do not). */
  private regularCount(): number {
    let count = 0;
    for (const channel of this.channels.values()) if (channel.type !== 'dm') count += 1;
    return count;
  }

  create(input: CreateChannelInput): ChannelRecord {
    const name = channelNameSchema.parse(input.name);
    const type = channelTypeSchema.parse(input.type) as CreatableChannelType;
    const visibility = (input.visibility ? channelVisibilitySchema.parse(input.visibility) : 'public') as ChannelVisibility;
    const topic = channelTopicSchema.parse(input.topic ?? null);

    if (this.regularCount() >= this.config.limits.maxChannels) {
      throw new AppError('Maximum number of channels (' + this.config.limits.maxChannels + ') reached', 'CHANNEL_LIMIT', 409);
    }
    if (this.getByName(name)) {
      throw new AppError('A channel named "' + name + '" already exists', 'CHANNEL_EXISTS', 409);
    }
    if (visibility === 'public' && input.joinPasswordHash) {
      throw new AppError('Only private channels can have a join password', 'PASSWORD_ON_PUBLIC_CHANNEL', 400);
    }

    const group = this.getGroup(input.groupId) ?? this.getOrCreateGroupForType(type);
    const now = Date.now();
    const channel: ChannelRecord = {
      id: newId('channel', 16),
      name,
      type,
      groupId: group.id,
      topic,
      visibility,
      joinPasswordHash: visibility === 'private' ? (input.joinPasswordHash ?? null) : null,
      streamKey: type === 'stream' ? generateStreamKeyToken() : null,
      permissions: normalizePermissions(input.permissions ?? null),
      position: this.channels.size,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
    };

    this.db.transaction(() => {
      this.stmts.insertChannel.run({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        group_id: channel.groupId,
        topic: channel.topic,
        visibility: channel.visibility,
        join_password_hash: channel.joinPasswordHash,
        stream_key: channel.streamKey,
        permissions: JSON.stringify(channel.permissions),
        position: channel.position,
        created_at: now,
        updated_at: now,
      });
      this.channels.set(channel.id, channel);
      if (channel.visibility === 'private' && input.creatorAccountId) {
        this.addMember(channel.id, input.creatorAccountId, input.creatorAccountId);
      }
    })();
    return channel;
  }

  // ------------------------------------------------------------ direct messages

  /** The DM channel between two accounts, if one exists. */
  findDm(accountA: string, accountB: string): ChannelRecord | null {
    for (const [channelId, members] of this.members) {
      const channel = this.channels.get(channelId);
      if (!channel || channel.type !== 'dm') continue;
      if (members.size === 2 && members.has(accountA) && members.has(accountB)) return channel;
    }
    return null;
  }

  /**
   * Open (or reuse) the one-to-one conversation between two accounts. DM
   * channels are private, ungrouped, named after a random id, and exempt from
   * the channel limit; only the two members can ever see them.
   */
  openDm(accountA: string, accountB: string): ChannelRecord {
    if (accountA === accountB) throw new AppError('You cannot message yourself', 'DM_SELF', 400);
    const existing = this.findDm(accountA, accountB);
    if (existing) return existing;
    const now = Date.now();
    const channel: ChannelRecord = {
      id: newId('dm', 16),
      name: newId('dm', 20),
      type: 'dm',
      groupId: null,
      topic: null,
      visibility: 'private',
      joinPasswordHash: null,
      streamKey: null,
      permissions: createDefaultPermissions(),
      position: 0,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
    };
    this.db.transaction(() => {
      this.stmts.insertChannel.run({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        group_id: null,
        topic: null,
        visibility: channel.visibility,
        join_password_hash: null,
        stream_key: null,
        permissions: JSON.stringify(channel.permissions),
        position: channel.position,
        created_at: now,
        updated_at: now,
      });
      this.channels.set(channel.id, channel);
      for (const accountId of [accountA, accountB]) {
        const record: ChannelMemberRecord = { channelId: channel.id, accountId, addedBy: null, joinedAt: now };
        this.stmts.insertMember.run(channel.id, accountId, null, now);
        this.membersOf(channel.id).set(accountId, record);
      }
    })();
    return channel;
  }

  /** Record that a message was posted (orders the DM list). */
  touchActivity(id: string, at = Date.now()): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    this.stmts.touchActivity.run(at, id);
    this.channels.set(id, { ...channel, lastMessageAt: at });
  }

  /** Change topic, visibility or the join password. Making a channel public clears the password and members. */
  update(id: string, input: UpdateChannelInput): ChannelRecord {
    const channel = this.require(id);
    if (channel.type === 'dm') throw new AppError('Direct messages cannot be edited', 'DM_IMMUTABLE', 400);
    const visibility = (input.visibility ? channelVisibilitySchema.parse(input.visibility) : channel.visibility) as ChannelVisibility;
    const topic = input.topic === undefined ? channel.topic : channelTopicSchema.parse(input.topic);
    let passwordHash = input.joinPasswordHash === undefined ? channel.joinPasswordHash : input.joinPasswordHash;
    if (visibility === 'public') passwordHash = null;

    const now = Date.now();
    const next: ChannelRecord = { ...channel, topic, visibility, joinPasswordHash: passwordHash, updatedAt: now };
    this.db.transaction(() => {
      this.stmts.updateMeta.run(topic, visibility, passwordHash, now, id);
      if (visibility === 'public' && channel.visibility === 'private') {
        for (const accountId of this.listMemberIds(id)) this.stmts.deleteMember.run(id, accountId);
        this.members.delete(id);
      }
      this.channels.set(id, next);
    })();
    return next;
  }

  delete(id: string): ChannelRecord {
    const channel = this.require(id);
    this.stmts.deleteChannel.run(id);
    this.channels.delete(id);
    this.members.delete(id);
    return channel;
  }

  getPermissions(id: string): ChannelPermissions {
    return clonePermissions(this.require(id).permissions);
  }

  updatePermissions(id: string, input: PermissionsInput): ChannelPermissions {
    const channel = this.require(id);
    const merged = normalizePermissions(input, channel.permissions);
    const now = Date.now();
    this.stmts.updatePermissions.run(JSON.stringify(merged), now, id);
    this.channels.set(id, { ...channel, permissions: merged, updatedAt: now });
    return clonePermissions(merged);
  }

  regenerateStreamKey(id: string): string {
    const channel = this.require(id);
    if (channel.type !== 'stream') {
      throw new AppError('Only stream channels have stream keys', 'NOT_STREAM_CHANNEL', 400);
    }
    const token = generateStreamKeyToken();
    const now = Date.now();
    this.stmts.updateStreamKey.run(token, now, id);
    this.channels.set(id, { ...channel, streamKey: token, updatedAt: now });
    return token;
  }

  // ------------------------------------------------------------- members

  isMember(channelId: string, accountId: string | null | undefined): boolean {
    if (!accountId) return false;
    return this.members.get(channelId)?.has(accountId) ?? false;
  }

  listMembers(channelId: string): ChannelMemberRecord[] {
    return Array.from(this.members.get(channelId)?.values() ?? []).sort((a, b) => a.joinedAt - b.joinedAt);
  }

  listMemberIds(channelId: string): string[] {
    return Array.from(this.members.get(channelId)?.keys() ?? []);
  }

  memberCount(channelId: string): number {
    return this.members.get(channelId)?.size ?? 0;
  }

  /** Channels an account belongs to (private memberships). */
  channelsOfMember(accountId: string): ChannelRecord[] {
    const result: ChannelRecord[] = [];
    for (const [channelId, map] of this.members) {
      if (!map.has(accountId)) continue;
      const channel = this.channels.get(channelId);
      if (channel) result.push(channel);
    }
    return result;
  }

  addMember(channelId: string, accountId: string, addedBy: string | null = null): ChannelMemberRecord {
    const channel = this.require(channelId);
    if (channel.type === 'dm') throw new AppError('Direct messages have fixed members', 'DM_IMMUTABLE', 400);
    if (channel.visibility !== 'private') {
      throw new AppError('Only private channels have a member list', 'CHANNEL_NOT_PRIVATE', 400);
    }
    const existing = this.members.get(channelId)?.get(accountId);
    if (existing) return existing;
    const record: ChannelMemberRecord = { channelId, accountId, addedBy, joinedAt: Date.now() };
    this.stmts.insertMember.run(channelId, accountId, addedBy, record.joinedAt);
    this.membersOf(channelId).set(accountId, record);
    return record;
  }

  removeMember(channelId: string, accountId: string): boolean {
    if (this.require(channelId).type === 'dm') throw new AppError('Direct messages have fixed members', 'DM_IMMUTABLE', 400);
    const removed = this.stmts.deleteMember.run(channelId, accountId).changes > 0;
    this.members.get(channelId)?.delete(accountId);
    return removed;
  }

  /** Remove an account from every private channel (account deleted). */
  removeMemberEverywhere(accountId: string): number {
    let removed = 0;
    for (const channelId of Array.from(this.members.keys())) {
      if (this.removeMember(channelId, accountId)) removed += 1;
    }
    return removed;
  }

  /**
   * Join a private channel with its password. Resolves to the channel when the
   * password matches (the account is added as a member), throws otherwise.
   * Comparison runs through bcrypt even for unknown channels so timing does not
   * reveal which names exist.
   */
  async joinWithPassword(name: string, accountId: string, password: unknown): Promise<ChannelRecord> {
    const invalid = () => new AppError('No private channel with that name and password', 'CHANNEL_JOIN_INVALID', 403);
    const channel = this.getByName(name);
    if (typeof password !== 'string' || !password || password.length > 128) throw invalid();
    if (!channel || channel.visibility !== 'private' || !channel.joinPasswordHash) {
      await bcrypt.compare(password, '$2a$10$CwTycUXWue0Thq9StjUM0uJ8W8V6Rq8kO5Rn4cJz7k9KZkC3Yq1mS');
      throw invalid();
    }
    const match = await bcrypt.compare(password, channel.joinPasswordHash);
    if (!match) throw invalid();
    this.addMember(channel.id, accountId, null);
    return channel;
  }

  // -------------------------------------------------------------- access

  /**
   * May `subject` perform `action` on the channel? Superusers always may.
   * Private channels are closed to everyone but their members and the admins
   * who manage channel permissions; after that the per-action role and
   * account lists apply.
   */
  canAccess(channel: ChannelRecord | string | null | undefined, subject: AccessSubject | null, action: PermissionAction): boolean {
    const record = typeof channel === 'string' ? this.get(channel) : channel;
    if (!record || !subject) return false;
    // A conversation belongs to its two participants only; not even superusers read along.
    if (record.type === 'dm') return this.isMember(record.id, subject.accountId);
    if (subject.isSuperuser) return true;

    if (record.visibility === 'private') {
      const manages = rolesHavePermission(subject.roles, 'canManageChannelPermissions');
      if (!manages && !this.isMember(record.id, subject.accountId)) return false;
    }

    const entry: PermissionEntry = record.permissions[action] ?? { roles: [ALL_ROLES], accounts: [] };
    if (entry.roles.includes(ALL_ROLES)) return true;

    const roles = subject.roles.map((role) => role.toLowerCase());
    if (roles.some((role) => entry.roles.includes(role))) return true;
    if (subject.accountId && entry.accounts.includes(subject.accountId)) return true;
    return false;
  }
}
