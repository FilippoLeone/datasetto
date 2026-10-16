import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

const require = createRequire(import.meta.url);

const boolFromEnv = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return defaultValue;
      if (typeof value === 'boolean') return value;
      return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    });

const listFromEnv = (defaults: string[] = []) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return [...defaults];
      return Array.from(new Set(value.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean)));
    });

const intFromEnv = (defaultValue: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue);

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value && value.trim() ? value.trim() : null));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intFromEnv(4000, 1, 65535),
  HOST: z.string().default('0.0.0.0'),
  TRUST_PROXY: boolFromEnv(false),
  DATABASE_PATH: z.string().default('./data/datasetto.db'),
  // Uploads (avatars) live here; defaults to the database's directory, /data in Docker.
  DATA_DIR: optionalString,

  CORS_ORIGINS: listFromEnv(['http://localhost:5173', 'http://localhost:8080']),
  ALLOW_NATIVE_ORIGINS: boolFromEnv(true),

  PUBLIC_RTMP_URL: optionalString,
  PUBLIC_HLS_URL: optionalString,

  REGISTRATION_MODE: z.enum(['open', 'invite', 'closed']).default('open'),
  REGISTRATION_INVITE_CODE: optionalString,
  ADMIN_EMAILS: listFromEnv([]).transform((list) => list.map((email) => email.toLowerCase())),

  SESSION_TTL_DAYS: intFromEnv(30, 1, 365),
  // One signed-in device per account: a new sign-in disconnects the previous socket.
  SINGLE_SESSION_PER_ACCOUNT: boolFromEnv(true),
  PASSWORD_MIN_LENGTH: intFromEnv(8, 8, 64),

  MAX_CHANNELS: intFromEnv(50, 1, 500),
  MAX_MESSAGE_LENGTH: intFromEnv(2000, 100, 10000),
  CHAT_HISTORY_LIMIT: intFromEnv(100, 10, 500),
  MESSAGE_RETENTION_PER_CHANNEL: intFromEnv(2000, 100, 100000),
  MAX_MESSAGES_PER_MINUTE: intFromEnv(30, 1, 600),
  MAX_CONNECTIONS_PER_IP: intFromEnv(20, 1, 1000),

  TURN_URLS: listFromEnv([]),
  TURN_SECRET: optionalString,
  TURN_CREDENTIAL_TTL_SECONDS: intFromEnv(43200, 300, 7 * 24 * 3600),
  STUN_URLS: listFromEnv(['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']),

  // Streaming cost controls (see ops/README.md, "Keeping the bill small").
  HLS_TICKET_SECRET: optionalString,
  STREAM_MAX_VIEWERS: intFromEnv(10, 1, 500),
  STREAM_MAX_BITRATE_KBPS: intFromEnv(6000, 500, 50000),
  STREAM_MONTHLY_EGRESS_GB: intFromEnv(150, 1, 100000),
  RTMP_STAT_URL: optionalString,
  // GitHub repository whose latest release feeds the downloads page.
  RELEASES_GITHUB_REPO: z
    .string()
    .trim()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'expected owner/name')
    .default('FilippoLeone/datasetto'),
  RELEASES_CACHE_SECONDS: intFromEnv(600, 30, 86400),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  isProduction: boolean;
  version: string;
  server: { port: number; host: string; trustProxy: boolean };
  database: { path: string };
  storage: { dataDir: string };
  cors: { origins: string[]; allowNativeOrigins: boolean };
  publicUrls: { rtmp: string | null; hls: string | null };
  registration: { mode: Env['REGISTRATION_MODE']; inviteCode: string | null; adminEmails: string[] };
  sessions: { ttlMs: number; singlePerAccount: boolean };
  security: { passwordMinLength: number; maxConnectionsPerIp: number };
  limits: {
    maxChannels: number;
    maxMessageLength: number;
    chatHistoryLimit: number;
    messageRetentionPerChannel: number;
    maxMessagesPerMinute: number;
  };
  turn: { urls: string[]; secret: string | null; credentialTtlSeconds: number; stunUrls: string[] };
  streaming: { maxViewers: number; maxBitrateKbps: number; monthlyEgressBytes: number; statUrl: string | null; ticketSecret: string | null };
  releases: { githubRepo: string; cacheSeconds: number };
}

const readVersion = (): string => {
  try {
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
};

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => issue.path.join('.') + ': ' + issue.message).join('; ');
    throw new Error('Invalid configuration: ' + details);
  }
  const env = parsed.data;

  if (env.REGISTRATION_MODE === 'invite' && !env.REGISTRATION_INVITE_CODE) {
    throw new Error('REGISTRATION_INVITE_CODE is required when REGISTRATION_MODE=invite');
  }
  if (env.TURN_URLS.length > 0 && !env.TURN_SECRET) {
    throw new Error('TURN_SECRET is required when TURN_URLS is set');
  }

  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    version: readVersion(),
    server: { port: env.PORT, host: env.HOST, trustProxy: env.TRUST_PROXY },
    database: { path: env.DATABASE_PATH },
    storage: { dataDir: env.DATA_DIR ?? (env.DATABASE_PATH === ':memory:' ? './data' : dirname(env.DATABASE_PATH)) },
    cors: { origins: env.CORS_ORIGINS, allowNativeOrigins: env.ALLOW_NATIVE_ORIGINS },
    publicUrls: { rtmp: env.PUBLIC_RTMP_URL, hls: env.PUBLIC_HLS_URL },
    streaming: {
      maxViewers: env.STREAM_MAX_VIEWERS,
      maxBitrateKbps: env.STREAM_MAX_BITRATE_KBPS,
      monthlyEgressBytes: env.STREAM_MONTHLY_EGRESS_GB * 1e9,
      statUrl: env.RTMP_STAT_URL ? env.RTMP_STAT_URL.replace(/[/]+$/, '') : null,
      ticketSecret: env.HLS_TICKET_SECRET,
    },
    registration: {
      mode: env.REGISTRATION_MODE,
      inviteCode: env.REGISTRATION_INVITE_CODE,
      adminEmails: env.ADMIN_EMAILS,
    },
    sessions: { ttlMs: env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000, singlePerAccount: env.SINGLE_SESSION_PER_ACCOUNT },
    security: { passwordMinLength: env.PASSWORD_MIN_LENGTH, maxConnectionsPerIp: env.MAX_CONNECTIONS_PER_IP },
    limits: {
      maxChannels: env.MAX_CHANNELS,
      maxMessageLength: env.MAX_MESSAGE_LENGTH,
      chatHistoryLimit: env.CHAT_HISTORY_LIMIT,
      messageRetentionPerChannel: env.MESSAGE_RETENTION_PER_CHANNEL,
      maxMessagesPerMinute: env.MAX_MESSAGES_PER_MINUTE,
    },
    turn: {
      urls: env.TURN_URLS,
      secret: env.TURN_SECRET,
      credentialTtlSeconds: env.TURN_CREDENTIAL_TTL_SECONDS,
      stunUrls: env.STUN_URLS,
    },
    releases: { githubRepo: env.RELEASES_GITHUB_REPO, cacheSeconds: env.RELEASES_CACHE_SECONDS },
  };
};

/** Load `.env` (if present, outside production) and build the configuration. */
export const loadConfigFromEnvFile = (): AppConfig => {
  if (process.env.NODE_ENV !== 'production') {
    loadDotenv({ path: process.env.DOTENV_PATH ?? '.env', quiet: true });
  }
  return loadConfig(process.env);
};
