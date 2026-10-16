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

  it('hides a closed conversation from that participant only, until they open it again', async () => {
    const ctx = makeContext();
    const alice = await ctx.accounts.register({ username: 'alice@example.com', password: 'password123', displayName: 'Alice' });
    const bob = await ctx.accounts.register({ username: 'bob@example.com', password: 'password123', displayName: 'Bob' });
    const carol = await ctx.accounts.register({ username: 'carol@example.com', password: 'password123', displayName: 'Carol' });
    const dm = ctx.channels.openDm(alice.id, bob.id);
    const listedFor = (accountId: string) => channelsPayload(ctx, subject(accountId)).channels.some((c) => c.id === dm.id);

    ctx.channels.closeDm(dm.id, bob.id);
    expect(ctx.channels.isDmClosed(dm.id, bob.id)).toBe(true);
    expect(ctx.channels.isDmClosed(dm.id, alice.id)).toBe(false);
    expect(listedFor(bob.id)).toBe(false);
    expect(listedFor(alice.id)).toBe(true);
    // Only the list entry is gone: access, membership and the row on disk stay.
    expect(ctx.channels.canAccess(dm, subject(bob.id), 'view')).toBe(true);
    expect(ctx.channels.listMemberIds(dm.id).sort()).toEqual([alice.id, bob.id].sort());
    const row = ctx.db.prepare('SELECT closed_at FROM channel_members WHERE channel_id = ? AND account_id = ?').get(dm.id, bob.id) as { closed_at: number | null };
    expect(row.closed_at).toEqual(expect.any(Number));
    // Closing twice changes nothing.
    ctx.channels.closeDm(dm.id, bob.id);
    expect(ctx.channels.isDmClosed(dm.id, bob.id)).toBe(true);

    // Alice opening the conversation does not bring it back for Bob; Bob opening it does.
    expect(ctx.channels.openDm(alice.id, bob.id).id).toBe(dm.id);
    expect(listedFor(bob.id)).toBe(false);
    expect(ctx.channels.openDm(bob.id, alice.id).id).toBe(dm.id);
    expect(ctx.channels.isDmClosed(dm.id, bob.id)).toBe(false);
    expect(listedFor(bob.id)).toBe(true);

    ctx.channels.closeDm(dm.id, bob.id);
    expect(ctx.channels.reopenDm(dm.id, bob.id)).toBe(true);
    expect(ctx.channels.reopenDm(dm.id, bob.id)).toBe(false);
    expect(ctx.channels.reopenDm(dm.id, carol.id)).toBe(false);
    expect(listedFor(bob.id)).toBe(true);

    // Only the participants, only conversations.
    expect(() => ctx.channels.closeDm(dm.id, carol.id)).toThrow(/participants/);
    expect(ctx.channels.isDmClosed(dm.id, carol.id)).toBe(false);
    const general = ctx.channels.getByName('general')!;
    expect(() => ctx.channels.closeDm(general.id, alice.id)).toThrow(/Only direct messages/);
    expect(() => ctx.channels.closeDm('channel-nope', alice.id)).toThrow(/not found/i);
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

  // Accounts are created directly (the per-IP registration limit is 5 per minute) and signed in over the socket.
  const signUp = async (username: string, displayName: string) => {
    await server.ctx.accounts.register({ username, password: 'password123', displayName });
    const socket = await client(server.url);
    sockets.push(socket);
    const auth = once<{ account: { id: string } }>(socket, 'auth:success');
    socket.emit('auth:login', { username, password: 'password123' });
    return { socket, account: (await auth).account };
  };

  const lists = (socket: Socket, channelId: string) =>
    waitForEvent<ChannelsUpdate>(socket, 'channels:update', (list) => list.channels.some((c) => c.id === channelId));
  const drops = (socket: Socket, channelId: string) =>
    waitForEvent<ChannelsUpdate>(socket, 'channels:update', (list) => !list.channels.some((c) => c.id === channelId));

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

  it('closes a conversation for one side only and brings it back on a new message, dm:open or channel:join', async () => {
    const alice = await signUp('alice@example.com', 'Alice');
    const bob = await signUp('bob@example.com', 'Bob');
    const carol = await signUp('carol@example.com', 'Carol');

    // Alice messages Bob.
    const opened = once<{ channelId: string }>(alice.socket, 'dm:opened');
    alice.socket.emit('dm:open', { accountId: bob.account.id });
    const { channelId } = await opened;
    await lists(bob.socket, channelId);
    const aliceJoined = once(alice.socket, 'channel:joined');
    alice.socket.emit('channel:join', channelId);
    await aliceJoined;
    const bobGotFirst = once<{ id: string }>(bob.socket, 'chat');
    alice.socket.emit('chat', 'hi bob');
    const first = await bobGotFirst;

    // Bob closes it: his list loses it, Alice hears nothing.
    const closed = once<{ channelId: string }>(bob.socket, 'dm:closed');
    const bobDropped = drops(bob.socket, channelId);
    const aliceList = once<ChannelsUpdate>(alice.socket, 'channels:update', 300);
    bob.socket.emit('dm:close', { channelId });
    expect((await closed).channelId).toBe(channelId);
    await bobDropped;
    await expect(aliceList).rejects.toThrow('timeout');
    expect(server.ctx.channels.isDmClosed(channelId, bob.account.id)).toBe(true);
    expect(server.ctx.channels.isDmClosed(channelId, alice.account.id)).toBe(false);
    // A fresh list for Bob leaves it out too; the history is intact.
    const relisted = once<ChannelsUpdate>(bob.socket, 'channels:update');
    bob.socket.emit('channels:list');
    expect((await relisted).channels.some((c) => c.id === channelId)).toBe(false);
    expect(server.ctx.messages.history(channelId).map((m) => m.id)).toEqual([first.id]);

    // Alice's next message brings it back for Bob, message included.
    const bobBack = lists(bob.socket, channelId);
    const bobGotSecond = once<{ text: string; channelId: string }>(bob.socket, 'chat');
    alice.socket.emit('chat', 'you there?');
    expect(await bobGotSecond).toMatchObject({ channelId, text: 'you there?' });
    await bobBack;
    expect(server.ctx.channels.isDmClosed(channelId, bob.account.id)).toBe(false);
    expect(server.ctx.messages.history(channelId)).toHaveLength(2);

    // Closed again; Bob opening the conversation himself reopens it.
    bob.socket.emit('dm:close', { channelId });
    await drops(bob.socket, channelId);
    const reopened = once<{ channelId: string }>(bob.socket, 'dm:opened');
    const bobBackAgain = lists(bob.socket, channelId);
    bob.socket.emit('dm:open', { accountId: alice.account.id });
    expect((await reopened).channelId).toBe(channelId);
    await bobBackAgain;
    expect(server.ctx.channels.isDmClosed(channelId, bob.account.id)).toBe(false);

    // Closed once more; going to it (a search result) reopens it as well.
    bob.socket.emit('dm:close', { channelId });
    await drops(bob.socket, channelId);
    const bobJoined = once(bob.socket, 'channel:joined');
    const bobBackViaJoin = lists(bob.socket, channelId);
    bob.socket.emit('channel:join', channelId);
    await bobJoined;
    await bobBackViaJoin;
    expect(server.ctx.channels.isDmClosed(channelId, bob.account.id)).toBe(false);

    // Outsiders, other channel kinds and unknown channels are refused.
    const carolError = once<{ code: string }>(carol.socket, 'error');
    carol.socket.emit('dm:close', { channelId });
    expect((await carolError).code).toBe('FORBIDDEN');
    const general = server.ctx.channels.getByName('general')!;
    const kindError = once<{ code: string }>(bob.socket, 'error');
    bob.socket.emit('dm:close', { channelId: general.id });
    expect((await kindError).code).toBe('NOT_DM');
    const missingError = once<{ code: string }>(bob.socket, 'error');
    bob.socket.emit('dm:close', { channelId: 'channel-nope' });
    expect((await missingError).code).toBe('NOT_FOUND');
    expect(server.ctx.channels.isDmClosed(channelId, bob.account.id)).toBe(false);
  });
});
