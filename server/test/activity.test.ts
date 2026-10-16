import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_ACTIVITY_LENGTH, PresenceService } from '../src/services/presence.js';
import { ACTIVITY_WINDOW_MS } from '../src/socket/context.js';
import type { PublicAccount } from '../src/types.js';
import { startTestServer, waitFor, type TestServer } from './helpers.js';

interface UserView {
  id: string;
  accountId: string;
  displayName: string;
  activity: string | null;
  voiceChannel: string | null;
}

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

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

const account = (overrides: Partial<PublicAccount> = {}): PublicAccount => ({
  id: 'acct-1',
  username: 'alice@example.com',
  displayName: 'Alice',
  email: null,
  bio: null,
  avatarUrl: null,
  roles: ['user'],
  status: 'active',
  metadata: {},
  createdAt: 0,
  updatedAt: 0,
  disabledAt: null,
  disabledReason: null,
  inviteTokenId: null,
  mustChangePassword: false,
  lastSeenAt: null,
  deletedAt: null,
  ...overrides,
});

describe('presence service: game activity', () => {
  it('starts empty, reports changes only, clips, and goes with the socket', () => {
    const presence = new PresenceService();
    presence.addUser('s1', account());
    expect(presence.exportUser('s1')?.activity).toBeNull();
    expect(presence.exportUsers()[0].activity).toBeNull();

    expect(presence.setActivity('s1', 'Elden Ring')).toBe(true);
    expect(presence.setActivity('s1', 'Elden Ring')).toBe(false);
    expect(presence.exportUser('s1')?.activity).toBe('Elden Ring');
    expect(presence.exportUsers().map((user) => user.activity)).toEqual(['Elden Ring']);

    expect(presence.setActivity('s1', 'x'.repeat(MAX_ACTIVITY_LENGTH + 20))).toBe(true);
    expect(presence.exportUser('s1')?.activity).toHaveLength(MAX_ACTIVITY_LENGTH);

    expect(presence.setActivity('s1', null)).toBe(true);
    expect(presence.setActivity('s1', null)).toBe(false);
    expect(presence.setActivity('s1', '')).toBe(false);
    expect(presence.setActivity('nobody', 'Elden Ring')).toBe(false);

    presence.setActivity('s1', 'Hades');
    presence.removeUser('s1');
    presence.addUser('s1', account());
    expect(presence.exportUser('s1')?.activity).toBeNull();
  });
});

describe('presence:activity over the socket', () => {
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

  // Accounts are made through the service (the registration event has a per-process limit of
  // five per minute) and signed in with a fresh session token.
  const register = async (socket: Socket, username: string, displayName: string) => {
    const account = server.ctx.accounts.getByUsername(username) ?? (await server.ctx.accounts.register({ username, password: 'password123', displayName }));
    const session = server.ctx.sessions.create(account.id);
    const success = once<{ user: UserView; session: { token: string } }>(socket, 'auth:success');
    socket.emit('auth:session', { token: session.token });
    return success;
  };

  /** Collects every `user:update` list a socket receives. */
  const collect = (socket: Socket) => {
    const updates: UserView[][] = [];
    socket.on('user:update', (list: UserView[]) => updates.push(list));
    return updates;
  };

  const activityOf = (list: UserView[], socketId: string) => list.find((user) => user.id === socketId)?.activity;

  it('is null at sign-in, shows the title to everyone, clears with null and does not broadcast repeats', async () => {
    const alice = await open();
    const aliceAuth = await register(alice, 'alice@example.com', 'Alice');
    expect(aliceAuth.user.activity).toBeNull();
    const bob = await open();
    await register(bob, 'bob@example.com', 'Bob');
    await settle();
    const bobUpdates = collect(bob);
    const aliceUpdates = collect(alice);

    alice.emit('presence:activity', { title: '  Elden Ring  ' });
    const seenByBob = await waitFor(() => bobUpdates.find((list) => activityOf(list, alice.id!) === 'Elden Ring'));
    expect(seenByBob.find((user) => user.id === bob.id)?.activity).toBeNull();
    await waitFor(() => aliceUpdates.find((list) => activityOf(list, alice.id!) === 'Elden Ring'));
    expect(server.ctx.presence.getUser(alice.id!)?.activity).toBe('Elden Ring');

    // The same title again, after the rate-limit window: nothing changes, nobody is told.
    await settle(ACTIVITY_WINDOW_MS);
    const before = bobUpdates.length;
    alice.emit('presence:activity', { title: 'Elden Ring' });
    await settle(300);
    expect(bobUpdates.length).toBe(before);

    await settle(ACTIVITY_WINDOW_MS);
    alice.emit('presence:activity', { title: null });
    await waitFor(() => bobUpdates.slice(before).find((list) => activityOf(list, alice.id!) === null));
    expect(server.ctx.presence.getUser(alice.id!)?.activity).toBeNull();
  }, 40_000);

  it('accepts one report per 10 s per socket and refuses the rest on presence:error without changing anything', async () => {
    const alice = await open();
    const aliceAuth = await register(alice, 'alice@example.com', 'Alice');
    const errors: Array<{ code: string }> = [];
    alice.on('presence:error', (payload: { code: string }) => errors.push(payload));
    const generic: unknown[] = [];
    alice.on('error', (payload: unknown) => generic.push(payload));

    alice.emit('presence:activity', { title: 'Hades' });
    await waitFor(() => server.ctx.presence.getUser(alice.id!)?.activity === 'Hades');
    alice.emit('presence:activity', { title: 'Celeste' });
    await waitFor(() => errors.length === 1);
    expect(errors[0].code).toBe('RATE_LIMITED');
    expect(server.ctx.presence.getUser(alice.id!)?.activity).toBe('Hades');
    expect(generic).toEqual([]);

    // Another socket of the same account has its own window.
    const again = await open();
    const resumed = once<{ user: UserView }>(again, 'auth:success');
    again.emit('auth:session', { token: aliceAuth.session.token });
    expect((await resumed).user.activity).toBeNull();
    again.emit('presence:activity', { title: 'Celeste' });
    await waitFor(() => server.ctx.presence.getUser(again.id!)?.activity === 'Celeste');
    expect(server.ctx.presence.getUser(alice.id!)?.activity).toBe('Hades');
  });

  it('validates the payload: strings of 1 to 64 characters or null, nothing else', async () => {
    const alice = await open();
    const auth = await register(alice, 'alice@example.com', 'Alice');

    // The rate limit runs before validation, so every attempt goes through its own socket of the same login.
    const bad = [{ title: 'x'.repeat(MAX_ACTIVITY_LENGTH + 1) }, { title: '' }, { title: '   ' }, { title: 42 }, { title: 'line\nbreak' }, { title: 'tab\there' }, {}, 'Elden Ring', null];
    for (const payload of bad) {
      const socket = await open();
      const resumed = once(socket, 'auth:success');
      socket.emit('auth:session', { token: auth.session.token });
      await resumed;
      const refused = once<{ code: string }>(socket, 'presence:error');
      socket.emit('presence:activity', payload);
      expect((await refused).code, JSON.stringify(payload)).toBe('VALIDATION_FAILED');
      expect(server.ctx.presence.getUser(socket.id!)?.activity).toBeNull();
    }

    // Exactly 64 characters is fine, and so is a trailing space that trims away.
    const ok = await open();
    const resumed = once(ok, 'auth:success');
    ok.emit('auth:session', { token: auth.session.token });
    await resumed;
    ok.emit('presence:activity', { title: 'y'.repeat(MAX_ACTIVITY_LENGTH) + ' ' });
    await waitFor(() => server.ctx.presence.getUser(ok.id!)?.activity === 'y'.repeat(MAX_ACTIVITY_LENGTH));
  });

  it('requires authentication and forgets the title when the socket goes away', async () => {
    const stranger = await open();
    const refused = once<{ code: string }>(stranger, 'presence:error');
    stranger.emit('presence:activity', { title: 'Hades' });
    expect((await refused).code).toBe('NOT_AUTHENTICATED');

    const alice = await open();
    const auth = await register(alice, 'alice@example.com', 'Alice');
    const bob = await open();
    await register(bob, 'bob@example.com', 'Bob');
    await settle();
    const bobUpdates = collect(bob);
    const aliceId = alice.id!;
    alice.emit('presence:activity', { title: 'Hades' });
    await waitFor(() => bobUpdates.find((list) => activityOf(list, aliceId) === 'Hades'));

    alice.disconnect();
    const gone = await waitFor(() => bobUpdates.find((list) => !list.some((user) => user.id === aliceId)));
    expect(gone.some((user) => user.activity)).toBe(false);

    // Back on a new socket with the same session: nothing is remembered.
    const back = await open();
    const resumed = once<{ user: UserView }>(back, 'auth:success');
    back.on('auth:error', (payload: unknown) => console.error('auth:error', payload));
    back.emit('auth:session', { token: auth.session.token });
    expect((await resumed).user.activity).toBeNull();
    expect(server.ctx.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%activity%'").all()).toEqual([]);
  });
});
