/**
 * The old-shell stub (docs/arcade/platform.md §14 item 16): desktop and Android builds from before
 * the Arcade still offer the old games. Starting or joining one gets a toast they already show;
 * every other old event is ignored without an error. Removed 3 releases after the Arcade ships.
 */
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_MESSAGE } from '../../src/arcade/legacy.js';
import { startTestServer, type TestServer } from '../helpers.js';

const once = <T = unknown>(socket: Socket, event: string, timeoutMs = 2000): Promise<T> =>
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

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

describe('old-shell game stub', () => {
  let server: TestServer;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await server.close();
  });

  const signedIn = async (): Promise<Socket> => {
    const account = await server.ctx.accounts.register({ username: 'old@example.com', password: 'password123', displayName: 'Old Shell' });
    const token = server.ctx.sessions.create(account.id).token;
    const socket = await client(server.url);
    sockets.push(socket);
    const ok = once(socket, 'auth:success');
    socket.emit('auth:session', { token });
    await ok;
    return socket;
  };

  it('answers start and join with the update notice', async () => {
    const socket = await signedIn();
    for (const event of ['voice:game:start', 'voice:game:join']) {
      const reply = once<{ message: string }>(socket, 'voice:game:error');
      socket.emit(event, { type: 'slither' });
      expect(await reply).toEqual({ message: LEGACY_MESSAGE });
    }
    expect(LEGACY_MESSAGE).toBe('Games moved to the Arcade. Update the app to play.');
  });

  it('ignores every other old event without an error', async () => {
    const socket = await signedIn();
    const seen: string[] = [];
    socket.onAny((event: string) => seen.push(event));
    for (const event of ['voice:game:leave', 'voice:game:input', 'voice:game:end', 'voice:game:leaderboard']) socket.emit(event, { type: 'slither' });
    await settle();
    expect(seen.filter((event) => event === 'error' || event.startsWith('voice:game:'))).toEqual([]);
  });

  it('answers a socket that is not signed in too', async () => {
    const socket = await client(server.url);
    sockets.push(socket);
    const reply = once<{ message: string }>(socket, 'voice:game:error');
    socket.emit('voice:game:start');
    expect((await reply).message).toBe(LEGACY_MESSAGE);
  });
});
