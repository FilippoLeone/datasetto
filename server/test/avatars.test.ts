import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AvatarService, detectAvatarFormat, MAX_AVATAR_BYTES } from '../src/services/avatars.js';
import { startTestServer, type TestServer } from './helpers.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x40, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(64, 2)]);

describe('avatar format sniffing', () => {
  it('recognises PNG and WebP by signature only', () => {
    expect(detectAvatarFormat(PNG)).toBe('png');
    expect(detectAvatarFormat(WEBP)).toBe('webp');
    expect(detectAvatarFormat(Buffer.from('GIF89a'))).toBeNull();
    expect(detectAvatarFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(detectAvatarFormat(Buffer.alloc(0))).toBeNull();
    expect(AvatarService.isLocalUrl('/api/avatars/acct-abc.webp?v=1')).toBe(true);
    expect(AvatarService.isLocalUrl('https://example.com/me.png')).toBe(false);
    expect(AvatarService.isLocalUrl('/api/avatars/../secret.webp')).toBe(false);
  });
});

describe('avatar upload over HTTP', () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.close();
  });

  const signIn = async (username = 'alice@example.com') => {
    const account = await server.ctx.accounts.register({ username, password: 'password123', displayName: 'Alice' });
    const session = server.ctx.sessions.create(account.id);
    return { account, auth: { Authorization: 'Bearer ' + session.token } };
  };

  it('requires a session, a real image and a sane size', async () => {
    const api = request(server.url);
    await api.post('/api/avatars').set('Content-Type', 'image/png').send(PNG).expect(401);
    const { auth } = await signIn();
    const bad = await api.post('/api/avatars').set(auth).set('Content-Type', 'image/png').send(Buffer.from('not an image')).expect(415);
    expect(bad.body.code).toBe('AVATAR_FORMAT');
    await api.post('/api/avatars').set(auth).set('Content-Type', 'text/plain').send('hello').expect(415);
    const huge = Buffer.concat([PNG, Buffer.alloc(MAX_AVATAR_BYTES)]);
    await api.post('/api/avatars').set(auth).set('Content-Type', 'image/png').send(huge).expect(413);
    await api.get('/api/avatars/missing.webp').expect(404);
    await api.get('/api/avatars/..%2F..%2Fpackage.json').expect(404);
  });

  it('stores the file, updates the account, serves it with long caching, and removes it again', async () => {
    const api = request(server.url);
    const { account, auth } = await signIn();

    const uploaded = await api.post('/api/avatars').set(auth).set('Content-Type', 'image/webp').send(WEBP).expect(200);
    expect(uploaded.body.avatarUrl).toMatch(new RegExp('^/api/avatars/' + account.id + '\\.webp\\?v=\\d+$'));
    expect(uploaded.body.account.avatarUrl).toBe(uploaded.body.avatarUrl);
    expect(server.ctx.accounts.getById(account.id)?.avatarUrl).toBe(uploaded.body.avatarUrl);
    const stored = join(server.ctx.avatars.dir, account.id + '.webp');
    expect(readFileSync(stored).equals(WEBP)).toBe(true);

    const served = await api.get(uploaded.body.avatarUrl).expect(200);
    expect(served.headers['content-type']).toBe('image/webp');
    expect(served.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(Buffer.from(served.body as ArrayBuffer).equals(WEBP) || served.text === WEBP.toString()).toBe(true);

    // A PNG replaces the WebP, and only one file remains.
    const replaced = await api.post('/api/avatars').set(auth).set('Content-Type', 'image/png').send(PNG).expect(200);
    expect(replaced.body.avatarUrl).toContain('.png');
    expect(existsSync(stored)).toBe(false);
    expect(existsSync(join(server.ctx.avatars.dir, account.id + '.png'))).toBe(true);

    // Typing an external URL in the profile drops the uploaded file.
    server.ctx.accounts.updateProfile(account.id, { avatarUrl: 'https://example.com/me.png' });
    await api.delete('/api/avatars').set(auth).expect(200);
    expect(existsSync(join(server.ctx.avatars.dir, account.id + '.png'))).toBe(false);
    expect(server.ctx.accounts.getById(account.id)?.avatarUrl).toBeNull();
    expect(server.ctx.avatars.urlFor(account.id)).toBeNull();
  });
});
