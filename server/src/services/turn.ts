import { createHmac } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { IceServer } from '../types.js';

export interface IceConfig {
  servers: IceServer[];
  /** Seconds the TURN credential stays valid, or null when TURN is disabled. */
  ttlSeconds: number | null;
  /** Unix ms when the TURN credential expires, or null when TURN is disabled. */
  expiresAt: number | null;
}

/**
 * Builds ICE server lists. TURN credentials are ephemeral HMAC credentials for
 * coturn's `use-auth-secret` mode, so the shared secret never leaves the server
 * and leaked credentials expire on their own.
 */
export class TurnService {
  constructor(private readonly config: AppConfig['turn']) {}

  isEnabled(): boolean {
    return this.config.urls.length > 0 && Boolean(this.config.secret);
  }

  iceConfig(now = Date.now()): IceConfig {
    const servers: IceServer[] = [];
    if (this.config.stunUrls.length > 0) {
      servers.push({ urls: [...this.config.stunUrls] });
    }

    if (!this.isEnabled()) {
      return { servers, ttlSeconds: null, expiresAt: null };
    }

    const ttl = this.config.credentialTtlSeconds;
    const expiry = Math.floor(now / 1000) + ttl;
    const username = expiry + ':datasetto';
    const credential = createHmac('sha1', this.config.secret as string).update(username).digest('base64');

    servers.push({
      urls: this.config.urls.flatMap((url) => expandTurnUrl(url)),
      username,
      credential,
    });

    return { servers, ttlSeconds: ttl, expiresAt: expiry * 1000 };
  }
}

/** `turn:host:3478` becomes UDP and TCP variants so clients behind strict NATs can fall back. */
export const expandTurnUrl = (url: string): string[] => {
  const trimmed = url.trim();
  if (!trimmed) return [];
  const withScheme = /^turns?:/i.test(trimmed) ? trimmed : 'turn:' + trimmed;
  if (/[?&]transport=/i.test(withScheme) || withScheme.toLowerCase().startsWith('turns:')) {
    return [withScheme];
  }
  return [withScheme + '?transport=udp', withScheme + '?transport=tcp'];
};
