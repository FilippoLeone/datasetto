import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import webpush from 'web-push';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHttpApp } from '../src/http/app.js';
import { buildNotification, mentionedAccounts, mentionsName, notifyMessageRecipients } from '../src/services/messageNotifications.js';
import { VISIBILITY_STALE_MS } from '../src/services/presence.js';
import { MAX_PAYLOAD_BYTES, MAX_SUBSCRIPTIONS_PER_ACCOUNT, serializeNotification, type PushTransport } from '../src/services/push.js';
import type { AccountRecord } from '../src/types.js';
import { makeConfig, makeContext, startTestServer, waitFor, type TestServer } from './helpers.js';

const vapid = webpush.generateVAPIDKeys();
const PUSH_ENV = {
  PUSH_VAPID_PUBLIC_KEY: vapid.publicKey,
  PUSH_VAPID_PRIVATE_KEY: vapid.privateKey,
  PUSH_VAPID_SUBJECT: 'mailto:ops@example.com',
};

interface Delivery {
  endpoint: string;
  payload: { title: string; body: string; url: string; tag: string; channelId: string | null };
  options: { TTL?: number; urgency?: string };
}

/** A push service stand-in: records deliveries, answers 410 for endpoints marked gone. */
const fakeTransport = () => {
  const deliveries: Delivery[] = [];
  const gone = new Set<string>();
  const transport: PushTransport = async (subscription, payload, options) => {
    if (gone.has(subscription.endpoint)) {
      throw Object.assign(new Error('Gone'), { statusCode: 410 });
    }
    deliveries.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload), options });
    return { statusCode: 201, body: '', headers: {} };
  };
  return { deliveries, gone, transport };
};

const subscription = (n: number) => ({
  endpoint: 'https://push.example.com/send/' + n,
  keys: { p256dh: 'BPublicKey' + n + '_'.repeat(20), auth: 'authSecret' + n },
});

const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

describe('push configuration', () => {
  it('is off without VAPID keys and advertised through /api/config', async () => {
    const ctx = makeContext();
    expect(ctx.push.isEnabled()).toBe(false);
    expect(ctx.push.publicKey()).toBeNull();
    const response = await request(createHttpApp(ctx)).get('/api/config').expect(200);
    expect(response.body.push).toEqual({ enabled: false, publicKey: null });
    expect(await ctx.push.send('acct-x', { title: 't', body: 'b', url: '/app', tag: 't', channelId: null }, 'c')).toMatchObject({ skipped: 'disabled' });
  });

  it('is on with a key pair and a subject, with the public key in /api/config', async () => {
    const ctx = makeContext(PUSH_ENV);
    expect(ctx.push.isEnabled()).toBe(true);
    const response = await request(createHttpApp(ctx)).get('/api/config').expect(200);
    expect(response.body.push).toEqual({ enabled: true, publicKey: vapid.publicKey });
  });

  it('falls back to the first admin email as the subject and rejects half a key pair', () => {
    expect(makeConfig({ ...PUSH_ENV, PUSH_VAPID_SUBJECT: '', ADMIN_EMAILS: 'Owner@Example.com, other@example.com' }).push.subject).toBe('mailto:owner@example.com');
    expect(() => makeConfig({ ...PUSH_ENV, PUSH_VAPID_SUBJECT: '' })).toThrow(/PUSH_VAPID_SUBJECT/);
    expect(() => makeConfig({ ...PUSH_ENV, PUSH_VAPID_SUBJECT: 'http://insecure.example.com' })).toThrow(/mailto: address or an https: URL/);
    expect(() => makeConfig({ PUSH_VAPID_PUBLIC_KEY: vapid.publicKey })).toThrow(/set together/);
    expect(makeConfig({}).push).toEqual({ publicKey: null, privateKey: null, subject: null });
  });
});

describe('push subscriptions (service)', () => {
  it('stores one row per endpoint, lists and removes the caller\'s own, and moves an endpoint between accounts', async () => {
    const { transport } = fakeTransport();
    const ctx = makeContext(PUSH_ENV, { push: { transport } });
    const alice = await ctx.accounts.register({ username: 'alice@example.com', password: 'password123', displayName: 'Alice' });
    const bob = await ctx.accounts.register({ username: 'bob@example.com', password: 'password123', displayName: 'Bob' });
    const session = ctx.sessions.create(alice.id);

    const first = ctx.push.subscribe(alice.id, session.tokenHash, { ...subscription(1), userAgent: 'Firefox' });
    expect(first).toMatchObject({ endpoint: subscription(1).endpoint, userAgent: 'Firefox', lastUsedAt: null });
    // Re-subscribing with the same endpoint refreshes the row instead of adding one.
    const again = ctx.push.subscribe(alice.id, session.tokenHash, { ...subscription(1), keys: { p256dh: 'BNewKey'.padEnd(30, '_'), auth: 'newAuth' } });
    expect(again.id).toBe(first.id);
    ctx.push.subscribe(alice.id, session.tokenHash, subscription(2));
    expect(ctx.push.list(alice.id).map((entry) => entry.endpoint)).toEqual([subscription(1).endpoint, subscription(2).endpoint]);

    // Bob cannot remove Alice's subscription; Alice can.
    expect(ctx.push.unsubscribe(bob.id, subscription(2).endpoint)).toBe(false);
    expect(ctx.push.unsubscribe(alice.id, subscription(2).endpoint)).toBe(true);
    expect(ctx.push.list(alice.id)).toHaveLength(1);

    // The same browser signing in as Bob takes its subscription along.
    ctx.push.subscribe(bob.id, ctx.sessions.create(bob.id).tokenHash, subscription(1));
    expect(ctx.push.list(alice.id)).toHaveLength(0);
    expect(ctx.push.list(bob.id)).toHaveLength(1);

    // Garbage is refused.
    expect(() => ctx.push.subscribe(alice.id, null, { endpoint: 'http://plain.example.com/x', keys: subscription(1).keys })).toThrow(/https/);
    expect(() => ctx.push.subscribe(alice.id, null, { endpoint: 'not a url', keys: subscription(1).keys })).toThrow(/Invalid push endpoint/);
    expect(() => ctx.push.subscribe(alice.id, null, { endpoint: subscription(3).endpoint, keys: { p256dh: 'has spaces', auth: 'x' } })).toThrow(/p256dh/);
  });

  it('keeps at most MAX_SUBSCRIPTIONS_PER_ACCOUNT browsers, the newest ones', async () => {
    const ctx = makeContext(PUSH_ENV);
    const alice = await ctx.accounts.register({ username: 'alice@example.com', password: 'password123', displayName: 'Alice' });
    for (let n = 0; n < MAX_SUBSCRIPTIONS_PER_ACCOUNT + 3; n += 1) {
      ctx.db.prepare('UPDATE push_subscriptions SET created_at = created_at - 1000').run();
      ctx.push.subscribe(alice.id, null, subscription(n));
    }
    const kept = ctx.push.list(alice.id);
    expect(kept).toHaveLength(MAX_SUBSCRIPTIONS_PER_ACCOUNT);
    expect(kept.some((entry) => entry.endpoint === subscription(0).endpoint)).toBe(false);
    expect(kept.some((entry) => entry.endpoint === subscription(MAX_SUBSCRIPTIONS_PER_ACCOUNT + 2).endpoint)).toBe(true);
  });

  it('delivers to every device once per conversation per window, drops gone endpoints and follows the login', async () => {
    const { deliveries, gone, transport } = fakeTransport();
    const ctx = makeContext(PUSH_ENV, { push: { transport, windowMs: 200 } });
    const alice = await ctx.accounts.register({ username: 'alice@example.com', password: 'password123', displayName: 'Alice' });
    const laptop = ctx.sessions.create(alice.id);
    const phone = ctx.sessions.create(alice.id);
    ctx.push.subscribe(alice.id, laptop.tokenHash, subscription(1));
    ctx.push.subscribe(alice.id, phone.tokenHash, subscription(2));
    ctx.push.subscribe(alice.id, null, subscription(3));

    const note = { title: 'Bob', body: 'hello  there\n\nfriend', url: '/app?channel=c1', tag: 'channel:c1', channelId: 'c1' };
    expect(await ctx.push.send(alice.id, note, 'c1')).toEqual({ skipped: null, sent: 3, failed: 0, dropped: 0 });
    expect(deliveries).toHaveLength(3);
    expect(deliveries[0].payload).toEqual({ ...note, body: 'hello there friend' });
    expect(deliveries[0].options).toMatchObject({ TTL: 3600, urgency: 'high' });
    expect(ctx.push.list(alice.id).every((entry) => typeof entry.lastUsedAt === 'number')).toBe(true);

    // Same conversation right away: rate limited. Another conversation: fine.
    expect(await ctx.push.send(alice.id, note, 'c1')).toMatchObject({ skipped: 'rate-limited' });
    expect(await ctx.push.send(alice.id, { ...note, channelId: 'c2' }, 'c2')).toMatchObject({ sent: 3 });
    await settle(250);
    expect(await ctx.push.send(alice.id, note, 'c1')).toMatchObject({ sent: 3 });

    // The push service says the phone's subscription is gone: it is removed.
    gone.add(subscription(2).endpoint);
    await settle(250);
    expect(await ctx.push.send(alice.id, note, 'c1')).toEqual({ skipped: null, sent: 2, failed: 0, dropped: 1 });
    expect(ctx.push.list(alice.id).map((entry) => entry.endpoint)).toEqual([subscription(1).endpoint, subscription(3).endpoint]);

    // The laptop logs out: its subscription goes with the session; the session-less one stays.
    ctx.sessions.revokeByHash(laptop.tokenHash);
    expect(ctx.push.purgeOrphans()).toBe(1);
    expect(ctx.push.list(alice.id).map((entry) => entry.endpoint)).toEqual([subscription(3).endpoint]);
    expect(ctx.push.removeAll(alice.id)).toBe(1);
    expect(await ctx.push.send(alice.id, note, 'c3')).toMatchObject({ skipped: 'no-subscriptions' });
  });

  it('keeps the payload short', () => {
    const json = serializeNotification({ title: 'T'.repeat(500), body: 'word '.repeat(2000), url: '/app?channel=c', tag: 'channel:c', channelId: 'c' });
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    const parsed = JSON.parse(json) as { title: string; body: string };
    expect(parsed.title).toHaveLength(80);
    expect(parsed.title.endsWith('…')).toBe(true);
    expect(parsed.body.length).toBeLessThanOrEqual(180);
  });
});

describe('mentions', () => {
  const account = (displayName: string, username: string, status: AccountRecord['status'] = 'active') =>
    ({ id: username, displayName, username, status } as unknown as AccountRecord);

  it('matches display names and usernames as whole words, case-insensitively', () => {
    expect(mentionsName('hey @Bob!', 'bob')).toBe(true);
    expect(mentionsName('hey @bob', 'Bob')).toBe(true);
    expect(mentionsName('hey @bobby', 'bob')).toBe(false);
    expect(mentionsName('@bobby and @bob.', 'bob')).toBe(true);
    expect(mentionsName('bob without the at sign', 'bob')).toBe(false);
    expect(mentionsName('ping @Bob Smith please', 'Bob Smith')).toBe(true);
    expect(mentionsName('ping @bob@example.com', 'bob@example.com')).toBe(true);
    expect(mentionsName('anything', '')).toBe(false);

    const accounts = [account('Bob', 'bob@example.com'), account('Bobby', 'bobby@example.com'), account('Carol', 'carol@example.com', 'disabled')];
    expect(mentionedAccounts('hi @bob and @carol', accounts).map((entry) => entry.displayName)).toEqual(['Bob']);
    expect(mentionedAccounts('hi @bobby@example.com', accounts).map((entry) => entry.displayName)).toEqual(['Bobby']);
    expect(mentionedAccounts('no mentions here', accounts)).toEqual([]);
  });

  it('builds the notification text and link', () => {
    const channel = { id: 'ch-1', name: 'general', type: 'text' } as never;
    const message = { from: 'Alice', text: 'lunch?' } as never;
    expect(buildNotification(channel, message, 'mention')).toEqual({ title: 'Alice in #general', body: 'lunch?', url: '/app?channel=ch-1', tag: 'channel:ch-1', channelId: 'ch-1' });
    expect(buildNotification(channel, message, 'dm').title).toBe('Alice');
  });
});

describe('presence visibility', () => {
  it('counts an account as attending only with a fresh, visible socket', async () => {
    const ctx = makeContext();
    const alice = await ctx.accounts.register({ username: 'alice@example.com', password: 'password123', displayName: 'Alice' });
    expect(ctx.presence.isAttending(alice.id)).toBe(false);
    ctx.presence.addUser('s1', alice);
    const now = Date.now();
    expect(ctx.presence.isAttending(alice.id)).toBe(true);
    ctx.presence.setVisibility('s1', false);
    expect(ctx.presence.isAttending(alice.id)).toBe(false);
    ctx.presence.setVisibility('s1', true, now);
    expect(ctx.presence.isAttending(alice.id, now + VISIBILITY_STALE_MS)).toBe(true);
    // No heartbeat for too long: the tab is probably frozen or the laptop asleep.
    expect(ctx.presence.isAttending(alice.id, now + VISIBILITY_STALE_MS + 1)).toBe(false);
    // Any activity on the socket counts as a heartbeat too.
    ctx.presence.touch('s1');
    expect(ctx.presence.isAttending(alice.id)).toBe(true);
    // A second, hidden device does not change the answer; the visible one does.
    ctx.presence.addUser('s2', alice);
    ctx.presence.setVisibility('s2', false);
    ctx.presence.setVisibility('s1', false);
    expect(ctx.presence.isAttending(alice.id)).toBe(false);
    ctx.presence.setVisibility('s2', true);
    expect(ctx.presence.isAttending(alice.id)).toBe(true);
    expect(ctx.presence.setVisibility('nobody', true)).toBe(false);
  });
});

// ------------------------------------------------------------------ sockets

const once = <T = unknown>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ' + event)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const ask = <T = Record<string, unknown>>(socket: Socket, event: string, payload?: unknown): Promise<T> =>
  new Promise((resolve, reject) => {
    socket.timeout(3000).emit(event, payload, (error: Error | null, response: T) => (error ? reject(error) : resolve(response)));
  });

const client = (url: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });

describe('push notifications (socket)', () => {
  let server: TestServer;
  let push: ReturnType<typeof fakeTransport>;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    push = fakeTransport();
    server = await startTestServer(PUSH_ENV, { push: { transport: push.transport, windowMs: 300 } });
  });

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
    await server.close();
  });

  // Accounts are created through the service and signed in with a session token: the
  // per-IP registration limiter (5 per minute) would otherwise run out across this file.
  const signUp = async (username: string, displayName: string) => {
    const account = await server.ctx.accounts.register({ username, password: 'password123', displayName });
    const socket = await client(server.url);
    sockets.push(socket);
    const auth = once<{ account: { id: string } }>(socket, 'auth:success');
    socket.emit('auth:session', { token: server.ctx.sessions.create(account.id).token });
    return { socket, account: (await auth).account };
  };

  const joinChannel = async (socket: Socket, channelId: string) => {
    const joined = once(socket, 'channel:joined');
    socket.emit('channel:join', channelId);
    await joined;
  };

  it('subscribes, unsubscribes and lists through acknowledgements', async () => {
    const bob = await signUp('bob@example.com', 'Bob');
    const subscribed = await ask<{ success: boolean; subscription: { endpoint: string; userAgent: string | null }; subscriptions: unknown[] }>(
      bob.socket,
      'push:subscribe',
      { ...subscription(1), expirationTime: null, userAgent: 'Firefox 150 on Linux' },
    );
    expect(subscribed.success).toBe(true);
    expect(subscribed.subscription.endpoint).toBe(subscription(1).endpoint);
    expect(subscribed.subscription.userAgent).toBe('Firefox 150 on Linux');
    expect(subscribed.subscriptions).toHaveLength(1);

    const listed = await ask<{ success: boolean; enabled: boolean; subscriptions: Array<{ endpoint: string }> }>(bob.socket, 'push:list');
    expect(listed).toMatchObject({ success: true, enabled: true });
    expect(listed.subscriptions.map((entry) => entry.endpoint)).toEqual([subscription(1).endpoint]);

    const invalid = await ask<{ success: boolean; code: string }>(bob.socket, 'push:subscribe', { endpoint: 'nope', keys: { p256dh: 'a', auth: 'b' } });
    expect(invalid).toMatchObject({ success: false, code: 'PUSH_INVALID' });

    const removed = await ask<{ success: boolean; removed: boolean; subscriptions: unknown[] }>(bob.socket, 'push:unsubscribe', { endpoint: subscription(1).endpoint });
    expect(removed).toMatchObject({ success: true, removed: true, subscriptions: [] });
    expect(await ask<{ removed: boolean }>(bob.socket, 'push:unsubscribe', { endpoint: subscription(1).endpoint })).toMatchObject({ removed: false });

    // Anonymous sockets are refused.
    const anonymous = await client(server.url);
    sockets.push(anonymous);
    expect(await ask<{ success: boolean; code: string }>(anonymous, 'push:subscribe', subscription(2))).toMatchObject({ success: false, code: 'NOT_AUTHENTICATED' });
  });

  it('notifies a direct message only while the recipient is away, once per 30 s window, and the subscription ends with the login', async () => {
    const alice = await signUp('alice@example.com', 'Alice');
    const bob = await signUp('bob@example.com', 'Bob');
    await ask(bob.socket, 'push:subscribe', subscription(1));

    const opened = once<{ channelId: string }>(alice.socket, 'dm:opened');
    alice.socket.emit('dm:open', { accountId: bob.account.id });
    const { channelId } = await opened;
    await joinChannel(alice.socket, channelId);

    // Bob's page is visible: he sees the message himself, no push.
    const seen = once<{ text: string }>(bob.socket, 'chat');
    alice.socket.emit('chat', 'are you there?');
    expect((await seen).text).toBe('are you there?');
    await settle();
    expect(push.deliveries).toHaveLength(0);

    // Bob switches tabs: his page reports itself hidden.
    bob.socket.emit('presence:visibility', { visible: false });
    await waitFor(() => server.ctx.presence.isAttending(bob.account.id) === false);
    alice.socket.emit('chat', 'ping');
    await waitFor(() => push.deliveries.length === 1);
    expect(push.deliveries[0].endpoint).toBe(subscription(1).endpoint);
    expect(push.deliveries[0].payload).toEqual({ title: 'Alice', body: 'ping', url: '/app?channel=' + channelId, tag: 'channel:' + channelId, channelId });

    // A second message in the same conversation right after: no second notification.
    alice.socket.emit('chat', 'ping again');
    await once(bob.socket, 'chat');
    await settle();
    expect(push.deliveries).toHaveLength(1);

    // The sender never notifies themself, and messages in the DM do not notify when Bob is back.
    bob.socket.emit('presence:visibility', { visible: true });
    await waitFor(() => server.ctx.presence.isAttending(bob.account.id) === true);
    await settle(350);
    alice.socket.emit('chat', 'welcome back');
    await once(bob.socket, 'chat');
    await settle();
    expect(push.deliveries).toHaveLength(1);

    // Bob closes the browser: no socket at all means away.
    bob.socket.disconnect();
    await waitFor(() => server.ctx.presence.getSocketsByAccount(bob.account.id).length === 0);
    await settle(350);
    alice.socket.emit('chat', 'still there?');
    await waitFor(() => push.deliveries.length === 2);
    expect(push.deliveries[1].payload.body).toBe('still there?');

    // Bob signs in again on the same browser and signs out: the subscription goes with the login.
    const again = await client(server.url);
    sockets.push(again);
    const authed = once(again, 'auth:success');
    again.emit('auth:login', { username: 'bob@example.com', password: 'password123' });
    await authed;
    await ask(again, 'push:subscribe', subscription(1));
    const out = once(again, 'auth:loggedOut');
    again.emit('auth:logout');
    await out;
    await settle(350);
    alice.socket.emit('chat', 'gone?');
    await settle();
    expect(push.deliveries).toHaveLength(2);
    expect(server.ctx.push.list(bob.account.id)).toHaveLength(0);
  });

  it('notifies @mentions only in channels the recipient may see', async () => {
    // The first account is the admin and can create private channels.
    const alice = await signUp('alice@example.com', 'Alice');
    const bob = await signUp('bob@example.com', 'Bob');
    await ask(bob.socket, 'push:subscribe', subscription(1));
    bob.socket.emit('presence:visibility', { visible: false });
    await waitFor(() => server.ctx.presence.isAttending(bob.account.id) === false);

    const created = once<{ channelId: string }>(alice.socket, 'channels:created');
    alice.socket.emit('channels:create', { name: 'staff', type: 'text', visibility: 'private' });
    const { channelId: privateId } = await created;
    await joinChannel(alice.socket, privateId);
    alice.socket.emit('chat', 'hey @Bob, secret plans');
    await settle(200);
    expect(push.deliveries).toHaveLength(0);

    // Same mention in a public channel: notified, with the channel in the title.
    const general = server.ctx.channels.getByName('general')!;
    await joinChannel(alice.socket, general.id);
    alice.socket.emit('chat', 'hey @bob, lunch?');
    await waitFor(() => push.deliveries.length === 1);
    expect(push.deliveries[0].payload).toMatchObject({ title: 'Alice in #general', body: 'hey @bob, lunch?', url: '/app?channel=' + general.id });

    // A message without a mention, or mentioning someone else, notifies nobody.
    await settle(350);
    alice.socket.emit('chat', 'nothing for bob here');
    alice.socket.emit('chat', '@Bobby is someone else');
    await settle(200);
    expect(push.deliveries).toHaveLength(1);

    // Bob joins the private channel: now the mention reaches him.
    server.ctx.channels.addMember(privateId, bob.account.id, alice.account.id);
    await joinChannel(alice.socket, privateId);
    alice.socket.emit('chat', 'welcome @Bob');
    await waitFor(() => push.deliveries.length === 2);
    expect(push.deliveries[1].payload.title).toBe('Alice in #staff');
  });

  it('runs the notifier without push configured and refuses subscriptions', async () => {
    await server.close();
    server = await startTestServer();
    const bob = await signUp('bob@example.com', 'Bob');
    expect(await ask<{ success: boolean; code: string }>(bob.socket, 'push:subscribe', subscription(1))).toMatchObject({ success: false, code: 'PUSH_DISABLED' });
    expect(await ask<{ success: boolean; enabled: boolean }>(bob.socket, 'push:list')).toMatchObject({ success: true, enabled: false, subscriptions: [] });
    const general = server.ctx.channels.getByName('general')!;
    const message = { id: 'm', channelId: general.id, from: 'X', fromId: null, accountId: null, text: '@Bob', ts: 1, roles: [], isSuperuser: false, edited: false, deleted: false, reactions: [] };
    expect(await notifyMessageRecipients(server.ctx, general, message)).toEqual([]);
  });

  it('sends a test notification to the caller\'s devices on request', async () => {
    const bob = await signUp('bob@example.com', 'Bob');
    expect(await ask<{ success: boolean; code: string }>(bob.socket, 'push:test')).toMatchObject({ success: false, code: 'PUSH_NO_SUBSCRIPTIONS' });
    await ask(bob.socket, 'push:subscribe', subscription(1));
    await ask(bob.socket, 'push:subscribe', subscription(2));
    const result = await ask<{ success: boolean; sent: number }>(bob.socket, 'push:test');
    expect(result).toMatchObject({ success: true, sent: 2, failed: 0, dropped: 0 });
    expect(push.deliveries.map((entry) => entry.payload.title)).toEqual(['Datasetto', 'Datasetto']);
    expect(await ask<{ success: boolean; code: string }>(bob.socket, 'push:test')).toMatchObject({ success: false, code: 'RATE_LIMITED' });
  });
});
