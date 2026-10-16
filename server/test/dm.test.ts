import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { channelsPayload } from '../src/socket/payloads.js';
import { makeContext, startTestServer, type TestServer } from './helpers.js';

const subject = (accountId: string, roles: string[] = ['user']) => ({ accountId, roles, isSuperuser: roles.includes('superuser') });

describe('direct messages (service)', () => {
  it('opens one conversation per pair, visible to the two participants only', async () => {
    const ctx = makeContext({ MAX_CHANNELS: '6' });
    const alice = await ctx.accounts.register({ username: 'alice@example.com', password: 'password123', displayName: 'Alice' });
    const bob = await ctx.accounts.register({ username: 'bob@example.com', password: 'password123', displayName: 'Bob' });
    const carol = await ctx.accounts.register({ username: 'carol@example.com', password: 'password123', displayName: 'Carol' });

    // The six default channels fill MAX_CHANNELS, but DMs are exempt.
    expect(() => ctx.channels.create({ name: 'one-more', type: 'text' })).toThrow(/Maximum number/);
    const dm = ctx.channels.openDm(alice.id, bob.id);
    expect(dm).toMatchObject({ type: 'dm', visibility: 'private', groupId: null, joinPasswordHash: null });
    expect(ctx.channels.openDm(bob.id, alice.id).id).toBe(dm.id);
    expect(ctx.channels.findDm(alice.id, carol.id)).toBeNull();
    expect(() => ctx.channels.openDm(alice.id, alice.id)).toThrow(/yourself/);
    expect(ctx.channels.listMemberIds(dm.id).sort()).toEqual([alice.id, bob.id].sort());

    for (const action of ['view', 'chat', 'manage'] as const) {
      expect(ctx.channels.canAccess(dm, subject(alice.id), action)).toBe(true);
      expect(ctx.channels.canAccess(dm, subject(bob.id), action)).toBe(true);
      expect(ctx.channels.canAccess(dm, subject(carol.id, ['admin']), action)).toBe(false);
      expect(ctx.channels.canAccess(dm, subject(carol.id, ['superuser']), action)).toBe(false);
    }

    // DMs are immutable from the admin side.
    expect(() => ctx.channels.addMember(dm.id, carol.id)).toThrow(/fixed members/);
    expect(() => ctx.channels.removeMember(dm.id, bob.id)).toThrow(/fixed members/);
    expect(() => ctx.channels.update(dm.id, { topic: 'x' })).toThrow(/cannot be edited/);

    // Each side sees the other as the peer; nobody else lists it.
    const forAlice = channelsPayload(ctx, subject(alice.id)).channels.find((c) => c.id === dm.id)!;
    expect(forAlice.dm).toEqual({ peerId: bob.id, peerName: 'Bob', peerUsername: 'bob@example.com', peerAvatarUrl: null });
    const forBob = channelsPayload(ctx, subject(bob.id)).channels.find((c) => c.id === dm.id)!;
    expect(forBob.dm?.peerName).toBe('Alice');
    expect(channelsPayload(ctx, subject(carol.id, ['superuser'])).channels.some((c) => c.id === dm.id)).toBe(false);

    ctx.channels.touchActivity(dm.id, 42);
    expect(ctx.channels.get(dm.id)?.lastMessageAt).toBe(42);
    expect(channelsPayload(ctx, subject(alice.id)).channels.find((c) => c.id === dm.id)?.lastMessageAt).toBe(42);
  });
});

const once = <T = unknown>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ' + event)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const waitForEvent = <T>(socket: Socket, event: string, predicate: (payload: T) => boolean, timeoutMs = 3000): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error('timeout waiting for ' + event));
    }, timeoutMs);
    const handler = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });

const client = (url: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });

interface ChannelsUpdate {
  channels: Array<{ id: string; type: string; dm?: { peerName: string } | null }>;
}

describe('direct messages (socket)', () => {
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
    const auth = once<{ account: { id: string } }>(socket, 'auth:success');
    socket.emit('auth:register', { username, password: 'password123', profile: { displayName } });
    return { socket, account: (await auth).account };
  };

  it('runs a conversation through the normal chat pipeline, restricted to the two participants', async () => {
    const admin = await signUp('admin@example.com', 'Admin');
    const bob = await signUp('bob@example.com', 'Bob');
    const carol = await signUp('carol@example.com', 'Carol');

    const opened = once<{ channelId: string; peerName: string }>(bob.socket, 'dm:opened');
    const carolList = waitForEvent<ChannelsUpdate>(carol.socket, 'channels:update', (list) => list.channels.some((c) => c.type === 'dm'));
    bob.socket.emit('dm:open', { accountId: carol.account.id });
    const { channelId, peerName } = await opened;
    expect(peerName).toBe('Carol');
    expect((await carolList).channels.find((c) => c.id === channelId)?.dm?.peerName).toBe('Bob');

    // The admin never sees the conversation.
    const adminError = once<{ code: string }>(admin.socket, 'error');
    admin.socket.emit('channel:join', channelId);
    expect((await adminError).code).toBe('FORBIDDEN');

    const bobJoined = once(bob.socket, 'channel:joined');
    bob.socket.emit('channel:join', channelId);
    await bobJoined;
    const carolSees = once<{ id: string; channelId: string; text: string }>(carol.socket, 'chat');
    const adminSees = once(admin.socket, 'chat', 300);
    bob.socket.emit('chat', 'hey carol');
    const message = await carolSees;
    expect(message).toMatchObject({ channelId, text: 'hey carol' });
    await expect(adminSees).rejects.toThrow('timeout');
    expect(server.ctx.channels.get(channelId)?.lastMessageAt).toEqual(expect.any(Number));

    // Reactions and history work, deletion by an outsider does not, by a participant does.
    const reacted = once<{ reactions: Array<{ count: number }> }>(bob.socket, 'chat:reaction');
    carol.socket.emit('chat:react', { channelId, messageId: message.id, emoji: '❤️' });
    expect((await reacted).reactions[0].count).toBe(1);
    const history = once<Array<{ id: string }>>(carol.socket, 'chat:history');
    carol.socket.emit('channel:join', channelId);
    expect((await history).map((m) => m.id)).toEqual([message.id]);

    const adminDelete = once<{ code: string }>(admin.socket, 'error');
    admin.socket.emit('chat:delete', { channelId, messageId: message.id });
    expect((await adminDelete).code).toBe('FORBIDDEN');
    // Inside a DM the usual rule holds: only the author (there are no moderators here) deletes.
    const carolDelete = once<{ code: string }>(carol.socket, 'error');
    carol.socket.emit('chat:delete', { channelId, messageId: message.id });
    expect((await carolDelete).code).toBe('FORBIDDEN');
    const deleted = once<{ messageId: string }>(carol.socket, 'chat:messageDeleted');
    bob.socket.emit('chat:delete', { channelId, messageId: message.id });
    expect((await deleted).messageId).toBe(message.id);

    // Opening the same conversation again reuses the channel; admin tools refuse it.
    const again = once<{ channelId: string }>(carol.socket, 'dm:opened');
    carol.socket.emit('dm:open', { accountId: bob.account.id });
    expect((await again).channelId).toBe(channelId);
    const refused = once<{ code: string }>(admin.socket, 'error');
    admin.socket.emit('channels:delete', channelId);
    expect((await refused).code).toBe('DM_IMMUTABLE');
    const selfError = once<{ code: string }>(bob.socket, 'error');
    bob.socket.emit('dm:open', { accountId: bob.account.id });
    expect((await selfError).code).toBe('DM_SELF');
    const missing = once<{ code: string }>(bob.socket, 'error');
    bob.socket.emit('dm:open', { accountId: 'acct-nobody' });
    expect((await missing).code).toBe('NOT_FOUND');
  });
});
