import request from 'supertest';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsService } from '../src/services/settings.js';
import { makeContext, startTestServer, type TestServer } from './helpers.js';

describe('SettingsService: permission templates for new channels', () => {
  it('stores per-kind templates, normalises them and applies them to new channels', () => {
    const ctx = makeContext();
    expect(ctx.settings.all()).toEqual({ channelPermissionTemplates: {} });
    expect(ctx.settings.channelPermissionTemplate('stream')).toBeNull();

    const updated = ctx.settings.update(
      { channelPermissionTemplates: { stream: { stream: { roles: ['Streamer', 'admin'] }, view: { roles: ['*'] } }, text: { chat: { roles: ['moderator'] } } } },
      'acct-admin',
    );
    expect(updated.channelPermissionTemplates.stream?.stream.roles).toEqual(['streamer', 'admin']);
    expect(updated.channelPermissionTemplates.stream?.manage.roles).toEqual(['admin']);
    expect(updated.channelPermissionTemplates.text?.chat.roles).toEqual(['moderator']);
    expect(updated.channelPermissionTemplates.voice).toBeUndefined();

    // Survives a reopen (reads from the table), partial updates keep other kinds, null clears one.
    expect(makeContextFromDb(ctx).settings.channelPermissionTemplate('text')?.chat.roles).toEqual(['moderator']);
    const cleared = ctx.settings.update({ channelPermissionTemplates: { text: null } }, 'acct-admin');
    expect(cleared.channelPermissionTemplates.text).toBeUndefined();
    expect(cleared.channelPermissionTemplates.stream?.stream.roles).toEqual(['streamer', 'admin']);
    expect(() => ctx.settings.update({ channelPermissionTemplates: { stream: { stream: 'nope' } } } as never, null)).toThrow();

    // A hand-edited bad row never breaks reads.
    ctx.db.prepare("UPDATE settings SET value = 'not json' WHERE key = 'channelPermissionTemplates'").run();
    expect(ctx.settings.channelPermissionTemplates()).toEqual({});
  });
});

/** Second service instance over the same database. */
const makeContextFromDb = (ctx: ReturnType<typeof makeContext>) => ({ settings: new SettingsService(ctx.db) });

const once = <T = unknown>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ' + event)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const client = (url: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });

describe('view permission is enforced everywhere', () => {
  let server: TestServer;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
    await server.close();
  });

  const signUp = async (username: string, displayName: string) => {
    const socket = await client(server.url);
    sockets.push(socket);
    const auth = once<{ account: { id: string }; session: { token: string } }>(socket, 'auth:success');
    socket.emit('auth:register', { username, password: 'password123', profile: { displayName } });
    const payload = await auth;
    return { socket, account: payload.account, token: payload.session.token };
  };

  it('blocks history, voice, screenshare, tickets and stream keys on channels the user cannot view', async () => {
    const admin = await signUp('admin@example.com', 'Admin');
    const bob = await signUp('bob@example.com', 'Bob');
    const adminOnly = { view: { roles: ['admin'] } };
    const text = server.ctx.channels.create({ name: 'staff-text', type: 'text', permissions: adminOnly });
    const voice = server.ctx.channels.create({ name: 'staff-voice', type: 'voice', permissions: { ...adminOnly, voice: { roles: ['*'] } } });
    const share = server.ctx.channels.create({ name: 'staff-share', type: 'screenshare', permissions: { ...adminOnly, stream: { roles: ['*'] } } });
    const stream = server.ctx.channels.create({ name: 'staff-stream', type: 'stream', permissions: { ...adminOnly, stream: { roles: ['*'] } } });

    const expectError = async (socket: Socket, event: string, payload: unknown, errorEvent = 'error') => {
      const error = once<{ code: string }>(socket, errorEvent);
      socket.emit(event, payload);
      return (await error).code;
    };

    expect(await expectError(bob.socket, 'channel:join', text.id)).toBe('FORBIDDEN');
    // voice: the voice entry says everyone, but Bob cannot view the channel.
    expect(await expectError(bob.socket, 'voice:join', voice.id)).toBe('FORBIDDEN');
    expect(await expectError(bob.socket, 'screenshare:start', { channelId: share.id }, 'screenshare:error')).toBe('FORBIDDEN');
    expect(await expectError(bob.socket, 'screenshare:viewer:join', { channelId: share.id }, 'screenshare:error')).toBe('FORBIDDEN');
    expect(await expectError(bob.socket, 'stream:key:request', { channelId: stream.id }, 'stream:key:error')).toBe('STREAM_KEY_FORBIDDEN');
    expect(await expectError(bob.socket, 'chat:react', { channelId: text.id, messageId: 'msg-x', emoji: '👍' })).toBe('FORBIDDEN');

    const ticket = await request(server.url).post('/api/stream/staff-stream/ticket').set('Authorization', 'Bearer ' + bob.token);
    expect(ticket.status).toBe(403);
    expect(server.ctx.presence.voicePeers(voice.id)).toEqual([]);

    // The admin can do all of it.
    const joined = once(admin.socket, 'voice:joined');
    admin.socket.emit('voice:join', voice.id);
    await joined;
    const key = once<{ streamKey: string }>(admin.socket, 'stream:key:response');
    admin.socket.emit('stream:key:request', { channelId: stream.id });
    expect((await key).streamKey).toContain('staff-stream?key=');

    // Permission updates reach viewers only.
    const bobSees = once(bob.socket, 'channels:permissionsUpdated', 300);
    const adminSees = once<{ channelId: string }>(admin.socket, 'channels:permissionsUpdated');
    admin.socket.emit('admin:channels:updatePermissions', { channelId: text.id, permissions: { chat: { roles: ['admin'] } } });
    expect((await adminSees).channelId).toBe(text.id);
    await expect(bobSees).rejects.toThrow('timeout');

    // Private stream channels are not acknowledged by the public status endpoint.
    server.ctx.channels.update(stream.id, { visibility: 'private' });
    await request(server.url).get('/api/stream/staff-stream/status').expect(404);
    await request(server.url).get('/api/stream/main-stream/status').expect(200);
  });

  it('applies the admin template to new channels of that kind and exposes settings to admins only', async () => {
    const admin = await signUp('admin@example.com', 'Admin');
    const bob = await signUp('bob@example.com', 'Bob');

    const denied = once<{ code: string }>(bob.socket, 'admin:error');
    bob.socket.emit('admin:settings:get');
    expect((await denied).code).toBe('FORBIDDEN');

    const saved = once<{ settings: { channelPermissionTemplates: Record<string, { chat: { roles: string[] } }> }; saved?: boolean }>(admin.socket, 'admin:settings');
    admin.socket.emit('admin:settings:update', { channelPermissionTemplates: { text: { chat: { roles: ['moderator', 'admin'] } } } });
    const result = await saved;
    expect(result.saved).toBe(true);
    expect(result.settings.channelPermissionTemplates.text.chat.roles).toEqual(['moderator', 'admin']);

    const created = once<{ channelId: string }>(admin.socket, 'channels:created');
    admin.socket.emit('channels:create', { name: 'from-template', type: 'text' });
    const { channelId } = await created;
    expect(server.ctx.channels.get(channelId)?.permissions.chat.roles).toEqual(['moderator', 'admin']);
    expect(server.ctx.channels.get(channelId)?.permissions.view.roles).toEqual(['*']);

    // Other kinds keep the server default; explicit permissions override the template.
    const voice = once<{ channelId: string }>(admin.socket, 'channels:created');
    admin.socket.emit('channels:create', { name: 'plain-voice', type: 'voice' });
    expect(server.ctx.channels.get((await voice).channelId)?.permissions.chat.roles).toEqual(['*']);
    const explicit = once<{ channelId: string }>(admin.socket, 'channels:created');
    admin.socket.emit('channels:create', { name: 'explicit', type: 'text', permissions: { chat: { roles: ['admin'] } } });
    expect(server.ctx.channels.get((await explicit).channelId)?.permissions.chat.roles).toEqual(['admin']);

    const fetched = once<{ settings: { channelPermissionTemplates: Record<string, unknown> } }>(admin.socket, 'admin:settings');
    admin.socket.emit('admin:settings:get');
    expect(Object.keys((await fetched).settings.channelPermissionTemplates)).toEqual(['text']);
  });
});
