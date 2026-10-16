import request from 'supertest';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShutdown, type RestartNotice } from '../src/shutdown.js';
import { startTestServer, waitFor, type TestServer } from './helpers.js';

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

const signIn = async (socket: Socket, username: string) => {
  const auth = once<{ session: { token: string } }>(socket, 'auth:success');
  socket.emit('auth:register', { username, password: 'password123' });
  return auth;
};

describe('graceful shutdown', () => {
  let server: TestServer | null = null;
  const sockets: Socket[] = [];

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
    await server?.close();
    server = null;
  });

  const open = async () => {
    const socket = await client(server!.url);
    sockets.push(socket);
    return socket;
  };

  it('tells every client it is restarting, closes them, refuses newcomers, checkpoints and exits 0 in time', async () => {
    server = await startTestServer({ RESTART_EXPECTED_WAIT_SECONDS: '7' });
    const alice = await open();
    const bob = await open();
    await signIn(alice, 'alice@example.com');
    await signIn(bob, 'bob@example.com');
    const anonymous = await open();
    expect(server.ctx.runtime.connectedSockets()).toBe(3);

    const exit = vi.fn();
    const shutdown = createShutdown({ ctx: server.ctx, io: server.sockets.io, server: server.server, exit, noticeMs: 50, lingerMs: 100 });
    expect(shutdown.started).toBe(false);

    const notices = Promise.all([alice, bob, anonymous].map((socket) => once<RestartNotice>(socket, 'server:restarting')));
    const gone = Promise.all([alice, bob, anonymous].map((socket) => once<string>(socket, 'disconnect')));
    const started = Date.now();
    const finished = shutdown('SIGTERM');
    expect(shutdown.started).toBe(true);
    expect(server.ctx.runtime.shuttingDown).toBe(true);

    // Health answers 503 "restarting" while the sequence runs, so a probe stops routing here.
    const probe = await request(server.url).get('/api/health');
    if (probe.status !== 0) {
      expect(probe.status).toBe(503);
      expect(probe.body.status).toBe('restarting');
    }

    for (const notice of await notices) {
      expect(notice.expectedWaitMs).toBe(7000);
      expect(notice.reason).toBe('SIGTERM');
      expect(typeof notice.at).toBe('number');
    }
    await gone;
    // Running the sequence twice joins the first run instead of starting over.
    expect(await shutdown('SIGINT')).toBe(0);
    expect(await finished).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(server.ctx.db.open).toBe(false);
    expect(server.ctx.runtime.connectedSockets()).toBe(0);
    expect(server.server.listening).toBe(false);
  });

  it('does not tell a voice room that anyone left while the sockets are being closed', async () => {
    server = await startTestServer();
    const lobby = server.ctx.channels.getByName('lobby')!;
    const alice = await open();
    const bob = await open();
    await signIn(alice, 'alice@example.com');
    await signIn(bob, 'bob@example.com');
    const aliceJoined = once(alice, 'voice:joined');
    alice.emit('voice:join', { channelId: lobby.id, rtcSessionId: 'a' });
    await aliceJoined;
    const bobJoined = once(bob, 'voice:joined');
    const bobSeen = once(alice, 'voice:peer-join');
    bob.emit('voice:join', { channelId: lobby.id, rtcSessionId: 'b' });
    await bobJoined;
    await bobSeen;

    const leaves: unknown[] = [];
    alice.on('voice:peer-leave', (payload) => leaves.push(payload));
    bob.on('voice:peer-leave', (payload) => leaves.push(payload));
    const gone = Promise.all([once(alice, 'disconnect'), once(bob, 'disconnect')]);
    const shutdown = createShutdown({ ctx: server.ctx, io: server.sockets.io, server: server.server, exit: vi.fn(), noticeMs: 50, lingerMs: 100 });
    await shutdown('SIGTERM');
    await gone;
    // Their peer connections carry on across the restart; a "left" here would have made them drop each other.
    expect(leaves).toEqual([]);
  });

  it('refuses new sockets as soon as the shutdown is marked', async () => {
    server = await startTestServer();
    server.ctx.runtime.shuttingDown = true;
    const socket = connect(server.url, { transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(socket);
    const error = await once<Error>(socket, 'connect_error');
    expect(error.message).toBe('Server is restarting');
    expect(socket.connected).toBe(false);
    const health = await request(server.url).get('/health').expect(503);
    expect(health.body.status).toBe('restarting');
    expect(health.body.shuttingDown).toBe(true);
  });

  it('forces the exit when a step hangs past the deadline', async () => {
    server = await startTestServer();
    const alice = await open();
    await signIn(alice, 'alice@example.com');
    const exit = vi.fn();
    // A socket server whose close never calls back stands in for a hung step.
    const stuck = { emit: () => true, close: () => undefined } as unknown as TestServer['sockets']['io'];
    const shutdown = createShutdown({ ctx: server.ctx, io: stuck, server: server.server, exit, deadlineMs: 300, noticeMs: 10, lingerMs: 50 });
    void shutdown('SIGTERM');
    await waitFor(() => exit.mock.calls.length > 0, 2000);
    expect(exit).toHaveBeenCalledWith(1);
    expect(server.ctx.db.open).toBe(false);
  });
});
