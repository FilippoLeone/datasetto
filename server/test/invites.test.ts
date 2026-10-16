import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inviteStatus } from '../src/services/invites.js';
import { makeContext, startTestServer, type TestServer } from './helpers.js';

describe('InviteService', () => {
  it('creates, lists, limits uses, expires and revokes tokens', () => {
    const ctx = makeContext();
    const now = 1_000_000;
    const single = ctx.invites.create({ createdBy: 'acct-admin', note: '  for Bob  ' }, now);
    expect(single.token).toMatch(/^inv-[A-Za-z0-9]{20}$/);
    expect(single).toMatchObject({ maxUses: 1, uses: 0, note: 'for Bob', expiresAt: null, revokedAt: null });

    const multi = ctx.invites.create({ createdBy: null, maxUses: 2, expiresAt: now + 1000 }, now);
    const past = ctx.invites.create({ createdBy: null, maxUses: 5000, expiresAt: now - 1 }, now);
    expect(past.expiresAt).toBeNull(); // expiry in the past is treated as "never"
    expect(past.maxUses).toBe(1000);

    expect(ctx.invites.list()).toHaveLength(3);
    expect(ctx.invites.getByToken(single.token)?.id).toBe(single.id);
    expect(ctx.invites.getByToken('inv-nope')).toBeNull();
    expect(ctx.invites.getByToken(single.token.slice(4))).toBeNull();

    expect(ctx.invites.redeem(single.token, now)?.uses).toBe(1);
    expect(ctx.invites.redeem(single.token, now)).toBeNull();
    expect(inviteStatus(ctx.invites.get(single.id)!, now)).toBe('exhausted');

    expect(ctx.invites.redeem(multi.token, now)).toBeTruthy();
    expect(ctx.invites.redeem(multi.token, now + 2000)).toBeNull();
    expect(inviteStatus(ctx.invites.get(multi.id)!, now + 2000)).toBe('expired');
    expect(inviteStatus(ctx.invites.get(multi.id)!, now)).toBe('active');

    const revoked = ctx.invites.revoke(past.id, now);
    expect(revoked.revokedAt).toBe(now);
    expect(ctx.invites.redeem(past.token, now)).toBeNull();
    expect(inviteStatus(revoked, now)).toBe('revoked');
    expect(ctx.invites.delete(past.id)).toBe(true);
    expect(ctx.invites.delete(past.id)).toBe(false);
    expect(ctx.invites.list()).toHaveLength(2);
  });

  it('accepts the env invite code or a valid token in invite mode and records the token on the account', async () => {
    const ctx = makeContext({ REGISTRATION_MODE: 'invite', REGISTRATION_INVITE_CODE: 'friends-only' });
    const invite = ctx.invites.create({ createdBy: null, maxUses: 2 });

    await expect(ctx.accounts.register({ username: 'a@example.com', password: 'password123' })).rejects.toThrow(/invite/i);
    await expect(ctx.accounts.register({ username: 'a@example.com', password: 'password123', inviteCode: 'inv-bogus' })).rejects.toThrow(/invite/i);

    const byCode = await ctx.accounts.register({ username: 'a@example.com', password: 'password123', inviteCode: 'friends-only' });
    expect(ctx.accounts.getById(byCode.id)?.inviteTokenId).toBeNull();

    const byToken = await ctx.accounts.register({ username: 'b@example.com', password: 'password123', inviteCode: ' ' + invite.token + ' ' });
    expect(ctx.accounts.getById(byToken.id)?.inviteTokenId).toBe(invite.id);
    expect(ctx.invites.get(invite.id)?.uses).toBe(1);
    expect(ctx.invites.redeemedBy(invite.id).map((r) => r.username)).toEqual(['b@example.com']);

    // A failed registration (duplicate email) must not spend a use.
    await expect(ctx.accounts.register({ username: 'b@example.com', password: 'password123', inviteCode: invite.token })).rejects.toThrow(/already exists/);
    expect(ctx.invites.get(invite.id)?.uses).toBe(1);

    await ctx.accounts.register({ username: 'c@example.com', password: 'password123', inviteCode: invite.token });
    await expect(ctx.accounts.register({ username: 'd@example.com', password: 'password123', inviteCode: invite.token })).rejects.toThrow(/invite/i);
    expect(ctx.invites.get(invite.id)?.uses).toBe(2);

    const revoked = ctx.invites.create({ createdBy: null });
    ctx.invites.revoke(revoked.id);
    await expect(ctx.accounts.register({ username: 'e@example.com', password: 'password123', inviteCode: revoked.token })).rejects.toThrow(/invite/i);
  });

  it('records valid tokens in open mode, ignores invalid ones, and keeps closed closed', async () => {
    const open = makeContext();
    const invite = open.invites.create({ createdBy: null });
    const first = await open.accounts.register({ username: 'a@example.com', password: 'password123', inviteCode: 'inv-stale' });
    expect(open.accounts.getById(first.id)?.inviteTokenId).toBeNull();
    const second = await open.accounts.register({ username: 'b@example.com', password: 'password123', inviteCode: invite.token });
    expect(open.accounts.getById(second.id)?.inviteTokenId).toBe(invite.id);

    const closed = makeContext({ REGISTRATION_MODE: 'closed' });
    const token = closed.invites.create({ createdBy: null }).token;
    await expect(closed.accounts.register({ username: 'a@example.com', password: 'password123', inviteCode: token })).rejects.toThrow(/closed/);
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

interface InviteView {
  id: string;
  token: string;
  status: string;
  uses: number;
  maxUses: number;
  note: string | null;
  createdByName: string | null;
  redeemedBy: Array<{ username: string }>;
}

describe('invites over the socket', () => {
  let server: TestServer;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    server = await startTestServer({ REGISTRATION_MODE: 'invite', REGISTRATION_INVITE_CODE: 'friends-only' });
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

  it('lets admins create and list invites, and new members register with them', async () => {
    const admin = await open();
    const adminAuth = once(admin, 'auth:success');
    admin.emit('auth:register', { username: 'admin@example.com', password: 'password123', inviteCode: 'friends-only', profile: { displayName: 'Admin' } });
    await adminAuth;

    const created = once<{ invite: InviteView }>(admin, 'admin:invites:created');
    admin.emit('admin:invites:create', { maxUses: 2, note: 'game night', expiresAt: Date.now() + 86_400_000 });
    const { invite } = await created;
    expect(invite).toMatchObject({ status: 'active', uses: 0, maxUses: 2, note: 'game night', createdByName: 'Admin', redeemedBy: [] });

    const rejected = once<{ code: string }>(admin, 'admin:error');
    admin.emit('admin:invites:create', { maxUses: 0 });
    expect((await rejected).code).toBe('VALIDATION_FAILED');

    // Bob registers with the token; Carol with the env code; Dave fails.
    const bob = await open();
    const bobAuth = once<{ account: { id: string } }>(bob, 'auth:success');
    bob.emit('auth:register', { username: 'bob@example.com', password: 'password123', inviteCode: invite.token, profile: { displayName: 'Bob' } });
    const bobAccount = (await bobAuth).account;
    expect(server.ctx.accounts.getById(bobAccount.id)?.inviteTokenId).toBe(invite.id);

    const carol = await open();
    const carolAuth = once(carol, 'auth:success');
    carol.emit('auth:register', { username: 'carol@example.com', password: 'password123', inviteCode: 'friends-only' });
    await carolAuth;

    const dave = await open();
    const daveError = once<{ code: string }>(dave, 'auth:error');
    dave.emit('auth:register', { username: 'dave@example.com', password: 'password123', inviteCode: 'inv-made-up' });
    expect((await daveError).code).toBe('INVITE_CODE_INVALID');

    const listed = once<{ invites: InviteView[] }>(admin, 'admin:invites:list');
    admin.emit('admin:invites:list');
    const entry = (await listed).invites.find((i) => i.id === invite.id)!;
    expect(entry.uses).toBe(1);
    expect(entry.redeemedBy.map((r) => r.username)).toEqual(['bob@example.com']);

    // Members cannot touch invites.
    const forbidden = once<{ code: string }>(bob, 'admin:error');
    bob.emit('admin:invites:list');
    expect((await forbidden).code).toBe('FORBIDDEN');

    const afterRevoke = once<{ invites: InviteView[] }>(admin, 'admin:invites:list');
    admin.emit('admin:invites:revoke', { inviteId: invite.id });
    expect((await afterRevoke).invites.find((i) => i.id === invite.id)?.status).toBe('revoked');

    const afterDelete = once<{ invites: InviteView[] }>(admin, 'admin:invites:list');
    admin.emit('admin:invites:delete', { inviteId: invite.id });
    expect((await afterDelete).invites).toHaveLength(0);
    // Deleting a token keeps the account; it just loses the reference.
    expect(server.ctx.accounts.getById(bobAccount.id)?.inviteTokenId).toBeNull();
  });
});
