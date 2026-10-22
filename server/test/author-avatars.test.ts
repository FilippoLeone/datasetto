import request from 'supertest';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MessageRecord } from '../src/types.js';
import { makeContext, startTestServer, type TestServer } from './helpers.js';

const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x40, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(64, 2)]);

describe('messages carry their author\'s current picture', () => {
  const setup = async () => {
    const ctx = makeContext();
    const register = (username: string, displayName: string) => ctx.accounts.register({ username, password: 'password123', displayName });
    const alice = await register('alice@example.com', 'Alice');
    const bob = await register('bob@example.com', 'Bob');
    const general = ctx.channels.getByName('general')!;
    return { ctx, alice, bob, general };
  };

  it('on send, in history, in older pages, by id and in reply quotes, always as the account has it now', async () => {
    const { ctx, alice, bob, general } = await setup();
    ctx.accounts.updateProfile(alice.id, { avatarUrl: '/api/avatars/' + alice.id + '.webp?v=1' });
    const aliceUser = ctx.presence.addUser('s-alice', ctx.accounts.getById(alice.id)!);
    const bobUser = ctx.presence.addUser('s-bob', bob);

    const first = ctx.messages.create(general.id, aliceUser, 'first');
    expect(first.authorAvatarUrl).toBe('/api/avatars/' + alice.id + '.webp?v=1');
    const second = ctx.messages.create(general.id, bobUser, 'second');
    expect(second.authorAvatarUrl).toBeNull();
    const reply = ctx.messages.create(general.id, bobUser, 'a reply', { replyToId: first.id });
    expect(reply.replyTo).toMatchObject({ id: first.id, accountId: alice.id, avatarUrl: '/api/avatars/' + alice.id + '.webp?v=1' });

    // Alice switches to a linked picture, Bob uploads one: old messages show the new ones.
    ctx.accounts.updateProfile(alice.id, { avatarUrl: 'https://pics.example/alice.png' });
    ctx.accounts.updateProfile(bob.id, { avatarUrl: '/api/avatars/' + bob.id + '.webp?v=2' });
    const history = ctx.messages.history(general.id);
    const byId = new Map(history.map((message) => [message.id, message]));
    expect(byId.get(first.id)?.authorAvatarUrl).toBe('https://pics.example/alice.png');
    expect(byId.get(second.id)?.authorAvatarUrl).toBe('/api/avatars/' + bob.id + '.webp?v=2');
    expect(byId.get(reply.id)?.replyTo?.avatarUrl).toBe('https://pics.example/alice.png');
    expect(ctx.messages.get(general.id, first.id)?.authorAvatarUrl).toBe('https://pics.example/alice.png');
    const older = ctx.messages.historyBefore(general.id, reply.id);
    expect(older.messages.map((message) => message.authorAvatarUrl)).toEqual(['https://pics.example/alice.png', '/api/avatars/' + bob.id + '.webp?v=2']);

    // Edits and deletions keep the author's picture (the tombstone still shows who wrote it).
    expect(ctx.messages.edit(general.id, second.id, 'second, edited').authorAvatarUrl).toBe('/api/avatars/' + bob.id + '.webp?v=2');
    expect(ctx.messages.delete(general.id, second.id, 'Bob').authorAvatarUrl).toBe('/api/avatars/' + bob.id + '.webp?v=2');
  });

  it('drops the picture of a deleted account and keeps a disabled account\'s', async () => {
    const { ctx, alice, bob, general } = await setup();
    ctx.accounts.updateProfile(alice.id, { avatarUrl: 'https://pics.example/alice.png' });
    ctx.accounts.updateProfile(bob.id, { avatarUrl: 'https://pics.example/bob.png' });
    const fromAlice = ctx.messages.create(general.id, ctx.presence.addUser('s-alice', ctx.accounts.getById(alice.id)!), 'hi');
    const fromBob = ctx.messages.create(general.id, ctx.presence.addUser('s-bob', ctx.accounts.getById(bob.id)!), 'hey', { replyToId: fromAlice.id });

    ctx.accounts.softDelete(alice.id);
    ctx.accounts.disable(bob.id, 'taking a break');
    const history = new Map(ctx.messages.history(general.id).map((message) => [message.id, message]));
    expect(history.get(fromAlice.id)?.authorAvatarUrl).toBeNull();
    expect(history.get(fromBob.id)?.replyTo?.avatarUrl).toBeNull();
    expect(history.get(fromBob.id)?.authorAvatarUrl).toBe('https://pics.example/bob.png');
  });
});

describe('picture changes reach everyone (user:avatar)', () => {
  let server: TestServer;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.disconnect();
    await server.close();
  });

  const client = (): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = connect(server.url, { transports: ['websocket'], forceNew: true, reconnection: false });
      sockets.push(socket);
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });

  const once = <T,>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for ' + event)), timeoutMs);
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  /** Collect every `user:avatar` a socket receives. */
  const record = (socket: Socket) => {
    const seen: Array<{ accountId: string; avatarUrl: string | null }> = [];
    socket.on('user:avatar', (payload) => seen.push(payload));
    return seen;
  };

  // Accounts are made directly (the registration limiter is shared by every test); sockets sign in with a session.
  const signUp = async (username: string, displayName: string) => {
    const account = await server.ctx.accounts.register({ username, password: 'password123', displayName });
    const socket = await client();
    const session = server.ctx.sessions.create(account.id);
    const auth = once(socket, 'auth:success');
    socket.emit('auth:session', { token: session.token });
    await auth;
    return { socket, account, session };
  };

  const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

  it('announces uploads, removals and linked pictures to every signed-in socket, and nothing when the picture stays', async () => {
    const admin = await signUp('admin@example.com', 'Admin'); // first account: admin
    const alice = await signUp('alice@example.com', 'Alice');
    const bob = await signUp('bob@example.com', 'Bob');
    const anonymous = await client();
    const bobSeen = record(bob.socket);
    const aliceSeen = record(alice.socket);
    const anonymousSeen = record(anonymous);
    const api = request(server.url);
    const auth = { Authorization: 'Bearer ' + alice.session.token };

    const uploaded = await api.post('/api/avatars').set(auth).set('Content-Type', 'image/webp').send(WEBP).expect(200);
    await settle();
    expect(bobSeen).toEqual([{ accountId: alice.account.id, avatarUrl: uploaded.body.avatarUrl }]);
    // Alice's own other devices learn it too (her messages in their lists).
    expect(aliceSeen).toEqual([{ accountId: alice.account.id, avatarUrl: uploaded.body.avatarUrl }]);

    // A profile save that does not touch the picture says nothing.
    const saved = once(alice.socket, 'account:updated');
    alice.socket.emit('account:update', { displayName: 'Alice A.' });
    await saved;
    await settle();
    expect(bobSeen).toHaveLength(1);

    // Switching to a linked picture.
    const linked = once(alice.socket, 'account:updated');
    alice.socket.emit('account:update', { avatarUrl: 'https://pics.example/alice.png' });
    await linked;
    await settle();
    expect(bobSeen[1]).toEqual({ accountId: alice.account.id, avatarUrl: 'https://pics.example/alice.png' });

    // Back to an upload, then removing it.
    await api.post('/api/avatars').set(auth).set('Content-Type', 'image/webp').send(WEBP).expect(200);
    await api.delete('/api/avatars').set(auth).expect(200);
    await settle();
    expect(bobSeen.slice(2).map((entry) => entry.avatarUrl)).toEqual([expect.stringMatching(/^\/api\/avatars\//), null]);

    // An admin deleting Bob's account: everyone's copy of his messages loses the picture.
    const adminSeen = record(admin.socket);
    server.ctx.accounts.updateProfile(bob.account.id, { avatarUrl: 'https://pics.example/bob.png' });
    const deleted = once(admin.socket, 'admin:accounts:deleted');
    admin.socket.emit('admin:accounts:delete', { accountId: bob.account.id });
    await deleted;
    await settle();
    expect(adminSeen).toContainEqual({ accountId: bob.account.id, avatarUrl: null });

    // Sockets that never signed in hear none of it.
    expect(anonymousSeen).toEqual([]);
  });

  it('sends the sender\'s picture with a new message and the current pictures with the history', async () => {
    const alice = await signUp('alice@example.com', 'Alice');
    const bob = await signUp('bob@example.com', 'Bob');
    server.ctx.accounts.updateProfile(alice.account.id, { avatarUrl: 'https://pics.example/alice.png' });
    server.ctx.presence.syncAccount(server.ctx.accounts.getById(alice.account.id)!);
    const general = server.ctx.channels.getByName('general')!;
    for (const { socket } of [alice, bob]) {
      const joined = once(socket, 'channel:joined');
      socket.emit('channel:join', general.id);
      await joined;
    }

    const arrived = once<MessageRecord>(bob.socket, 'chat');
    alice.socket.emit('chat', { channelId: general.id, text: 'look, a picture' });
    expect(await arrived).toMatchObject({ accountId: alice.account.id, authorAvatarUrl: 'https://pics.example/alice.png' });

    server.ctx.accounts.updateProfile(alice.account.id, { avatarUrl: 'https://pics.example/alice-2.png' });
    const history = once<MessageRecord[]>(bob.socket, 'chat:history');
    bob.socket.emit('channel:join', general.id);
    const list = await history;
    expect(list.find((message) => message.text === 'look, a picture')?.authorAvatarUrl).toBe('https://pics.example/alice-2.png');
  });
});
