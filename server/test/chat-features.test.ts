import Database from 'better-sqlite3';
import { io as connect, type Socket } from 'socket.io-client';
import webpush from 'web-push';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrations, runMigrations } from '../src/db/migrations.js';
import { MAX_MENTIONS_PER_MESSAGE, quoteOf, REPLY_QUOTE_LENGTH } from '../src/services/messages.js';
import { resolveMentions } from '../src/services/messageNotifications.js';
import type { PushTransport } from '../src/services/push.js';
import type { AccountRecord, MessageRecord } from '../src/types.js';
import { makeContext, startTestServer, waitFor, type TestServer } from './helpers.js';

const vapid = webpush.generateVAPIDKeys();
const PUSH_ENV = { PUSH_VAPID_PUBLIC_KEY: vapid.publicKey, PUSH_VAPID_PRIVATE_KEY: vapid.privateKey, PUSH_VAPID_SUBJECT: 'mailto:ops@example.com' };

/** What the FTS index itself knows, regardless of the deleted_at filter the search applies. */
const indexed = (ctx: { db: Database.Database }, word: string): number =>
  Number((ctx.db.prepare('SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get('"' + word + '"') as { n: number }).n);

const setup = async () => {
  const ctx = makeContext();
  const register = (username: string, displayName: string) => ctx.accounts.register({ username, password: 'password123', displayName });
  const alice = await register('alice@example.com', 'Alice');
  const bob = await register('bob@example.com', 'Bob');
  const smith = await register('bobsmith@example.com', 'Bob Smith');
  const users = { alice: ctx.presence.addUser('s-alice', alice), bob: ctx.presence.addUser('s-bob', bob), smith: ctx.presence.addUser('s-smith', smith) };
  const general = ctx.channels.getByName('general')!;
  const mentionsIn = (text: string) => resolveMentions(text, ctx.accounts.list());
  return { ctx, alice, bob, smith, users, general, mentionsIn };
};

describe('mentions are resolved against the accounts', () => {
  it('stores each mentioned account with the name the text uses, names with spaces included', async () => {
    const { ctx, alice, bob, smith, mentionsIn } = await setup();
    expect(mentionsIn('hey @Bob and @alice')).toEqual([
      { accountId: alice.id, name: 'Alice' },
      { accountId: bob.id, name: 'Bob' },
    ]);
    // "@Bob Smith" is Bob Smith (and, by its first word, Bob); the username is used when the display name is not.
    expect(mentionsIn('ping @Bob Smith please').map((m) => [m.accountId, m.name])).toEqual([
      [bob.id, 'Bob'],
      [smith.id, 'Bob Smith'],
    ]);
    expect(mentionsIn('ping @bobsmith@example.com')).toEqual([{ accountId: smith.id, name: 'bobsmith@example.com' }]);
    expect(mentionsIn('@Bobby is nobody; bob@example.com is an address')).toEqual([]);
    expect(mentionsIn('no at sign')).toEqual([]);
    // Disabled accounts are not mentionable.
    ctx.accounts.disable(bob.id, 'gone');
    expect(mentionsIn('@Bob?')).toEqual([]);
  });

  it('caps the mentions of one message', async () => {
    const ctx = makeContext();
    const accounts: AccountRecord[] = [];
    for (let index = 0; index < MAX_MENTIONS_PER_MESSAGE + 5; index += 1) {
      accounts.push(await ctx.accounts.register({ username: 'u' + index + '@example.com', password: 'password123', displayName: 'User' + index }));
    }
    const text = accounts.map((account) => '@' + account.displayName).join(' ');
    expect(resolveMentions(text, ctx.accounts.list())).toHaveLength(MAX_MENTIONS_PER_MESSAGE);
  });
});

describe('MessageService: edit, delete, reply and mentions', () => {
  it('edits the text, marks the edit, replaces the mentions and re-indexes the search', async () => {
    const { ctx, users, general, bob, smith, mentionsIn } = await setup();
    const text = 'hello @Bob, see the walrus';
    const message = ctx.messages.create(general.id, users.alice, text, { mentions: mentionsIn(text) });
    expect(message.mentions).toEqual([{ accountId: bob.id, name: 'Bob' }]);
    expect(message.edited).toBe(false);
    expect(message.editedAt).toBeNull();
    expect(indexed(ctx, 'walrus')).toBe(1);

    const next = 'hello @Bob Smith, see the narwhal';
    const edited = ctx.messages.edit(general.id, message.id, next, { mentions: mentionsIn(next) });
    expect(edited).toMatchObject({ id: message.id, text: next, edited: true, deleted: false });
    expect(edited.editedAt).toEqual(expect.any(Number));
    expect(edited.mentions.map((m) => m.accountId).sort()).toEqual([bob.id, smith.id].sort());
    expect(ctx.messages.history(general.id)[0]).toMatchObject({ text: next, edited: true, editedAt: edited.editedAt });
    expect(ctx.db.prepare('SELECT account_id, name FROM message_mentions WHERE message_id = ? ORDER BY name').all(message.id)).toEqual([
      { account_id: bob.id, name: 'Bob' },
      { account_id: smith.id, name: 'Bob Smith' },
    ]);
    expect(indexed(ctx, 'walrus')).toBe(0);
    expect(indexed(ctx, 'narwhal')).toBe(1);

    // The usual text rules apply; a deleted or unknown message cannot be edited.
    expect(() => ctx.messages.edit(general.id, message.id, '   ')).toThrow(/empty/);
    expect(() => ctx.messages.edit(general.id, 'msg-nope', 'x')).toThrow(/not found/);
    ctx.messages.delete(general.id, message.id, 'Alice');
    expect(() => ctx.messages.edit(general.id, message.id, 'back from the dead')).toThrow(/not found/);
  });

  it('keeps or replaces the link card on edit depending on whether the link changed', async () => {
    const { ctx, users, general } = await setup();
    const message = ctx.messages.create(general.id, users.alice, 'see https://a.example.com/', { previewUrl: 'https://a.example.com/' });
    ctx.messages.removePreview(general.id, message.id);
    // Same link after the edit: the card the author took off stays off.
    ctx.messages.edit(general.id, message.id, 'see https://a.example.com/ again', { previewUrl: 'https://a.example.com/' });
    expect(ctx.messages.previewUrlOf(general.id, message.id)).toBeNull();
    // A different link: a card is wanted again.
    ctx.messages.edit(general.id, message.id, 'see https://b.example.com/', { previewUrl: 'https://b.example.com/' });
    expect(ctx.messages.previewUrlOf(general.id, message.id)).toBe('https://b.example.com/');
    // No link any more: nothing to fetch.
    ctx.messages.edit(general.id, message.id, 'no links', { previewUrl: null });
    expect(ctx.messages.previewUrlOf(general.id, message.id)).toBeNull();
  });

  it('deletes into a tombstone that leaves the search index and keeps its place in history', async () => {
    const { ctx, users, general, bob, mentionsIn } = await setup();
    const text = '@Bob the pangolin';
    const first = ctx.messages.create(general.id, users.alice, 'before');
    const message = ctx.messages.create(general.id, users.alice, text, { mentions: mentionsIn(text) });
    const last = ctx.messages.create(general.id, users.alice, 'after');
    ctx.messages.addReaction(general.id, message.id, bob.id, '👍');
    expect(indexed(ctx, 'pangolin')).toBe(1);

    const deleted = ctx.messages.delete(general.id, message.id, 'Alice');
    expect(deleted).toMatchObject({ id: message.id, deleted: true, text: '', mentions: [], reactions: [], attachments: [], preview: null, replyTo: null });
    expect(indexed(ctx, 'pangolin')).toBe(0);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM message_mentions WHERE message_id = ?').get(message.id)).toEqual({ n: 0 });
    expect(ctx.messages.history(general.id).map((m) => [m.id, m.deleted])).toEqual([
      [first.id, false],
      [message.id, true],
      [last.id, false],
    ]);
    const page = ctx.messages.historyBefore(general.id, last.id, 10);
    expect(page.messages.map((m) => [m.id, m.deleted, m.text])).toEqual([
      [first.id, false, 'before'],
      [message.id, true, ''],
    ]);
    // Deleting twice is harmless; the time of the first deletion stays.
    const row = () => ctx.db.prepare('SELECT deleted_at FROM messages WHERE id = ?').get(message.id) as { deleted_at: number };
    const at = row().deleted_at;
    ctx.messages.delete(general.id, message.id, 'Mod');
    expect(row().deleted_at).toBe(at);
  });

  it('quotes the original in a reply, follows its deletion, and survives its pruning', async () => {
    const { ctx, users, general, alice } = await setup();
    const long = 'x'.repeat(REPLY_QUOTE_LENGTH + 50);
    expect(quoteOf('  two\n\nlines  ')).toBe('two lines');
    expect(quoteOf(long)).toHaveLength(REPLY_QUOTE_LENGTH);
    expect(quoteOf(long).endsWith('…')).toBe(true);

    const original = ctx.messages.create(general.id, users.alice, 'the ' + long);
    const reply = ctx.messages.create(general.id, users.bob, 'agreed', { replyToId: original.id });
    expect(reply.replyTo).toEqual({ id: original.id, from: 'Alice', accountId: alice.id, avatarUrl: null, text: quoteOf('the ' + long), deleted: false, pictures: 0 });
    // Hydrated the same way from history, in both directions.
    expect(ctx.messages.history(general.id)[1].replyTo).toEqual(reply.replyTo);
    const later = ctx.messages.create(general.id, users.bob, 'cursor');
    expect(ctx.messages.historyBefore(general.id, later.id, 5).messages[1].replyTo).toEqual(reply.replyTo);
    expect(ctx.messages.get(general.id, reply.id)?.replyTo).toEqual(reply.replyTo);

    // The original is deleted: the quote says so and shows no text.
    ctx.messages.delete(general.id, original.id, 'Alice');
    expect(ctx.messages.get(general.id, reply.id)?.replyTo).toEqual({ id: original.id, from: 'Alice', accountId: alice.id, avatarUrl: null, text: '', deleted: true, pictures: 0 });
    // The reply itself deleted: a tombstone has no quote.
    ctx.messages.delete(general.id, reply.id, 'Bob');
    expect(ctx.messages.get(general.id, reply.id)?.replyTo).toBeNull();

    // The original's row is gone (pruned): the quote is a placeholder.
    const gone = ctx.messages.create(general.id, users.alice, 'soon pruned');
    const orphan = ctx.messages.create(general.id, users.bob, 'orphan', { replyToId: gone.id });
    ctx.db.prepare('DELETE FROM messages WHERE id = ?').run(gone.id);
    expect(ctx.messages.get(general.id, orphan.id)?.replyTo).toEqual({ id: gone.id, from: null, accountId: null, avatarUrl: null, text: '', deleted: true, pictures: 0 });
  });
});

describe('migration 13', () => {
  it('upgrades a version-12 database: new columns and table, old tombstones leave the search index', () => {
    const db = new Database(':memory:');
    for (const migration of migrations.filter((entry) => entry.version <= 12)) db.exec(migration.up);
    db.pragma('user_version = 12');
    db.prepare("INSERT INTO channels (id, name, type, permissions, created_at, updated_at) VALUES ('ch', 'old', 'text', '{}', 1, 1)").run();
    db.prepare("INSERT INTO messages (id, channel_id, author_name, text, created_at) VALUES ('m-kept', 'ch', 'A', 'kept quokka', 1)").run();
    db.prepare("INSERT INTO messages (id, channel_id, author_name, text, created_at, deleted_at) VALUES ('m-gone', 'ch', 'A', 'deleted quokka', 2, 3)").run();
    db.prepare("INSERT INTO accounts (id, username, display_name, password_hash, created_at, updated_at) VALUES ('a1', 'a@example.com', 'A', 'x', 1, 1)").run();
    db.prepare("INSERT INTO push_subscriptions (id, account_id, endpoint, p256dh, auth, created_at) VALUES ('p1', 'a1', 'https://push.example.com/1', 'k', 'a', 1)").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH '\"quokka\"'").get()).toEqual({ n: 2 });

    expect(runMigrations(db)).toBe(migrations.filter((entry) => entry.version > 12).length);
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(13);
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH '\"quokka\"'").get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT text, reply_to_id FROM messages WHERE id = ?').get('m-gone')).toEqual({ text: '', reply_to_id: null });
    expect(db.prepare('SELECT text FROM messages WHERE id = ?').get('m-kept')).toEqual({ text: 'kept quokka' });
    expect(db.prepare('SELECT notify_mentions, notify_dms FROM push_subscriptions WHERE id = ?').get('p1')).toEqual({ notify_mentions: 1, notify_dms: 1 });
    db.prepare("INSERT INTO message_mentions (message_id, account_id, name) VALUES ('m-kept', 'a1', 'A')").run();
    db.prepare("DELETE FROM messages WHERE id = 'm-kept'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM message_mentions').get()).toEqual({ n: 0 });
    db.close();
  });
});

// ---------------------------------------------------------------- socket

const once = <T = unknown>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ' + event)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const request = <T = Record<string, unknown>>(socket: Socket, event: string, payload: unknown, timeoutMs = 3000): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ack of ' + event)), timeoutMs);
    socket.emit(event, payload, (response: T) => {
      clearTimeout(timer);
      resolve(response);
    });
  });

const client = (url: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });

interface Delivery {
  endpoint: string;
  payload: { title: string; body: string; channelId: string | null };
}

interface Ack {
  success: boolean;
  error?: string;
  code?: string;
  messageId?: string;
  editedAt?: number;
}

interface Updated {
  channelId: string;
  messageId: string;
  text?: string;
  edited?: boolean;
  editedAt?: number | null;
  mentions?: Array<{ accountId: string; name: string }>;
}

describe('chat features (socket)', () => {
  let server: TestServer;
  const sockets: Socket[] = [];
  const deliveries: Delivery[] = [];
  const transport: PushTransport = async (subscription, payload) => {
    deliveries.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
    return { statusCode: 201, body: '', headers: {} };
  };

  beforeEach(async () => {
    deliveries.length = 0;
    server = await startTestServer(PUSH_ENV, { push: { transport, windowMs: 50 } });
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.disconnect();
    await server.close();
  });

  // Accounts are made directly (the registration limiter is per IP and shared by every test); the socket signs in with a session.
  const signUp = async (username: string, displayName: string) => {
    const account = await server.ctx.accounts.register({ username, password: 'password123', displayName });
    const socket = await client(server.url);
    sockets.push(socket);
    const auth = once<{ account: { id: string } }>(socket, 'auth:success');
    const session = server.ctx.sessions.create(account.id);
    socket.emit('auth:session', { token: session.token });
    return { socket, account: (await auth).account, session };
  };

  const joinChannel = async (socket: Socket, channelId: string) => {
    const joined = once(socket, 'channel:joined');
    socket.emit('channel:join', channelId);
    await joined;
  };

  let sends = 0;
  /** Send and wait for this message's own echo (other people's messages may still be arriving on the socket). */
  const send = async (socket: Socket, channelId: string, text: string, extra: Record<string, unknown> = {}) => {
    const clientId = (extra.clientId as string | undefined) ?? 'c-' + (sends += 1);
    const echo = new Promise<MessageRecord>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for the echo')), 3000);
      const handler = (message: MessageRecord & { clientId?: string }) => {
        if (message.clientId !== clientId) return;
        clearTimeout(timer);
        socket.off('chat', handler);
        resolve(message);
      };
      socket.on('chat', handler);
    });
    const ack = await request<Ack>(socket, 'chat', { channelId, text, ...extra, clientId });
    expect(ack.success).toBe(true);
    return { ack, message: await echo };
  };

  const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

  it('lets the author edit, tells viewers, re-indexes the search and refuses everyone else', async () => {
    const alice = await signUp('alice@example.com', 'Alice'); // first account: admin
    const bob = await signUp('bob@example.com', 'Bob');
    const carol = await signUp('carol@example.com', 'Carol');
    const general = server.ctx.channels.getByName('general')!;
    for (const { socket } of [alice, bob, carol]) await joinChannel(socket, general.id);

    const { message } = await send(bob.socket, general.id, 'the first wombat');
    expect(message.edited).toBe(false);

    const seen = once<Updated>(carol.socket, 'chat:messageUpdated');
    const ack = await request<Ack>(bob.socket, 'chat:edit', { channelId: general.id, messageId: message.id, text: 'the second wombat, @Carol' });
    expect(ack).toMatchObject({ success: true, messageId: message.id });
    expect(ack.editedAt).toEqual(expect.any(Number));
    expect(await seen).toEqual({
      channelId: general.id,
      messageId: message.id,
      text: 'the second wombat, @Carol',
      edited: true,
      editedAt: ack.editedAt,
      mentions: [{ accountId: carol.account.id, name: 'Carol' }],
      preview: null,
    });
    expect(server.ctx.messages.get(general.id, message.id)).toMatchObject({ text: 'the second wombat, @Carol', edited: true });
    const search = (query: string) => server.ctx.search.search({ query, channelIds: [general.id] }).results.map((hit) => hit.id);
    expect(search('first')).toEqual([]);
    expect(search('second')).toEqual([message.id]);

    // Not the author: refused, admins included. Unknown message: not found. Bad text: validation.
    expect(await request<Ack>(alice.socket, 'chat:edit', { channelId: general.id, messageId: message.id, text: 'admin rewrite' })).toMatchObject({ success: false, code: 'FORBIDDEN' });
    expect(await request<Ack>(carol.socket, 'chat:edit', { channelId: general.id, messageId: message.id, text: 'other rewrite' })).toMatchObject({ success: false, code: 'FORBIDDEN' });
    expect(await request<Ack>(bob.socket, 'chat:edit', { channelId: general.id, messageId: 'msg-nope', text: 'x' })).toMatchObject({ success: false, code: 'NOT_FOUND' });
    expect(await request<Ack>(bob.socket, 'chat:edit', { channelId: general.id, messageId: message.id, text: '   ' })).toMatchObject({ success: false, code: 'VALIDATION_FAILED' });
    expect(server.ctx.messages.get(general.id, message.id)?.text).toBe('the second wombat, @Carol');

    // After a deletion the edit is refused too.
    bob.socket.emit('chat:delete', { channelId: general.id, messageId: message.id });
    await once(carol.socket, 'chat:messageDeleted');
    expect(await request<Ack>(bob.socket, 'chat:edit', { channelId: general.id, messageId: message.id, text: 'undo' })).toMatchObject({ success: false, code: 'NOT_FOUND' });
  });

  it('deletes own messages, lets admins delete any, refuses other users, and serves tombstones in history', async () => {
    const alice = await signUp('alice@example.com', 'Alice'); // admin
    const bob = await signUp('bob@example.com', 'Bob');
    const carol = await signUp('carol@example.com', 'Carol');
    const general = server.ctx.channels.getByName('general')!;
    for (const { socket } of [alice, bob, carol]) await joinChannel(socket, general.id);

    const own = (await send(bob.socket, general.id, 'my own axolotl')).message;
    const other = (await send(bob.socket, general.id, 'for the admin')).message;
    const kept = (await send(bob.socket, general.id, 'stays')).message;

    // A plain user cannot delete someone else's message.
    expect(await request<Ack>(carol.socket, 'chat:delete', { channelId: general.id, messageId: own.id })).toMatchObject({ success: false, code: 'FORBIDDEN' });
    expect(server.ctx.messages.get(general.id, own.id)?.deleted).toBe(false);

    const gone = once<{ messageId: string; channelId: string; deletedBy: string }>(carol.socket, 'chat:messageDeleted');
    bob.socket.emit('chat:delete', { channelId: general.id, messageId: own.id });
    expect(await gone).toEqual({ messageId: own.id, channelId: general.id, deletedBy: 'Bob' });
    expect(server.ctx.search.search({ query: 'axolotl', channelIds: [general.id] }).total).toBe(0);
    expect(indexed(server.ctx, 'axolotl')).toBe(0);

    const byAdmin = once<{ messageId: string; deletedBy: string }>(bob.socket, 'chat:messageDeleted');
    alice.socket.emit('chat:delete', { channelId: general.id, messageId: other.id });
    expect(await byAdmin).toMatchObject({ messageId: other.id, deletedBy: 'Alice' });

    // A fresh join serves the tombstones in place, without text.
    const history = once<MessageRecord[]>(carol.socket, 'chat:history');
    carol.socket.emit('channel:join', general.id);
    const list = (await history).filter((entry) => [own.id, other.id, kept.id].includes(entry.id));
    expect(list.map((entry) => [entry.id, entry.deleted, entry.text])).toEqual([
      [own.id, true, ''],
      [other.id, true, ''],
      [kept.id, false, 'stays'],
    ]);
  });

  it('carries the quote of a reply and refuses replies to missing or deleted messages', async () => {
    const alice = await signUp('alice@example.com', 'Alice');
    const bob = await signUp('bob@example.com', 'Bob');
    const general = server.ctx.channels.getByName('general')!;
    for (const { socket } of [alice, bob]) await joinChannel(socket, general.id);

    const original = (await send(alice.socket, general.id, 'shall we play?')).message;
    const seen = once<MessageRecord>(alice.socket, 'chat');
    const { ack, message } = await send(bob.socket, general.id, 'yes!', { replyToId: original.id, clientId: 'c-1' });
    expect(ack).toMatchObject({ clientId: 'c-1' });
    expect(message.replyTo).toEqual({ id: original.id, from: 'Alice', accountId: alice.account.id, avatarUrl: null, text: 'shall we play?', deleted: false, pictures: 0 });
    expect((await seen).replyTo).toEqual(message.replyTo);

    expect(await request<Ack>(bob.socket, 'chat', { channelId: general.id, text: 'x', replyToId: 'msg-nope' })).toMatchObject({ success: false, code: 'REPLY_TARGET_MISSING' });
    // The original must be in the same channel.
    const random = server.ctx.channels.getByName('announcements')!;
    expect(await request<Ack>(bob.socket, 'chat', { channelId: random.id, text: 'x', replyToId: original.id })).toMatchObject({ success: false, code: 'REPLY_TARGET_MISSING' });
    alice.socket.emit('chat:delete', { channelId: general.id, messageId: original.id });
    await once(bob.socket, 'chat:messageDeleted');
    expect(await request<Ack>(bob.socket, 'chat', { channelId: general.id, text: 'too late', replyToId: original.id })).toMatchObject({ success: false, code: 'REPLY_TARGET_MISSING' });
    // The earlier reply now quotes a deleted message.
    expect(server.ctx.messages.get(general.id, message.id)?.replyTo).toMatchObject({ id: original.id, deleted: true, text: '' });
  });

  it('resolves mentions when sending and editing and pushes them to devices that want mentions', async () => {
    const alice = await signUp('alice@example.com', 'Alice');
    const bob = await signUp('bob@example.com', 'Bob');
    const carol = await signUp('carol@example.com', 'Carol');
    const general = server.ctx.channels.getByName('general')!;
    for (const { socket } of [alice, bob, carol]) await joinChannel(socket, general.id);
    // Bob's phone wants mentions, Carol's laptop does not; both pages are hidden.
    server.ctx.push.subscribe(bob.account.id, bob.session.tokenHash, { endpoint: 'https://push.example.com/bob', keys: { p256dh: 'BKey'.padEnd(24, '_'), auth: 'auth1' } });
    server.ctx.push.subscribe(carol.account.id, carol.session.tokenHash, {
      endpoint: 'https://push.example.com/carol',
      keys: { p256dh: 'BKey'.padEnd(24, '_'), auth: 'auth2' },
      preferences: { mentions: false },
    });
    bob.socket.emit('presence:visibility', { visible: false });
    carol.socket.emit('presence:visibility', { visible: false });
    await settle();

    const { message } = await send(alice.socket, general.id, 'hey @Bob and @Carol, lunch?');
    expect(message.mentions).toEqual([
      { accountId: bob.account.id, name: 'Bob' },
      { accountId: carol.account.id, name: 'Carol' },
    ]);
    await waitFor(() => deliveries.length === 1);
    await settle();
    expect(deliveries.map((d) => d.endpoint)).toEqual(['https://push.example.com/bob']);
    expect(deliveries[0].payload).toMatchObject({ title: 'Alice in #general', body: 'hey @Bob and @Carol, lunch?', channelId: general.id });

    // Carol switches mentions on from her settings (the subscription is sent again with the choice).
    const resub = await request<{ success: boolean; subscription: { preferences: { mentions: boolean; dms: boolean } } }>(carol.socket, 'push:subscribe', {
      endpoint: 'https://push.example.com/carol',
      keys: { p256dh: 'BKey'.padEnd(24, '_'), auth: 'auth2' },
      preferences: { mentions: true, dms: false },
    });
    expect(resub.subscription.preferences).toEqual({ mentions: true, dms: false });

    // An edit that adds a mention tells the newly mentioned person only; Bob was told already.
    await settle(60);
    deliveries.length = 0;
    const updated = once<Updated>(bob.socket, 'chat:messageUpdated');
    const plain = await request<Ack>(alice.socket, 'chat:edit', { channelId: general.id, messageId: message.id, text: 'hey @Bob, lunch? (@Carol too)' });
    expect(plain.success).toBe(true);
    expect((await updated).mentions?.map((m) => m.name)).toEqual(['Bob', 'Carol']);
    // Carol was mentioned before the edit as well: nothing new to tell her, nothing for Bob either.
    await settle(150);
    expect(deliveries).toEqual([]);
    const added = await request<Ack>(alice.socket, 'chat:edit', { channelId: general.id, messageId: message.id, text: 'lunch @Carol?' });
    expect(added.success).toBe(true);
    await settle(150);
    expect(deliveries).toEqual([]);
    // Dave was never mentioned: an edit that brings him in notifies him.
    const dave = await signUp('dave@example.com', 'Dave');
    server.ctx.push.subscribe(dave.account.id, dave.session.tokenHash, { endpoint: 'https://push.example.com/dave', keys: { p256dh: 'BKey'.padEnd(24, '_'), auth: 'auth3' } });
    dave.socket.emit('presence:visibility', { visible: false });
    await settle();
    expect((await request<Ack>(alice.socket, 'chat:edit', { channelId: general.id, messageId: message.id, text: 'lunch @Carol and @Dave?' })).success).toBe(true);
    await waitFor(() => deliveries.length === 1);
    expect(deliveries[0]).toMatchObject({ endpoint: 'https://push.example.com/dave', payload: { body: 'lunch @Carol and @Dave?' } });

    // A device that switched direct messages off hears nothing about them, mentions still arrive.
    deliveries.length = 0;
    const opened = once<{ channelId: string }>(alice.socket, 'dm:opened');
    alice.socket.emit('dm:open', { accountId: carol.account.id });
    const dm = (await opened).channelId;
    await joinChannel(alice.socket, dm);
    await send(alice.socket, dm, 'private hello');
    await settle(150);
    expect(deliveries).toEqual([]);
  });

  it('lists the people who can read a channel for the mention autocomplete', async () => {
    const alice = await signUp('alice@example.com', 'Alice'); // admin
    const bob = await signUp('bob@example.com', 'Bob');
    const carol = await signUp('carol@example.com', 'Carol');
    const general = server.ctx.channels.getByName('general')!;
    const secret = server.ctx.channels.create({ name: 'secret', type: 'text', visibility: 'private', creatorAccountId: bob.account.id });
    const dm = server.ctx.channels.openDm(bob.account.id, carol.account.id);
    type Members = { success: boolean; code?: string; channelId?: string; members?: Array<{ accountId: string; displayName: string; username: string; avatarUrl: string | null; roles: string[] }> };
    const names = (response: Members) => response.members?.map((member) => member.displayName);

    const everyone = await request<Members>(carol.socket, 'channel:members', { channelId: general.id });
    expect(everyone.success).toBe(true);
    expect(names(everyone)).toEqual(['Alice', 'Bob', 'Carol']);
    expect(everyone.members?.[0]).toEqual({ accountId: alice.account.id, displayName: 'Alice', username: 'alice@example.com', avatarUrl: null, roles: ['admin'] });

    // A private channel: its member and the admin who can see it; outsiders are refused.
    expect(names(await request<Members>(bob.socket, 'channel:members', { channelId: secret.id }))).toEqual(['Alice', 'Bob']);
    expect(await request<Members>(carol.socket, 'channel:members', { channelId: secret.id })).toMatchObject({ success: false, code: 'FORBIDDEN' });
    // A conversation: the two participants.
    expect(names(await request<Members>(carol.socket, 'channel:members', { channelId: dm.id }))).toEqual(['Bob', 'Carol']);
    expect(await request<Members>(alice.socket, 'channel:members', { channelId: dm.id })).toMatchObject({ success: false, code: 'FORBIDDEN' });
    expect(await request<Members>(alice.socket, 'channel:members', { channelId: 'channel-nope' })).toMatchObject({ success: false, code: 'NOT_FOUND' });
    expect(await request<Members>(alice.socket, 'channel:members', { channelId: server.ctx.channels.getByName('lobby')!.id })).toMatchObject({ success: false, code: 'CHAT_NOT_SUPPORTED' });
    // Disabled and banned accounts are left out.
    server.ctx.accounts.disable(carol.account.id, 'away');
    server.ctx.moderation.ban(bob.account.id, 'rude', 'Alice');
    expect(names(await request<Members>(alice.socket, 'channel:members', { channelId: general.id }))).toEqual(['Alice']);
  });
});
