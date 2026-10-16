import type { AppConfig } from '../config.js';
import { extractStreamKeyToken, generateStreamKeyToken, newId } from '../core/ids.js';
import { channelNameSchema, channelTypeSchema, type PermissionsInput } from '../core/validation.js';
import { parseJson, type DB } from '../db/index.js';
import { AppError, notFound } from '../errors.js';
import {
  PERMISSION_ACTIONS,
  type ChannelGroupRecord,
  type ChannelPermissions,
  type ChannelRecord,
  type ChannelType,
  type PermissionAction,
  type PermissionEntry,
} from '../types.js';

const ALL_ROLES = '*';

export const DEFAULT_GROUPS: Record<ChannelType, string> = {
  text: 'Text Channels',
  voice: 'Voice Channels',
  stream: 'Live Streams',
  screenshare: 'Screenshare Rooms',
};

export const DEFAULT_CHANNELS: Record<ChannelType, string[]> = {
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
  type: ChannelType;
  groupId?: string | null;
  permissions?: PermissionsInput | null;
}

interface ChannelRow {
  id: string;
  name: string;
  type: string;
  group_id: string | null;
  stream_key: string | null;
  permissions: string;
  position: number;
  created_at: number;
  updated_at: number;
}

interface GroupRow {
  id: string;
  name: string;
  type: string;
  collapsed: number;
  position: number;
  created_at: number;
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
  streamKey: row.stream_key,
  permissions: clonePermissions(parseJson<Partial<ChannelPermissions>>(row.permissions, {})),
  position: row.position,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const rowToGroup = (row: GroupRow): ChannelGroupRecord => ({
  id: row.id,
  name: row.name,
  type: row.type as ChannelType,
  collapsed: Boolean(row.collapsed),
  position: row.position,
  createdAt: row.created_at,
});

/**
 * Persistent channel catalogue. Everything is cached in memory and written
 * through to SQLite, so reads are synchronous and cheap.
 */
export class ChannelService {
  private readonly channels = new Map<string, ChannelRecord>();
  private readonly groups = new Map<string, ChannelGroupRecord>();
  private readonly stmts;

  constructor(
    private readonly db: DB,
    private readonly config: AppConfig,
  ) {
    this.stmts = {
      allChannels: db.prepare('SELECT * FROM channels ORDER BY position ASC, created_at ASC'),
      allGroups: db.prepare('SELECT * FROM channel_groups ORDER BY position ASC, created_at ASC'),
      insertChannel: db.prepare(`
        INSERT INTO channels (id, name, type, group_id, stream_key, permissions, position, created_at, updated_at)
        VALUES (@id, @name, @type, @group_id, @stream_key, @permissions, @position, @created_at, @updated_at)
      `),
      insertGroup: db.prepare(`
        INSERT INTO channel_groups (id, name, type, collapsed, position, created_at)
        VALUES (@id, @name, @type, @collapsed, @position, @created_at)
      `),
      deleteChannel: db.prepare('DELETE FROM channels WHERE id = ?'),
      updatePermissions: db.prepare('UPDATE channels SET permissions = ?, updated_at = ? WHERE id = ?'),
      updateStreamKey: db.prepare('UPDATE channels SET stream_key = ?, updated_at = ? WHERE id = ?'),
    };
    this.load();
  }

  private load(): void {
    this.channels.clear();
    this.groups.clear();
    for (const row of this.stmts.allGroups.all() as GroupRow[]) {
      const group = rowToGroup(row);
      this.groups.set(group.id, group);
    }
    for (const row of this.stmts.allChannels.all() as ChannelRow[]) {
      const channel = rowToChannel(row);
      this.channels.set(channel.id, channel);
    }
  }

  /** Create the default groups and channels when the catalogue is empty. */
  seedDefaults(): boolean {
    if (this.channels.size > 0) return false;
    this.db.transaction(() => {
      for (const type of Object.keys(DEFAULT_GROUPS) as ChannelType[]) {
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

  getOrCreateGroupForType(type: ChannelType): ChannelGroupRecord {
    for (const group of this.groups.values()) {
      if (group.type === type) return group;
    }
    return this.createGroup(DEFAULT_GROUPS[type], type);
  }

  createGroup(name: string, type: ChannelType, collapsed = false): ChannelGroupRecord {
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

  create(input: CreateChannelInput): ChannelRecord {
    const name = channelNameSchema.parse(input.name);
    const type = channelTypeSchema.parse(input.type) as ChannelType;

    if (this.channels.size >= this.config.limits.maxChannels) {
      throw new AppError('Maximum number of channels (' + this.config.limits.maxChannels + ') reached', 'CHANNEL_LIMIT', 409);
    }
    if (this.getByName(name)) {
      throw new AppError('A channel named "' + name + '" already exists', 'CHANNEL_EXISTS', 409);
    }

    const group = this.getGroup(input.groupId) ?? this.getOrCreateGroupForType(type);
    const now = Date.now();
    const channel: ChannelRecord = {
      id: newId('channel', 16),
      name,
      type,
      groupId: group.id,
      streamKey: type === 'stream' ? generateStreamKeyToken() : null,
      permissions: normalizePermissions(input.permissions ?? null),
      position: this.channels.size,
      createdAt: now,
      updatedAt: now,
    };

    this.stmts.insertChannel.run({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      group_id: channel.groupId,
      stream_key: channel.streamKey,
      permissions: JSON.stringify(channel.permissions),
      position: channel.position,
      created_at: now,
      updated_at: now,
    });
    this.channels.set(channel.id, channel);
    return channel;
  }

  delete(id: string): ChannelRecord {
    const channel = this.require(id);
    this.stmts.deleteChannel.run(id);
    this.channels.delete(id);
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

  canAccess(channel: ChannelRecord | string | null | undefined, subject: AccessSubject | null, action: PermissionAction): boolean {
    const record = typeof channel === 'string' ? this.get(channel) : channel;
    if (!record || !subject) return false;
    if (subject.isSuperuser) return true;

    const entry: PermissionEntry = record.permissions[action] ?? { roles: [ALL_ROLES], accounts: [] };
    if (entry.roles.includes(ALL_ROLES)) return true;

    const roles = subject.roles.map((role) => role.toLowerCase());
    if (roles.some((role) => entry.roles.includes(role))) return true;
    if (subject.accountId && entry.accounts.includes(subject.accountId)) return true;
    return false;
  }
}
