/**
 * Application Configuration
 * Centralized configuration management with validation
 */

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, '../../.env') });

/**
 * Validate required environment variables
 */
function validateConfig() {
  const errors = [];

  if (errors.length > 0) {
    console.warn('⚠️  Configuration warnings:');
    errors.forEach(err => console.warn(`   - ${err}`));
  }
}

/**
 * Application configuration object
 */
export const appConfig = {
  // Server configuration
  server: {
    port: parseInt(process.env.PORT || '4000', 10),
    host: process.env.HOST || '0.0.0.0', // Bind to all interfaces for Docker
    env: process.env.NODE_ENV || 'development',
    isDevelopment: process.env.NODE_ENV !== 'production',
    isProduction: process.env.NODE_ENV === 'production',
  },

  // CORS configuration
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true,
  },

  // Security configuration
  security: {
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10), // 1 minute
    rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
    maxConnectionsPerIp: parseInt(process.env.MAX_CONNECTIONS_PER_IP || '50', 10),
    passwordMinLength: parseInt(process.env.PASSWORD_MIN_LENGTH || '8', 10),
  },

  // Channel limits
  channels: {
    maxChannels: parseInt(process.env.MAX_CHANNELS || '50', 10),
    maxUsersPerChannel: parseInt(process.env.MAX_USERS_PER_CHANNEL || '50', 10),
    maxChannelNameLength: 32,
    defaultTextChannels: ['general', 'announcements'],
    defaultVoiceChannels: ['lobby', 'room-1'],
    defaultStreamChannels: ['main-stream'],
  },

  // Message configuration
  messages: {
    maxHistoryPerChannel: parseInt(process.env.MAX_MESSAGES_PER_CHANNEL || '100', 10),
    maxMessageLength: parseInt(process.env.MAX_MESSAGE_LENGTH || '1000', 10),
    maxMessagesPerMinute: parseInt(process.env.MAX_MESSAGES_PER_MINUTE || '30', 10),
  },

  // Streaming configuration
  streaming: {
    hlsPath: process.env.HLS_PATH || '/tmp/hls',
  hlsBaseUrl: process.env.HLS_BASE_URL || 'http://localhost/hls',
    streamKeyLength: 24,
    maxStreamDuration: parseInt(process.env.MAX_STREAM_DURATION || '14400', 10), // 4 hours in seconds
  },

  // Logging configuration
  logging: {
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    format: process.env.LOG_FORMAT || 'json',
    console: process.env.LOG_CONSOLE !== 'false',
    file: process.env.LOG_FILE === 'true',
    filePath: process.env.LOG_FILE_PATH || './logs',
  },

  // Socket.IO configuration
  socket: {
    pingTimeout: parseInt(process.env.SOCKET_PING_TIMEOUT || '60000', 10),
    pingInterval: parseInt(process.env.SOCKET_PING_INTERVAL || '25000', 10),
    maxHttpBufferSize: parseInt(process.env.SOCKET_MAX_BUFFER_SIZE || '1e6', 10), // 1MB
  },

  // Voice/WebRTC configuration
  voice: {
    maxPeers: parseInt(process.env.MAX_VOICE_PEERS || '20', 10),
    audioQuality: process.env.AUDIO_QUALITY || 'high', // low, medium, high
  },

  // Storage configuration
  storage: {
    driver: process.env.MESSAGE_STORE_DRIVER || 'memory',
    messageStorePath: process.env.MESSAGE_STORE_PATH || join(process.cwd(), 'storage/messages.json'),
    flushDebounceMs: parseInt(process.env.MESSAGE_STORE_FLUSH_DEBOUNCE_MS || '500', 10),
    accountStorePath: process.env.ACCOUNT_STORE_PATH || join(process.cwd(), 'storage/accounts.json'),
    accountSessionTtlMs: parseInt(process.env.ACCOUNT_SESSION_TTL_MS || '86400000', 10), // 24 hours
  },
};

// Validate configuration on load
validateConfig();

// Role definitions with hierarchical permissions
export const ROLES = {
  superuser: {
    level: 5,
    canCreateChannels: true,
    canDeleteChannels: true,
    canEditChannels: true,
    canManageUsers: true,
    canAssignRoles: true,
    canRegenerateKeys: true,
    canStreamAnywhere: true,
    canModerate: true,
    canViewAllKeys: true,
    canDeleteAnyMessage: true,
    canBanUsers: true,
    canViewLogs: true,
    canManageChannelPermissions: true,
    canDisableAccounts: true,
  },
  admin: {
    level: 4,
    canCreateChannels: true,
    canDeleteChannels: true,
    canEditChannels: true,
    canManageUsers: true,
    canAssignRoles: true,
    canRegenerateKeys: true,
    canStreamAnywhere: true,
    canModerate: true,
    canViewAllKeys: true,
    canDeleteAnyMessage: true,
    canBanUsers: true,
    canViewLogs: true,
    canManageChannelPermissions: true,
    canDisableAccounts: true,
  },
  moderator: {
    level: 3,
    canCreateChannels: true,
    canDeleteChannels: false,
    canEditChannels: false,
    canManageUsers: false,
    canAssignRoles: false,
    canRegenerateKeys: false,
    canStreamAnywhere: false,
    canModerate: true,
    canViewAllKeys: false,
    canDeleteAnyMessage: true,
    canBanUsers: false,
    canViewLogs: false,
    canManageChannelPermissions: false,
    canDisableAccounts: false,
  },
  streamer: {
    level: 2,
    canCreateChannels: false,
    canDeleteChannels: false,
    canEditChannels: false,
    canManageUsers: false,
    canAssignRoles: false,
    canRegenerateKeys: false,
    canStreamAnywhere: false,
    canModerate: false,
    canViewAllKeys: false,
    canDeleteAnyMessage: false,
    canBanUsers: false,
    canViewLogs: false,
    canManageChannelPermissions: false,
    canDisableAccounts: false,
  },
  user: {
    level: 1,
    canCreateChannels: false,
    canDeleteChannels: false,
    canEditChannels: false,
    canManageUsers: false,
    canAssignRoles: false,
    canRegenerateKeys: false,
    canStreamAnywhere: false,
    canModerate: false,
    canViewAllKeys: false,
    canDeleteAnyMessage: false,
    canBanUsers: false,
    canViewLogs: false,
    canManageChannelPermissions: false,
    canDisableAccounts: false,
  },
};

// Export role hierarchy for easy access
export const ROLE_HIERARCHY = ['superuser', 'admin', 'moderator', 'streamer', 'user'];

export default appConfig;
