/**
 * Channel Manager
 * Handles all channel-related operations
 */

import { generateId, validateChannelName, isValidChannelType } from '../utils/helpers.js';
import { appConfig } from '../config/index.js';
import logger from '../utils/logger.js';

const ALL_ROLES = '*';
const PERMISSION_ACTIONS = ['view', 'chat', 'voice', 'stream', 'manage'];

function createDefaultPermissions() {
  return {
    view: { roles: [ALL_ROLES], accounts: [] },
    chat: { roles: [ALL_ROLES], accounts: [] },
    voice: { roles: [ALL_ROLES], accounts: [] },
    stream: { roles: [ALL_ROLES], accounts: [] },
    manage: { roles: ['admin'], accounts: [] },
  };
}

function normalizeRoleList(value, fallback = [ALL_ROLES]) {
  if (value === undefined || value === null) {
    return Array.from(fallback);
  }

  let list = value;
  if (!Array.isArray(list)) {
    list = [list];
  }

  if (Array.isArray(value) && value.length === 0) {
    return [];
  }

  const normalized = Array.from(new Set(list
    .map((role) => (typeof role === 'string' ? role.trim() : `${role}`))
    .filter(Boolean)
    .map((role) => role.toLowerCase())));

  if (normalized.length === 0) {
    return Array.from(fallback);
  }

  if (normalized.includes(ALL_ROLES) || normalized.includes('@all')) {
    return [ALL_ROLES];
  }

  return normalized;
}

function normalizeAccountList(value, fallback = []) {
  if (value === undefined || value === null) {
    return Array.from(fallback);
  }

  let list = value;
  if (!Array.isArray(list)) {
    list = [list];
  }

  if (Array.isArray(value) && value.length === 0) {
    return [];
  }

  const normalized = Array.from(new Set(list
    .map((entry) => (typeof entry === 'string' ? entry.trim() : `${entry}`))
    .filter(Boolean)));

  return normalized.length > 0 ? normalized : Array.from(fallback);
}

function clonePermissions(template = {}) {
  const base = createDefaultPermissions();
  const clone = {};

  PERMISSION_ACTIONS.forEach((action) => {
    const source = template[action] || base[action];
    clone[action] = {
      roles: Array.from(source.roles || []),
      accounts: Array.from(source.accounts || []),
    };
  });

  return clone;
}

export class ChannelManager {
  constructor() {
    this.channels = new Map(); // channelId -> Channel
    this.channelGroups = new Map(); // groupId -> ChannelGroup
  }

  normalizePermissions(rawPermissions = {}, channelType = 'text') {
    const permissions = clonePermissions();
    const source = rawPermissions || {};

    // Legacy support: allowedStreamers becomes stream.accounts
    if (Array.isArray(source.allowedStreamers) && source.allowedStreamers.length > 0) {
      permissions.stream.accounts = normalizeAccountList(source.allowedStreamers, permissions.stream.accounts);
    }

    PERMISSION_ACTIONS.forEach((action) => {
      const entry = source[action];
      if (!entry) {
        return;
      }

      const fallback = permissions[action];
      permissions[action] = {
        roles: normalizeRoleList(entry.roles ?? entry.allowRoles ?? fallback.roles, fallback.roles),
        accounts: normalizeAccountList(entry.accounts ?? entry.allowAccounts ?? fallback.accounts, fallback.accounts),
      };
    });

    if (source.superuserOnly === true) {
      PERMISSION_ACTIONS.forEach((action) => {
        permissions[action].roles = ['superuser'];
      });
    }

    const streamRoles = permissions.stream?.roles || [];
    const streamAccounts = permissions.stream?.accounts || [];
    const legacyStreamRoleSet = new Set(streamRoles.map((role) => role.toLowerCase()));
    if (
      streamAccounts.length === 0 &&
      legacyStreamRoleSet.size === 2 &&
      legacyStreamRoleSet.has('admin') &&
      legacyStreamRoleSet.has('streamer')
    ) {
      permissions.stream.roles = [ALL_ROLES];
    }

    return permissions;
  }

  canAccess(channel, user, action) {
    const channelObj = typeof channel === 'string' ? this.getChannel(channel) : channel;
    if (!channelObj) {
      return false;
    }

    if (!user) {
      return false;
    }

    if (user.isSuperuser) {
      return true;
    }

    const permissions = channelObj.permissions || this.normalizePermissions({}, channelObj.type);
    const entry = permissions[action] || { roles: [ALL_ROLES], accounts: [] };

    if (entry.roles.includes(ALL_ROLES)) {
      return true;
    }

    const userRoles = Array.isArray(user.roles) ? user.roles.map((role) => role.toLowerCase()) : [];
    const hasRole = userRoles.some((role) => entry.roles.includes(role));

    if (hasRole) {
      return true;
    }

    if (user.accountId && entry.accounts.includes(user.accountId)) {
      return true;
    }

    return false;
  }

  getChannelPermissions(channelId) {
    const channel = this.getChannel(channelId);
    if (!channel) {
      throw new Error('Channel not found');
    }

    return clonePermissions(channel.permissions);
  }

  updateChannelPermissions(channelId, updates = {}) {
    const channel = this.getChannel(channelId);
    if (!channel) {
      throw new Error('Channel not found');
    }

    const normalizedExisting = this.normalizePermissions(channel.permissions, channel.type);
    const merged = clonePermissions(normalizedExisting);

    PERMISSION_ACTIONS.forEach((action) => {
      if (updates[action]) {
        merged[action] = {
          roles: normalizeRoleList(updates[action].roles ?? updates[action].allowRoles, normalizedExisting[action].roles),
          accounts: normalizeAccountList(updates[action].accounts ?? updates[action].allowAccounts, normalizedExisting[action].accounts),
        };
      }
    });

    if (Array.isArray(updates.allowedStreamers)) {
      merged.stream.accounts = normalizeAccountList(updates.allowedStreamers, merged.stream.accounts);
    }

    channel.permissions = merged;
    channel.updatedAt = Date.now();

    logger.info(`Channel permissions updated`, { channelId, permissions: merged });

    return clonePermissions(channel.permissions);
  }

  /**
   * Create a new channel
   */
  createChannel(name, type, groupId, permissions = {}) {
    try {
      // Validate inputs
      const nameValidation = validateChannelName(name);
      if (!nameValidation.valid) {
        throw new Error(nameValidation.error);
      }

      if (!isValidChannelType(type)) {
        throw new Error(`Invalid channel type: ${type}`);
      }

      // Check channel limit
      if (this.channels.size >= appConfig.channels.maxChannels) {
        throw new Error(`Maximum channels limit (${appConfig.channels.maxChannels}) reached`);
      }

      const id = `channel-${generateId()}`;
  const streamKey = type === 'stream' ? nameValidation.value : null;

      const channel = {
        id,
        name: nameValidation.value,
        type,
        groupId,
        users: new Map(), // socketId -> User
        voiceUsers: new Map(), // socketId -> Voice participant (voice channels only)
        voiceSessionId: null,
        voiceStartedAt: null,
        streamKey,
        permissions: this.normalizePermissions(permissions, type),
        isLive: false,
        activeStream: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      this.channels.set(id, channel);
      logger.info(`Channel created: ${name} (${type})`, { channelId: id });

      return channel;
    } catch (error) {
      logger.error(`Failed to create channel: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get channel by ID
   */
  getChannel(channelId) {
    return this.channels.get(channelId);
  }

  /**
   * Get channel by name
   */
  getChannelByName(name) {
    for (const channel of this.channels.values()) {
      if (channel.name === name) {
        return channel;
      }
    }
    return null;
  }

  /**
   * Get channel by stream key
   */
  getChannelByStreamKey(streamKey) {
    for (const channel of this.channels.values()) {
      if (channel.streamKey === streamKey) {
        return channel;
      }
    }
    return null;
  }

  /**
   * Get all channels
   */
  getAllChannels() {
    return Array.from(this.channels.values());
  }

  /**
   * Get channels by type
   */
  getChannelsByType(type) {
    return this.getAllChannels().filter(ch => ch.type === type);
  }

  /**
   * Get channels by group
   */
  getChannelsByGroup(groupId) {
    return this.getAllChannels().filter(ch => ch.groupId === groupId);
  }

  /**
   * Update channel
   */
  updateChannel(channelId, updates) {
    const channel = this.getChannel(channelId);
    if (!channel) {
      throw new Error('Channel not found');
    }

    // Validate name if being updated
    if (updates.name) {
      const nameValidation = validateChannelName(updates.name);
      if (!nameValidation.valid) {
        throw new Error(nameValidation.error);
      }
      updates.name = nameValidation.value;
    }

    Object.assign(channel, updates, { updatedAt: Date.now() });
    logger.info(`Channel updated: ${channel.name}`, { channelId });

    return channel;
  }

  /**
   * Delete channel
   */
  deleteChannel(channelId) {
    const channel = this.getChannel(channelId);
    if (!channel) {
      throw new Error('Channel not found');
    }

    this.channels.delete(channelId);
    logger.info(`Channel deleted: ${channel.name}`, { channelId });

    return true;
  }

  /**
   * Regenerate stream key
   */
  regenerateStreamKey(channelId) {
    const channel = this.getChannel(channelId);
    if (!channel) {
      throw new Error('Channel not found');
    }

    if (channel.type !== 'stream') {
      throw new Error('Channel is not a stream channel');
    }

    channel.streamKey = channel.name;
    channel.updatedAt = Date.now();
    logger.info(`Stream key reset to channel name for: ${channel.name}`, { channelId });

    return channel.streamKey;
  }

  /**
   * Add user to channel
   */
  addUserToChannel(channelId, user) {
    const channel = this.getChannel(channelId);
    if (!channel) {
      throw new Error('Channel not found');
    }

    const accessAction = channel.type === 'voice' ? 'voice' : 'view';
    if (!this.canAccess(channel, user, accessAction)) {
      throw new Error('No permission to join this channel');
    }

    if (channel.users.size >= appConfig.channels.maxUsersPerChannel) {
      throw new Error(`Channel is full (max ${appConfig.channels.maxUsersPerChannel} users)`);
    }

    channel.users.set(user.id, {
      id: user.id,
      name: user.displayName || user.name || user.username,
      roles: user.roles || ['user'],
      isSuperuser: user.isSuperuser || false,
      muted: false,
      deafened: false,
      joinedAt: Date.now(),
      updatedAt: Date.now(),
    });

    logger.debug(`User ${user.displayName || user.name} joined channel ${channel.name}`, { channelId, userId: user.id });
    return channel.users.get(user.id);
  }

  addVoiceParticipant(channelId, user) {
    const channel = this.getChannel(channelId);
    if (!channel || channel.type !== 'voice') {
      return null;
    }

    if (!channel.voiceUsers) {
      channel.voiceUsers = new Map();
    }

    const wasEmpty = channel.voiceUsers.size === 0;
    const existing = channel.voiceUsers.get(user.id) || {};

    const participant = {
      id: user.id,
      name: user.displayName || user.name || user.username,
      roles: user.roles || existing.roles || ['user'],
      isSuperuser: user.isSuperuser || existing.isSuperuser || false,
      muted: existing.muted ?? false,
      deafened: existing.deafened ?? false,
      joinedAt: existing.joinedAt || Date.now(),
      updatedAt: Date.now(),
    };

    channel.voiceUsers.set(user.id, participant);

    const channelUser = channel.users.get(user.id);
    if (channelUser) {
      channelUser.muted = participant.muted;
      channelUser.deafened = participant.deafened;
      channelUser.updatedAt = participant.updatedAt;
    }

    if (wasEmpty) {
      channel.voiceSessionId = `vs-${generateId(12)}`;
      channel.voiceStartedAt = Date.now();
      logger.info(`Voice session started in ${channel.name}`, {
        channelId,
        sessionId: channel.voiceSessionId,
      });
    }

    channel.updatedAt = Date.now();

    return participant;
  }

  removeVoiceParticipant(channelId, userId) {
    const channel = this.getChannel(channelId);
    if (!channel || channel.type !== 'voice' || !channel.voiceUsers) {
      return false;
    }

    const removed = channel.voiceUsers.delete(userId);
    if (removed) {
      const channelUser = channel.users.get(userId);
      if (channelUser) {
        channelUser.muted = false;
        channelUser.deafened = false;
        channelUser.updatedAt = Date.now();
      }

      if (channel.voiceUsers.size === 0) {
        logger.info(`Voice session ended in ${channel.name}`, {
          channelId,
          sessionId: channel.voiceSessionId,
        });
        channel.voiceSessionId = null;
        channel.voiceStartedAt = null;
      }

      channel.updatedAt = Date.now();
    }

    return removed;
  }

  getVoiceChannelUsers(channelId) {
    const channel = this.getChannel(channelId);
    if (!channel || channel.type !== 'voice' || !channel.voiceUsers) {
      return [];
    }

    return Array.from(channel.voiceUsers.values()).map((user) => ({
      id: user.id,
      name: user.name,
      muted: Boolean(user.muted),
      deafened: Boolean(user.deafened),
    }));
  }

  getVoiceSessionMetadata(channelId) {
    const channel = this.getChannel(channelId);
    if (!channel || channel.type !== 'voice') {
      return { startedAt: null, sessionId: null, participantCount: 0 };
    }

    return {
      startedAt: channel.voiceStartedAt ?? null,
      sessionId: channel.voiceSessionId ?? null,
      participantCount: channel.voiceUsers ? channel.voiceUsers.size : 0,
    };
  }

  updateVoiceUserState(channelId, userId, state = {}) {
    const channel = this.getChannel(channelId);
    if (!channel) {
      return null;
    }

    const applyUpdates = (entry) => {
      if (!entry) {
        return null;
      }

      if (typeof state.muted === 'boolean') {
        entry.muted = state.muted;
      }

      if (typeof state.deafened === 'boolean') {
        entry.deafened = state.deafened;
      }

      entry.updatedAt = Date.now();
      return entry;
    };

    const updatedVoiceEntry = channel.type === 'voice' && channel.voiceUsers
      ? applyUpdates(channel.voiceUsers.get(userId))
      : null;

    const updatedUserEntry = applyUpdates(channel.users.get(userId));

    return updatedVoiceEntry || updatedUserEntry;
  }

  /**
   * Remove user from channel
   */
  removeUserFromChannel(channelId, userId) {
    const channel = this.getChannel(channelId);
    if (!channel) {
      return false;
    }

    const removed = channel.users.delete(userId);
    const voiceRemoved = channel.type === 'voice' ? this.removeVoiceParticipant(channelId, userId) : false;
    if (removed) {
      logger.debug(`User removed from channel ${channel.name}`, { channelId, userId });
    }

    return removed || voiceRemoved;
  }

  /**
   * Get channel users
   */
  getChannelUsers(channelId) {
    const channel = this.getChannel(channelId);
    if (!channel) {
      return [];
    }

    return Array.from(channel.users.values());
  }

  /**
   * Set channel live status
   */
  setChannelLiveStatus(channelId, isLive) {
    const channel = this.getChannel(channelId);
    if (!channel) {
      throw new Error('Channel not found');
    }

    if (channel.isLive === isLive) {
      return channel;
    }

    channel.isLive = isLive;
    channel.updatedAt = Date.now();

    if (isLive) {
      logger.info(`Channel ${channel.name} is now LIVE`, { channelId });
    } else {
      logger.info(`Channel ${channel.name} is now OFFLINE`, { channelId });
    }

    return channel;
  }

  startStream(channelId, streamInfo = {}) {
    const channel = this.getChannel(channelId);
    if (!channel) {
      throw new Error('Channel not found');
    }

    if (channel.type !== 'stream') {
      throw new Error('Channel is not configured for streaming');
    }

    const existing = channel.activeStream;
    const incomingAccount = streamInfo.accountId || null;
    if (existing && existing.accountId && existing.accountId !== incomingAccount) {
      throw new Error('Channel already has an active stream');
    }

    const sessionId = `stream-${generateId(16)}`;

    channel.activeStream = {
      sessionId,
      accountId: streamInfo.accountId || null,
      username: streamInfo.username || null,
      displayName: streamInfo.displayName || null,
      clientId: streamInfo.clientId || null,
      sourceIp: streamInfo.sourceIp || null,
      startedAt: Date.now(),
      metadata: streamInfo.metadata || null,
    };

    channel.updatedAt = Date.now();

    this.setChannelLiveStatus(channelId, true);
    return channel.activeStream;
  }

  endStream(channelId, match = {}) {
    const channel = this.getChannel(channelId);
    if (!channel) {
      throw new Error('Channel not found');
    }

    if (channel.type !== 'stream') {
      throw new Error('Channel is not configured for streaming');
    }

    const { clientId, sessionId, accountId } = match;
    const active = channel.activeStream;

    if (active) {
      const matchesClient = clientId && active.clientId && clientId === active.clientId;
      const matchesSession = sessionId && active.sessionId && sessionId === active.sessionId;
      const matchesAccount = accountId && active.accountId && accountId === active.accountId;

      if (!clientId && !sessionId && !accountId) {
        logger.warn(`Ending stream for ${channel.name} without match data`, { channelId });
      } else if (!(matchesClient || matchesSession || matchesAccount)) {
        logger.warn(`Stream end request did not match active stream`, {
          channelId,
          expected: {
            clientId: active.clientId,
            sessionId: active.sessionId,
            accountId: active.accountId,
          },
          received: { clientId, sessionId, accountId },
        });
      }
    }

    channel.activeStream = null;
    this.setChannelLiveStatus(channelId, false);
    return true;
  }

  /**
   * Create channel group
   */
  createChannelGroup(name, type, collapsed = false) {
    const id = `group-${type}-${generateId(8)}`;
    const group = {
      id,
      name,
      type,
      collapsed,
      createdAt: Date.now(),
    };

    this.channelGroups.set(id, group);
    logger.info(`Channel group created: ${name} (${type})`, { groupId: id });

    return group;
  }

  /**
   * Get channel group
   */
  getChannelGroup(groupId) {
    return this.channelGroups.get(groupId);
  }

  /**
   * Get all channel groups
   */
  getAllChannelGroups() {
    return Array.from(this.channelGroups.values());
  }

  /**
   * Delete channel group (and optionally its channels)
   */
  deleteChannelGroup(groupId, deleteChannels = false) {
    const group = this.getChannelGroup(groupId);
    if (!group) {
      throw new Error('Channel group not found');
    }

    if (deleteChannels) {
      // Delete all channels in this group
      const channels = this.getChannelsByGroup(groupId);
      channels.forEach(channel => this.deleteChannel(channel.id));
    }

    this.channelGroups.delete(groupId);
    logger.info(`Channel group deleted: ${group.name}`, { groupId });

    return true;
  }

  /**
   * Get channel count
   */
  getChannelCount() {
    return this.channels.size;
  }

  /**
   * Get active users count across all channels
   */
  getActiveUsersCount() {
    let count = 0;
    for (const channel of this.channels.values()) {
      count += channel.users.size;
    }
    return count;
  }

  /**
   * Export channel data for serialization
   */
  exportChannelData(channelId) {
    const channel = this.getChannel(channelId);
    if (!channel) {
      return null;
    }

    return {
      id: channel.id,
      name: channel.name,
      type: channel.type,
      groupId: channel.groupId,
      count: channel.type === 'voice'
        ? (channel.voiceUsers ? channel.voiceUsers.size : 0)
        : channel.users.size,
      streamKey: channel.streamKey, // Only expose to authorized users
      isLive: channel.isLive,
      liveStartedAt: channel.activeStream ? channel.activeStream.startedAt : null,
      liveAccountId: channel.activeStream ? channel.activeStream.accountId : null,
      liveDisplayName: channel.activeStream ? channel.activeStream.displayName : null,
      permissions: clonePermissions(channel.permissions),
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
      voiceStartedAt: channel.type === 'voice' ? channel.voiceStartedAt ?? null : null,
      voiceSessionId: channel.type === 'voice' ? channel.voiceSessionId ?? null : null,
    };
  }

  /**
   * Export channels list (safe for clients)
   */
  exportChannelsList(includeStreamKeys = false) {
    return this.getAllChannels().map(channel => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      groupId: channel.groupId,
      count: channel.type === 'voice'
        ? (channel.voiceUsers ? channel.voiceUsers.size : 0)
        : channel.users.size,
      isLive: channel.isLive,
      liveStartedAt: channel.activeStream ? channel.activeStream.startedAt : null,
      liveDisplayName: channel.activeStream ? channel.activeStream.displayName : null,
      voiceStartedAt: channel.type === 'voice' ? channel.voiceStartedAt ?? null : null,
      voiceSessionId: channel.type === 'voice' ? channel.voiceSessionId ?? null : null,
      ...(includeStreamKeys && channel.streamKey && { streamKey: channel.streamKey }),
    }));
  }

  /**
   * Initialize default channels and groups
   */
  initializeDefaults() {
    // Create default groups
    const textGroup = this.createChannelGroup('Text Channels', 'text');
    const voiceGroup = this.createChannelGroup('Voice Channels', 'voice');
    const streamGroup = this.createChannelGroup('Live Streams', 'stream');

    // Create default text channels
    appConfig.channels.defaultTextChannels.forEach(name => {
      this.createChannel(name, 'text', textGroup.id);
    });

    // Create default voice channels
    appConfig.channels.defaultVoiceChannels.forEach(name => {
      this.createChannel(name, 'voice', voiceGroup.id);
    });

    // Create default stream channels (restricted to stream-capable roles)
    appConfig.channels.defaultStreamChannels.forEach(name => {
      const channel = this.createChannel(name, 'stream', streamGroup.id);
      logger.info(`🔑 Stream Key for ${name}: ${channel.streamKey}`);
    });

    logger.info('Default channels initialized');
  }

  /**
   * Clear all data (for testing)
   */
  clear() {
    this.channels.clear();
    this.channelGroups.clear();
    logger.warn('All channel data cleared');
  }
}

export default new ChannelManager();
