import Database from 'better-sqlite3';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrations, runMigrations } from '../src/db/migrations.js';
import { compileFtsQuery, parseSnippet, type SnippetPart } from '../src/services/search.js';
import { SEARCHES_PER_MINUTE } from '../src/socket/context.js';
import type { AppContext } from '../src/context.js';
import type { ConnectedUser } from '../src/types.js';
import { makeContext, startTestServer, type TestServer } from './helpers.js';

const plain = (snippet: SnippetPart[]) => snippet.map((part) => part.text).join('');
const highlighted = (snippet: SnippetPart[]) => snippet.filter((part) => part.match).map((part) => part.text);

describe('compileFtsQuery', () => {
  it('quotes every term so FTS operators and syntax become plain words', () => {
    expect(compileFtsQuery('hello world')).toBe('"hello" "world"*');
    expect(compileFtsQuery('pizza AND beer')).toBe('"pizza" "AND" "beer"*');
    expect(compileFtsQuery('NOT this OR that')).toBe('"NOT" "this" "OR" "that"*');
    expect(compileFtsQuery('text:secret')).toBe('"text secret"*');
    expect(compileFtsQuery('(a OR b) NEAR(c d, 2)')).toBe('"a" "OR" "b" "NEAR c" "d" "2"*');
    expect(compileFtsQuery('^start +plus -minus')).toBe('"start" "plus" "minus"*');
    expect(compileFtsQuery('don\'t stop')).toBe('"don t" "stop"*');
  });

  it('keeps quoted text as one phrase and never emits a prefix for it', () => {
    expect(compileFtsQuery('"brown fox"')).toBe('"brown fox"');
    expect(compileFtsQuery('"brown fox" jumps')).toBe('"brown fox" "jumps"*');
    expect(compileFtsQuery('"unterminated phrase')).toBe('"unterminated" "phrase"*');
    expect(compileFtsQuery('"" empty')).toBe('"empty"*');
    expect(compileFtsQuery('say ""')).toBe('"say"');
  });

  it('drops queries without a searchable word and caps the number of terms', () => {
    expect(compileFtsQuery('')).toBeNull();
    expect(compileFtsQuery('   ')).toBeNull();
    expect(compileFtsQuery('"" * ( ) : ^ -')).toBeNull();
    expect(compileFtsQuery('🙂 👍')).toBeNull();
    const many = compileFtsQuery(Array.from({ length: 20 }, (_, index) => 'w' + index).join(' '));
    expect(many?.split(' ')).toHaveLength(8);
    expect(compileFtsQuery('x'.repeat(500))?.length).toBeLessThan(210);
  });

  it('splits snippets into plain and highlighted parts', () => {
    expect(parseSnippet('a \u0001b\u0002 c')).toEqual([
      { text: 'a ', match: false },
      { text: 'b', match: true },
      { text: ' c', match: false },
    ]);
    expect(parseSnippet('\u0001only\u0002')).toEqual([{ text: 'only', match: true }]);
    expect(parseSnippet('none')).toEqual([{ text: 'none', match: false }]);
  });
});

/** Five accounts: alice is the first (admin), the others plain users. */
const setup = async () => {
  const ctx = makeContext();
  const register = (username: string, displayName: string) => ctx.accounts.register({ username, password: 'password123', displayName });
  const alice = await register('alice@example.com', 'Alice');
  const bob = await register('bob@example.com', 'Bob');
  const carol = await register('carol@example.com', 'Carol');
  const dave = await register('dave@example.com', 'Dave');
  const eve = await register('eve@example.com', 'Eve');
  ctx.accounts.assignRoles(eve.id, ['superuser']);
  const connected: Record<string, ConnectedUser> = {
    alice: ctx.presence.addUser('s-alice', alice),
    bob: ctx.presence.addUser('s-bob', bob),
    carol: ctx.presence.addUser('s-carol', carol),
    dave: ctx.presence.addUser('s-dave', dave),
    eve: ctx.presence.addUser('s-eve', ctx.accounts.getById(eve.id)!),
  };
  const general = ctx.channels.getByName('general')!;
  const secret = ctx.channels.create({ name: 'secret', type: 'text', visibility: 'private', creatorAccountId: bob.id });
  const dm = ctx.channels.openDm(bob.id, carol.id);
  return { ctx, users: connected, general, secret, dm };
};

/** Search the way the socket handler does: only channels the user may view. */
const searchAs = (ctx: AppContext, user: ConnectedUser, query: string, extra: { authorId?: string | null; limit?: number; offset?: number; channelIds?: string[] } = {}) => {
  const channelIds =
    extra.channelIds ??
    ctx.channels
      .list()
      .filter((channel) => ['text', 'stream', 'dm'].includes(channel.type) && ctx.channels.canAccess(channel, user, 'view'))
      .map((channel) => channel.id);
  return ctx.search.search({ query, channelIds, authorId: extra.authorId, limit: extra.limit, offset: extra.offset });
};

describe('SearchService', () => {
  it('finds messages in public channels, private channels for members and conversations for their participants', async () => {
    const { ctx, users, general, secret, dm } = await setup();
    const pub = ctx.messages.create(general.id, users.bob, 'pineapple on pizza is fine');
    const priv = ctx.messages.create(secret.id, users.bob, 'the pineapple plan stays secret');
    const direct = ctx.messages.create(dm.id, users.bob, 'carol, pineapple tonight?');

    // Dave is a plain user who is not a member of anything: public channels only.
    expect(searchAs(ctx, users.dave, 'pineapple').results.map((hit) => hit.id)).toEqual([pub.id]);
    // Carol shares the DM with Bob but is not in #secret.
    expect(searchAs(ctx, users.carol, 'pineapple').results.map((hit) => hit.id).sort()).toEqual([pub.id, direct.id].sort());
    // Bob sees all three.
    expect(searchAs(ctx, users.bob, 'pineapple').results.map((hit) => hit.id).sort()).toEqual([pub.id, priv.id, direct.id].sort());
    // Admins manage channel permissions and therefore see private channels, but never other people's DMs.
    expect(searchAs(ctx, users.alice, 'pineapple').results.map((hit) => hit.id).sort()).toEqual([pub.id, priv.id].sort());
    // Superusers neither.
    expect(searchAs(ctx, users.eve, 'pineapple').results.map((hit) => hit.id).sort()).toEqual([pub.id, priv.id].sort());
    expect(searchAs(ctx, users.eve, 'pineapple').total).toBe(2);

    // The service itself only searches what it is told to; an outsider's scope can never include the DM.
    expect(searchAs(ctx, users.dave, 'pineapple', { channelIds: [dm.id] }).results.map((hit) => hit.id)).toEqual([direct.id]);

    // Results carry what the panel shows.
    const [hit] = searchAs(ctx, users.dave, 'pineapple').results;
    expect(hit).toMatchObject({ channelId: general.id, authorId: users.bob.accountId, authorName: 'Bob', ts: pub.ts, roles: ['user'], isSuperuser: false });
    expect(plain(hit.snippet)).toBe('pineapple on pizza is fine');
    expect(highlighted(hit.snippet)).toEqual(['pineapple']);
  });

  it('is case and accent insensitive, matches prefixes while typing and highlights every matched term', async () => {
    const { ctx, users, general } = await setup();
    const msg = ctx.messages.create(general.id, users.bob, 'Café crème with the Quick Brown Fox');
    expect(searchAs(ctx, users.dave, 'cafe').results.map((hit) => hit.id)).toEqual([msg.id]);
    expect(searchAs(ctx, users.dave, 'CRÈME').results.map((hit) => hit.id)).toEqual([msg.id]);
    expect(searchAs(ctx, users.dave, 'qui').results.map((hit) => hit.id)).toEqual([msg.id]);
    expect(searchAs(ctx, users.dave, '"brown fox"').results.map((hit) => hit.id)).toEqual([msg.id]);
    expect(searchAs(ctx, users.dave, '"fox brown"').results).toEqual([]);
    expect(searchAs(ctx, users.dave, 'quick fox').results.map((hit) => hit.id)).toEqual([msg.id]);
    expect(highlighted(searchAs(ctx, users.dave, 'quick fox').results[0].snippet)).toEqual(['Quick', 'Fox']);
    expect(searchAs(ctx, users.dave, 'quick zebra').results).toEqual([]);
  });

  it('shortens long messages around the match', async () => {
    const { ctx, users, general } = await setup();
    const words = Array.from({ length: 80 }, (_, index) => 'filler' + index);
    words[50] = 'needle';
    ctx.messages.create(general.id, users.bob, words.join(' '));
    const [hit] = searchAs(ctx, users.dave, 'needle').results;
    const text = plain(hit.snippet);
    expect(text).toContain('needle');
    expect(text.startsWith('…')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThan(200);
    expect(highlighted(hit.snippet)).toEqual(['needle']);
  });

  it('treats FTS syntax in the query as text instead of failing or widening the search', async () => {
    const { ctx, users, general } = await setup();
    const a = ctx.messages.create(general.id, users.bob, 'apples and oranges');
    ctx.messages.create(general.id, users.bob, 'bananas only');
    // With real operators `apples OR bananas` would match both; here OR is a word that nothing contains.
    expect(searchAs(ctx, users.dave, 'apples OR bananas').results).toEqual([]);
    expect(searchAs(ctx, users.dave, 'apples AND oranges').results.map((hit) => hit.id)).toEqual([a.id]);
    for (const nasty of ['"', '""', 'text:bananas', 'apples)', '(bananas', 'NOT apples', 'apples NEAR oranges', '*', 'apples -oranges', '^bananas', "'; DROP TABLE messages; --"]) {
      expect(() => searchAs(ctx, users.dave, nasty)).not.toThrow();
    }
    expect(searchAs(ctx, users.dave, 'text:bananas').results).toEqual([]);
    expect(searchAs(ctx, users.dave, '"').results).toEqual([]);
    expect(ctx.messages.count(general.id)).toBe(2);
  });

  it('drops deleted messages: soft deletes at query time, hard deletes through the triggers', async () => {
    const { ctx, users, general, secret } = await setup();
    const kept = ctx.messages.create(general.id, users.bob, 'keep this walrus');
    const soft = ctx.messages.create(general.id, users.bob, 'walrus to moderate');
    const hard = ctx.messages.create(secret.id, users.bob, 'walrus in a doomed channel');
    expect(searchAs(ctx, users.bob, 'walrus').total).toBe(3);

    ctx.messages.delete(general.id, soft.id, 'Mod');
    expect(searchAs(ctx, users.bob, 'walrus').results.map((hit) => hit.id).sort()).toEqual([kept.id, hard.id].sort());

    ctx.channels.delete(secret.id);
    expect(searchAs(ctx, users.bob, 'walrus').results.map((hit) => hit.id)).toEqual([kept.id]);
    // The soft-deleted tombstone has no text any more, so the index only knows the kept message.
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH '\"walrus\"'").get()).toEqual({ n: 1 });

    // Editing the text re-indexes it.
    ctx.messages.edit(general.id, kept.id, 'now a narwhal');
    expect(searchAs(ctx, users.bob, 'walrus').results).toEqual([]);
    expect(searchAs(ctx, users.bob, 'narwhal').results.map((hit) => hit.id)).toEqual([kept.id]);
  });

  it('forgets pruned messages', async () => {
    const ctx = makeContext({ MESSAGE_RETENTION_PER_CHANNEL: '100' });
    const acct = await ctx.accounts.register({ username: 'a@example.com', password: 'password123', displayName: 'Alice' });
    const author = ctx.presence.addUser('s-1', acct);
    const general = ctx.channels.getByName('general')!;
    for (let index = 0; index < 120; index += 1) ctx.messages.create(general.id, author, 'lobster number ' + index);
    ctx.messages.prune(general.id);
    expect(ctx.messages.count(general.id)).toBe(100);
    const page = ctx.search.search({ query: 'lobster', channelIds: [general.id], limit: 50 });
    expect(page.total).toBe(100);
    expect(ctx.search.search({ query: '"lobster number 0"', channelIds: [general.id] }).results).toEqual([]);
    expect(ctx.search.search({ query: '"lobster number 119"', channelIds: [general.id] }).results).toHaveLength(1);
  });

  it('pages newest first and filters by channel and author', async () => {
    const { ctx, users, general, secret } = await setup();
    const ids: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const author = index % 3 === 0 ? users.carol : users.bob;
      const channel = index % 5 === 0 ? secret : general;
      ids.push(ctx.messages.create(channel.id, author, 'otter sighting ' + index).id);
    }
    const first = searchAs(ctx, users.bob, 'otter', { limit: 10 });
    expect(first.total).toBe(30);
    expect(first.hasMore).toBe(true);
    expect(first.results.map((hit) => hit.id)).toEqual(ids.slice(20).reverse());
    const second = searchAs(ctx, users.bob, 'otter', { limit: 10, offset: 10 });
    expect(second.results.map((hit) => hit.id)).toEqual(ids.slice(10, 20).reverse());
    const last = searchAs(ctx, users.bob, 'otter', { limit: 10, offset: 20 });
    expect(last.hasMore).toBe(false);
    expect(searchAs(ctx, users.bob, 'otter', { limit: 10, offset: 30 }).results).toEqual([]);

    const carolOnly = searchAs(ctx, users.bob, 'otter', { authorId: users.carol.accountId, limit: 50 });
    expect(carolOnly.total).toBe(10);
    expect(carolOnly.results.every((hit) => hit.authorName === 'Carol')).toBe(true);
    const secretOnly = searchAs(ctx, users.bob, 'otter', { channelIds: [secret.id], limit: 50 });
    expect(secretOnly.total).toBe(6);
    expect(secretOnly.results.every((hit) => hit.channelId === secret.id)).toBe(true);
    // Limits are clamped rather than rejected at this level.
    expect(searchAs(ctx, users.bob, 'otter', { limit: 500 }).results).toHaveLength(30);
    expect(searchAs(ctx, users.bob, 'otter', { channelIds: [] }).results).toEqual([]);
  });

  it('indexes the messages that already exist when the migration runs', () => {
    const db = new Database(':memory:');
    for (const migration of migrations.filter((entry) => entry.version <= 8)) db.exec(migration.up);
    db.pragma('user_version = 8');
    db.prepare("INSERT INTO channels (id, name, type, permissions, created_at, updated_at) VALUES ('ch', 'old', 'text', '{}', 1, 1)").run();
    db.prepare("INSERT INTO messages (id, channel_id, author_name, text, created_at) VALUES ('m-old', 'ch', 'Someone', 'ancient mammoth', 1)").run();
    expect(() => db.prepare("SELECT 1 FROM messages_fts").get()).toThrow();
    // Every migration after 8 runs here (later features add their own), the search one among them.
    expect(runMigrations(db)).toBe(migrations.filter((entry) => entry.version > 8).length);
    expect(db.prepare("SELECT m.id FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid WHERE messages_fts MATCH '\"mammoth\"'").all()).toEqual([{ id: 'm-old' }]);
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

interface SearchResponse {
  success: boolean;
  code?: string;
  error?: string;
  results: Array<{ id: string; channelId: string; channelName: string; channelType: string; snippet: SnippetPart[] }>;
  total: number;
  hasMore: boolean;
}

describe('search (socket)', () => {
  let server: TestServer;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
    await server.close();
  });

  // Accounts are created directly (the per-IP registration limit is 5 per minute) and signed in over the socket.
  const signUp = async (username: string, displayName: string) => {
    const created = await server.ctx.accounts.register({ username, password: 'password123', displayName });
    const socket = await client(server.url);
    sockets.push(socket);
    const auth = once<{ account: { id: string } }>(socket, 'auth:success');
    socket.emit('auth:login', { username, password: 'password123' });
    const { account } = await auth;
    expect(account.id).toBe(created.id);
    return { socket, account };
  };

  it('answers over the acknowledgement with only what the caller may read', async () => {
    const admin = await signUp('admin@example.com', 'Admin');
    const bob = await signUp('bob@example.com', 'Bob');
    const carol = await signUp('carol@example.com', 'Carol');
    const dave = await signUp('dave@example.com', 'Dave');
    const { ctx } = server;
    const general = ctx.channels.getByName('general')!;
    const secret = ctx.channels.create({ name: 'secret', type: 'text', visibility: 'private', creatorAccountId: bob.account.id });
    const dm = ctx.channels.openDm(bob.account.id, carol.account.id);
    const bobUser = ctx.presence.getUser(bob.socket.id)!;
    const pub = ctx.messages.create(general.id, bobUser, 'public giraffe');
    const priv = ctx.messages.create(secret.id, bobUser, 'private giraffe');
    const direct = ctx.messages.create(dm.id, bobUser, 'whispered giraffe');

    const asDave = await request<SearchResponse>(dave.socket, 'search', { query: 'giraffe' });
    expect(asDave.success).toBe(true);
    expect(asDave.results.map((hit) => hit.id)).toEqual([pub.id]);
    expect(asDave.results[0]).toMatchObject({ channelName: 'general', channelType: 'text' });

    const asCarol = await request<SearchResponse>(carol.socket, 'search', { query: 'giraffe' });
    expect(asCarol.results.map((hit) => hit.id).sort()).toEqual([pub.id, direct.id].sort());
    expect(asCarol.results.find((hit) => hit.id === direct.id)).toMatchObject({ channelType: 'dm' });

    const asAdmin = await request<SearchResponse>(admin.socket, 'search', { query: 'giraffe' });
    expect(asAdmin.results.map((hit) => hit.id).sort()).toEqual([pub.id, priv.id].sort());

    const asBob = await request<SearchResponse>(bob.socket, 'search', { query: 'giraffe', limit: 2 });
    expect(asBob.total).toBe(3);
    expect(asBob.hasMore).toBe(true);
    expect(asBob.results).toHaveLength(2);

    // Asking for a channel you cannot see is refused; one you can is narrowed to.
    const refused = await request<SearchResponse>(dave.socket, 'search', { query: 'giraffe', channelId: secret.id });
    expect(refused).toMatchObject({ success: false, code: 'FORBIDDEN' });
    const refusedDm = await request<SearchResponse>(admin.socket, 'search', { query: 'giraffe', channelId: dm.id });
    expect(refusedDm).toMatchObject({ success: false, code: 'FORBIDDEN' });
    const missing = await request<SearchResponse>(dave.socket, 'search', { query: 'giraffe', channelId: 'channel-nope' });
    expect(missing).toMatchObject({ success: false, code: 'NOT_FOUND' });
    const narrowed = await request<SearchResponse>(bob.socket, 'search', { query: 'giraffe', channelId: secret.id });
    expect(narrowed.results.map((hit) => hit.id)).toEqual([priv.id]);

    // Validation: too long, wrong types; an empty query is simply empty.
    const tooLong = await request<SearchResponse>(bob.socket, 'search', { query: 'x'.repeat(201) });
    expect(tooLong).toMatchObject({ success: false, code: 'VALIDATION_FAILED' });
    const badLimit = await request<SearchResponse>(bob.socket, 'search', { query: 'giraffe', limit: 1000 });
    expect(badLimit).toMatchObject({ success: false, code: 'VALIDATION_FAILED' });
    const empty = await request<SearchResponse>(bob.socket, 'search', { query: '"" ()' });
    expect(empty).toMatchObject({ success: true, results: [], total: 0 });

    // Without an acknowledgement the answer comes as an event.
    const evented = once<SearchResponse>(dave.socket, 'search:results');
    dave.socket.emit('search', { query: 'giraffe' });
    expect((await evented).results.map((hit) => hit.id)).toEqual([pub.id]);

    // Deleting a message removes it from everyone's results at once.
    const deleted = once(bob.socket, 'chat:messageDeleted');
    bob.socket.emit('chat:delete', { channelId: general.id, messageId: pub.id });
    await deleted;
    expect((await request<SearchResponse>(dave.socket, 'search', { query: 'giraffe' })).results).toEqual([]);
  });

  it('refuses anonymous sockets and rate limits each connection', async () => {
    const anonymous = await client(server.url);
    sockets.push(anonymous);
    expect(await request(anonymous, 'search', { query: 'anything' })).toMatchObject({ success: false, code: 'NOT_AUTHENTICATED' });

    const bob = await signUp('bob@example.com', 'Bob');
    const responses: SearchResponse[] = [];
    for (let index = 0; index < SEARCHES_PER_MINUTE; index += 1) {
      responses.push(await request<SearchResponse>(bob.socket, 'search', { query: 'hello' }));
    }
    expect(responses.every((response) => response.success)).toBe(true);
    const limited = await request<SearchResponse>(bob.socket, 'search', { query: 'hello' });
    expect(limited).toMatchObject({ success: false, code: 'RATE_LIMITED' });
    // Other requests are not affected by the search bucket.
    const stillFine = await request<{ success: boolean }>(bob.socket, 'voice:game:leaderboard', { type: 'slither' });
    expect(stillFine.success).toBe(true);
  });

  it('pages older history before a message the client already has', async () => {
    const bob = await signUp('bob@example.com', 'Bob');
    const carol = await signUp('carol@example.com', 'Carol');
    const { ctx } = server;
    const general = ctx.channels.getByName('general')!;
    const secret = ctx.channels.create({ name: 'secret', type: 'text', visibility: 'private', creatorAccountId: bob.account.id });
    const bobUser = ctx.presence.getUser(bob.socket.id)!;
    const ids: string[] = [];
    for (let index = 0; index < 25; index += 1) ids.push(ctx.messages.create(general.id, bobUser, 'line ' + index).id);
    ctx.messages.delete(general.id, ids[3], 'Mod');
    ctx.messages.addReaction(general.id, ids[1], carol.account.id, '👍');
    const privateId = ctx.messages.create(secret.id, bobUser, 'hidden').id;

    type Page = { success: boolean; code?: string; channelId: string; messages: Array<{ id: string; reactions: Array<{ emoji: string }> }>; hasMore: boolean };
    const first = await request<Page>(carol.socket, 'chat:history:before', { channelId: general.id, beforeMessageId: ids[20], limit: 10 });
    expect(first.success).toBe(true);
    expect(first.hasMore).toBe(true);
    expect(first.messages.map((message) => message.id)).toEqual(ids.slice(10, 20));
    const second = await request<Page>(carol.socket, 'chat:history:before', { channelId: general.id, beforeMessageId: ids[10], limit: 10 });
    // The deleted message keeps its place as a tombstone, so ten remain before index 10 and nothing older exists.
    expect(second.messages.map((message) => message.id)).toEqual(ids.slice(0, 10));
    expect((second.messages[3] as { deleted?: boolean; text?: string }).deleted).toBe(true);
    expect((second.messages[3] as { deleted?: boolean; text?: string }).text).toBe('');
    expect(second.hasMore).toBe(false);
    expect(second.messages.find((message) => message.id === ids[1])?.reactions).toEqual([expect.objectContaining({ emoji: '👍' })]);
    // A deleted message is still a valid cursor; the page before the first message is empty.
    expect((await request<Page>(carol.socket, 'chat:history:before', { channelId: general.id, beforeMessageId: ids[3] })).messages.map((m) => m.id)).toEqual(ids.slice(0, 3));
    expect(await request<Page>(carol.socket, 'chat:history:before', { channelId: general.id, beforeMessageId: ids[0] })).toMatchObject({ success: true, messages: [], hasMore: false });

    // Access checks: the channel must be viewable and the cursor must belong to it.
    expect(await request<Page>(carol.socket, 'chat:history:before', { channelId: secret.id, beforeMessageId: privateId })).toMatchObject({ success: false, code: 'FORBIDDEN' });
    expect(await request<Page>(carol.socket, 'chat:history:before', { channelId: general.id, beforeMessageId: privateId })).toMatchObject({ success: false, code: 'NOT_FOUND' });
    expect(await request<Page>(carol.socket, 'chat:history:before', { channelId: general.id, beforeMessageId: ids[5], limit: 999 })).toMatchObject({ success: false, code: 'VALIDATION_FAILED' });
  });
});
