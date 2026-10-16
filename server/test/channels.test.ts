import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { ChannelService } from '../src/services/channels.js';
import { makeConfig, makeContext } from './helpers.js';

const user = (roles: string[], accountId = 'acct-1') => ({ accountId, roles, isSuperuser: roles.includes('superuser') });

describe('ChannelService', () => {
  it('seeds defaults once and keeps them across reopen', () => {
    const config = makeConfig();
    const db = openDatabase(':memory:', { memory: true });
    const first = new ChannelService(db, config);
    expect(first.seedDefaults()).toBe(true);
    expect(first.list().map((c) => c.name)).toEqual(['general', 'announcements', 'lobby', 'room-1', 'main-stream', 'team-share']);
    expect(first.listGroups()).toHaveLength(4);

    const reopened = new ChannelService(db, config);
    expect(reopened.seedDefaults()).toBe(false);
    expect(reopened.count()).toBe(6);
    expect(reopened.getByName('MAIN-STREAM')?.streamKey).toMatch(/^[A-Za-z0-9]{24}$/);
  });

  it('validates names, enforces uniqueness and the channel limit', () => {
    const ctx = makeContext({ MAX_CHANNELS: '7' });
    expect(() => ctx.channels.create({ name: 'bad name!', type: 'text' })).toThrow(/letters, numbers/);
    expect(() => ctx.channels.create({ name: 'General', type: 'voice' })).toThrow(/already exists/);
    ctx.channels.create({ name: 'extra', type: 'text' });
    expect(() => ctx.channels.create({ name: 'one-too-many', type: 'text' })).toThrow(/Maximum number/);
  });

  it('applies role and account based permissions', () => {
    const ctx = makeContext();
    const channel = ctx.channels.create({
      name: 'staff',
      type: 'text',
      permissions: { view: { roles: ['moderator'] }, chat: { roles: ['admin'], accounts: ['acct-vip'] } },
    });
    expect(ctx.channels.canAccess(channel, user(['user']), 'view')).toBe(false);
    expect(ctx.channels.canAccess(channel, user(['moderator']), 'view')).toBe(true);
    expect(ctx.channels.canAccess(channel, user(['moderator']), 'chat')).toBe(false);
    expect(ctx.channels.canAccess(channel, user(['user'], 'acct-vip'), 'chat')).toBe(true);
    expect(ctx.channels.canAccess(channel, user(['superuser']), 'chat')).toBe(true);
    expect(ctx.channels.canAccess(channel, null, 'view')).toBe(false);

    const updated = ctx.channels.updatePermissions(channel.id, { view: { roles: ['*'] } });
    expect(updated.view.roles).toEqual(['*']);
    expect(updated.chat.roles).toEqual(['admin']);
    expect(ctx.channels.canAccess(channel.id, user(['user']), 'view')).toBe(true);
  });

  it('finds stream channels by key in any OBS format and regenerates keys', () => {
    const ctx = makeContext();
    const stream = ctx.channels.getByName('main-stream')!;
    const token = stream.streamKey!;
    expect(ctx.channels.getByStreamKey('main-stream+' + token)?.id).toBe(stream.id);
    expect(ctx.channels.getByStreamKey('main-stream?key=' + token)?.id).toBe(stream.id);
    expect(ctx.channels.getByStreamKey(token)?.id).toBe(stream.id);
    expect(ctx.channels.getByStreamKey('main-stream+nope')).toBeNull();

    const fresh = ctx.channels.regenerateStreamKey(stream.id);
    expect(fresh).not.toBe(token);
    expect(ctx.channels.getByStreamKey(token)).toBeNull();
    expect(ctx.channels.getByStreamKey(fresh)?.id).toBe(stream.id);
    expect(() => ctx.channels.regenerateStreamKey(ctx.channels.getByName('general')!.id)).toThrow(/Only stream/);
  });

  it('deletes channels together with their messages', async () => {
    const ctx = makeContext();
    const channel = ctx.channels.create({ name: 'temp', type: 'text' });
    const acct = await ctx.accounts.register({ username: 'a@example.com', password: 'password123' });
    const author = ctx.presence.addUser('sock-1', acct);
    ctx.messages.create(channel.id, author, 'hello');
    expect(ctx.messages.count(channel.id)).toBe(1);
    ctx.channels.delete(channel.id);
    expect(ctx.channels.get(channel.id)).toBeNull();
    expect(ctx.messages.count(channel.id)).toBe(0);
  });
});
