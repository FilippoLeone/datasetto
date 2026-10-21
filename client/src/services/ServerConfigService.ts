/**
 * Runtime configuration fetched from the server (`GET /api/config`).
 *
 * The server owns everything that can change without a client rebuild: TURN
 * credentials (short-lived HMAC tokens), the public RTMP ingest URL, and
 * whether registration needs an invite code. The client falls back to its
 * build-time configuration when the request fails, so the app still loads
 * when the API is briefly unavailable.
 */
import { config as buildConfig } from '@/config';

export interface ServerIceConfig {
  servers: RTCIceServer[];
  ttlSeconds: number | null;
  expiresAt: number | null;
}

export interface ServerConfig {
  version: string;
  serverTime: number;
  registration: { mode: 'open' | 'invite' | 'closed'; requiresInvite: boolean; acceptsInviteLinks: boolean };
  urls: { rtmp: string | null; hls: string | null };
  ice: ServerIceConfig;
  limits: { maxMessageLength: number; passwordMinLength: number; chatHistoryLimit: number };
  /** Web Push: off without VAPID keys on the server; `publicKey` is what browsers subscribe with. */
  push: { enabled: boolean; publicKey: string | null };
  /** Pictures in chat: size per file, files per message, accepted MIME types; videos (posted clips) have their own cap and types. */
  uploads: { maxBytes: number; maxFilesPerMessage: number; acceptedTypes: string[]; videoMaxBytes: number; videoTypes: string[] };
  linkPreviews: { enabled: boolean };
}

export const DEFAULT_UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const DEFAULT_VIDEO_TYPES = ['video/webm'];
const DEFAULT_UPLOAD_LIMITS: ServerConfig['uploads'] = { maxBytes: 10 * 1024 * 1024, maxFilesPerMessage: 10, acceptedTypes: DEFAULT_UPLOAD_TYPES, videoMaxBytes: 50 * 1024 * 1024, videoTypes: DEFAULT_VIDEO_TYPES };

const DEFAULT_STUN: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const FETCH_TIMEOUT_MS = 4000;
/** Refresh TURN credentials this long before they expire. */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

const splitList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

const ensureTurnScheme = (url: string): string => (/^turns?:/i.test(url) ? url : `turn:${url}`);

/** ICE servers from build-time env, used when the server does not provide any. */
const buildTimeIceServers = (): RTCIceServer[] => {
  const custom = buildConfig.WEBRTC_ICE_SERVERS;
  if (custom) {
    try {
      const parsed = JSON.parse(custom);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as RTCIceServer[];
    } catch (error) {
      console.warn('[ServerConfig] Invalid VITE_WEBRTC_ICE_SERVERS, ignoring', error);
    }
  }
  const servers = [...DEFAULT_STUN];
  const turnUrls = splitList(buildConfig.TURN_URL);
  if (turnUrls.length > 0) {
    servers.push({
      urls: turnUrls.map(ensureTurnScheme),
      username: buildConfig.TURN_USERNAME || undefined,
      credential: buildConfig.TURN_CREDENTIAL || undefined,
    });
  }
  return servers;
};

const isTurn = (server: RTCIceServer): boolean => {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  return urls.some((url) => typeof url === 'string' && /^turns?:/i.test(url));
};

class ServerConfigService {
  private current: ServerConfig | null = null;
  private apiBaseUrl = '';
  private inflight: Promise<ServerConfig | null> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private iceRefresher: (() => void) | null = null;

  /** TURN credentials come from the socket (auth:success / turn:credentials); the public config carries STUN only. */
  applyIce(ice: Partial<ServerIceConfig> | null | undefined): void {
    if (!ice || !Array.isArray(ice.servers) || ice.servers.length === 0) return;
    const base = this.current ?? this.normalize({});
    this.current = {
      ...base,
      ice: {
        servers: ice.servers as RTCIceServer[],
        ttlSeconds: typeof ice.ttlSeconds === 'number' ? ice.ttlSeconds : null,
        expiresAt: typeof ice.expiresAt === 'number' ? ice.expiresAt : null,
      },
    };
    this.scheduleRefresh();
  }

  /** How to ask for fresh TURN credentials (set by the socket bindings once signed in). */
  setIceRefresher(fn: (() => void) | null): void {
    this.iceRefresher = fn;
  }

  /** Fetch once at boot. Never throws; returns null when the server is unreachable. */
  async load(apiBaseUrl: string): Promise<ServerConfig | null> {
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, '');
    return this.refresh();
  }

  async refresh(): Promise<ServerConfig | null> {
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchConfig().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  get(): ServerConfig | null {
    return this.current;
  }

  /** Mode advertised by the server; `open` when unknown so the form still works. */
  registrationMode(): 'open' | 'invite' | 'closed' {
    return this.current?.registration.mode ?? 'open';
  }

  rtmpUrl(): string | null {
    return this.current?.urls.rtmp ?? null;
  }

  pushEnabled(): boolean {
    return this.current?.push.enabled === true && typeof this.current.push.publicKey === 'string';
  }

  pushPublicKey(): string | null {
    return this.pushEnabled() ? this.current!.push.publicKey : null;
  }

  /** ICE servers to use right now. Triggers a background refresh when TURN credentials are stale. */
  iceServers(): RTCIceServer[] {
    const ice = this.current?.ice;
    if (!ice || ice.servers.length === 0) return buildTimeIceServers();
    if (ice.expiresAt && ice.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
      this.requestFreshIce();
    }
    return ice.servers.map((server) => ({ ...server }));
  }

  turnConfigured(): boolean {
    return this.iceServers().some(isTurn);
  }

  private async fetchConfig(): Promise<ServerConfig | null> {
    const url = `${this.apiBaseUrl}/api/config`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal, credentials: 'include', cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as Partial<ServerConfig>;
      this.current = this.normalize(data);
      this.scheduleRefresh();
      return this.current;
    } catch (error) {
      console.warn('[ServerConfig] Could not load runtime config, using build-time defaults:', error);
      return this.current;
    } finally {
      clearTimeout(timer);
    }
  }

  private normalize(data: Partial<ServerConfig>): ServerConfig {
    const mode = data.registration?.mode;
    const ice = data.ice;
    return {
      version: typeof data.version === 'string' ? data.version : 'unknown',
      serverTime: typeof data.serverTime === 'number' ? data.serverTime : Date.now(),
      registration: {
        mode: mode === 'invite' || mode === 'closed' ? mode : 'open',
        requiresInvite: mode === 'invite',
        acceptsInviteLinks: mode !== 'closed',
      },
      urls: {
        rtmp: typeof data.urls?.rtmp === 'string' && data.urls.rtmp ? data.urls.rtmp : null,
        hls: typeof data.urls?.hls === 'string' && data.urls.hls ? data.urls.hls : null,
      },
      ice: {
        servers: Array.isArray(ice?.servers) ? (ice!.servers as RTCIceServer[]) : [],
        ttlSeconds: typeof ice?.ttlSeconds === 'number' ? ice.ttlSeconds : null,
        expiresAt: typeof ice?.expiresAt === 'number' ? ice.expiresAt : null,
      },
      limits: {
        maxMessageLength: typeof data.limits?.maxMessageLength === 'number' ? data.limits.maxMessageLength : 2000,
        passwordMinLength: typeof data.limits?.passwordMinLength === 'number' ? data.limits.passwordMinLength : 8,
        chatHistoryLimit: typeof data.limits?.chatHistoryLimit === 'number' ? data.limits.chatHistoryLimit : 100,
      },
      push: {
        enabled: data.push?.enabled === true && typeof data.push.publicKey === 'string' && data.push.publicKey.length > 0,
        publicKey: typeof data.push?.publicKey === 'string' && data.push.publicKey ? data.push.publicKey : null,
      },
      uploads: {
        maxBytes: typeof data.uploads?.maxBytes === 'number' ? data.uploads.maxBytes : DEFAULT_UPLOAD_LIMITS.maxBytes,
        maxFilesPerMessage: typeof data.uploads?.maxFilesPerMessage === 'number' ? data.uploads.maxFilesPerMessage : DEFAULT_UPLOAD_LIMITS.maxFilesPerMessage,
        acceptedTypes: Array.isArray(data.uploads?.acceptedTypes) && data.uploads.acceptedTypes.length > 0 ? data.uploads.acceptedTypes.filter((t): t is string => typeof t === 'string') : DEFAULT_UPLOAD_TYPES,
        videoMaxBytes: typeof data.uploads?.videoMaxBytes === 'number' ? data.uploads.videoMaxBytes : DEFAULT_UPLOAD_LIMITS.videoMaxBytes,
        videoTypes: Array.isArray(data.uploads?.videoTypes) && data.uploads.videoTypes.length > 0 ? data.uploads.videoTypes.filter((t): t is string => typeof t === 'string') : DEFAULT_VIDEO_TYPES,
      },
      linkPreviews: { enabled: data.linkPreviews?.enabled !== false },
    };
  }

  /** Limits for pictures and videos in chat (server values once loaded, defaults before). */
  uploadLimits(): ServerConfig['uploads'] {
    return this.current?.uploads ?? DEFAULT_UPLOAD_LIMITS;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const expiresAt = this.current?.ice.expiresAt;
    if (!expiresAt) return;
    const delay = Math.max(60_000, expiresAt - Date.now() - REFRESH_MARGIN_MS);
    this.refreshTimer = setTimeout(() => this.requestFreshIce(), Math.min(delay, 2 ** 31 - 1));
  }

  private requestFreshIce(): void {
    if (this.iceRefresher) this.iceRefresher();
    else void this.refresh();
  }
}

export const serverConfig = new ServerConfigService();
