import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emojiSchema } from '../src/core/validation.js';
import { MAX_REACTIONS_PER_ACCOUNT, MAX_REACTIONS_PER_MESSAGE } from '../src/services/messages.js';
import { makeContext, startTestServer, type TestServer } from './helpers.js';

describe('emoji validation', () => {
  it('accepts emoji with modifiers and joiners, rejects text', () => {
    for (const ok of ['👍', '🔥', '❤️', '👍🏽', '👨‍👩‍👧', '🇳🇱', '1️⃣', '  😀 ']) expect(() => emojiSchema.parse(ok)).not.toThrow();
    for (const bad of ['', 'a', ':)', '👍 nice', 'x'.repeat(20), '<script>']) expect(() => emojiSchema.parse(bad)).toThrow();
  });
});

describe('MessageService reactions', () => {
  const setup = async () => {
    const ctx = makeContext();
    const alice = await ctx.accounts.register({ username: 'alice@example.com', password: 'password123', displayName: 'Alice' });
    const bob = await ctx.accounts.register({ username: 'bob@example.com', password: 'password123', displayName: 'Bob' });
    const author = ctx.presence.addUser('sock-1', alice);
    const channel = ctx.channels.getByName('general')!;
    const message = ctx.messages.create(channel.id, author, 'react to me');
    return { ctx, alice, bob, channel, message };
  };

  it('adds and removes reactions idempotently and summarises who reacted', async () => {
    const { ctx, alice, bob, channel, message } = await setup();
    expect(ctx.messages.addReaction(channel.id, message.id, alice.id, '👍')).toEqual([{ emoji: '👍', count: 1, accountIds: [alice.id], names: ['Alice'] }]);
    ctx.messages.addReaction(channel.id, message.id, alice.id, '👍');
    const both = ctx.messages.addReaction(channel.id, message.id, bob.id, '👍');
    expect(both).toEqual([{ emoji: '👍', count: 2, accountIds: [alice.id, bob.id], names: ['Alice', 'Bob'] }]);
    ctx.messages.addReaction(channel.id, message.id, bob.id, '🔥');
    expect(ctx.messages.history(channel.id)[0].reactions.map((r) => [r.emoji, r.count])).toEqual([
      ['👍', 2],
      ['🔥', 1],
    ]);
    expect(ctx.messages.get(channel.id, message.id)?.reactions).toHaveLength(2);

    expect(ctx.messages.removeReaction(channel.id, message.id, alice.id, '👍').map((r) => r.count)).toEqual([1, 1]);
    expect(ctx.messages.removeReaction(channel.id, message.id, alice.id, '👍').map((r) => r.count)).toEqual([1, 1]);
    expect(ctx.messages.removeReaction(channel.id, message.id, bob.id, '👍').map((r) => r.emoji)).toEqual(['🔥']);

    expect(() => ctx.messages.addReaction(channel.id, message.id, alice.id, 'nope')).toThrow(/emoji/);
    expect(() => ctx.messages.addReaction(channel.id, 'msg-missing', alice.id, '👍')).toThrow(/not found/);
    expect(() => ctx.messages.addReaction(ctx.channels.getByName('announcements')!.id, message.id, alice.id, '👍')).toThrow(/not found/);
  });

  it('caps reactions per message and per account, and drops them with the message', async () => {
    const { ctx, alice, bob, channel, message } = await setup();
    const emojis = ['😀', '😂', '🤣', '😊', '😍', '🥰', '😎', '🤔', '😅', '😭', '😡', '🥳', '🤯', '😴', '🙃', '😬', '👍', '👎', '👏', '🙌', '🙏', '🤝'];
    for (const emoji of emojis.slice(0, MAX_REACTIONS_PER_ACCOUNT)) ctx.messages.addReaction(channel.id, message.id, alice.id, emoji);
    expect(() => ctx.messages.addReaction(channel.id, message.id, alice.id, '🚀')).toThrow(/enough times/);
    for (const emoji of emojis.slice(MAX_REACTIONS_PER_ACCOUNT, MAX_REACTIONS_PER_MESSAGE)) ctx.messages.addReaction(channel.id, message.id, bob.id, emoji);
    expect(ctx.messages.reactions(message.id)).toHaveLength(MAX_REACTIONS_PER_MESSAGE);
    const carol = await ctx.accounts.register({ username: 'carol@example.com', password: 'password123', displayName: 'Carol' });
    expect(() => ctx.messages.addReaction(channel.id, message.id, carol.id, '🚀')).toThrow(/maximum number/);
    // Joining an existing emoji is still fine at the cap.
    expect(ctx.messages.addReaction(channel.id, message.id, carol.id, '😀').find((r) => r.emoji === '😀')?.count).toBe(2);

    ctx.messages.delete(channel.id, message.id, 'Alice');
    expect(() => ctx.messages.addReaction(channel.id, message.id, carol.id, '😀')).toThrow(/not found/);
    expect(ctx.messages.history(channel.id)).toEqual([]);
    ctx.messages.prune(channel.id);
    const second = ctx.messages.create(channel.id, ctx.presence.getUser('sock-1')!, 'second');
    ctx.messages.addReaction(channel.id, second.id, bob.id, '👍');
    ctx.db.prepare('DELETE FROM messages WHERE id = ?').run(second.id);
    // Alice 10 + Bob 10 + Carol 1 stay on the soft-deleted message; the hard-deleted one took its reaction along.
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM message_reactions').get() as { n: number }).n).toBe(MAX_REACTIONS_PER_ACCOUNT * 2 + 1);
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

const client = (url: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });

interface ReactionEvent {
  channelId: string;
  messageId: string;
  emoji: string;
  accountId: string;
  displayName: string;
  added: boolean;
  reactions: Array<{ emoji: string; count: number; names: string[] }>;
}

describe('reactions over the socket', () => {
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

  it('broadcasts reactions to everyone who can see the channel and includes them in history', async () => {
    const alice = await signUp('alice@example.com', 'Alice');
    const bob = await signUp('bob@example.com', 'Bob');
    const general = server.ctx.channels.getByName('general')!;
    const joined = once(alice.socket, 'channel:joined');
    alice.socket.emit('channel:join', general.id);
    await joined;
    const sent = once<{ id: string }>(alice.socket, 'chat');
    alice.socket.emit('chat', 'hello');
    const message = await sent;

    // Bob is not even in the channel but can view it, so he gets the reaction event.
    const bobSees = once<ReactionEvent>(bob.socket, 'chat:reaction');
    const aliceSees = once<ReactionEvent>(alice.socket, 'chat:reaction');
    bob.socket.emit('chat:react', { channelId: general.id, messageId: message.id, emoji: '🔥' });
    const event = await bobSees;
    expect(event).toMatchObject({ channelId: general.id, messageId: message.id, emoji: '🔥', displayName: 'Bob', added: true });
    expect(event.reactions).toEqual([{ emoji: '🔥', count: 1, accountIds: [bob.account.id], names: ['Bob'] }]);
    expect((await aliceSees).reactions[0].count).toBe(1);

    const history = once<Array<{ id: string; reactions: unknown[] }>>(bob.socket, 'chat:history');
    bob.socket.emit('channel:join', general.id);
    expect((await history).find((m) => m.id === message.id)?.reactions).toHaveLength(1);

    const removed = once<ReactionEvent>(alice.socket, 'chat:reaction');
    bob.socket.emit('chat:unreact', { channelId: general.id, messageId: message.id, emoji: '🔥' });
    expect(await removed).toMatchObject({ added: false, reactions: [] });

    const invalid = once<{ code: string }>(bob.socket, 'error');
    bob.socket.emit('chat:react', { channelId: general.id, messageId: message.id, emoji: 'lol' });
    expect((await invalid).code).toBe('VALIDATION_FAILED');
  });

  it('refuses reactions in channels the user cannot see', async () => {
    const admin = await signUp('admin@example.com', 'Admin');
    const bob = await signUp('bob@example.com', 'Bob');
    const staff = server.ctx.channels.create({ name: 'staff', type: 'text', permissions: { view: { roles: ['admin'] } } });
    const joined = once(admin.socket, 'channel:joined');
    admin.socket.emit('channel:join', staff.id);
    await joined;
    const sent = once<{ id: string }>(admin.socket, 'chat');
    admin.socket.emit('chat', 'private note');
    const message = await sent;

    const denied = once<{ code: string }>(bob.socket, 'error');
    const adminSees = once(admin.socket, 'chat:reaction', 300);
    bob.socket.emit('chat:react', { channelId: staff.id, messageId: message.id, emoji: '👀' });
    expect((await denied).code).toBe('FORBIDDEN');
    await expect(adminSees).rejects.toThrow('timeout');
    expect(server.ctx.messages.reactions(message.id)).toEqual([]);
  });
});
