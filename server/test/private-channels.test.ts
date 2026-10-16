import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { ChannelService } from '../src/services/channels.js';
import { makeConfig, makeContext, startTestServer, type TestServer } from './helpers.js';

const subject = (roles: string[], accountId: string | null = 'acct-1') => ({ accountId, roles, isSuperuser: roles.includes('superuser') });

/** channel_members references accounts, so tests need real rows. Returns ids keyed by the requested alias. */
const accounts = async (ctx: { accounts: { register: (input: { username: string; password: string }) => Promise<{ id: string }> } }, ...aliases: string[]) => {
  const ids: Record<string, string> = {};
  for (const alias of aliases) ids[alias] = (await ctx.accounts.register({ username: alias + '@example.com', password: 'password123' })).id;
  return ids;
};

/** Resolve once `socket` receives `event` with a payload the predicate accepts (earlier payloads are skipped). */
const waitForEvent = <T>(socket: Socket, event: string, predicate: (payload: T) => boolean, timeoutMs = 3000): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error('timeout waiting for ' + event));
    }, timeoutMs);
    const handler = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });

describe('private channels (service)', () => {
  it('hides private channels from non-members and lets members and admins in', async () => {
    const ctx = makeContext();
    const ids = await accounts(ctx, 'acct-owner', 'acct-1', 'acct-2', 'acct-3');
    const hash = await ChannelService.hashPassword('secret-1');
    const channel = ctx.channels.create({ name: 'inner-circle', type: 'text', visibility: 'private', topic: ' Plans ', joinPasswordHash: hash, creatorAccountId: ids['acct-owner'] });
    expect(channel.visibility).toBe('private');
    expect(channel.topic).toBe('Plans');
    expect(channel.joinPasswordHash).toBe(hash);
    expect(ctx.channels.isMember(channel.id, ids['acct-owner'])).toBe(true);
    expect(ctx.channels.memberCount(channel.id)).toBe(1);

    expect(ctx.channels.canAccess(channel, subject(['user'], ids['acct-1']), 'view')).toBe(false);
    expect(ctx.channels.canAccess(channel, subject(['user'], ids['acct-1']), 'chat')).toBe(false);
    expect(ctx.channels.canAccess(channel, subject(['moderator'], ids['acct-1']), 'view')).toBe(false);
    expect(ctx.channels.canAccess(channel.id, subject(['user'], ids['acct-owner']), 'view')).toBe(true);
    expect(ctx.channels.canAccess(channel, subject(['user'], ids['acct-owner']), 'chat')).toBe(true);
    expect(ctx.channels.canAccess(channel, subject(['admin'], ids['acct-2']), 'view')).toBe(true);
    expect(ctx.channels.canAccess(channel, subject(['superuser'], ids['acct-3']), 'view')).toBe(true);

    // Membership and role permissions combine: a member still needs the action's role.
    ctx.channels.updatePermissions(channel.id, { chat: { roles: ['admin'] } });
    expect(ctx.channels.canAccess(channel.id, subject(['user'], ids['acct-owner']), 'view')).toBe(true);
    expect(ctx.channels.canAccess(channel.id, subject(['user'], ids['acct-owner']), 'chat')).toBe(false);

    const view = ctx.presence.channelView(channel, ctx.channels.memberCount(channel.id));
    expect(view).toMatchObject({ visibility: 'private', hasPassword: true, memberCount: 1, topic: 'Plans' });
    expect(JSON.stringify(view)).not.toContain(hash);
  });

  it('joins with the right password only, and keeps members across a reopen', async () => {
    const config = makeConfig();
    const db = openDatabase(':memory:', { memory: true });
    const service = new ChannelService(db, config);
    service.seedDefaults();
    const { AccountService } = await import('../src/services/accounts.js');
    const acct = (await new AccountService(db, config).register({ username: 'a@example.com', password: 'password123' })).id;
    const channel = service.create({ name: 'club', type: 'text', visibility: 'private', joinPasswordHash: await ChannelService.hashPassword('open-sesame') });

    await expect(service.joinWithPassword('club', acct, 'wrong')).rejects.toThrow(/name and password/);
    await expect(service.joinWithPassword('nope', acct, 'open-sesame')).rejects.toThrow(/name and password/);
    await expect(service.joinWithPassword('general', acct, 'open-sesame')).rejects.toThrow(/name and password/);
    await expect(service.joinWithPassword('CLUB', acct, 'open-sesame')).resolves.toMatchObject({ id: channel.id });
    expect(service.isMember(channel.id, acct)).toBe(true);

    const reopened = new ChannelService(db, config);
    expect(reopened.isMember(channel.id, acct)).toBe(true);
    expect(reopened.get(channel.id)?.joinPasswordHash).toBe(channel.joinPasswordHash);
    expect(reopened.listMembers(channel.id).map((m) => m.accountId)).toEqual([acct]);
  });

  it('manages members, rejects passwords on public channels and clears members when a channel goes public', async () => {
    const ctx = makeContext();
    const ids = await accounts(ctx, 'acct-1', 'acct-2', 'acct-3', 'acct-9', 'acct-admin');
    await expect(ChannelService.hashPassword('abc')).rejects.toThrow(/at least 4/);
    expect(() => ctx.channels.create({ name: 'pub', type: 'text', joinPasswordHash: 'x' })).toThrow(/Only private/);
    const pub = ctx.channels.create({ name: 'pub', type: 'text' });
    expect(() => ctx.channels.addMember(pub.id, ids['acct-1'])).toThrow(/Only private/);

    const priv = ctx.channels.create({ name: 'priv', type: 'voice', visibility: 'private' });
    ctx.channels.addMember(priv.id, ids['acct-1'], ids['acct-admin']);
    ctx.channels.addMember(priv.id, ids['acct-1'], ids['acct-admin']);
    ctx.channels.addMember(priv.id, ids['acct-2'], ids['acct-admin']);
    expect(ctx.channels.listMembers(priv.id).map((m) => [m.accountId, m.addedBy])).toEqual([
      [ids['acct-1'], ids['acct-admin']],
      [ids['acct-2'], ids['acct-admin']],
    ]);
    expect(ctx.channels.channelsOfMember(ids['acct-2']).map((c) => c.id)).toEqual([priv.id]);
    expect(ctx.channels.removeMember(priv.id, ids['acct-1'])).toBe(true);
    expect(ctx.channels.removeMember(priv.id, ids['acct-1'])).toBe(false);
    expect(ctx.channels.canAccess(priv, subject(['user'], ids['acct-1']), 'voice')).toBe(false);
    expect(ctx.channels.canAccess(priv, subject(['user'], ids['acct-2']), 'voice')).toBe(true);

    const updated = ctx.channels.update(priv.id, { visibility: 'public', topic: 'now open' });
    expect(updated).toMatchObject({ visibility: 'public', topic: 'now open', joinPasswordHash: null });
    expect(ctx.channels.memberCount(priv.id)).toBe(0);
    expect(ctx.channels.canAccess(priv.id, subject(['user'], ids['acct-9']), 'view')).toBe(true);

    ctx.channels.addMember(ctx.channels.update(priv.id, { visibility: 'private' }).id, ids['acct-3']);
    ctx.channels.delete(priv.id);
    expect(ctx.channels.channelsOfMember(ids['acct-3'])).toEqual([]);
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM channel_members').get() as { n: number }).n).toBe(0);
  });
});

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

interface ChannelsUpdate {
  channels: Array<{ id: string; name: string; visibility: string; hasPassword: boolean; memberCount: number }>;
}

describe('private channels (socket)', () => {
  let server: TestServer;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
    await server.close();
  });

  const signUp = async (username: string, displayName: string) => {
    const socket = await client(server.url);
    sockets.push(socket);
    const auth = once<{ account: { id: string } }>(socket, 'auth:success');
    socket.emit('auth:register', { username, password: 'password123', profile: { displayName } });
    return { socket, account: (await auth).account };
  };

  it('creates a private channel through the flow, hides it until the password is entered, and admins manage members', async () => {
    const admin = await signUp('admin@example.com', 'Admin');
    const bob = await signUp('bob@example.com', 'Bob');
    const carol = await signUp('carol@example.com', 'Carol');

    // Public channels cannot take a password.
    const rejected = once<{ code: string }>(admin.socket, 'error');
    admin.socket.emit('channels:create', { name: 'oops', type: 'text', password: 'secret-1' });
    expect((await rejected).code).toBe('PASSWORD_ON_PUBLIC_CHANNEL');

    const created = once<{ channelId: string; channelName: string }>(admin.socket, 'channels:created');
    const bobList = once<ChannelsUpdate>(bob.socket, 'channels:update');
    admin.socket.emit('channels:create', { name: 'vip', type: 'text', topic: 'Members only', visibility: 'private', password: 'secret-1' });
    const { channelId } = await created;
    expect((await bobList).channels.some((c) => c.id === channelId)).toBe(false);
    const channel = server.ctx.channels.get(channelId)!;
    expect(channel.visibility).toBe('private');
    expect(server.ctx.channels.isMember(channelId, admin.account.id)).toBe(true);

    // Bob cannot open or chat in it.
    const denied = once<{ code: string }>(bob.socket, 'error');
    bob.socket.emit('channel:join', channelId);
    expect((await denied).code).toBe('FORBIDDEN');

    // Wrong password, then the right one.
    const wrong = once<{ code: string }>(bob.socket, 'error');
    bob.socket.emit('channels:joinPrivate', { name: 'vip', password: 'nope' });
    expect((await wrong).code).toBe('CHANNEL_JOIN_INVALID');
    const joined = once<{ channelId: string }>(bob.socket, 'channels:privateJoined');
    const bobList2 = once<ChannelsUpdate>(bob.socket, 'channels:update');
    bob.socket.emit('channels:joinPrivate', { name: 'VIP', password: 'secret-1' });
    expect((await joined).channelId).toBe(channelId);
    const visible = (await bobList2).channels.find((c) => c.id === channelId)!;
    expect(visible).toMatchObject({ visibility: 'private', hasPassword: true, memberCount: 2 });

    // Messages in the private channel reach members only.
    const bobJoined = once(bob.socket, 'channel:joined');
    bob.socket.emit('channel:join', channelId);
    await bobJoined;
    const adminSees = once<{ text: string }>(admin.socket, 'chat');
    const carolSees = once(carol.socket, 'chat', 300);
    bob.socket.emit('chat', 'hello vips');
    expect((await adminSees).text).toBe('hello vips');
    await expect(carolSees).rejects.toThrow('timeout');

    // Admin adds Carol, who then sees the channel, then removes Bob, who loses it.
    const members = once<{ channelId: string; members: Array<{ accountId: string; displayName: string }> }>(admin.socket, 'admin:channels:members');
    const carolList = once<ChannelsUpdate>(carol.socket, 'channels:update');
    admin.socket.emit('admin:channels:members:add', { channelId, accountId: carol.account.id });
    expect((await members).members.map((m) => m.displayName).sort()).toEqual(['Admin', 'Bob', 'Carol']);
    expect((await carolList).channels.some((c) => c.id === channelId)).toBe(true);

    const bobRemoved = once<{ channelId: string; reason?: string }>(bob.socket, 'channel:deleted');
    const bobList3 = once<ChannelsUpdate>(bob.socket, 'channels:update');
    admin.socket.emit('admin:channels:members:remove', { channelId, accountId: bob.account.id });
    expect(await bobRemoved).toMatchObject({ channelId, reason: 'removed' });
    expect((await bobList3).channels.some((c) => c.id === channelId)).toBe(false);
    expect(server.ctx.presence.channelMemberCount(channelId)).toBe(0);

    // Non-admins cannot manage members or edit channels.
    const forbidden = once<{ code: string }>(carol.socket, 'admin:error');
    carol.socket.emit('admin:channels:members:add', { channelId, accountId: bob.account.id });
    expect((await forbidden).code).toBe('FORBIDDEN');
    const forbiddenEdit = once<{ code: string }>(carol.socket, 'error');
    carol.socket.emit('channels:update', { channelId, visibility: 'public' });
    expect((await forbiddenEdit).code).toBe('FORBIDDEN');

    // Admin changes the password; the old one stops working, then makes the channel public.
    const updated = once(admin.socket, 'channels:updated');
    admin.socket.emit('channels:update', { channelId, password: 'secret-2', topic: 'New topic' });
    await updated;
    const stale = once<{ code: string }>(bob.socket, 'error');
    bob.socket.emit('channels:joinPrivate', { name: 'vip', password: 'secret-1' });
    expect((await stale).code).toBe('CHANNEL_JOIN_INVALID');
    const fresh = once(bob.socket, 'channels:privateJoined');
    bob.socket.emit('channels:joinPrivate', { name: 'vip', password: 'secret-2' });
    await fresh;

    const everyone = waitForEvent<ChannelsUpdate>(carol.socket, 'channels:update', (list) => list.channels.some((c) => c.id === channelId && c.visibility === 'public'));
    admin.socket.emit('channels:update', { channelId, visibility: 'public' });
    const pub = (await everyone).channels.find((c) => c.id === channelId)!;
    expect(pub).toMatchObject({ visibility: 'public', hasPassword: false, memberCount: 0 });
    expect(server.ctx.channels.get(channelId)?.topic).toBe('New topic');
  });

  it('validates the join payload', async () => {
    const bob = await signUp('bob@example.com', 'Bob');
    const invalid = once<{ code: string }>(bob.socket, 'error');
    bob.socket.emit('channels:joinPrivate', { name: 'bad name!', password: 'x' });
    expect((await invalid).code).toBe('VALIDATION_FAILED');
  });
});
