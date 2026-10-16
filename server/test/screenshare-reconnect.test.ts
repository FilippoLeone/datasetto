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

interface SessionEvent {
  channelId: string;
  active: boolean;
  hostId: string | null;
  hostAccountId: string | null;
  hostName: string | null;
  rtcSessionId: string | null;
  viewerCount: number;
}

interface PendingEvent {
  channelId: string;
  viewerId: string;
  viewerAccountId: string;
  viewerName: string;
  rtcSessionId: string | null;
  holding: { accountId: string; rtcSessionId: string | null }[];
}

describe('screenshare rooms across reconnects', () => {
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

  const register = async (socket: Socket, username: string, displayName: string) => {
    const auth = once<AuthSuccess>(socket, 'auth:success');
    socket.emit('auth:register', { username, password: 'password123', profile: { displayName } });
    return auth;
  };

  const resume = async (socket: Socket, token: string) => {
    const auth = once<AuthSuccess>(socket, 'auth:success');
    socket.emit('auth:session', { token });
    return auth;
  };

  const enter = async (socket: Socket, channelId: string) => {
    const joined = once(socket, 'channel:joined');
    socket.emit('channel:join', channelId);
    await joined;
  };

  it('seats hosts and viewers by account, so a reconnected socket takes its own seat over', async () => {
    server = await startTestServer();
    const room = server.ctx.channels.getByName('team-share')!;
    const alice = await open();
    const { session: aliceSession, account: aliceAccount } = await register(alice, 'alice@example.com', 'Alice');
    const bob = await open();
    const { session: bobSession, account: bobAccount } = await register(bob, 'bob@example.com', 'Bob');
    await enter(alice, room.id);
    await enter(bob, room.id);

    // Alice presents; Bob watches. Both say what they hold.
    const started = once<SessionEvent>(alice, 'screenshare:session');
    alice.emit('screenshare:start', { channelId: room.id, rtcSessionId: 'alice-rtc', holding: [] });
    expect(await started).toMatchObject({ channelId: room.id, active: true, hostId: alice.id, hostAccountId: aliceAccount.id, hostName: 'Alice', rtcSessionId: 'alice-rtc', viewerCount: 0 });
    const pending = once<PendingEvent>(alice, 'screenshare:viewer:pending');
    const seated = once<{ hostId: string; hostAccountId: string; rtcSessionId: string }>(bob, 'screenshare:viewer:seated');
    bob.emit('screenshare:viewer:join', { channelId: room.id, rtcSessionId: 'bob-rtc', holding: [{ accountId: aliceAccount.id, rtcSessionId: 'alice-rtc' }] });
    expect(await pending).toEqual({ channelId: room.id, viewerId: bob.id, viewerAccountId: bobAccount.id, viewerName: 'Bob', rtcSessionId: 'bob-rtc', holding: [{ accountId: aliceAccount.id, rtcSessionId: 'alice-rtc' }] });
    expect(await seated).toMatchObject({ hostId: alice.id, hostAccountId: aliceAccount.id, hostName: 'Alice', rtcSessionId: 'alice-rtc' });
    expect(server.ctx.presence.screenshareView(room.id).viewerCount).toBe(1);

    // Alice's connection dropped unnoticed; her new socket resumes the token and starts again with the
    // same media session. She takes her seat over, keeps Bob, and is told about him so she can decide
    // whether her connection to him survived.
    const alice2 = await open();
    await resume(alice2, aliceSession.token);
    await enter(alice2, room.id);
    const replaced = once<{ channelId: string; role: string; bySocketId: string }>(alice, 'screenshare:replaced');
    const bobSees = once<SessionEvent>(bob, 'screenshare:session');
    const knownViewer = once<PendingEvent>(alice2, 'screenshare:viewer:pending');
    const bobNotKicked = never(bob, 'screenshare:replaced');
    alice2.emit('screenshare:start', { channelId: room.id, rtcSessionId: 'alice-rtc', holding: [{ accountId: bobAccount.id, rtcSessionId: 'bob-rtc' }] });
    expect(await replaced).toEqual({ channelId: room.id, role: 'host', bySocketId: alice2.id });
    expect(await bobSees).toMatchObject({ active: true, hostId: alice2.id, hostAccountId: aliceAccount.id, rtcSessionId: 'alice-rtc', viewerCount: 1 });
    expect(await knownViewer).toMatchObject({ viewerId: bob.id, viewerAccountId: bobAccount.id, rtcSessionId: 'bob-rtc' });
    await bobNotKicked;
    expect(server.ctx.presence.getScreenshare(room.id)?.hostId).toBe(alice2.id);
    expect(server.ctx.presence.screenshareViewers(room.id).map((viewer) => viewer.id)).toEqual([bob.id]);

    // The old host socket is no longer the host: its stop is refused, the share stays.
    const refused = once<{ code: string }>(alice, 'screenshare:error');
    alice.emit('screenshare:stop', { channelId: room.id });
    expect((await refused).code).toBe('NOT_HOST');
    expect(server.ctx.presence.screenshareView(room.id).active).toBe(true);

    // Bob's reconnect: his new socket takes the viewer seat; the host learns the new id for the same account.
    const bob2 = await open();
    await resume(bob2, bobSession.token);
    await enter(bob2, room.id);
    const viewerReplaced = once<{ role: string; bySocketId: string }>(bob, 'screenshare:replaced');
    const rejoined = once<PendingEvent>(alice2, 'screenshare:viewer:pending');
    bob2.emit('screenshare:viewer:join', { channelId: room.id, rtcSessionId: 'bob-rtc', holding: [{ accountId: aliceAccount.id, rtcSessionId: 'alice-rtc' }] });
    expect(await viewerReplaced).toMatchObject({ role: 'viewer', bySocketId: bob2.id });
    expect(await rejoined).toMatchObject({ viewerId: bob2.id, viewerAccountId: bobAccount.id, rtcSessionId: 'bob-rtc' });
    expect(server.ctx.presence.screenshareViewers(room.id).map((viewer) => viewer.id)).toEqual([bob2.id]);
    expect(server.ctx.presence.screenshareView(room.id).viewerCount).toBe(1);

    // Another account cannot take the host seat while the share is on.
    const carol = await open();
    await register(carol, 'carol@example.com', 'Carol');
    await enter(carol, room.id);
    const busy = once<{ code: string }>(carol, 'screenshare:error');
    carol.emit('screenshare:start', { channelId: room.id, rtcSessionId: 'carol-rtc' });
    expect((await busy).code).toBe('SCREENSHARE_BUSY');

    // Signalling follows the new ids.
    const relayed = once<{ from: string; data: unknown }>(bob2, 'screenshare:signal');
    alice2.emit('screenshare:signal', { to: bob2.id, data: { hello: 1 }, channelId: room.id });
    expect(await relayed).toMatchObject({ from: alice2.id, data: { hello: 1 } });
  });

  it('answers a viewer who joins before the presenter is back with an inactive session, then seats it when the share returns', async () => {
    server = await startTestServer();
    const room = server.ctx.channels.getByName('team-share')!;
    const alice = await open();
    const { account: aliceAccount } = await register(alice, 'alice@example.com', 'Alice');
    const bob = await open();
    await register(bob, 'bob@example.com', 'Bob');
    await enter(alice, room.id);
    await enter(bob, room.id);

    const inactive = once<SessionEvent>(bob, 'screenshare:session');
    bob.emit('screenshare:viewer:join', { channelId: room.id, rtcSessionId: 'bob-rtc', holding: [{ accountId: aliceAccount.id, rtcSessionId: 'alice-rtc' }] });
    expect(await inactive).toMatchObject({ channelId: room.id, active: false, hostId: null, viewerCount: 0 });

    const active = once<SessionEvent>(bob, 'screenshare:session');
    alice.emit('screenshare:start', { channelId: room.id, rtcSessionId: 'alice-rtc' });
    expect(await active).toMatchObject({ active: true, hostId: alice.id, hostAccountId: aliceAccount.id, rtcSessionId: 'alice-rtc', viewerCount: 0 });
    const seated = once<{ hostId: string }>(bob, 'screenshare:viewer:seated');
    const pending = once<PendingEvent>(alice, 'screenshare:viewer:pending');
    bob.emit('screenshare:viewer:join', { channelId: room.id, rtcSessionId: 'bob-rtc', holding: [{ accountId: aliceAccount.id, rtcSessionId: 'alice-rtc' }] });
    expect((await seated).hostId).toBe(alice.id);
    expect((await pending).viewerId).toBe(bob.id);

    // A deliberate stop says so; a host socket going away says that instead, so viewers can wait.
    const stopped = once<SessionEvent & { endedBy?: string }>(bob, 'screenshare:session');
    alice.emit('screenshare:stop', { channelId: room.id });
    expect(await stopped).toMatchObject({ active: false, endedBy: 'host' });
    const again = once(bob, 'screenshare:session');
    alice.emit('screenshare:start', { channelId: room.id, rtcSessionId: 'alice-rtc-2' });
    await again;
    const lost = once<SessionEvent & { endedBy?: string }>(bob, 'screenshare:session');
    alice.disconnect();
    expect(await lost).toMatchObject({ active: false, endedBy: 'disconnect' });
  });

  it('says nothing about the share while shutting down and lets both sides rebuild the room on the new process', async () => {
    dir = mkdtempSync(join(tmpdir(), 'datasetto-share-restart-'));
    const file = join(dir, 'datasetto.db');
    server = await startTestServer({}, {}, { db: openDatabase(file) });
    const port = server.port;
    const room = server.ctx.channels.getByName('team-share')!;
    // The per-IP registration limiter is shared by the tests of this file: mint these two directly.
    const aliceAccount = await server.ctx.accounts.register({ username: 'alice@example.com', password: 'password123', displayName: 'Alice', inviteCode: null });
    const bobAccount = await server.ctx.accounts.register({ username: 'bob@example.com', password: 'password123', displayName: 'Bob', inviteCode: null });
    const aliceSession = server.ctx.sessions.create(aliceAccount.id);
    const bobSession = server.ctx.sessions.create(bobAccount.id);
    const alice = await open({ reconnection: true, reconnectionDelay: 50, reconnectionDelayMax: 200 });
    await resume(alice, aliceSession.token);
    const bob = await open({ reconnection: true, reconnectionDelay: 50, reconnectionDelayMax: 200 });
    await resume(bob, bobSession.token);
    await enter(alice, room.id);
    await enter(bob, room.id);
    const started = once(alice, 'screenshare:session');
    alice.emit('screenshare:start', { channelId: room.id, rtcSessionId: 'alice-rtc' });
    await started;
    const seated = once(bob, 'screenshare:viewer:seated');
    bob.emit('screenshare:viewer:join', { channelId: room.id, rtcSessionId: 'bob-rtc', holding: [{ accountId: aliceAccount.id, rtcSessionId: 'alice-rtc' }] });
    await seated;

    const sessionsDuringShutdown: SessionEvent[] = [];
    bob.on('screenshare:session', (payload: SessionEvent) => sessionsDuringShutdown.push(payload));
    alice.on('screenshare:session', (payload: SessionEvent) => sessionsDuringShutdown.push(payload));
    const dropped = Promise.all([once(alice, 'disconnect'), once(bob, 'disconnect')]);
    const shutdown = createShutdown({ ctx: server.ctx, io: server.sockets.io, server: server.server, exit: vi.fn(), noticeMs: 50, lingerMs: 100 });
    await shutdown('SIGTERM');
    await dropped;
    expect(sessionsDuringShutdown).toEqual([]);

    const reconnected = Promise.all([once(alice, 'connect', 8000), once(bob, 'connect', 8000)]);
    const old = server;
    server = await startTestServer({}, {}, { db: openDatabase(file), port });
    await old.close();
    await reconnected;
    await waitFor(() => alice.connected && bob.connected, 5000);
    await resume(alice, aliceSession.token).catch((error) => {
      throw new Error('alice: ' + error.message);
    });
    await resume(bob, bobSession.token).catch((error) => {
      throw new Error('bob: ' + error.message);
    });
    await enter(alice, room.id);
    await enter(bob, room.id);

    // Bob is back first: no presenter yet. Alice restarts hosting with the same media session and
    // says she still holds Bob; Bob joins again and the host hears about him.
    const inactive = once<SessionEvent>(bob, 'screenshare:session');
    bob.emit('screenshare:viewer:join', { channelId: room.id, rtcSessionId: 'bob-rtc', holding: [{ accountId: aliceAccount.id, rtcSessionId: 'alice-rtc' }] });
    expect((await inactive).active).toBe(false);
    const active = once<SessionEvent>(bob, 'screenshare:session');
    alice.emit('screenshare:start', { channelId: room.id, rtcSessionId: 'alice-rtc', holding: [{ accountId: bobAccount.id, rtcSessionId: 'bob-rtc' }] });
    expect(await active).toMatchObject({ active: true, hostId: alice.id, hostAccountId: aliceAccount.id, rtcSessionId: 'alice-rtc' });
    const seatedAgain = once<{ hostId: string; rtcSessionId: string }>(bob, 'screenshare:viewer:seated');
    const pending = once<PendingEvent>(alice, 'screenshare:viewer:pending');
    bob.emit('screenshare:viewer:join', { channelId: room.id, rtcSessionId: 'bob-rtc', holding: [{ accountId: aliceAccount.id, rtcSessionId: 'alice-rtc' }] });
    expect(await seatedAgain).toMatchObject({ hostId: alice.id, rtcSessionId: 'alice-rtc' });
    expect(await pending).toMatchObject({ viewerId: bob.id, viewerAccountId: bobAccount.id, rtcSessionId: 'bob-rtc', holding: [{ accountId: aliceAccount.id, rtcSessionId: 'alice-rtc' }] });
    expect(server.ctx.sessions.countForAccount(aliceAccount.id)).toBe(1);
  });
});
