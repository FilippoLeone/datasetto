import { describe, expect, it } from 'vitest';
import { makeContext } from './helpers.js';

describe('AccountService', () => {
  it('grants admin to the first account and user to the rest', async () => {
    const ctx = makeContext();
    const first = await ctx.accounts.register({ username: 'Owner@Example.com', password: 'password123' });
    const second = await ctx.accounts.register({ username: 'friend@example.com', password: 'password123', displayName: 'Friend' });
    expect(first.username).toBe('owner@example.com');
    expect(first.roles).toEqual(['admin']);
    expect(first.displayName).toBe('owner');
    expect(second.roles).toEqual(['user']);
    expect(second.displayName).toBe('Friend');
    expect((first as unknown as { passwordHash?: string }).passwordHash).toBeUndefined();
  });

  it('rejects duplicates, bad emails and short passwords', async () => {
    const ctx = makeContext();
    await ctx.accounts.register({ username: 'a@example.com', password: 'password123' });
    await expect(ctx.accounts.register({ username: 'A@example.com', password: 'password123' })).rejects.toThrow(/already exists/);
    await expect(ctx.accounts.register({ username: 'not-an-email', password: 'password123' })).rejects.toThrow(/valid address/);
    await expect(ctx.accounts.register({ username: 'b@example.com', password: 'short' })).rejects.toThrow(/at least 8/);
  });

  it('authenticates with correct credentials only', async () => {
    const ctx = makeContext();
    await ctx.accounts.register({ username: 'a@example.com', password: 'password123' });
    const account = await ctx.accounts.authenticate('a@example.com', 'password123');
    expect(account.username).toBe('a@example.com');
    await expect(ctx.accounts.authenticate('a@example.com', 'wrong-password')).rejects.toThrow(/Invalid email or password/);
    await expect(ctx.accounts.authenticate('ghost@example.com', 'password123')).rejects.toThrow(/Invalid email or password/);
  });

  it('enforces invite codes and closed registration', async () => {
    const invite = makeContext({ REGISTRATION_MODE: 'invite', REGISTRATION_INVITE_CODE: 'friends-only' });
    await expect(invite.accounts.register({ username: 'a@example.com', password: 'password123' })).rejects.toThrow(/invite/i);
    await expect(
      invite.accounts.register({ username: 'a@example.com', password: 'password123', inviteCode: 'friends-only' }),
    ).resolves.toMatchObject({ username: 'a@example.com' });

    const closed = makeContext({ REGISTRATION_MODE: 'closed' });
    await expect(closed.accounts.register({ username: 'a@example.com', password: 'password123' })).rejects.toThrow(/closed/);
  });

  it('promotes configured admin emails to superuser', async () => {
    const ctx = makeContext({ ADMIN_EMAILS: 'boss@example.com' });
    await ctx.accounts.register({ username: 'first@example.com', password: 'password123' });
    const boss = await ctx.accounts.register({ username: 'boss@example.com', password: 'password123' });
    expect(boss.roles).toContain('superuser');
  });

  it('disables accounts and blocks their login, then re-enables', async () => {
    const ctx = makeContext();
    await ctx.accounts.register({ username: 'admin@example.com', password: 'password123' });
    const target = await ctx.accounts.register({ username: 'x@example.com', password: 'password123' });
    ctx.accounts.disable(target.id, 'spam');
    await expect(ctx.accounts.authenticate('x@example.com', 'password123')).rejects.toThrow(/spam/);
    ctx.accounts.enable(target.id);
    await expect(ctx.accounts.authenticate('x@example.com', 'password123')).resolves.toMatchObject({ status: 'active' });
  });

  it('changes passwords only with the current one', async () => {
    const ctx = makeContext();
    const acct = await ctx.accounts.register({ username: 'a@example.com', password: 'password123' });
    await expect(ctx.accounts.changePassword(acct.id, 'nope', 'newpassword1')).rejects.toThrow(/incorrect/);
    await ctx.accounts.changePassword(acct.id, 'password123', 'newpassword1');
    await expect(ctx.accounts.authenticate('a@example.com', 'newpassword1')).resolves.toBeTruthy();
  });
});
