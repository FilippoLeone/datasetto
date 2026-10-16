import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { extractStreamChannelName, extractStreamKeyToken, formatStreamKey } from '../src/core/ids.js';
import { RateLimiter } from '../src/core/rateLimit.js';
import { highestRole, normalizeRoles, rolesHavePermission } from '../src/core/roles.js';
import { TurnService, expandTurnUrl } from '../src/services/turn.js';
import { makeContext, testEnv } from './helpers.js';

describe('config', () => {
  it('applies defaults and parses lists/booleans', () => {
    const config = loadConfig(testEnv({ CORS_ORIGINS: 'https://a.example, https://b.example/', TRUST_PROXY: 'yes' }));
    expect(config.server.port).toBe(4000);
    expect(config.server.trustProxy).toBe(true);
    expect(config.cors.origins).toEqual(['https://a.example', 'https://b.example/']);
    expect(config.registration.mode).toBe('open');
  });

  it('rejects inconsistent settings', () => {
    expect(() => loadConfig(testEnv({ REGISTRATION_MODE: 'invite' }))).toThrow(/INVITE_CODE/);
    expect(() => loadConfig(testEnv({ TURN_URLS: 'turn:x:3478' }))).toThrow(/TURN_SECRET/);
    expect(() => loadConfig(testEnv({ PORT: '99999' }))).toThrow(/PORT/);
  });
});

describe('stream keys', () => {
  it('extracts tokens from every format OBS users produce', () => {
    const key = formatStreamKey('main-stream', 'AbC123');
    expect(key).toBe('main-stream?key=AbC123');
    expect(extractStreamKeyToken(key)).toBe('AbC123');
    expect(extractStreamKeyToken('main-stream?key=AbC123')).toBe('AbC123');
    expect(extractStreamKeyToken('AbC123')).toBe('AbC123');
    expect(extractStreamKeyToken('')).toBe('');
    expect(extractStreamKeyToken(42)).toBe('');
    expect(extractStreamChannelName('main-stream+AbC123')).toBe('main-stream');
    expect(extractStreamChannelName('main-stream?key=x')).toBe('main-stream');
  });
});

describe('roles', () => {
  it('normalizes and ranks roles', () => {
    expect(normalizeRoles(['Admin', 'bogus', 'admin', 'user'])).toEqual(['admin', 'user']);
    expect(normalizeRoles(undefined)).toEqual(['user']);
    expect(highestRole(['user', 'moderator'])).toBe('moderator');
    expect(rolesHavePermission(['moderator'], 'canDeleteAnyMessage')).toBe(true);
    expect(rolesHavePermission(['moderator'], 'canBanUsers')).toBe(false);
    expect(rolesHavePermission(['admin'], 'canBanUsers')).toBe(true);
  });
});

describe('RateLimiter', () => {
  it('allows up to max hits per window and then blocks until reset', () => {
    const limiter = new RateLimiter(3, 1000, false);
    const now = 1_000_000;
    expect(limiter.hit('k', now).allowed).toBe(true);
    expect(limiter.hit('k', now + 1).allowed).toBe(true);
    expect(limiter.hit('k', now + 2).allowed).toBe(true);
    const blocked = limiter.hit('k', now + 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(limiter.hit('other', now).allowed).toBe(true);
    expect(limiter.hit('k', now + 1001).allowed).toBe(true);
  });
});

describe('TurnService', () => {
  it('returns STUN only when TURN is not configured', () => {
    const ctx = makeContext();
    const ice = ctx.turn.iceConfig();
    expect(ctx.turn.isEnabled()).toBe(false);
    expect(ice.servers).toHaveLength(1);
    expect(ice.ttlSeconds).toBeNull();
  });

  it('issues HMAC credentials coturn can verify', () => {
    const ctx = makeContext({ TURN_URLS: 'turn:turn.example.com:3478', TURN_SECRET: 'shh', TURN_CREDENTIAL_TTL_SECONDS: '600' });
    const now = 1_700_000_000_000;
    const ice = new TurnService(ctx.config.turn).iceConfig(now);
    const turn = ice.servers.find((s) => s.username)!;
    expect(turn.urls).toEqual(['turn:turn.example.com:3478?transport=udp', 'turn:turn.example.com:3478?transport=tcp']);
    const expiry = Math.floor(now / 1000) + 600;
    expect(turn.username).toBe(expiry + ':datasetto');
    expect(turn.credential).toBe(createHmac('sha1', 'shh').update(turn.username!).digest('base64'));
    expect(ice.expiresAt).toBe(expiry * 1000);
    expect(expandTurnUrl('turns:turn.example.com:5349')).toEqual(['turns:turn.example.com:5349']);
    expect(expandTurnUrl('turn.example.com:3478?transport=tcp')).toEqual(['turn:turn.example.com:3478?transport=tcp']);
  });
});

describe('SessionService', () => {
  it('issues, resumes and revokes sessions', async () => {
    const ctx = makeContext();
    const acct = await ctx.accounts.register({ username: 'a@example.com', password: 'password123' });
    const issued = ctx.sessions.create(acct.id, { ip: '127.0.0.1' });
    expect(issued.token.startsWith('sess-')).toBe(true);
    expect(ctx.sessions.resume(issued.token)?.accountId).toBe(acct.id);
    expect(ctx.sessions.resume('sess-garbage')).toBeNull();
    expect(ctx.sessions.resume(123)).toBeNull();
    const other = ctx.sessions.create(acct.id);
    expect(ctx.sessions.revokeAll(acct.id, other.tokenHash)).toBe(1);
    expect(ctx.sessions.resume(issued.token)).toBeNull();
    expect(ctx.sessions.resume(other.token)).not.toBeNull();
    expect(ctx.sessions.revoke(other.token)).toBe(true);
    expect(ctx.sessions.countForAccount(acct.id)).toBe(0);
  });
});
