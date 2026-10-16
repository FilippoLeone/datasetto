import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tombstoneUsername } from '../src/services/accounts.js';
import { makeContext, startTestServer, type TestServer } from './helpers.js';

describe('AccountService management', () => {
  it('resets passwords with a forced change, tracks last seen and soft deletes', async () => {
    const ctx = makeContext();
    await ctx.accounts.register({ username: 'admin@example.com', password: 'password123' });
    const bob = await ctx.accounts.register({ username: 'bob@example.com', password: 'password123', displayName: 'Bob' });

    await expect(ctx.accounts.resetPassword(bob.id, 'short')).rejects.toThrow(/at least 8/);
    const reset = await ctx.accounts.resetPassword(bob.id, 'temporary-1');
    expect(reset.mustChangePassword).toBe(true);
    await expect(ctx.accounts.authenticate('bob@example.com', 'password123')).rejects.toThrow(/Invalid/);
    const signedIn = await ctx.accounts.authenticate('bob@example.com', 'temporary-1');
    expect(signedIn.mustChangePassword).toBe(true);
    await ctx.accounts.changePassword(bob.id, 'temporary-1', 'brand-new-pw');
    expect(ctx.accounts.getById(bob.id)?.mustChangePassword).toBe(false);

    ctx.accounts.touchLastSeen(bob.id, 1000);
    ctx.accounts.touchLastSeen(bob.id, 2000); // throttled: within a minute of the last write
    expect(ctx.accounts.getById(bob.id)?.lastSeenAt).toBe(1000);
    ctx.accounts.touchLastSeen(bob.id, 70_000);
    expect(ctx.accounts.getById(bob.id)?.lastSeenAt).toBe(70_000);

    const deleted = ctx.accounts.softDelete(bob.id);
    expect(deleted).toMatchObject({ status: 'deleted', displayName: 'Deleted user', username: tombstoneUsername(bob.id), roles: ['user'] });
    expect(deleted.metadata).toEqual({ deletedUsername: 'bob@example.com', deletedDisplayName: 'Bob' });
    expect(ctx.accounts.getByUsername('bob@example.com')).toBeNull();
    await expect(ctx.accounts.authenticate('bob@example.com', 'brand-new-pw')).rejects.toThrow(/Invalid/);
    // The email is free again, and the new account is a different one.
    const again = await ctx.accounts.register({ username: 'bob@example.com', password: 'password123' });
    expect(again.id).not.toBe(bob.id);
    expect(ctx.accounts.countActiveAdmins()).toBe(1);
    await expect(ctx.accounts.resetPassword(bob.id, 'whatever-1')).rejects.toThrow(/deleted/);
  });

  it('lists and revokes sessions', async () => {
    const ctx = makeContext();
    const one = (await ctx.accounts.register({ username: 'one@example.com', password: 'password123' })).id;
    const two = (await ctx.accounts.register({ username: 'two@example.com', password: 'password123' })).id;
    const a = ctx.sessions.create(one, { userAgent: 'Firefox', ip: '10.0.0.1' });
    const b = ctx.sessions.create(one, { userAgent: 'Chrome', ip: '10.0.0.2' });
    ctx.sessions.create(two);
    expect(ctx.sessions.listForAccount(one).map((s) => s.userAgent).sort()).toEqual(['Chrome', 'Firefox']);
    expect(ctx.sessions.revokeByHash(a.tokenHash)).toBe(true);
    expect(ctx.sessions.revokeByHash(a.tokenHash)).toBe(false);
    expect(ctx.sessions.listForAccount(one).map((s) => s.tokenHash)).toEqual([b.tokenHash]);
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

interface SessionsPayload {
  accountId: string;
  sessions: Array<{ id: string; online: boolean; current: boolean; userAgent: string | null }>;
}

describe('admin user management over the socket', () => {
  let server: TestServer;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    // This suite looks at several live sessions of one account, so the single-login rule is off here.
    server = await startTestServer({ SINGLE_SESSION_PER_ACCOUNT: 'false' });
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

  const signUp = async (username: string, displayName: string) => {
    const socket = await open();
    const auth = once<{ account: { id: string }; session: { token: string } }>(socket, 'auth:success');
    socket.emit('auth:register', { username, password: 'password123', profile: { displayName } });
    const payload = await auth;
    return { socket, account: payload.account, token: payload.session.token };
  };

  it('renames, resets passwords with a forced change, lists and revokes sessions, and soft deletes', async () => {
    const admin = await signUp('admin@example.com', 'Admin');
    const bob = await signUp('bob@example.com', 'Bob');

    // Rename.
    const renamed = once<{ account: { displayName: string } }>(admin.socket, 'admin:accounts:updated');
    const bobSees = once<{ account: { displayName: string }; source?: string }>(bob.socket, 'account:updated');
    admin.socket.emit('admin:accounts:update', { accountId: bob.account.id, displayName: 'Robert' });
    expect((await renamed).account.displayName).toBe('Robert');
    expect(await bobSees).toMatchObject({ account: { displayName: 'Robert' }, source: 'admin' });

    // Members cannot manage, and admins cannot act on themselves.
    const denied = once<{ code: string }>(bob.socket, 'admin:error');
    bob.socket.emit('admin:accounts:resetPassword', { accountId: admin.account.id, temporaryPassword: 'temporary-1' });
    expect((await denied).code).toBe('FORBIDDEN');
    const self = once<{ code: string }>(admin.socket, 'admin:error');
    admin.socket.emit('admin:accounts:delete', { accountId: admin.account.id });
    expect((await self).code).toBe('FORBIDDEN');

    // Sessions: Bob has one; a second sign-in adds another; revoking one disconnects that socket only.
    const bob2 = await open();
    const bob2Auth = once<{ session: { token: string } }>(bob2, 'auth:success');
    bob2.emit('auth:login', { username: 'bob@example.com', password: 'password123' });
    await bob2Auth;
    const listed = once<SessionsPayload>(admin.socket, 'admin:accounts:sessions');
    admin.socket.emit('admin:accounts:sessions:list', { accountId: bob.account.id });
    const sessions = (await listed).sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.online && !s.current)).toBe(true);
    expect(sessions[0].id).toHaveLength(16);

    const bobKicked = once<{ code: string }>(bob.socket, 'auth:error');
    const bob2Alive = once(bob2, 'auth:error', 300);
    // Bob's first session is the older one; find it by matching what each socket still holds.
    const afterRevoke = once<SessionsPayload>(admin.socket, 'admin:accounts:sessions');
    admin.socket.emit('admin:accounts:sessions:revoke', { accountId: bob.account.id, sessionId: sessions[1].id });
    const revokedPayload = await afterRevoke;
    expect(revokedPayload.sessions).toHaveLength(1);
    const kicked = await Promise.race([bobKicked.then(() => 'bob'), bob2Alive.then(() => 'bob2')]);
    expect(['bob', 'bob2']).toContain(kicked);
    expect(server.ctx.sessions.countForAccount(bob.account.id)).toBe(1);

    // Password reset: all sessions gone, old password dead, temporary one works but demands a change.
    const resetDone = once<{ account: { mustChangePassword: boolean } }>(admin.socket, 'admin:accounts:passwordReset');
    admin.socket.emit('admin:accounts:resetPassword', { accountId: bob.account.id, temporaryPassword: 'temporary-1' });
    expect((await resetDone).account.mustChangePassword).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.ctx.sessions.countForAccount(bob.account.id)).toBe(0);

    const bob3 = await open();
    const oldPassword = once<{ code: string }>(bob3, 'auth:error');
    bob3.emit('auth:login', { username: 'bob@example.com', password: 'password123' });
    expect((await oldPassword).code).toBe('INVALID_CREDENTIALS');
    const tempLogin = once<{ account: { mustChangePassword: boolean } }>(bob3, 'auth:success');
    bob3.emit('auth:login', { username: 'bob@example.com', password: 'temporary-1' });
    expect((await tempLogin).account.mustChangePassword).toBe(true);
    const gated = once<{ code: string }>(bob3, 'error');
    bob3.emit('channel:join', server.ctx.channels.getByName('general')!.id);
    expect((await gated).code).toBe('PASSWORD_CHANGE_REQUIRED');
    const changed = once<{ account: { mustChangePassword: boolean } }>(bob3, 'account:updated');
    bob3.emit('account:update', { currentPassword: 'temporary-1', newPassword: 'my-own-password' });
    expect((await changed).account.mustChangePassword).toBe(false);
    const joined = once(bob3, 'channel:joined');
    bob3.emit('channel:join', server.ctx.channels.getByName('general')!.id);
    await joined;

    // Soft delete: disconnected, listed as deleted, email free, memberships gone.
    const priv = server.ctx.channels.create({ name: 'club', type: 'text', visibility: 'private' });
    server.ctx.channels.addMember(priv.id, bob.account.id);
    const deletedEvent = once<{ account: { status: string } }>(admin.socket, 'admin:accounts:deleted');
    const bob3Gone = once<{ code: string }>(bob3, 'auth:error');
    admin.socket.emit('admin:accounts:delete', { accountId: bob.account.id });
    expect((await deletedEvent).account.status).toBe('deleted');
    expect((await bob3Gone).code).toBe('ACCOUNT_DELETED');
    expect(server.ctx.channels.isMember(priv.id, bob.account.id)).toBe(false);
    const list = once<{ accounts: Array<{ id: string; status: string; username: string }> }>(admin.socket, 'admin:accounts:list');
    admin.socket.emit('admin:accounts:list');
    const entry = (await list).accounts.find((a) => a.id === bob.account.id)!;
    expect(entry.status).toBe('deleted');
    expect(entry.username).toBe(tombstoneUsername(bob.account.id));
    const afterDelete = once<{ code: string }>(admin.socket, 'admin:error');
    admin.socket.emit('admin:accounts:enable', { accountId: bob.account.id });
    expect((await afterDelete).code).toBe('ACCOUNT_DELETED');

    const fresh = await open();
    const reRegistered = once<{ account: { id: string } }>(fresh, 'auth:success');
    fresh.emit('auth:register', { username: 'bob@example.com', password: 'password123' });
    expect((await reRegistered).account.id).not.toBe(bob.account.id);
  });
});
