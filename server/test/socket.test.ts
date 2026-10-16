import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './helpers.js';

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

describe('Socket protocol', () => {
  let server: TestServer;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
    await server.close();
  });

  const open = async () => {
    const socket = await client(server.url);
    sockets.push(socket);
    return socket;
  };

  it('registers, joins a channel, chats and resumes the session', async () => {
    const alice = await open();
    const success = once<{ account: { roles: string[] }; session: { token: string }; channels: unknown[]; isNewAccount: boolean }>(alice, 'auth:success');
    alice.emit('auth:register', { username: 'alice@example.com', password: 'password123', profile: { displayName: 'Alice' } });
    const auth = await success;
    expect(auth.account.roles).toEqual(['admin']);
    expect(auth.isNewAccount).toBe(true);
    expect(auth.channels.length).toBe(6);

    const general = server.ctx.channels.getByName('general')!;
    const joined = once<{ channelId: string }>(alice, 'channel:joined');
    const history = once<unknown[]>(alice, 'chat:history');
    alice.emit('channel:join', general.id);
    expect((await joined).channelId).toBe(general.id);
    expect(await history).toEqual([]);

    const message = once<{ text: string; from: string }>(alice, 'chat');
    alice.emit('chat', 'hello world');
    expect(await message).toMatchObject({ text: 'hello world', from: 'Alice' });
    expect(server.ctx.messages.count(general.id)).toBe(1);

    // A second connection resumes with the token and sees history.
    const again = await open();
    const resumed = once<{ account: { username: string } }>(again, 'auth:success');
    again.emit('auth:session', { token: auth.session.token });
    expect((await resumed).account.username).toBe('alice@example.com');
    const history2 = once<unknown[]>(again, 'chat:history');
    again.emit('channel:join', general.id);
    expect(await history2).toHaveLength(1);
  });

  it('delivers chat to everyone who can view the channel, not only to sockets inside it', async () => {
    const alice = await open();
    const aliceAuth = once(alice, 'auth:success');
    alice.emit('auth:register', { username: 'alice@example.com', password: 'password123', profile: { displayName: 'Alice' } });
    await aliceAuth;
    const bob = await open();
    const bobAuth = once(bob, 'auth:success');
    bob.emit('auth:register', { username: 'bob@example.com', password: 'password123', profile: { displayName: 'Bob' } });
    await bobAuth;

    const general = server.ctx.channels.getByName('general')!;
    const announcements = server.ctx.channels.getByName('announcements')!;
    const aliceJoined = once(alice, 'channel:joined');
    alice.emit('channel:join', general.id);
    await aliceJoined;
    const bobJoined = once(bob, 'channel:joined');
    bob.emit('channel:join', announcements.id);
    await bobJoined;

    // Bob is viewing #announcements but still receives #general traffic (unread badges, mentions).
    const bobSees = once<{ channelId: string; text: string; id: string }>(bob, 'chat');
    alice.emit('chat', 'ping from general');
    const delivered = await bobSees;
    expect(delivered).toMatchObject({ channelId: general.id, text: 'ping from general' });

    const bobSeesDelete = once<{ channelId: string; messageId: string }>(bob, 'chat:messageDeleted');
    alice.emit('chat:delete', { messageId: delivered.id, channelId: general.id });
    expect(await bobSeesDelete).toMatchObject({ channelId: general.id, messageId: delivered.id });

    // Unauthenticated sockets never get chat.
    const stranger = await open();
    const strangerSees = once(stranger, 'chat', 300);
    alice.emit('chat', 'second');
    await expect(strangerSees).rejects.toThrow('timeout');
  });

  it('rejects unauthenticated actions, bad tokens and wrong passwords', async () => {
    const socket = await open();
    const error = once<{ code: string }>(socket, 'error');
    socket.emit('chat', 'hi');
    expect((await error).code).toBe('NOT_AUTHENTICATED');

    const sessionError = once<{ code: string }>(socket, 'auth:error');
    socket.emit('auth:session', { token: 'sess-bogus' });
    expect((await sessionError).code).toBe('SESSION_FAILED');

    await server.ctx.accounts.register({ username: 'bob@example.com', password: 'password123' });
    const loginError = once<{ code: string; message: string }>(socket, 'auth:error');
    socket.emit('auth:login', { username: 'bob@example.com', password: 'wrong-pass' });
    expect((await loginError).code).toBe('INVALID_CREDENTIALS');
  });

  it('enforces permissions and relays voice signaling only within a room', async () => {
    const admin = await open();
    const adminAuth = once(admin, 'auth:success');
    admin.emit('auth:register', { username: 'admin@example.com', password: 'password123' });
    await adminAuth;

    const bob = await open();
    const bobAuth = once(bob, 'auth:success');
    bob.emit('auth:register', { username: 'bob@example.com', password: 'password123' });
    await bobAuth;

    const denied = once<{ code: string }>(bob, 'error');
    bob.emit('channels:create', { name: 'bobs-room', type: 'text' });
    expect((await denied).code).toBe('FORBIDDEN');

    const createdList = once<{ channels: { name: string }[] }>(admin, 'channels:update');
    admin.emit('channels:create', { name: 'planning', type: 'text' });
    expect((await createdList).channels.some((c) => c.name === 'planning')).toBe(true);

    const lobby = server.ctx.channels.getByName('lobby')!;
    const adminJoined = once<{ peers: unknown[] }>(admin, 'voice:joined');
    admin.emit('voice:join', lobby.id);
    expect((await adminJoined).peers).toEqual([]);

    const peerJoin = once<{ name: string }>(admin, 'voice:peer-join');
    const bobJoined = once<{ peers: { id: string }[] }>(bob, 'voice:joined');
    bob.emit('voice:join', lobby.id);
    expect((await peerJoin).name).toBe('bob');
    const peers = (await bobJoined).peers;
    expect(peers).toHaveLength(1);

    const signal = once<{ from: string; data: { sdp: string } }>(admin, 'voice:signal');
    bob.emit('voice:signal', { to: peers[0].id, data: { sdp: 'offer' } });
    expect((await signal).data.sdp).toBe('offer');

    const kicked = once<{ by: string }>(bob, 'voice:kicked');
    admin.emit('voice:kick', { targetSocketId: bob.id, targetName: 'bob' });
    expect((await kicked).by).toBe('admin');
    expect(server.ctx.presence.voicePeers(lobby.id)).toHaveLength(1);

    const banned = once<{ reason: string }>(bob, 'user:banned');
    admin.emit('user:ban', { targetSocketId: bob.id, targetName: 'bob', reason: 'testing' });
    expect((await banned).reason).toBe('testing');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.ctx.moderation.listBans()).toHaveLength(1);
    expect(server.ctx.presence.onlineCount()).toBe(1);
  });
});
