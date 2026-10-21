import { describe, expect, it } from 'vitest';
import { makeContext } from './helpers.js';

const setup = async (overrides: Record<string, string> = {}) => {
  const ctx = makeContext(overrides);
  const acct = await ctx.accounts.register({ username: 'a@example.com', password: 'password123', displayName: 'Alice' });
  const author = ctx.presence.addUser('sock-1', acct);
  const channel = ctx.channels.getByName('general')!;
  return { ctx, author, channel };
};

describe('MessageService', () => {
  it('stores messages and returns history oldest first', async () => {
    const { ctx, author, channel } = await setup();
    const first = ctx.messages.create(channel.id, author, '  hello  ');
    const second = ctx.messages.create(channel.id, author, 'world');
    expect(first.text).toBe('hello');
    expect(first.from).toBe('Alice');
    expect(first.fromId).toBe('sock-1');
    const history = ctx.messages.history(channel.id);
    expect(history.map((m) => m.id)).toEqual([first.id, second.id]);
    expect(history[0].fromId).toBe(author.accountId);
  });

  it('rejects empty, oversized and control-character messages', async () => {
    const { ctx, author, channel } = await setup({ MAX_MESSAGE_LENGTH: '100' });
    expect(() => ctx.messages.create(channel.id, author, '   ')).toThrow(/empty/);
    expect(() => ctx.messages.create(channel.id, author, 'x'.repeat(101))).toThrow(/100 characters/);
    expect(ctx.messages.create(channel.id, author, 'ok\u0007done').text).toBe('okdone');
  });

  it('limits history and prunes old messages', async () => {
    const { ctx, author, channel } = await setup({ CHAT_HISTORY_LIMIT: '10', MESSAGE_RETENTION_PER_CHANNEL: '100' });
    for (let i = 0; i < 160; i += 1) ctx.messages.create(channel.id, author, 'msg ' + i);
    expect(ctx.messages.history(channel.id)).toHaveLength(10);
    expect(ctx.messages.history(channel.id).at(-1)?.text).toBe('msg 159');
    expect(ctx.messages.count(channel.id)).toBeLessThanOrEqual(100 + 50);
    ctx.messages.prune(channel.id);
    expect(ctx.messages.count(channel.id)).toBe(100);
  });

  it('soft deletes: the message stays in history as a tombstone without its text', async () => {
    const { ctx, author, channel } = await setup();
    const msg = ctx.messages.create(channel.id, author, 'oops');
    const deleted = ctx.messages.delete(channel.id, msg.id, 'Mod');
    expect(deleted.deleted).toBe(true);
    expect(deleted.text).toBe('');
    const history = ctx.messages.history(channel.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: msg.id, deleted: true, text: '', from: 'Alice', reactions: [], attachments: [], preview: null, mentions: [], replyTo: null });
    expect(ctx.db.prepare('SELECT text, deleted_by FROM messages WHERE id = ?').get(msg.id)).toEqual({ text: '', deleted_by: 'Mod' });
    expect(() => ctx.messages.delete(channel.id, 'msg-missing', 'Mod')).toThrow(/not found/);
  });
});

describe('ModerationService', () => {
  it('persists bans with optional expiry', () => {
    const ctx = makeContext();
    ctx.moderation.ban('acct-1', 'rude', 'Admin');
    expect(ctx.moderation.isBanned('acct-1')).toBe(true);
    expect(ctx.moderation.getBan('acct-1')?.reason).toBe('rude');
    ctx.moderation.ban('acct-2', 'temp', 'Admin', -1);
    expect(ctx.moderation.isBanned('acct-2')).toBe(true);
    ctx.moderation.unban('acct-1');
    expect(ctx.moderation.isBanned('acct-1')).toBe(false);
  });

  it('clamps voice timeouts', () => {
    const ctx = makeContext();
    expect(ctx.moderation.setVoiceTimeout('acct-1', 5)).toBe(60_000);
    expect(ctx.moderation.voiceTimeoutRemaining('acct-1')).toBeGreaterThan(50_000);
    expect(ctx.moderation.setVoiceTimeout('acct-2', 10 ** 12)).toBe(7 * 24 * 3600 * 1000);
    ctx.moderation.clearVoiceTimeout('acct-1');
    expect(ctx.moderation.voiceTimeoutRemaining('acct-1')).toBe(0);
  });
});
