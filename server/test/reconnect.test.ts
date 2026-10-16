import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { createShutdown } from '../src/shutdown.js';
import { startTestServer, waitFor, type TestServer } from './helpers.js';

const once = <T = unknown>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ' + event)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const never = (socket: Socket, event: string, ms = 400) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    socket.once(event, (payload: unknown) => {
      clearTimeout(timer);
      reject(new Error('unexpected ' + event + ': ' + JSON.stringify(payload)));
    });
  });

const client = (url: string, options: Record<string, unknown> = {}): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false, ...options });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });

interface AuthSuccess {
  session: { token: string };
  account: { id: string };
}

describe('reconnecting after a restart', () => {
  let server: TestServer | null = null;
  let dir: string | null = null;
  const sockets: Socket[] = [];

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
    await server?.close();
    server = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  const open = async (options: Record<string, unknown> = {}) => {
    const socket = await client(server!.url, options);
    sockets.push(socket);
    return socket;
  };

  it('resumes the same token on the new process without counting as a new login', async () => {
    dir = mkdtempSync(join(tmpdir(), 'datasetto-restart-'));
    const file = join(dir, 'datasetto.db');
    server = await startTestServer({}, {}, { db: openDatabase(file) });
    const port = server.port;

    // Alice is signed in on a client that reconnects by itself (like the app does), Bob on another.
    const alice = await open({ reconnection: true, reconnectionDelay: 50, reconnectionDelayMax: 200 });
    const aliceAuth = once<AuthSuccess>(alice, 'auth:success');
    alice.emit('auth:register', { username: 'alice@example.com', password: 'password123' });
    const { session, account } = await aliceAuth;
    const bob = await open();
    const bobAuth = once(bob, 'auth:success');
    bob.emit('auth:register', { username: 'bob@example.com', password: 'password123' });
    await bobAuth;
    expect(server.ctx.sessions.countForAccount(account.id)).toBe(1);

    // The deploy: SIGTERM, the process says goodbye and exits; a new one starts on the same database.
    const exit = vi.fn();
    const restarting = once<{ expectedWaitMs: number }>(alice, 'server:restarting');
    const dropped = once<string>(alice, 'disconnect');
    const shutdown = createShutdown({ ctx: server.ctx, io: server.sockets.io, server: server.server, exit, noticeMs: 50, lingerMs: 100 });
    await shutdown('SIGTERM');
    expect((await restarting).expectedWaitMs).toBe(10_000);
    await dropped;
    expect(exit).toHaveBeenCalledWith(0);
    const old = server;
    server = await startTestServer({}, {}, { db: openDatabase(file), port });
    await old.close();
    expect(server.port).toBe(port);

    // Alice's client reconnects and re-presents the stored token: same login, nothing revoked.
    await waitFor(() => alice.connected, 5000);
    const noError = never(alice, 'auth:error', 500);
    const resumed = once<AuthSuccess>(alice, 'auth:success');
    alice.emit('auth:session', { token: session.token });
    const again = await resumed;
    expect(again.session.token).toBe(session.token);
    expect(again.account.id).toBe(account.id);
    await noError;
    expect(server.ctx.sessions.countForAccount(account.id)).toBe(1);
    expect(server.ctx.presence.getSocketsByAccount(account.id)).toEqual([alice.id]);

    // A second tab of the same browser (same token) joining during the wave stays, like before the restart.
    const tab = await open();
    const tabAuth = once(tab, 'auth:success');
    const aliceStays = never(alice, 'auth:error', 300);
    tab.emit('auth:session', { token: session.token });
    await tabAuth;
    await aliceStays;
    expect(server.ctx.presence.getSocketsByAccount(account.id).sort()).toEqual([alice.id, tab.id].sort());
    expect(server.ctx.sessions.countForAccount(account.id)).toBe(1);

    // A password sign-in from elsewhere is still another login and still ends this one.
    const phone = await open();
    const replaced = once<{ code: string }>(alice, 'auth:error');
    const phoneAuth = once(phone, 'auth:success');
    phone.emit('auth:login', { username: 'alice@example.com', password: 'password123' });
    await phoneAuth;
    expect((await replaced).code).toBe('SIGNED_IN_ELSEWHERE');
  });

  it('lets a reconnecting socket take over its own voice seat and tells peers it was replaced, not gone', async () => {
    server = await startTestServer();
    const lobby = server.ctx.channels.getByName('lobby')!;
    const alice = await open();
    const aliceAuth = once<AuthSuccess>(alice, 'auth:success');
    alice.emit('auth:register', { username: 'alice@example.com', password: 'password123', profile: { displayName: 'Alice' } });
    const { session, account } = await aliceAuth;
    const bob = await open();
    const bobAuth = once<AuthSuccess>(bob, 'auth:success');
    bob.emit('auth:register', { username: 'bob@example.com', password: 'password123', profile: { displayName: 'Bob' } });
    const bobAccount = (await bobAuth).account;

    const bobJoined = once(bob, 'voice:joined');
    bob.emit('voice:join', { channelId: lobby.id, rtcSessionId: 'bob-rtc-1' });
    await bobJoined;
    const seen = once<{ id: string; accountId: string; rtcSessionId: string | null }>(bob, 'voice:peer-join');
    const aliceJoined = once<{ peers: { id: string; accountId: string; rtcSessionId: string | null; name: string }[] }>(alice, 'voice:joined');
    alice.emit('voice:join', { channelId: lobby.id, rtcSessionId: 'alice-rtc-1' });
    expect((await aliceJoined).peers).toEqual([{ id: bob.id, accountId: bobAccount.id, name: 'Bob', muted: false, deafened: false, rtcSessionId: 'bob-rtc-1' }]);
    expect(await seen).toMatchObject({ id: alice.id, accountId: account.id, rtcSessionId: 'alice-rtc-1' });

    // Alice's connection drops without the server noticing yet (no disconnect: the old socket stays).
    // Her new socket resumes the token and rejoins with the same media session id.
    const next = await open();
    const nextAuth = once(next, 'auth:success');
    next.emit('auth:session', { token: session.token });
    await nextAuth;
    const replaced = once<{ id: string; accountId: string; reason: string }>(bob, 'voice:peer-leave');
    const rejoinedSeen = once<{ id: string; accountId: string; rtcSessionId: string | null; holding?: unknown }>(bob, 'voice:peer-join');
    const oldTold = once<{ channelId: string; bySocketId: string }>(alice, 'voice:replaced');
    const nextJoined = once<{ peers: { id: string }[] }>(next, 'voice:joined');
    next.emit('voice:join', { channelId: lobby.id, rtcSessionId: 'alice-rtc-1', holding: [{ accountId: bobAccount.id, rtcSessionId: 'bob-rtc-1' }] });
    expect(await replaced).toEqual({ id: alice.id, accountId: account.id, reason: 'replaced' });
    // Bob learns that Alice still holds her connection to him, so he keeps his side.
    expect(await rejoinedSeen).toMatchObject({ id: next.id, accountId: account.id, rtcSessionId: 'alice-rtc-1', holding: [{ accountId: bobAccount.id, rtcSessionId: 'bob-rtc-1' }] });
    expect(await oldTold).toEqual({ channelId: lobby.id, bySocketId: next.id });
    // The new socket sees Bob only: its own stale seat is not a peer.
    expect((await nextJoined).peers.map((peer) => peer.id)).toEqual([bob.id]);
    expect(server.ctx.presence.voicePeers(lobby.id).map((peer) => peer.id).sort()).toEqual([bob.id, next.id].sort());
    expect(server.ctx.presence.getUser(alice.id)?.voiceChannel).toBeNull();

    // A real leave still says so.
    const left = once<{ id: string; reason: string }>(bob, 'voice:peer-leave');
    next.emit('voice:leave');
    expect(await left).toMatchObject({ id: next.id, accountId: account.id, reason: 'left' });
  });

  it('accepts a queued message for a named channel with an acknowledgement that echoes the client id', async () => {
    server = await startTestServer();
    const general = server.ctx.channels.getByName('general')!;
    const random = server.ctx.channels.create({ name: 'random', type: 'text', groupId: null, permissions: null, topic: null, visibility: 'public', joinPasswordHash: null, creatorAccountId: null });
    const alice = await open();
    const aliceAuth = once<AuthSuccess>(alice, 'auth:success');
    alice.emit('auth:register', { username: 'alice@example.com', password: 'password123', profile: { displayName: 'Alice' } });
    await aliceAuth;
    const joined = once(alice, 'channel:joined');
    alice.emit('channel:join', general.id);
    await joined;

    // Typed in #random while offline, sent after the reconnect while #general is open.
    const echo = once<{ id: string; channelId: string; clientId?: string; text: string }>(alice, 'chat');
    const ack = await new Promise<{ success: boolean; messageId: string; channelId: string; clientId: string | null }>((resolve) => {
      alice.emit('chat', { text: 'hello from the queue', channelId: random.id, clientId: 'q-1' }, resolve);
    });
    expect(ack).toMatchObject({ success: true, channelId: random.id, clientId: 'q-1' });
    const message = await echo;
    expect(message).toMatchObject({ id: ack.messageId, channelId: random.id, clientId: 'q-1', text: 'hello from the queue' });
    expect(server.ctx.messages.count(random.id)).toBe(1);
    expect(server.ctx.messages.count(general.id)).toBe(0);

    // The plain form still works and is not acknowledged with an id it did not send.
    const plain = once<{ clientId?: string }>(alice, 'chat');
    alice.emit('chat', 'plain text');
    expect((await plain).clientId).toBeUndefined();

    // A refusal arrives on the acknowledgement, so the client can mark the message as failed.
    const refused = await new Promise<{ success: boolean; code: string }>((resolve) => {
      alice.emit('chat', { text: 'nope', channelId: 'does-not-exist', clientId: 'q-2' }, resolve);
    });
    expect(refused).toMatchObject({ success: false, code: 'NOT_FOUND' });
  });
});
