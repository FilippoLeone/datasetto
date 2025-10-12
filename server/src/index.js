/**
 * RTMP-Disc Backend Server
 * Modular, production-ready WebSocket and REST API server
 */

import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Configuration and utilities
import { appConfig, ROLES } from './config/index.js';
import logger from './utils/logger.js';
import { formatError, getClientIp } from './utils/helpers.js';

// Models/Managers
import channelManager from './models/ChannelManager.js';
import userManager from './models/UserManager.js';
import messageManager from './models/MessageManager.js';
import accountManager from './models/AccountManager.js';

// Get current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize Express app
const app = express();

const normalizeOrigin = (value = '') => value.replace(/\/$/, '').toLowerCase();
const allowedOrigins = new Set(appConfig.cors.origins.map(normalizeOrigin));
const allowAllOrigins = allowedOrigins.has('*');

// Middleware
app.use(cors({
  origin: (origin, callback) => {
    logger.debug(`CORS check for origin: ${origin}`);
    
    if (!origin || allowAllOrigins) {
      logger.debug(`Allowing origin: ${origin || '(none)'} - no origin or wildcard`);
      return callback(null, true);
    }

    const normalizedOrigin = normalizeOrigin(origin);
    logger.debug(`Normalized origin: ${normalizedOrigin}, allowed origins: ${Array.from(allowedOrigins).join(', ')}`);

    if (allowedOrigins.has(normalizedOrigin)) {
      logger.debug(`✅ Allowed origin: ${origin}`);
      return callback(null, true);
    }

    logger.warn('❌ Blocked request from disallowed origin', { origin, normalizedOrigin });
    return callback(new Error(`Origin ${origin} not allowed by CORS`), false);
  },
  credentials: appConfig.cors.credentials,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 86400, // 24 hours
  preflightContinue: false,
  optionsSuccessStatus: 204
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.http(req.method, req.path, res.statusCode, duration);
  });
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: Date.now(),
    env: appConfig.server.env,
  });
});

// Stats endpoint
app.get('/api/stats', (req, res) => {
  try {
    const stats = {
      channels: channelManager.getChannelCount(),
      users: userManager.getOnlineCount(),
      messages: messageManager.getTotalMessageCount(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: Date.now(),
    };
    res.json(stats);
  } catch (error) {
    logger.error(`Stats endpoint error: ${error.message}`);
    res.status(500).json(formatError('Failed to retrieve stats'));
  }
});

// Check if a stream is live
app.get('/api/stream/:channelName/status', (req, res) => {
  try {
    const { channelName } = req.params;
    const channel = channelManager.getChannelByName(channelName);
    
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found', isLive: false });
    }
    
    res.json({
      channelName,
      isLive: channel.isLive || false,
      viewerCount: channel.users.size,
      timestamp: Date.now(),
    });
  } catch (error) {
    logger.error(`Stream status error: ${error.message}`);
    res.status(500).json({ error: 'Failed to check stream status', isLive: false });
  }
});

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO with minimal, proven configuration
const io = new Server(server, {
  path: '/socket.io/',
  serveClient: false,
  cors: {
    origin: (origin, callback) => {
      // Allow all origins for now, can restrict later
      callback(null, origin || '*');
    },
    credentials: true,
    methods: ["GET", "POST"]
  },
  transports: ['polling', 'websocket'], // Polling first for better compatibility
  allowUpgrades: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  maxHttpBufferSize: 1e6,
  connectTimeout: 45000,
});

logger.info("🔧 Socket.IO server initialized");
logger.info(`   Path: /socket.io/`);
logger.info(`   Transports: polling, websocket`);
logger.info(`   CORS: Allow all origins (debugging)`);

// Log Engine.IO events for debugging
io.engine.on("connection_error", (err) => {
  logger.error("❌ Engine.IO connection_error:", { 
    code: err.code,
    message: err.message,
    context: err.context
  });
});

/**
 * Broadcast channel updates to all clients
 */
function broadcastChannels() {
  const channels = channelManager.exportChannelsList(false);
  const groups = channelManager.getAllChannelGroups();
  io.emit('channels:update', { channels, groups });
}

/**
 * Broadcast user updates for a specific channel
 */
function broadcastUserUpdate(channelId) {
  if (!channelId) return;
  
  const users = channelManager.getChannelUsers(channelId);
  io.to(channelId).emit('user:update', users);
}

/**
 * Broadcast global user list
 */
function broadcastUsers() {
  const users = userManager.exportUsersList();
  io.emit('user:update', users);
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  const clientIp = getClientIp(socket);
  const transport = socket.conn.transport.name;
  
  logger.info(`🔥 New Socket.IO connection`, { 
    socketId: socket.id,
    clientIp,
    transport,
    origin: socket.handshake.headers.origin || 'unknown'
  });

  let currentUser = null;
  let currentAccount = null;
  let currentSession = null;
  let currentChannel = null;
  let currentVoiceChannel = null;
  
  // Log transport upgrades
  socket.conn.on('upgrade', (transport) => {
    logger.info(`🔼 Transport upgraded`, {
      socketId: socket.id,
      newTransport: transport.name
    });
  });

  /**
   * Authentication helpers
   */
  const finalizeAuthentication = ({ account, session, isNewAccount = false }) => {
    if (!account || !session) {
      throw new Error('Account and session are required');
    }

    if (currentUser) {
      userManager.removeUser(socket.id);
      broadcastUsers();
    }

    currentAccount = account;
    currentSession = session;
    currentUser = userManager.createUser(socket.id, account, session.token);

    if (currentUser.isSuperuser) {
      userManager.setSuperuser(socket.id, true);
    }

    socket.emit('auth:success', {
      user: userManager.exportUserData(socket.id),
      account,
      session: {
        token: session.token,
        expiresAt: session.expiresAt,
      },
      channels: channelManager.exportChannelsList(false),
      groups: channelManager.getAllChannelGroups(),
      isNewAccount,
    });

    broadcastUsers();
    broadcastChannels();

    logger.info(`User authenticated: ${currentUser.displayName}`, {
      socketId: socket.id,
      accountId: currentAccount.id,
      roles: currentAccount.roles,
      isNewAccount,
    });
  };

  const requireNoActiveUser = () => {
    if (currentUser) {
      throw new Error('User already authenticated');
    }
  };

  /**
   * Account registration
   */
  socket.on('auth:register', async (payload = {}) => {
    try {
      requireNoActiveUser();

      const { username, password, profile = {} } = payload;
      const account = await accountManager.registerAccount({
        username,
        password,
        profile: {
          displayName: profile.displayName || username,
          email: profile.email,
          bio: profile.bio,
          avatarUrl: profile.avatarUrl,
          metadata: profile.metadata,
        },
      });

      const session = accountManager.createSession(account.id);
      finalizeAuthentication({ account, session, isNewAccount: true });
    } catch (error) {
      logger.error(`Registration failed: ${error.message}`, { socketId: socket.id });
      socket.emit('auth:error', formatError(error.message, 'REGISTRATION_FAILED'));
    }
  });

  /**
   * Account login with username/password
   */
  socket.on('auth:login', async (payload = {}) => {
    try {
      requireNoActiveUser();

      const { username, password } = payload;
      const account = await accountManager.authenticate(username, password);
      const session = accountManager.createSession(account.id);
      finalizeAuthentication({ account, session, isNewAccount: false });
    } catch (error) {
      logger.warn(`Login failed: ${error.message}`, { socketId: socket.id });
      socket.emit('auth:error', formatError(error.message, 'LOGIN_FAILED'));
    }
  });

  /**
   * Resume session using token
   */
  socket.on('auth:session', (payload = {}) => {
    try {
      requireNoActiveUser();

      const { token } = payload;
      if (!token) {
        throw new Error('Session token is required');
      }

      const session = accountManager.touchSession(token);
      if (!session) {
        throw new Error('Invalid or expired session');
      }

      const accountRecord = accountManager.getAccountById(session.accountId);
      if (!accountRecord || accountRecord.status !== 'active') {
        accountManager.revokeSession(token);
        throw new Error('Account is no longer active');
      }

      const account = accountManager.sanitizeAccount(accountRecord);
      finalizeAuthentication({ account, session, isNewAccount: false });
    } catch (error) {
      logger.warn(`Session resume failed: ${error.message}`, { socketId: socket.id });
      socket.emit('auth:error', formatError(error.message, 'SESSION_FAILED'));
    }
  });

  /**
   * Logout current session
   */
  socket.on('auth:logout', () => {
    try {
      if (currentSession?.token) {
        accountManager.revokeSession(currentSession.token);
      }

      if (currentUser) {
        userManager.removeUser(socket.id);
        broadcastUsers();
        broadcastChannels();
      }

      currentUser = null;
      currentAccount = null;
      currentSession = null;

      socket.emit('auth:loggedOut');
    } catch (error) {
      logger.error(`Logout failed: ${error.message}`, { socketId: socket.id });
      socket.emit('auth:error', formatError(error.message, 'LOGOUT_FAILED'));
    }
  });

  /**
   * Update account profile or password
   */
  socket.on('account:update', (payload = {}) => {
    try {
      if (!currentUser || !currentAccount) {
        throw new Error('Not authenticated');
      }

      const updates = {};

      if (typeof payload.displayName === 'string') {
        updates.displayName = payload.displayName;
      }

      if (payload.email !== undefined) {
        updates.email = payload.email;
      }

      if (payload.bio !== undefined) {
        updates.bio = payload.bio;
      }

      if (payload.avatarUrl !== undefined) {
        updates.avatarUrl = payload.avatarUrl;
      }

      if (payload.metadata && typeof payload.metadata === 'object') {
        updates.metadata = payload.metadata;
      }

      if (payload.newPassword) {
        updates.password = payload.newPassword;
        updates.currentPassword = payload.currentPassword;
      }

      const updatedAccount = accountManager.updateAccount(currentAccount.id, updates);
      currentAccount = updatedAccount;
      userManager.syncAccountDetails(updatedAccount);
      currentUser = userManager.getUser(socket.id);

      socket.emit('account:updated', {
        account: updatedAccount,
        user: userManager.exportUserData(socket.id),
      });

      broadcastUsers();
    } catch (error) {
      logger.error(`Account update failed: ${error.message}`, { socketId: socket.id });
      socket.emit('account:error', formatError(error.message, 'ACCOUNT_UPDATE_FAILED'));
    }
  });

  /**
   * Provide current account details
   */
  socket.on('account:get', () => {
    try {
      if (!currentUser || !currentAccount) {
        throw new Error('Not authenticated');
      }

      socket.emit('account:data', {
        account: currentAccount,
        user: userManager.exportUserData(socket.id),
      });
    } catch (error) {
      logger.error(`Account fetch failed: ${error.message}`, { socketId: socket.id });
      socket.emit('account:error', formatError(error.message, 'ACCOUNT_FETCH_FAILED'));
    }
  });

  /**
   * Administrative account management
   */
  socket.on('admin:accounts:list', () => {
    try {
      if (!currentUser) {
        throw new Error('Not authenticated');
      }

      if (!userManager.hasPermission(socket.id, 'canManageUsers')) {
        throw new Error('No permission to view accounts');
      }

      const accounts = accountManager.listAccounts().map((acct) => accountManager.sanitizeAccount(acct));
      socket.emit('admin:accounts:list', { accounts });
    } catch (error) {
      logger.error(`Account list failed: ${error.message}`, { socketId: socket.id });
      socket.emit('admin:error', formatError(error.message, 'ACCOUNTS_LIST_FAILED'));
    }
  });

  socket.on('admin:accounts:updateRoles', ({ accountId, roles }) => {
    try {
      if (!currentUser) {
        throw new Error('Not authenticated');
      }

      if (!userManager.hasPermission(socket.id, 'canAssignRoles')) {
        throw new Error('No permission to assign roles');
      }

      if (!accountId || !Array.isArray(roles) || roles.length === 0) {
        throw new Error('Account ID and roles are required');
      }

      const sanitizedRoles = Array.from(new Set(roles.map((role) => (typeof role === 'string' ? role.trim().toLowerCase() : `${role}`)).filter(Boolean)));
      if (sanitizedRoles.length === 0) {
        throw new Error('At least one role must be provided');
      }

      const validRoleNames = new Set(Object.keys(ROLES).map((role) => role.toLowerCase()));
      const filteredRoles = sanitizedRoles.filter((role) => validRoleNames.has(role));
      if (filteredRoles.length === 0) {
        throw new Error('No valid roles provided');
      }

      // Prevent removing the last admin
      if (!filteredRoles.includes('admin')) {
        const remainingAdmins = accountManager.listAccounts().filter((acct) => acct.id !== accountId && acct.roles?.includes('admin') && acct.status === 'active');
        if (remainingAdmins.length === 0) {
          throw new Error('At least one admin account is required');
        }
      }

      const updatedAccount = accountManager.assignRoles(accountId, filteredRoles);
      userManager.syncAccountDetails(updatedAccount);

      userManager.getSocketsByAccount(accountId).forEach((targetSocketId) => {
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
          targetSocket.emit('account:rolesUpdated', {
            account: updatedAccount,
            user: userManager.exportUserData(targetSocketId),
          });
        }
      });

      if (currentAccount?.id === accountId) {
        currentAccount = updatedAccount;
        currentUser = userManager.getUser(socket.id);
      }

      socket.emit('admin:accounts:rolesUpdated', { account: updatedAccount });
      broadcastUsers();
    } catch (error) {
      logger.error(`Account role update failed: ${error.message}`, { socketId: socket.id });
      socket.emit('admin:error', formatError(error.message, 'ACCOUNTS_UPDATE_FAILED'));
    }
  });

  socket.on('admin:accounts:disable', ({ accountId, reason }) => {
    try {
      if (!currentUser) {
        throw new Error('Not authenticated');
      }

      if (!userManager.hasPermission(socket.id, 'canDisableAccounts')) {
        throw new Error('No permission to disable accounts');
      }

      const targetAccount = accountManager.getAccountById(accountId);
      if (!targetAccount) {
        throw new Error('Account not found');
      }

      if (targetAccount.roles?.includes('admin')) {
        const remainingAdmins = accountManager.listAccounts().filter((acct) => acct.id !== accountId && acct.roles?.includes('admin') && acct.status === 'active');
        if (remainingAdmins.length === 0) {
          throw new Error('Cannot disable the last admin account');
        }
      }

      const disabledAccount = accountManager.disableAccount(accountId, reason);
      const sockets = userManager.getSocketsByAccount(accountId);

      sockets.forEach((targetSocketId) => {
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
          targetSocket.emit('auth:error', formatError('Account disabled by administrator', 'ACCOUNT_DISABLED'));
          targetSocket.disconnect(true);
        }
      });

      socket.emit('admin:accounts:disabled', { account: disabledAccount });
      broadcastUsers();
      broadcastChannels();
    } catch (error) {
      logger.error(`Disable account failed: ${error.message}`, { socketId: socket.id });
      socket.emit('admin:error', formatError(error.message, 'ACCOUNTS_DISABLE_FAILED'));
    }
  });

  socket.on('admin:accounts:enable', ({ accountId }) => {
    try {
      if (!currentUser) {
        throw new Error('Not authenticated');
      }

      if (!userManager.hasPermission(socket.id, 'canDisableAccounts')) {
        throw new Error('No permission to enable accounts');
      }

      const enabledAccount = accountManager.enableAccount(accountId);
      socket.emit('admin:accounts:enabled', { account: enabledAccount });
    } catch (error) {
      logger.error(`Enable account failed: ${error.message}`, { socketId: socket.id });
      socket.emit('admin:error', formatError(error.message, 'ACCOUNTS_ENABLE_FAILED'));
    }
  });

  socket.on('admin:channels:getPermissions', ({ channelId }) => {
    try {
      if (!currentUser) {
        throw new Error('Not authenticated');
      }

      if (!userManager.hasPermission(socket.id, 'canManageChannelPermissions')) {
        throw new Error('No permission to view channel permissions');
      }

      const permissions = channelManager.getChannelPermissions(channelId);
      socket.emit('admin:channels:permissions', { channelId, permissions });
    } catch (error) {
      logger.error(`Get channel permissions failed: ${error.message}`, { socketId: socket.id });
      socket.emit('admin:error', formatError(error.message, 'CHANNEL_PERMISSIONS_FAILED'));
    }
  });

  socket.on('admin:channels:updatePermissions', ({ channelId, permissions }) => {
    try {
      if (!currentUser) {
        throw new Error('Not authenticated');
      }

      if (!userManager.hasPermission(socket.id, 'canManageChannelPermissions')) {
        throw new Error('No permission to modify channel permissions');
      }

      const updatedPermissions = channelManager.updateChannelPermissions(channelId, permissions || {});
      io.emit('channels:permissionsUpdated', { channelId, permissions: updatedPermissions });
      socket.emit('admin:channels:permissionsUpdated', { channelId, permissions: updatedPermissions });
      broadcastChannels();
    } catch (error) {
      logger.error(`Update channel permissions failed: ${error.message}`, { socketId: socket.id });
      socket.emit('admin:error', formatError(error.message, 'CHANNEL_PERMISSIONS_UPDATE_FAILED'));
    }
  });

  /**
   * Create channel
   */
  socket.on('channels:create', (data) => {
    try {
      if (!currentUser) {
        throw new Error('User not registered');
      }

      if (!userManager.hasPermission(socket.id, 'canCreateChannels')) {
        throw new Error('No permission to create channels');
      }

      // Handle both old format (string) and new format (object)
      const channelData = typeof data === 'string' 
        ? { name: data, type: 'text', groupId: null }
        : data;

      if (channelData.permissions && !userManager.hasPermission(socket.id, 'canManageChannelPermissions')) {
        throw new Error('No permission to configure channel permissions');
      }

      const channel = channelManager.createChannel(
        channelData.name,
        channelData.type || 'text',
        channelData.groupId || null,
        channelData.permissions || {}
      );

      broadcastChannels();
  logger.info(`Channel created: ${channel.name} by ${currentUser.displayName}`, { channelId: channel.id });
    } catch (error) {
      logger.error(`Channel create error: ${error.message}`, { socketId: socket.id });
      socket.emit('error', formatError(error.message, 'CHANNEL_CREATE_FAILED'));
    }
  });

  /**
   * Delete channel
   */
  socket.on('channels:delete', (channelId) => {
    try {
      if (!currentUser) {
        throw new Error('User not registered');
      }

      if (!userManager.hasPermission(socket.id, 'canDeleteChannels')) {
        throw new Error('No permission to delete channels');
      }

      const channel = channelManager.getChannel(channelId);
      if (!channel) {
        throw new Error('Channel not found');
      }

      // Kick all users from channel
      const users = channelManager.getChannelUsers(channelId);
      users.forEach(user => {
        io.to(user.id).emit('channel:deleted', { channelId });
        socket.to(user.id).leave(channelId);
      });

      channelManager.deleteChannel(channelId);
      broadcastChannels();

  logger.info(`Channel deleted: ${channel.name} by ${currentUser.displayName}`, { channelId });
    } catch (error) {
      logger.error(`Channel delete error: ${error.message}`, { socketId: socket.id });
      socket.emit('error', formatError(error.message, 'CHANNEL_DELETE_FAILED'));
    }
  });

  /**
   * Join channel
   */
  socket.on('channel:join', (channelId) => {
    try {
      if (!currentUser) {
        throw new Error('User not registered');
      }

      const channel = channelManager.getChannel(channelId);
      if (!channel) {
        throw new Error('Channel not found');
      }

      const accessAction = channel.type === 'voice' ? 'voice' : 'view';
      if (!channelManager.canAccess(channel, currentUser, accessAction)) {
        throw new Error('No permission to access this channel');
      }

      const newChannel = channel;
      const previousChannelId = currentChannel;
      const previousChannel = previousChannelId ? channelManager.getChannel(previousChannelId) : null;
      const previousWasVoice = previousChannel?.type === 'voice';
      const newIsVoice = newChannel.type === 'voice';
  const keepPreviousVoiceRoom = previousWasVoice && currentVoiceChannel === previousChannelId;

      // Leave previous channel unless we intentionally stay connected to its voice room
      if (previousChannelId && !keepPreviousVoiceRoom) {
        socket.leave(previousChannelId);
        channelManager.removeUserFromChannel(previousChannelId, socket.id);
        broadcastUserUpdate(previousChannelId);
      }

      // Join new channel
      socket.join(channelId);
      currentChannel = channelId;
      channelManager.addUserToChannel(channelId, currentUser);
      userManager.setCurrentChannel(socket.id, channelId);

      // Send join confirmation and message history
      socket.emit('channel:joined', {
        channelId,
        channelName: channel.name,
        channelType: channel.type,
      });

      // Send message history for text/stream channels
      if (channel.type === 'text' || channel.type === 'stream') {
        const history = messageManager.getHistory(channelId);
        socket.emit('chat:history', history);
      }

      broadcastUserUpdate(channelId);
      broadcastChannels();

  logger.debug(`User ${currentUser.displayName} joined channel ${channel.name}`, { socketId: socket.id, channelId });
    } catch (error) {
      logger.error(`Channel join error: ${error.message}`, { socketId: socket.id });
      socket.emit('error', formatError(error.message, 'CHANNEL_JOIN_FAILED'));
    }
  });

  /**
   * Join voice channel
   */
  socket.on('voice:join', (channelId) => {
    try {
      if (!currentUser) {
        throw new Error('User not registered');
      }

      const channel = channelManager.getChannel(channelId);
      if (!channel || channel.type !== 'voice') {
        throw new Error('Invalid voice channel');
      }

      if (!channelManager.canAccess(channel, currentUser, 'voice')) {
        throw new Error('No permission to join this voice channel');
      }

      // Leave previous voice channel
      if (currentVoiceChannel) {
        const prevChannel = channelManager.getChannel(currentVoiceChannel);
        if (prevChannel) {
          socket.to(currentVoiceChannel).emit('voice:peer-leave', { id: socket.id });
        }
        channelManager.removeUserFromChannel(currentVoiceChannel, socket.id);
      }

      // Join new voice channel
      socket.join(channelId);
      currentVoiceChannel = channelId;
      const voiceUser = channelManager.addVoiceParticipant(channelId, currentUser);
      if (!voiceUser) {
        throw new Error('Failed to join voice session');
      }
      userManager.setVoiceChannel(socket.id, channelId);

      // Notify existing users
      socket.to(channelId).emit('voice:peer-join', {
        id: socket.id,
        name: voiceUser.name,
        muted: Boolean(voiceUser.muted),
        deafened: Boolean(voiceUser.deafened),
      });

      const sessionMetadata = channelManager.getVoiceSessionMetadata(channelId);
      const peers = channelManager.getVoiceChannelUsers(channelId)
        .filter(u => u.id !== socket.id);

      socket.emit('voice:joined', {
        channelId,
        peers,
        startedAt: sessionMetadata.startedAt,
        sessionId: sessionMetadata.sessionId,
      });

      broadcastUserUpdate(channelId);
      broadcastChannels();

  logger.debug(`User ${currentUser.displayName} joined voice channel ${channel.name}`, { socketId: socket.id, channelId });
    } catch (error) {
      logger.error(`Voice join error: ${error.message}`, { socketId: socket.id });
      socket.emit('error', formatError(error.message, 'VOICE_JOIN_FAILED'));
    }
  });

  /**
   * Leave voice channel
   */
  socket.on('voice:leave', () => {
    try {
      if (!currentVoiceChannel) {
        return;
      }

      socket.to(currentVoiceChannel).emit('voice:peer-leave', { id: socket.id });
      socket.leave(currentVoiceChannel);
      channelManager.removeVoiceParticipant(currentVoiceChannel, socket.id);
      channelManager.removeUserFromChannel(currentVoiceChannel, socket.id);
      userManager.setVoiceChannel(socket.id, null);

      broadcastUserUpdate(currentVoiceChannel);
    broadcastChannels();

    logger.debug(`User ${currentUser?.displayName} left voice channel`, { socketId: socket.id });
      currentVoiceChannel = null;
    } catch (error) {
      logger.error(`Voice leave error: ${error.message}`, { socketId: socket.id });
    }
  });

  /**
   * Chat message
   */
  socket.on('chat', (text) => {
    try {
      if (!currentUser) {
        throw new Error('User not registered');
      }

      if (!currentChannel) {
        throw new Error('Not in a channel');
      }

      const channel = channelManager.getChannel(currentChannel);
      if (!channel || (channel.type !== 'text' && channel.type !== 'stream')) {
        throw new Error('Invalid channel for chat');
      }

      if (!channelManager.canAccess(channel, currentUser, 'chat')) {
        throw new Error('No permission to send messages in this channel');
      }

      const message = messageManager.createMessage(
        currentChannel,
        socket.id,
        currentUser.displayName,
        text,
        currentUser.roles,
        currentUser.isSuperuser
      );

      io.to(currentChannel).emit('chat', message);
      logger.debug(`Message sent in ${channel.name}`, { socketId: socket.id, messageId: message.id });
    } catch (error) {
      logger.error(`Chat error: ${error.message}`, { socketId: socket.id });
      socket.emit('error', formatError(error.message, 'CHAT_FAILED'));
    }
  });

  /**
   * Delete message (moderation)
   */
  socket.on('chat:delete', ({ messageId, channelId }) => {
    try {
      if (!currentUser) {
        throw new Error('User not registered');
      }

      if (!userManager.hasPermission(socket.id, 'canDeleteAnyMessage')) {
        throw new Error('No permission to delete messages');
      }

      messageManager.deleteMessage(channelId, messageId, currentUser.displayName);
      io.to(channelId).emit('chat:messageDeleted', { messageId, channelId, deletedBy: currentUser.displayName });

      logger.info(`Message deleted by ${currentUser.displayName}`, { messageId, channelId });
    } catch (error) {
      logger.error(`Message delete error: ${error.message}`, { socketId: socket.id });
      socket.emit('error', formatError(error.message, 'DELETE_FAILED'));
    }
  });

  /**
   * WebRTC signaling
   */
  socket.on('voice:signal', ({ to, data }) => {
    if (!currentUser) return;
    socket.to(to).emit('voice:signal', { from: socket.id, data });
    logger.trace(`Voice signal forwarded`, { from: socket.id, to });
  });

  socket.on('voice:state', (payload = {}) => {
    if (!currentVoiceChannel) {
      return;
    }

    const state = {
      muted: Boolean(payload.muted),
      deafened: Boolean(payload.deafened),
    };

    channelManager.updateVoiceUserState(currentVoiceChannel, socket.id, state);

    socket.to(currentVoiceChannel).emit('voice:state', {
      id: socket.id,
      muted: state.muted,
      deafened: state.deafened,
    });

    logger.trace(`Voice state broadcast`, { socketId: socket.id, ...state });
  });

  /**
   * Disconnect handler
   */
  socket.on('disconnect', () => {
    try {
      if (!currentUser) {
        return;
      }

      // Leave current channel
      if (currentChannel) {
        channelManager.removeUserFromChannel(currentChannel, socket.id);
        broadcastUserUpdate(currentChannel);
      }

      // Leave voice channel
      if (currentVoiceChannel) {
        socket.to(currentVoiceChannel).emit('voice:peer-leave', { id: socket.id });
        channelManager.removeVoiceParticipant(currentVoiceChannel, socket.id);
        channelManager.removeUserFromChannel(currentVoiceChannel, socket.id);
        broadcastUserUpdate(currentVoiceChannel);
      }

      // Remove user
      userManager.removeUser(socket.id);
      broadcastUsers();
      broadcastChannels();

      logger.info(`User disconnected: ${currentUser.displayName}`, { socketId: socket.id });

      currentUser = null;
      currentAccount = null;
      currentSession = null;
      currentChannel = null;
      currentVoiceChannel = null;
    } catch (error) {
      logger.error(`Disconnect handler error: ${error.message}`, { socketId: socket.id });
    }
  });
});

// Initialize default channels
channelManager.initializeDefaults();

// Cleanup tasks
setInterval(() => {
  userManager.cleanupExpiredBans();
}, 60000); // Every minute

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

// Error handling
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason, promise });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

// Start server
server.listen(appConfig.server.port, appConfig.server.host, () => {
  logger.info(`🚀 RTMP-Disc Server started`);
  logger.info(`   Host: ${appConfig.server.host}`);
  logger.info(`   Port: ${appConfig.server.port}`);
  logger.info(`   Environment: ${appConfig.server.env}`);
  logger.info(`   CORS Origins: ${appConfig.cors.origins.join(', ')}`);
  logger.info(`   Log Level: ${appConfig.logging.level}`);
  logger.info(`   Max Channels: ${appConfig.channels.maxChannels}`);
  logger.info(`   Max Users/Channel: ${appConfig.channels.maxUsersPerChannel}`);
  logger.info('');
  logger.info('📊 Endpoints:');
  logger.info(`   Health: http://${appConfig.server.host}:${appConfig.server.port}/health`);
  logger.info(`   Stats: http://${appConfig.server.host}:${appConfig.server.port}/api/stats`);
  logger.info('');
  logger.info('✅ Server ready for connections');
});

export { app, server, io };
