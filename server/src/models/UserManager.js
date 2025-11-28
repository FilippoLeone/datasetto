/**
 * User Manager
 * Handles all user-related operations
 */

import { sanitizeUserData } from '../utils/helpers.js';
import { ROLES, ROLE_HIERARCHY } from '../config/index.js';
import logger from '../utils/logger.js';

export class UserManager {
  constructor() {
    this.users = new Map(); // socketId -> User
    this.superuserIds = new Set(); // Set of superuser socket IDs
    this.bannedUsers = new Map(); // userId -> ban info
    this.usersByAccount = new Map(); // accountId -> Set of socket IDs
  }

  /**
   * Create/register a user
   */
  createUser(socketId, account, sessionToken = null) {
    try {
      if (!account || typeof account !== 'object') {
        throw new Error('Account details are required');
      }

  const safeDisplayName = this._safeDisplayName(account.displayName, account.username);

  const user = {
        id: socketId,
        accountId: account.id,
        username: account.username,
    displayName: safeDisplayName,
  name: safeDisplayName,
  roles: Array.isArray(account.roles) && account.roles.length ? account.roles : ['user'],
        email: account.email || null,
        bio: account.bio || null,
        avatarUrl: account.avatarUrl || null,
  isSuperuser: Array.isArray(account.roles) ? account.roles.includes('superuser') : false,
        sessionToken,
        currentChannel: null,
        voiceChannel: null,
        connectedAt: Date.now(),
        lastActivity: Date.now(),
      };

      this.users.set(socketId, user);
      if (user.accountId) {
        if (!this.usersByAccount.has(user.accountId)) {
          this.usersByAccount.set(user.accountId, new Set());
        }
        this.usersByAccount.get(user.accountId).add(socketId);
      }

      if (user.isSuperuser) {
        this.superuserIds.add(socketId);
      }

      logger.info(`User connected: ${user.displayName}`, { userId: socketId, accountId: user.accountId });

      return user;
    } catch (error) {
      logger.error(`Failed to create user: ${error.message}`);
      throw error;
    }
  }

  _safeDisplayName(preferred, identifier) {
    const preferredTrimmed = typeof preferred === 'string' ? preferred.trim() : '';
    if (preferredTrimmed.length > 0) {
      return preferredTrimmed.slice(0, 50);
    }

    if (typeof identifier === 'string') {
      const trimmed = identifier.trim();
      if (trimmed.includes('@')) {
        const [localPart] = trimmed.split('@');
        if (localPart && localPart.length > 0) {
          return localPart.slice(0, 50);
        }
      }
      if (trimmed.length > 0) {
        return trimmed.slice(0, 50);
      }
    }

    return 'User';
  }

  /**
   * Get user by socket ID
   */
  getUser(socketId) {
    return this.users.get(socketId);
  }

  /**
   * Get user by name
   */
  getUserByName(name) {
    for (const user of this.users.values()) {
      if (user.displayName === name || user.username === name) {
        return user;
      }
    }
    return null;
  }

  /**
   * Get all users
   */
  getAllUsers() {
    return Array.from(this.users.values());
  }

  /**
   * Get online users count
   */
  getOnlineCount() {
    return this.users.size;
  }

  /**
   * Update user
   */
  updateUser(socketId, updates) {
    const user = this.getUser(socketId);
    if (!user) {
      throw new Error('User not found');
    }

    if (updates.displayName) {
      updates.displayName = updates.displayName.trim().slice(0, 50);
    }

    Object.assign(user, updates, { lastActivity: Date.now() });
    logger.debug(`User updated: ${user.displayName}`, { userId: socketId });

    return user;
  }

  /**
   * Remove user
   */
  removeUser(socketId) {
    const user = this.getUser(socketId);
    if (!user) {
      return false;
    }

    this.users.delete(socketId);
    this.superuserIds.delete(socketId);
    if (user.accountId && this.usersByAccount.has(user.accountId)) {
      const sockets = this.usersByAccount.get(user.accountId);
      sockets.delete(socketId);
      if (sockets.size === 0) {
        this.usersByAccount.delete(user.accountId);
      }
    }

    logger.info(`User disconnected: ${user.displayName}`, { userId: socketId, accountId: user.accountId });

    return true;
  }

  /**
   * Set user as superuser
   */
  setSuperuser(socketId, isSuperuser = true) {
    const user = this.getUser(socketId);
    if (!user) {
      throw new Error('User not found');
    }

    user.isSuperuser = isSuperuser;

    if (isSuperuser) {
      this.superuserIds.add(socketId);
  logger.info(`User ${user.displayName} granted superuser privileges`, { userId: socketId });
    } else {
      this.superuserIds.delete(socketId);
  logger.info(`User ${user.displayName} revoked superuser privileges`, { userId: socketId });
    }

    return user;
  }

  /**
   * Check if user is superuser
   */
  isSuperuser(socketId) {
    return this.superuserIds.has(socketId);
  }

  /**
   * Assign roles to user
   */
  assignRoles(socketId, roles) {
    const user = this.getUser(socketId);
    if (!user) {
      throw new Error('User not found');
    }

    // Validate roles
    const validRoles = roles.filter(role => ROLES[role] !== undefined);
    if (validRoles.length === 0) {
      throw new Error('No valid roles provided');
    }

    user.roles = validRoles;
    user.lastActivity = Date.now();
  logger.info(`Roles assigned to ${user.displayName}: ${validRoles.join(', ')}`, { userId: socketId });

    return user;
  }

  /**
   * Get user's highest role
   */
  getUserHighestRole(socketId) {
    const user = this.getUser(socketId);
    if (!user) {
      return 'user';
    }

    if (user.isSuperuser) {
      return 'superuser';
    }

    for (const role of ROLE_HIERARCHY) {
      if (user.roles.includes(role)) {
        return role;
      }
    }

    return 'user';
  }

  /**
   * Check if user has permission
   */
  hasPermission(socketId, permission, channelId = null) {
    const user = this.getUser(socketId);
    if (!user) {
      return false;
    }

    // Superuser has all permissions
    if (user.isSuperuser) {
      return true;
    }

    // Check role-based permissions
    for (const roleName of user.roles) {
      const role = ROLES[roleName];
      if (role && role[permission]) {
        return true;
      }
    }

    return false;
  }

  /**
   * Set user's current channel
   */
  setCurrentChannel(socketId, channelId) {
    const user = this.getUser(socketId);
    if (!user) {
      throw new Error('User not found');
    }

    user.currentChannel = channelId;
    user.lastActivity = Date.now();
    return user;
  }

  /**
   * Set user's voice channel
   */
  setVoiceChannel(socketId, channelId) {
    const user = this.getUser(socketId);
    if (!user) {
      throw new Error('User not found');
    }

    user.voiceChannel = channelId;
    user.lastActivity = Date.now();
    return user;
  }

  /**
   * Set voice timeout for a user (prevents joining voice until timeout expires)
   */
  setVoiceTimeout(socketId, timeoutUntil) {
    const user = this.getUser(socketId);
    if (!user) {
      throw new Error('User not found');
    }

    user.voiceTimeoutUntil = timeoutUntil;
    logger.info(`Voice timeout set for user ${user.displayName} until ${new Date(timeoutUntil).toISOString()}`);
    return user;
  }

  /**
   * Check if user is currently timed out from voice
   */
  isVoiceTimedOut(socketId) {
    const user = this.getUser(socketId);
    if (!user || !user.voiceTimeoutUntil) {
      return false;
    }

    if (Date.now() >= user.voiceTimeoutUntil) {
      // Timeout has expired, clear it
      user.voiceTimeoutUntil = null;
      return false;
    }

    return true;
  }

  /**
   * Get remaining voice timeout duration in ms
   */
  getVoiceTimeoutRemaining(socketId) {
    const user = this.getUser(socketId);
    if (!user || !user.voiceTimeoutUntil) {
      return 0;
    }

    const remaining = user.voiceTimeoutUntil - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  /**
   * Get users in a specific channel
   */
  getUsersInChannel(channelId) {
    return this.getAllUsers().filter(user => user.currentChannel === channelId);
  }

  /**
   * Get users in a specific voice channel
   */
  getUsersInVoiceChannel(channelId) {
    return this.getAllUsers().filter(user => user.voiceChannel === channelId);
  }

  /**
   * Update user activity timestamp
   */
  updateActivity(socketId) {
    const user = this.getUser(socketId);
    if (user) {
      user.lastActivity = Date.now();
    }
  }

  /**
   * Ban a user
   */
  banUser(userId, reason, bannedBy, duration = null) {
    const banInfo = {
      userId,
      reason,
      bannedBy,
      bannedAt: Date.now(),
      expiresAt: duration ? Date.now() + duration : null,
    };

    this.bannedUsers.set(userId, banInfo);
    logger.warn(`User banned: ${userId}`, { reason, bannedBy, duration });

    // Disconnect user if currently connected
    const user = this.getUser(userId);
    if (user) {
      this.removeUser(userId);
    }

    return banInfo;
  }

  /**
   * Unban a user
   */
  unbanUser(userId) {
    const removed = this.bannedUsers.delete(userId);
    if (removed) {
      logger.info(`User unbanned: ${userId}`);
    }
    return removed;
  }

  /**
   * Check if user is banned
   */
  isUserBanned(userId) {
    const banInfo = this.bannedUsers.get(userId);
    if (!banInfo) {
      return false;
    }

    // Check if ban has expired
    if (banInfo.expiresAt && Date.now() > banInfo.expiresAt) {
      this.unbanUser(userId);
      return false;
    }

    return true;
  }

  /**
   * Get ban info for user
   */
  getBanInfo(userId) {
    return this.bannedUsers.get(userId);
  }

  /**
   * Get all banned users
   */
  getAllBannedUsers() {
    return Array.from(this.bannedUsers.values());
  }

  /**
   * Sync connected users with updated account details
   */
  syncAccountDetails(account) {
    if (!account || !account.id) {
      return 0;
    }

    const sockets = this.usersByAccount.get(account.id);
    if (!sockets || sockets.size === 0) {
      return 0;
    }

    let updated = 0;
    const roles = Array.isArray(account.roles) && account.roles.length ? account.roles : ['user'];
    const isSuperuser = roles.includes('superuser');

    sockets.forEach((socketId) => {
      const user = this.getUser(socketId);
      if (!user) {
        return;
      }

      const safeDisplayName = this._safeDisplayName(account.displayName, account.username);
      user.username = account.username;
      user.displayName = safeDisplayName;
  user.name = safeDisplayName;
      user.roles = roles;
      user.email = account.email || null;
      user.bio = account.bio || null;
      user.avatarUrl = account.avatarUrl || null;
      user.isSuperuser = isSuperuser;
      user.lastActivity = Date.now();

      if (isSuperuser) {
        this.superuserIds.add(socketId);
      } else {
        this.superuserIds.delete(socketId);
      }

      updated += 1;
    });

    return updated;
  }

  getSocketsByAccount(accountId) {
    const sockets = this.usersByAccount.get(accountId);
    return sockets ? Array.from(sockets) : [];
  }

  /**
   * Clean up expired bans
   */
  cleanupExpiredBans() {
    const now = Date.now();
    let cleaned = 0;

    for (const [userId, banInfo] of this.bannedUsers.entries()) {
      if (banInfo.expiresAt && now > banInfo.expiresAt) {
        this.unbanUser(userId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`Cleaned up ${cleaned} expired bans`);
    }

    return cleaned;
  }

  /**
   * Export user data (sanitized)
   */
  exportUserData(socketId) {
    const user = this.getUser(socketId);
    if (!user) {
      return null;
    }

    return sanitizeUserData({
      id: user.id,
      accountId: user.accountId,
      username: user.username,
      displayName: user.displayName,
  name: user.displayName,
      roles: user.roles,
      isSuperuser: user.isSuperuser,
      email: user.email,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      currentChannel: user.currentChannel,
      voiceChannel: user.voiceChannel,
    });
  }

  /**
   * Export users list (safe for clients)
   */
  exportUsersList() {
    return this.getAllUsers().map(user => sanitizeUserData({
      id: user.id,
      accountId: user.accountId,
      username: user.username,
      displayName: user.displayName,
  name: user.displayName,
      roles: user.roles,
      isSuperuser: user.isSuperuser,
      voiceChannel: user.voiceChannel,
    }));
  }

  /**
   * Get user statistics
   */
  getStatistics() {
    const users = this.getAllUsers();
    const roleStats = {};

    for (const role of ROLE_HIERARCHY) {
      roleStats[role] = users.filter(u => u.roles.includes(role)).length;
    }

    return {
      total: users.length,
      superusers: this.superuserIds.size,
      roles: roleStats,
      banned: this.bannedUsers.size,
    };
  }

  /**
   * Clear all data (for testing)
   */
  clear() {
    this.users.clear();
    this.superuserIds.clear();
    this.bannedUsers.clear();
    logger.warn('All user data cleared');
  }
}

export default new UserManager();
