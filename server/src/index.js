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
import {
  formatError,
  getClientIp,
  checkRateLimit,
  cleanupRateLimitStore,
  extractStreamKeyToken,
  formatStreamKey,
} from './utils/helpers.js';

// Models/Managers
import channelManager from './models/ChannelManager.js';
import userManager from './models/UserManager.js';
import messageManager from './models/MessageManager.js';
import accountManager from './models/AccountManager.js';
import MinigameManager from './services/MinigameManager.js';

// Get current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize Express app
const app = express();

const streamAuthRateStore = new Map();
const streamAuthCleanupHandle = setInterval(
  () => cleanupRateLimitStore(streamAuthRateStore),
  appConfig.security.streamAuthWindowMs,
);
streamAuthCleanupHandle.unref?.();

const normalizeOrigin = (value = '') => value.replace(/\/$/, '').toLowerCase();
const allowedOrigins = new Set(appConfig.cors.origins.map(normalizeOrigin));
const allowAllOrigins = allowedOrigins.has('*');

const PLACEHOLDER_PATTERN = /^\$[A-Za-z0-9_]+$/;

const normalizeCandidate = (value) => {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();

    if (!trimmed || trimmed === 'undefined' || trimmed === 'null') {
      return '';
    }

    if (PLACEHOLDER_PATTERN.test(trimmed)) {
      return '';
    }

    return trimmed;
  }

  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }

  return '';
};

const pickFirstString = (...values) => {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = pickFirstString(...value);
      if (nested) {
        return nested;
      }
      continue;
    }

    const candidate = normalizeCandidate(value);
    if (candidate) {
      return candidate;
    }
  }

  return '';
};

const extractCredentialsFromUrl = (rawUrl = '') => {
  const trimmed = normalizeCandidate(rawUrl);
  if (!trimmed) {
    return { username: '', password: '' };
  }

  try {
    const normalized = trimmed.replace(/^rtmps?:\/\//i, 'http://');
    const parsed = new URL(normalized);
    const username = normalizeCandidate(decodeURIComponent(parsed.username || ''));
    const password = normalizeCandidate(decodeURIComponent(parsed.password || ''));
    return { username, password };
  } catch (error) {
    logger.debug('Failed to parse auth from tcurl', { rawUrl: trimmed, error: error?.message });
    return { username: '', password: '' };
  }
};

const extractCredentialsFromHeader = (headerValue = '') => {
  if (typeof headerValue !== 'string') {
    return { username: '', password: '' };
  }

  const value = headerValue.trim();
  if (!value.toLowerCase().startsWith('basic ')) {
    return { username: '', password: '' };
  }

  try {
    const decoded = Buffer.from(value.slice(6), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');

    if (separatorIndex === -1) {
      return { username: '', password: '' };
    }

    const username = normalizeCandidate(decoded.slice(0, separatorIndex));
    const password = normalizeCandidate(decoded.slice(separatorIndex + 1));
    return { username, password };
  } catch (error) {
    logger.debug('Failed to parse credentials from Authorization header', { error: error?.message });
    return { username: '', password: '' };
  }
};

const parseStreamAuthRequest = (req) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const query = req.query && typeof req.query === 'object' ? req.query : {};

  const argsString = pickFirstString(body.args, query.args);
  const args = new URLSearchParams(typeof argsString === 'string' ? argsString : '');

  const channelName = pickFirstString(
    query.channel,
    body.channel,
    body.name,
    query.name,
    args.get('channel'),
    args.get('name'),
  );

  let username = pickFirstString(
    body.username,
    body.user,
    query.username,
    query.user,
    args.get('username'),
    args.get('user'),
  );

  let password = pickFirstString(
    body.password,
    body.pass,
    body.pswd,
    query.password,
    query.pass,
    args.get('password'),
    args.get('pass'),
  );

  const clientId = pickFirstString(
    body.clientid,
    body.clientId,
    query.clientid,
    query.clientId,
    args.get('clientid'),
    args.get('clientId'),
  );

  const tcUrl = pickFirstString(
    body.tcurl,
    body.tcUrl,
    query.tcurl,
    query.tcUrl,
    args.get('tcurl'),
    args.get('tcUrl'),
  );

  const streamKey = pickFirstString(
    body.streamKey,
    body['stream-key'],
    body.stream_key,
    body.key,
    query.streamKey,
    query['stream-key'],
    query.stream_key,
    query.key,
    args.get('streamKey'),
    args.get('stream-key'),
    args.get('stream_key'),
    args.get('key'),
  );

  if (!username || !password) {
    const fromTcurl = extractCredentialsFromUrl(tcUrl);
    if (!username && fromTcurl.username) {
      username = fromTcurl.username;
    }
    if (!password && fromTcurl.password) {
      password = fromTcurl.password;
    }
  }

  if (!username || !password) {
    const authHeader = req.headers?.authorization || req.headers?.Authorization;
    const fromHeader = extractCredentialsFromHeader(authHeader);
    if (!username && fromHeader.username) {
      username = fromHeader.username;
    }
    if (!password && fromHeader.password) {
      password = fromHeader.password;
    }
  }

  const requestIp = pickFirstString(
    query.ip,
    body.ip,
    body.addr,
    args.get('ip'),
    req.headers['cf-connecting-ip'],
    req.headers['x-real-ip'],
    req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0] : '',
  ) || req.ip;

  const appName = pickFirstString(body.app, query.app, args.get('app'));

  return {
    channelName,
    username,
    password,
    clientId,
    ip: requestIp,
    appName,
    tcUrl,
    streamKey,
    args: Object.fromEntries(args.entries()),
  };
};

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

app.post('/api/stream/auth', async (req, res) => {
  const {
    channelName: rawChannelName,
    username,
    password,
    clientId,
    ip,
    streamKey: streamKeyCandidate,
  } = parseStreamAuthRequest(req);

  const truncateChannelName = (value) => {
    if (!value || typeof value !== 'string') {
      return value;
    }

    let endIndex = value.length;
    const plusIndex = value.indexOf('+');
    const questionIndex = value.indexOf('?');
    if (plusIndex !== -1) {
      endIndex = Math.min(endIndex, plusIndex);
    }
    if (questionIndex !== -1) {
      endIndex = Math.min(endIndex, questionIndex);
    }
    return value.slice(0, endIndex);
  };

  let resolvedChannelName = truncateChannelName(rawChannelName);

  const extractToken = (value) => extractStreamKeyToken(value);

  let streamKeyToken = extractToken(streamKeyCandidate);
  if (!streamKeyToken && rawChannelName) {
    streamKeyToken = extractToken(rawChannelName);
  }
  if (!streamKeyToken && password) {
    streamKeyToken = extractToken(password);
  }

  const hasStreamKey = Boolean(streamKeyToken);
  const hasCredentials = Boolean(username && password);

  const rateKey = hasStreamKey
    ? `${ip || 'unknown'}:key:${streamKeyToken?.slice(-8) || 'none'}`
    : `${ip || 'unknown'}:${(username || '').toLowerCase()}`;

  const allowed = checkRateLimit(
    streamAuthRateStore,
    rateKey,
    appConfig.security.streamAuthMaxAttempts,
    appConfig.security.streamAuthWindowMs,
  );

  if (!allowed) {
    logger.warn('Stream auth rate limit exceeded', {
      channelName: resolvedChannelName || rawChannelName || null,
      username: hasStreamKey ? undefined : username,
      ip,
      mode: hasStreamKey ? 'stream-key' : 'credentials',
    });
    return res.status(429).json({
      allowed: false,
      code: 'STREAM_AUTH_RATE_LIMITED',
      message: 'Too many authentication attempts',
    });
  }

  if (hasStreamKey) {
    const channel = channelManager.getChannelByStreamKey(streamKeyToken);

    if (!channel || channel.type !== 'stream') {
      logger.warn('Stream auth failed: invalid stream key', {
        providedChannel: rawChannelName || null,
        streamKeyTail: streamKeyToken.slice(-6),
        ip,
      });

      return res.status(403).json({
        allowed: false,
        code: 'STREAM_KEY_INVALID',
        message: 'Invalid or expired stream key',
      });
    }

    try {
      resolvedChannelName = channel.name;

      const activeStream = channelManager.startStream(channel.id, {
        accountId: null,
        username: 'stream-key',
        displayName: `${channel.name} Stream`,
        clientId: clientId || null,
        sourceIp: ip || null,
        metadata: { authMode: 'stream-key', streamKeyTail: streamKeyToken.slice(-6) },
      });

      broadcastChannels();

      logger.info('Stream authenticated via stream key', {
        channelId: channel.id,
        channelName: channel.name,
        clientId: clientId || null,
        ip: ip || null,
      });

      return res.status(200).json({
        allowed: true,
        channelId: channel.id,
        channel: channel.name,
        startedAt: activeStream.startedAt,
      });
    } catch (error) {
      if (error && error.message === 'Channel already has an active stream') {
        logger.warn('Stream auth denied: channel already live', {
          channelName: channel.name,
          mode: 'stream-key',
        });

        return res.status(409).json({
          allowed: false,
          code: 'STREAM_ALREADY_LIVE',
          message: 'Channel already has an active stream',
        });
      }

      logger.error('Stream auth error during stream-key start', {
        channelId: channel.id,
        channelName: channel.name,
        error: error?.message,
      });

      return res.status(500).json({
        allowed: false,
        code: 'STREAM_AUTH_ERROR',
        message: 'Failed to validate stream authentication',
      });
    }
  }

  if (!resolvedChannelName || !hasCredentials) {
    logger.warn('Stream auth missing required fields', {
      channelName: resolvedChannelName || rawChannelName,
      usernamePresent: Boolean(username),
      hasStreamKey,
    });

    return res.status(400).json({
      allowed: false,
      code: 'STREAM_AUTH_INVALID',
      message: 'Missing channel name or credentials',
    });
  }

  try {
    const account = await accountManager.authenticate(username, password);
    const channel = channelManager.getChannelByName(resolvedChannelName);

    if (!channel || channel.type !== 'stream') {
      logger.warn('Stream auth failed: channel not stream-capable', { channelName, username: account.username });
      return res.status(403).json({
        allowed: false,
        code: 'STREAM_AUTH_CHANNEL_INVALID',
        message: 'Channel is not available for streaming',
      });
    }

    const pseudoUser = {
      id: account.id,
      accountId: account.id,
      username: account.username,
      displayName: account.displayName,
      roles: Array.isArray(account.roles) ? account.roles : ['user'],
      isSuperuser: Array.isArray(account.roles) ? account.roles.includes('superuser') : false,
    };

    if (!channelManager.canAccess(channel, pseudoUser, 'stream')) {
      logger.warn('Stream auth failed: insufficient permissions', { channelName, username: account.username });
      return res.status(403).json({
        allowed: false,
        code: 'STREAM_AUTH_FORBIDDEN',
        message: 'You are not allowed to stream to this channel',
      });
    }

    try {
      const activeStream = channelManager.startStream(channel.id, {
        accountId: account.id,
        username: account.username,
        displayName: account.displayName,
        clientId: clientId || null,
        sourceIp: ip || null,
      });

      broadcastChannels();

      logger.info('Stream authenticated successfully', {
        channelId: channel.id,
        channelName: resolvedChannelName,
        accountId: account.id,
        username: account.username,
        clientId: clientId || null,
      });

      return res.status(200).json({
        allowed: true,
        channelId: channel.id,
        channel: resolvedChannelName,
        startedAt: activeStream.startedAt,
      });
    } catch (error) {
      if (error && error.message === 'Channel already has an active stream') {
        logger.warn('Stream auth denied: channel already live', { channelName, username: account.username });
        return res.status(409).json({
          allowed: false,
          code: 'STREAM_ALREADY_LIVE',
          message: 'Channel already has an active stream',
        });
      }

      throw error;
    }
  } catch (error) {
    if (error && typeof error.message === 'string' && error.message.toLowerCase().includes('invalid credentials')) {
      logger.warn('Stream auth failed: invalid credentials', { channelName: resolvedChannelName, username });
      return res.status(403).json({
        allowed: false,
        code: 'STREAM_AUTH_INVALID_CREDENTIALS',
        message: 'Invalid username or password',
      });
    }

    logger.error(`Stream auth error: ${error.message}`, { channelName: resolvedChannelName, username });
    return res.status(500).json({
      allowed: false,
      code: 'STREAM_AUTH_ERROR',
      message: 'Failed to validate stream authentication',
    });
  }
});

app.post('/api/stream/end', (req, res) => {
  const {
    channelName: rawChannelName,
    streamKey: streamKeyCandidate,
    clientId,
  } = parseStreamAuthRequest(req);

  let resolvedChannelName = rawChannelName;
  const extractToken = (value) => extractStreamKeyToken(value);
  const streamKeyToken = extractToken(streamKeyCandidate) || extractToken(rawChannelName);

  let channel = streamKeyToken ? channelManager.getChannelByStreamKey(streamKeyToken) : null;

  if (!channel && rawChannelName) {
    const baseName = rawChannelName.includes('+')
      ? rawChannelName.slice(0, rawChannelName.indexOf('+'))
      : rawChannelName.includes('?')
        ? rawChannelName.slice(0, rawChannelName.indexOf('?'))
        : rawChannelName;
    resolvedChannelName = baseName;
    channel = baseName ? channelManager.getChannelByName(baseName) : null;
  }

  if (!channel || channel.type !== 'stream') {
    return res.status(200).json({ released: false, reason: 'invalid channel' });
  }

  if (!channel.activeStream) {
    return res.status(200).json({ released: false, reason: 'not live' });
  }

  channelManager.endStream(channel.id, { clientId: clientId || null });
  broadcastChannels();

  logger.info('Stream ended', {
    channelId: channel.id,
    channelName: channel.name,
    clientId: clientId || null,
  });

  return res.status(200).json({ released: true });
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

const minigameManager = new MinigameManager({
  io,
  channelManager,
  onChannelUpdate: () => {
    broadcastChannels();
  },
});

/**
 * Broadcast channel updates to all clients
 */
function broadcastChannels() {
  const channels = channelManager.exportChannelsList(true);
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

function emitScreenshareSession(channelId, targetSocket = null) {
  if (!channelId) {
    return;
  }

  const session = channelManager.getScreenshareSession(channelId);
  const payload = {
    channelId,
    active: Boolean(session),
    hostId: session?.hostId || null,
    hostName: session?.displayName || null,
    startedAt: session?.startedAt || null,
    viewerCount: session?.viewerCount || 0,
  };

  if (targetSocket) {
    targetSocket.emit('screenshare:session', payload);
    return;
  }

  io.to(channelId).emit('screenshare:session', payload);
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
  let currentScreenshareChannel = null;
  let currentScreenshareViewingChannel = null;
  const getUserDisplayName = () => currentUser?.displayName || currentUser?.name || currentUser?.username || 'Player';
  const ensureVoiceGameAccess = () => {
    if (!currentUser) {
      throw new Error('User not registered');
    }

    if (!currentVoiceChannel) {
      throw new Error('Join a voice channel first');
    }

    return currentVoiceChannel;
  };
  
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
  channels: channelManager.exportChannelsList(true),
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

      // If user is already authenticated with the same account, just confirm success
      // This handles mobile app resume scenarios where socket reconnects
      if (currentUser && currentAccount && currentAccount.id === accountRecord.id) {
        logger.info(`Session resume for already authenticated user`, {
          socketId: socket.id,
          accountId: currentAccount.id,
          username: currentAccount.username,
        });
        
        // Re-emit auth:success to confirm connection
        socket.emit('auth:success', {
          user: userManager.exportUserData(socket.id),
          account: currentAccount,
          session: {
            token: session.token,
            expiresAt: session.expiresAt,
          },
          channels: channelManager.exportChannelsList(true),
          groups: channelManager.getAllChannelGroups(),
          isNewAccount: false,
        });
        return;
      }

      // If user exists but it's a different account, require logout first
      if (currentUser) {
        throw new Error('User already authenticated with different account');
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

  socket.on('stream:key:request', (payload = {}) => {
    const { channelId, channelName } = payload;
    let resolvedChannel = null;

    try {
      if (!currentUser) {
        const error = new Error('Not authenticated');
        error.code = 'STREAM_KEY_UNAUTHENTICATED';
        throw error;
      }

      const identifier = typeof channelId === 'string' && channelId.trim().length > 0
        ? channelId.trim()
        : typeof channelName === 'string'
          ? channelName.trim()
          : '';

      if (!identifier) {
        const error = new Error('Channel identifier is required');
        error.code = 'STREAM_KEY_INVALID_REQUEST';
        throw error;
      }

      const channel = channelId
        ? channelManager.getChannel(channelId)
        : channelManager.getChannelByName(identifier);

      if (!channel || channel.type !== 'stream') {
        const error = new Error('Stream channel not found');
        error.code = 'STREAM_KEY_CHANNEL_NOT_FOUND';
        throw error;
      }

      resolvedChannel = channel;

      if (!channel.streamKey) {
        const error = new Error('Stream key unavailable');
        error.code = 'STREAM_KEY_MISSING';
        throw error;
      }

      const hasGlobalKeyAccess = userManager.hasPermission(socket.id, 'canViewAllKeys') ||
        userManager.hasPermission(socket.id, 'canStreamAnywhere');
      const hasChannelAccess = channelManager.canAccess(channel, currentUser, 'stream');

      if (!hasGlobalKeyAccess && !hasChannelAccess) {
        const error = new Error('You do not have permission to view this stream key');
        error.code = 'STREAM_KEY_FORBIDDEN';
        throw error;
      }

      socket.emit('stream:key:response', {
        channelId: channel.id,
        channelName: channel.name,
        streamKey: formatStreamKey(channel.name, channel.streamKey),
        streamKeyChannel: channel.name,
        streamKeyToken: channel.streamKey,
      });

      logger.info('Stream key provided to user', {
        socketId: socket.id,
        channelId: channel.id,
        accountId: currentAccount?.id,
      });
    } catch (error) {
      const message = error?.code === 'STREAM_KEY_FORBIDDEN'
        ? 'You do not have access to this stream key'
        : (error?.message || 'Unable to retrieve stream key');

      logger.warn('Stream key request failed', {
        socketId: socket.id,
        channelId: channelId || resolvedChannel?.id || null,
        code: error?.code || 'STREAM_KEY_ERROR',
        reason: error?.message,
      });

      socket.emit('stream:key:error', {
        channelId: channelId || resolvedChannel?.id || null,
        channelName: resolvedChannel?.name || (typeof channelName === 'string' ? channelName.trim() : null),
        message,
        code: error?.code || 'STREAM_KEY_ERROR',
      });
    }
  });

  socket.on('screenshare:start', (payload = {}) => {
    try {
      if (!currentUser) {
        throw new Error('User not registered');
      }

      const channelId = typeof payload.channelId === 'string' ? payload.channelId : currentChannel;
      if (!channelId) {
        throw new Error('Channel ID is required');
      }

      const channel = channelManager.getChannel(channelId);
      if (!channel || channel.type !== 'screenshare') {
        throw new Error('Not a screenshare channel');
      }

      if (!channelManager.canAccess(channel, currentUser, 'stream')) {
        throw new Error('No permission to share screen in this channel');
      }

      channelManager.startScreenshare(channelId, {
        hostId: socket.id,
        accountId: currentAccount?.id || null,
        displayName: getUserDisplayName(),
      });
      currentScreenshareChannel = channelId;
      emitScreenshareSession(channelId);
      broadcastChannels();
    } catch (error) {
      socket.emit('screenshare:error', {
        channelId: payload?.channelId || currentChannel,
        message: error.message || 'Unable to start screenshare',
        code: 'SCREENSHARE_START_FAILED',
      });
    }
  });

  socket.on('screenshare:stop', (payload = {}) => {
    try {
      const channelId = typeof payload.channelId === 'string' ? payload.channelId : currentScreenshareChannel;
      if (!channelId) {
        throw new Error('Channel ID is required');
      }

      if (currentScreenshareChannel !== channelId) {
        throw new Error('Not hosting this screenshare');
      }

      channelManager.stopScreenshare(channelId, 'host-request');
      currentScreenshareChannel = null;
      emitScreenshareSession(channelId);
      broadcastChannels();
    } catch (error) {
      socket.emit('screenshare:error', {
        channelId: payload?.channelId || currentChannel,
        message: error.message || 'Unable to stop screenshare',
        code: 'SCREENSHARE_STOP_FAILED',
      });
    }
  });

  socket.on('screenshare:viewer:join', (payload = {}) => {
    try {
      const channelId = typeof payload.channelId === 'string' ? payload.channelId : currentChannel;
      if (!currentUser || !channelId) {
        throw new Error('Channel ID is required');
      }

      const channel = channelManager.getChannel(channelId);
      if (!channel || channel.type !== 'screenshare') {
        throw new Error('Not a screenshare channel');
      }

      const session = channelManager.getScreenshareSession(channelId);
      if (!session?.hostId) {
        socket.emit('screenshare:session', {
          channelId,
          active: false,
          hostId: null,
          hostName: null,
          startedAt: null,
          viewerCount: 0,
        });
        return;
      }

      if (currentScreenshareViewingChannel === channelId) {
        return;
      }

      if (session.hostId === socket.id) {
        return;
      }

      currentScreenshareViewingChannel = channelId;
      channelManager.addScreenshareViewer(channelId, socket.id);
      emitScreenshareSession(channelId);
      broadcastChannels();

      io.to(session.hostId).emit('screenshare:viewer:pending', {
        channelId,
        viewerId: socket.id,
        viewerName: getUserDisplayName(),
      });
    } catch (error) {
      socket.emit('screenshare:error', {
        channelId: payload?.channelId || currentChannel,
        message: error.message || 'Unable to join screenshare',
        code: 'SCREENSHARE_VIEWER_FAILED',
      });
    }
  });

  socket.on('screenshare:viewer:leave', (payload = {}) => {
    const channelId = typeof payload.channelId === 'string' ? payload.channelId : currentScreenshareViewingChannel;
    if (!channelId) {
      return;
    }

    channelManager.removeScreenshareViewer(channelId, socket.id);
    emitScreenshareSession(channelId);
    broadcastChannels();
    if (currentScreenshareViewingChannel === channelId) {
      currentScreenshareViewingChannel = null;
    }
  });

  socket.on('screenshare:signal', ({ to, data, channelId }) => {
    if (!to || !data) {
      return;
    }

    socket.to(to).emit('screenshare:signal', {
      from: socket.id,
      data,
      channelId: channelId || null,
    });
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

        if (previousChannel?.type === 'screenshare' && currentScreenshareViewingChannel === previousChannelId) {
          channelManager.removeScreenshareViewer(previousChannelId, socket.id);
          emitScreenshareSession(previousChannelId);
          currentScreenshareViewingChannel = null;
        }
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
      if (channel.type === 'text' || channel.type === 'stream' || channel.type === 'screenshare') {
        const history = messageManager.getHistory(channelId);
        socket.emit('chat:history', history);
      }

      if (channel.type === 'screenshare') {
        emitScreenshareSession(channelId, socket);
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

      const minigameState = minigameManager.getState(channelId);
      if (minigameState) {
        socket.emit('voice:game:state', minigameState);
      }

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
      minigameManager.handleVoiceMemberLeft(currentVoiceChannel, socket.id);
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

  socket.on('voice:game:start', (payload = {}) => {
    try {
      const channelId = ensureVoiceGameAccess();
  const type = typeof payload.type === 'string' ? payload.type : 'slither';
      minigameManager.startGame({
        channelId,
        hostId: socket.id,
        hostName: getUserDisplayName(),
        type,
      });
    } catch (error) {
      logger.warn(`Minigame start failed: ${error.message}`, { socketId: socket.id });
      socket.emit('voice:game:error', {
        message: error.message || 'Unable to start minigame',
        code: 'GAME_START_FAILED',
      });
    }
  });

  socket.on('voice:game:join', () => {
    try {
      const channelId = ensureVoiceGameAccess();
      const state = minigameManager.joinGame(channelId, socket.id, getUserDisplayName());
      if (state) {
        socket.emit('voice:game:state', state);
      }
    } catch (error) {
      socket.emit('voice:game:error', {
        message: error.message || 'Unable to join minigame',
        code: 'GAME_JOIN_FAILED',
      });
    }
  });

  socket.on('voice:game:leave', () => {
    try {
      const channelId = ensureVoiceGameAccess();
      const state = minigameManager.leaveGame(channelId, socket.id);
      if (state) {
        socket.emit('voice:game:state', state);
      }
    } catch (error) {
      socket.emit('voice:game:error', {
        message: error.message || 'Unable to leave minigame',
        code: 'GAME_LEAVE_FAILED',
      });
    }
  });

  socket.on('voice:game:input', (payload = {}) => {
    try {
      const channelId = ensureVoiceGameAccess();
      const vector = payload?.vector;
      const x = typeof vector?.x === 'number' ? vector.x : null;
      const y = typeof vector?.y === 'number' ? vector.y : null;
      if (x === null || y === null || Number.isNaN(x) || Number.isNaN(y)) {
        throw new Error('Movement vector is required');
      }
      minigameManager.handleInput(channelId, socket.id, { x, y });
    } catch (error) {
      socket.emit('voice:game:error', {
        message: error.message || 'Unable to register input',
        code: 'GAME_INPUT_FAILED',
      });
    }
  });

  socket.on('voice:game:end', () => {
    try {
      const channelId = ensureVoiceGameAccess();
      const state = minigameManager.getState(channelId);
      if (!state) {
        throw new Error('No active minigame to end');
      }

      const isHost = state.hostId === socket.id;
      if (!isHost && !currentUser?.isSuperuser) {
        throw new Error('Only the host can end this minigame');
      }

      minigameManager.endGame(channelId, 'ended_by_host');
    } catch (error) {
      socket.emit('voice:game:error', {
        message: error.message || 'Unable to end minigame',
        code: 'GAME_END_FAILED',
      });
    }
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
        minigameManager.handleVoiceMemberLeft(currentVoiceChannel, socket.id);
        broadcastUserUpdate(currentVoiceChannel);
      }

      if (currentScreenshareViewingChannel) {
        channelManager.removeScreenshareViewer(currentScreenshareViewingChannel, socket.id);
        emitScreenshareSession(currentScreenshareViewingChannel);
        broadcastChannels();
        currentScreenshareViewingChannel = null;
      }

      if (currentScreenshareChannel) {
        channelManager.stopScreenshare(currentScreenshareChannel, 'host-disconnected');
        emitScreenshareSession(currentScreenshareChannel);
        broadcastChannels();
        currentScreenshareChannel = null;
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
      currentScreenshareChannel = null;
      currentScreenshareViewingChannel = null;
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
