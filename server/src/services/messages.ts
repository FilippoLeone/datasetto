import type { AppConfig } from '../config.js';
import { newId } from '../core/ids.js';
import { normalizeRoles } from '../core/roles.js';
import { emojiSchema, messageTextSchema } from '../core/validation.js';
import { parseJson, type DB } from '../db/index.js';
import { AppError, notFound } from '../errors.js';
import type { ConnectedUser, MessageRecord, ReactionSummary } from '../types.js';

/** Distinct emojis one message can carry, and reactions one account may add to it. */
export const MAX_REACTIONS_PER_MESSAGE = 20;
export const MAX_REACTIONS_PER_ACCOUNT = 10;

interface ReactionRow {
  message_id: string;
  account_id: string;
  emoji: string;
  created_at: number;
  display_name: string | null;
}

/** Group raw reaction rows per message, emojis in first-reaction order. */
const summarize = (rows: ReactionRow[]): Map<string, ReactionSummary[]> => {
  const byMessage = new Map<string, Map<string, ReactionSummary>>();
  for (const row of rows) {
    let perMessage = byMessage.get(row.message_id);
    if (!perMessage) {
      perMessage = new Map();
      byMessage.set(row.message_id, perMessage);
    }
    let summary = perMessage.get(row.emoji);
    if (!summary) {
      summary = { emoji: row.emoji, count: 0, accountIds: [], names: [] };
      perMessage.set(row.emoji, summary);
    }
    summary.count += 1;
    summary.accountIds.push(row.account_id);
    summary.names.push(row.display_name ?? 'Former member');
  }
  const result = new Map<string, ReactionSummary[]>();
  for (const [messageId, perMessage] of byMessage) result.set(messageId, Array.from(perMessage.values()));
  return result;
};

interface MessageRow {
  id: string;
  channel_id: string;
  account_id: string | null;
  author_name: string;
  text: string;
  roles: string;
  is_superuser: number;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  deleted_by: string | null;
}

const rowToRecord = (row: MessageRow, reactions: ReactionSummary[] = []): MessageRecord => ({
  id: row.id,
  channelId: row.channel_id,
  from: row.author_name,
  fromId: row.account_id,
  accountId: row.account_id,
  text: row.deleted_at ? '' : row.text,
  ts: row.created_at,
  roles: normalizeRoles(parseJson<string[]>(row.roles, [])),
  isSuperuser: Boolean(row.is_superuser),
  edited: row.edited_at !== null,
  deleted: row.deleted_at !== null,
  reactions,
});

const PRUNE_EVERY = 50;

export class MessageService {
  private readonly stmts;
  private insertsSincePrune = 0;

  constructor(
    db: DB,
    private readonly config: AppConfig,
  ) {
    this.stmts = {
      insert: db.prepare(`
        INSERT INTO messages (id, channel_id, account_id, author_name, text, roles, is_superuser, created_at)
        VALUES (@id, @channel_id, @account_id, @author_name, @text, @roles, @is_superuser, @created_at)
      `),
      history: db.prepare(`
        SELECT * FROM (
          SELECT m.*, m.rowid AS rid FROM messages m
          WHERE m.channel_id = ? AND m.deleted_at IS NULL
          ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?
        ) ORDER BY created_at ASC, rid ASC
      `),
      byId: db.prepare('SELECT * FROM messages WHERE id = ? AND channel_id = ?'),
      softDelete: db.prepare('UPDATE messages SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL'),
      countChannel: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?'),
      countAll: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NULL'),
      prune: db.prepare(`
        DELETE FROM messages WHERE channel_id = ? AND rowid NOT IN (
          SELECT rowid FROM messages WHERE channel_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
        )
      `),
      reactionsOfChannel: db.prepare(`
        SELECT r.message_id, r.account_id, r.emoji, r.created_at, a.display_name
        FROM message_reactions r
        JOIN messages m ON m.id = r.message_id
        LEFT JOIN accounts a ON a.id = r.account_id
        WHERE m.channel_id = ? ORDER BY r.created_at ASC, r.rowid ASC
      `),
      reactionsOfMessage: db.prepare(`
        SELECT r.message_id, r.account_id, r.emoji, r.created_at, a.display_name
        FROM message_reactions r LEFT JOIN accounts a ON a.id = r.account_id
        WHERE r.message_id = ? ORDER BY r.created_at ASC, r.rowid ASC
      `),
      insertReaction: db.prepare(`
        INSERT INTO message_reactions (message_id, account_id, emoji, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(message_id, account_id, emoji) DO NOTHING
      `),
      deleteReaction: db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND account_id = ? AND emoji = ?'),
      countDistinctEmojis: db.prepare('SELECT COUNT(DISTINCT emoji) AS n FROM message_reactions WHERE message_id = ?'),
      countByAccount: db.prepare('SELECT COUNT(*) AS n FROM message_reactions WHERE message_id = ? AND account_id = ?'),
    };
  }

  /** Validate and persist a message authored by a connected user. */
  create(channelId: string, author: ConnectedUser, rawText: unknown): MessageRecord {
    const text = messageTextSchema(this.config.limits.maxMessageLength).parse(rawText);
    const record: MessageRecord = {
      id: newId('msg', 18),
      channelId,
      from: author.displayName,
      fromId: author.id,
      accountId: author.accountId,
      text,
      ts: Date.now(),
      roles: [...author.roles],
      isSuperuser: author.isSuperuser,
      edited: false,
      deleted: false,
      reactions: [],
    };

    this.stmts.insert.run({
      id: record.id,
      channel_id: channelId,
      account_id: author.accountId,
      author_name: record.from,
      text,
      roles: JSON.stringify(record.roles),
      is_superuser: record.isSuperuser ? 1 : 0,
      created_at: record.ts,
    });

    this.insertsSincePrune += 1;
    if (this.insertsSincePrune >= PRUNE_EVERY) {
      this.insertsSincePrune = 0;
      this.prune(channelId);
    }
    return record;
  }

  history(channelId: string, limit = this.config.limits.chatHistoryLimit): MessageRecord[] {
    const rows = this.stmts.history.all(channelId, limit) as MessageRow[];
    if (rows.length === 0) return [];
    const reactions = summarize(this.stmts.reactionsOfChannel.all(channelId) as ReactionRow[]);
    return rows.map((row) => rowToRecord(row, reactions.get(row.id) ?? []));
  }

  get(channelId: string, messageId: string): MessageRecord | null {
    const row = this.stmts.byId.get(messageId, channelId) as MessageRow | undefined;
    return row ? rowToRecord(row, this.reactions(row.id)) : null;
  }

  /** Reactions on one message, grouped by emoji. */
  reactions(messageId: string): ReactionSummary[] {
    return summarize(this.stmts.reactionsOfMessage.all(messageId) as ReactionRow[]).get(messageId) ?? [];
  }

  /** Add an emoji reaction; returns the message's reactions afterwards. Idempotent per account and emoji. */
  addReaction(channelId: string, messageId: string, accountId: string, rawEmoji: unknown): ReactionSummary[] {
    const emoji = emojiSchema.parse(rawEmoji);
    const existing = this.stmts.byId.get(messageId, channelId) as MessageRow | undefined;
    if (!existing || existing.deleted_at !== null) throw notFound('Message');

    const already = this.reactions(messageId).some((entry) => entry.emoji === emoji && entry.accountIds.includes(accountId));
    if (!already) {
      const distinct = Number((this.stmts.countDistinctEmojis.get(messageId) as { n: number }).n);
      const hasEmoji = this.reactions(messageId).some((entry) => entry.emoji === emoji);
      if (!hasEmoji && distinct >= MAX_REACTIONS_PER_MESSAGE) {
        throw new AppError('This message already has the maximum number of different reactions', 'REACTION_LIMIT', 409);
      }
      const mine = Number((this.stmts.countByAccount.get(messageId, accountId) as { n: number }).n);
      if (mine >= MAX_REACTIONS_PER_ACCOUNT) {
        throw new AppError('You already reacted to this message enough times', 'REACTION_LIMIT', 409);
      }
      this.stmts.insertReaction.run(messageId, accountId, emoji, Date.now());
    }
    return this.reactions(messageId);
  }

  /** Remove an account's emoji reaction; returns the message's reactions afterwards. */
  removeReaction(channelId: string, messageId: string, accountId: string, rawEmoji: unknown): ReactionSummary[] {
    const emoji = emojiSchema.parse(rawEmoji);
    const existing = this.stmts.byId.get(messageId, channelId) as MessageRow | undefined;
    if (!existing) throw notFound('Message');
    this.stmts.deleteReaction.run(messageId, accountId, emoji);
    return this.reactions(messageId);
  }

  delete(channelId: string, messageId: string, deletedBy: string): MessageRecord {
    const existing = this.get(channelId, messageId);
    if (!existing) throw notFound('Message');
    this.stmts.softDelete.run(Date.now(), deletedBy.slice(0, 100), messageId);
    return { ...existing, text: '', deleted: true };
  }

  prune(channelId: string): number {
    const keep = this.config.limits.messageRetentionPerChannel;
    return this.stmts.prune.run(channelId, channelId, keep).changes;
  }

  count(channelId?: string): number {
    const row = (channelId ? this.stmts.countChannel.get(channelId) : this.stmts.countAll.get()) as { n: number };
    return Number(row.n);
  }
}
