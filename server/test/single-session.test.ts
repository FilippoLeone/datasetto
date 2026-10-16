import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('one active login per account', () => {
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

  it('disconnects the older connection when the same account signs in again (default on)', async () => {
    server = await startTestServer();
    const first = await open();
    const firstAuth = once<{ session: { token: string } }>(first, 'auth:success');
    first.emit('auth:register', { username: 'alice@example.com', password: 'password123' });
    const { session } = await firstAuth;

    // A second sign-in (new token) replaces the first socket.
    const second = await open();
    const replaced = once<{ code: string; message: string }>(first, 'auth:error');
    const firstGone = once(first, 'disconnect');
    const secondAuth = once(second, 'auth:success');
    second.emit('auth:login', { username: 'alice@example.com', password: 'password123' });
    await secondAuth;
    const notice = await replaced;
    expect(notice.code).toBe('SIGNED_IN_ELSEWHERE');
    expect(notice.message).toMatch(/signed in somewhere else/i);
    await firstGone;
    expect(server.ctx.presence.getSocketsByAccount(server.ctx.accounts.getByUsername('alice@example.com')!.id)).toEqual([second.id]);
    expect(first.connected).toBe(false);
    expect(second.connected).toBe(true);

    // The first token stays valid: resuming it elsewhere (a reload) takes the account back.
    const third = await open();
    const secondReplaced = once<{ code: string }>(second, 'auth:error');
    const thirdAuth = once(third, 'auth:success');
    third.emit('auth:session', { token: session.token });
    await thirdAuth;
    expect((await secondReplaced).code).toBe('SIGNED_IN_ELSEWHERE');
    expect(third.connected).toBe(true);

    // Other accounts are untouched.
    const bob = await open();
    const bobAuth = once(bob, 'auth:success');
    bob.emit('auth:register', { username: 'bob@example.com', password: 'password123' });
    await bobAuth;
    expect(third.connected).toBe(true);
    expect(server.ctx.presence.onlineCount()).toBe(2);
  });

  it('allows several connections when SINGLE_SESSION_PER_ACCOUNT=false', async () => {
    server = await startTestServer({ SINGLE_SESSION_PER_ACCOUNT: 'false' });
    const first = await open();
    const firstAuth = once(first, 'auth:success');
    first.emit('auth:register', { username: 'alice@example.com', password: 'password123' });
    await firstAuth;
    const second = await open();
    const stillThere = once(first, 'auth:error', 300);
    const secondAuth = once(second, 'auth:success');
    second.emit('auth:login', { username: 'alice@example.com', password: 'password123' });
    await secondAuth;
    await expect(stillThere).rejects.toThrow('timeout');
    expect(first.connected).toBe(true);
    expect(server.ctx.presence.onlineCount()).toBe(2);
  });
});
