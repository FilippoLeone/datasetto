import type { AppConfig } from '../config.js';
import { newId } from '../core/ids.js';
import { normalizeRoles } from '../core/roles.js';
import { emojiSchema, messageTextSchema } from '../core/validation.js';
import { parseJson, type DB } from '../db/index.js';
import { AppError, notFound } from '../errors.js';
import type { AttachmentView, ConnectedUser, LinkPreviewView, MessageRecord, ReactionSummary } from '../types.js';
import { attachmentView, type UploadService } from './uploads.js';

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
  preview_url: string | null;
  preview_removed: number;
}

interface AttachmentRow {
  id: string;
  message_id: string;
  account_id: string;
  kind: string;
  file_name: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  stored_name: string;
  preview_name: string | null;
  preview_width: number | null;
  preview_height: number | null;
  created_at: number;
}

interface PreviewRow {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  site_name: string | null;
}

/** Everything a message row needs besides its own columns. */
interface Extras {
  reactions: Map<string, ReactionSummary[]>;
  attachments: Map<string, AttachmentView[]>;
  previews: Map<string, LinkPreviewView>;
}

const rowToRecord = (row: MessageRow, extras: Extras): MessageRecord => ({
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
  reactions: extras.reactions.get(row.id) ?? [],
  attachments: row.deleted_at ? [] : (extras.attachments.get(row.id) ?? []),
  preview: row.deleted_at || row.preview_removed || !row.preview_url ? null : (extras.previews.get(row.preview_url) ?? null),
});

const PRUNE_EVERY = 50;

export interface CreateMessageOptions {
  /** Allow an empty text (the message carries pictures). */
  allowEmpty?: boolean;
  /** The link a preview card will be fetched for, if any. */
  previewUrl?: string | null;
}

export class MessageService {
  private readonly stmts;
  private insertsSincePrune = 0;

  constructor(
    db: DB,
    private readonly config: AppConfig,
    private readonly uploads: UploadService,
  ) {
    this.stmts = {
      insert: db.prepare(`
        INSERT INTO messages (id, channel_id, account_id, author_name, text, roles, is_superuser, created_at, preview_url)
        VALUES (@id, @channel_id, @account_id, @author_name, @text, @roles, @is_superuser, @created_at, @preview_url)
      `),
      attachmentsOfMessages: db.prepare(`
        SELECT * FROM message_attachments WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY created_at ASC, rowid ASC
      `),
      previewsOf: db.prepare(`
        SELECT url, title, description, image, site_name FROM link_previews
        WHERE ok = 1 AND url IN (SELECT value FROM json_each(?))
      `),
      removePreview: db.prepare('UPDATE messages SET preview_removed = 1 WHERE id = ? AND channel_id = ?'),
      channelOf: db.prepare('SELECT channel_id FROM messages WHERE id = ? AND deleted_at IS NULL'),
      attachmentsToPrune: db.prepare(`
        SELECT a.stored_name, a.preview_name FROM message_attachments a
        JOIN messages m ON m.id = a.message_id
        WHERE m.channel_id = ? AND m.rowid NOT IN (
          SELECT rowid FROM messages WHERE channel_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
        )
      `),
      history: db.prepare(`
        SELECT * FROM (
          SELECT m.*, m.rowid AS rid FROM messages m
          WHERE m.channel_id = ? AND m.deleted_at IS NULL
          ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?
        ) ORDER BY created_at ASC, rid ASC
      `),
      // Older history, newest-first page before a cursor message (by time, then insertion order).
      historyBefore: db.prepare(`
        SELECT * FROM (
          SELECT m.*, m.rowid AS rid FROM messages m
          WHERE m.channel_id = ? AND m.deleted_at IS NULL
            AND (m.created_at < ? OR (m.created_at = ? AND m.rowid < ?))
          ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?
        ) ORDER BY created_at ASC, rid ASC
      `),
      cursor: db.prepare('SELECT created_at, rowid AS rid FROM messages WHERE id = ? AND channel_id = ?'),
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
      reactionsOfMessages: db.prepare(`
        SELECT r.message_id, r.account_id, r.emoji, r.created_at, a.display_name
        FROM message_reactions r LEFT JOIN accounts a ON a.id = r.account_id
        WHERE r.message_id IN (SELECT value FROM json_each(?)) ORDER BY r.created_at ASC, r.rowid ASC
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

  /** Validate and persist a message authored by a connected user. Pictures are bound afterwards with {@link attach}. */
  create(channelId: string, author: ConnectedUser, rawText: unknown, options: CreateMessageOptions = {}): MessageRecord {
    const text = messageTextSchema(this.config.limits.maxMessageLength, options.allowEmpty === true).parse(rawText);
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
      attachments: [],
      preview: null,
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
      preview_url: options.previewUrl ?? null,
    });

    this.insertsSincePrune += 1;
    if (this.insertsSincePrune >= PRUNE_EVERY) {
      this.insertsSincePrune = 0;
      this.prune(channelId);
    }
    return record;
  }

  /**
   * Bind pending uploads of the author to a message (at most `maxFilesPerMessage`);
   * returns the message with its attachments.
   */
  attach(record: MessageRecord, attachmentIds: readonly string[]): MessageRecord {
    if (attachmentIds.length === 0) return record;
    if (attachmentIds.length > this.config.uploads.maxFilesPerMessage) {
      throw new AppError('At most ' + this.config.uploads.maxFilesPerMessage + ' pictures per message', 'TOO_MANY_ATTACHMENTS', 400);
    }
    if (!record.accountId) throw new AppError('Only signed-in users can share pictures', 'NOT_AUTHENTICATED', 401);
    const attachments = this.uploads.attach(record.id, record.accountId, attachmentIds).map(attachmentView);
    return { ...record, attachments };
  }

  /** Reactions, attachments and preview cards for a set of message rows, in three queries. */
  private extrasFor(rows: readonly MessageRow[], reactions?: Map<string, ReactionSummary[]>): Extras {
    const ids = JSON.stringify(rows.map((row) => row.id));
    const attachments = new Map<string, AttachmentView[]>();
    for (const row of this.stmts.attachmentsOfMessages.all(ids) as AttachmentRow[]) {
      const list = attachments.get(row.message_id) ?? [];
      list.push(
        attachmentView({
          id: row.id,
          messageId: row.message_id,
          accountId: row.account_id,
          kind: 'image',
          fileName: row.file_name,
          mime: row.mime,
          size: row.size,
          width: row.width,
          height: row.height,
          storedName: row.stored_name,
          previewName: row.preview_name,
          previewWidth: row.preview_width,
          previewHeight: row.preview_height,
          createdAt: row.created_at,
        }),
      );
      attachments.set(row.message_id, list);
    }
    const previews = new Map<string, LinkPreviewView>();
    const urls = Array.from(new Set(rows.filter((row) => row.preview_url && !row.preview_removed && !row.deleted_at).map((row) => row.preview_url as string)));
    if (urls.length > 0) {
      for (const row of this.stmts.previewsOf.all(JSON.stringify(urls)) as PreviewRow[]) {
        if (!row.title && !row.description && !row.image) continue;
        previews.set(row.url, { url: row.url, title: row.title, description: row.description, image: row.image, siteName: row.site_name });
      }
    }
    return {
      reactions: reactions ?? summarize(this.stmts.reactionsOfMessages.all(ids) as ReactionRow[]),
      attachments,
      previews,
    };
  }

  history(channelId: string, limit = this.config.limits.chatHistoryLimit): MessageRecord[] {
    const rows = this.stmts.history.all(channelId, limit) as MessageRow[];
    if (rows.length === 0) return [];
    const reactions = summarize(this.stmts.reactionsOfChannel.all(channelId) as ReactionRow[]);
    const extras = this.extrasFor(rows, reactions);
    return rows.map((row) => rowToRecord(row, extras));
  }

  /**
   * The page of history before `beforeMessageId` (oldest first) and whether
   * anything older than that page exists. The cursor message must belong to the
   * channel; it may itself be deleted.
   */
  historyBefore(channelId: string, beforeMessageId: string, limit = this.config.limits.chatHistoryLimit): { messages: MessageRecord[]; hasMore: boolean } {
    const cursor = this.stmts.cursor.get(beforeMessageId, channelId) as { created_at: number; rid: number } | undefined;
    if (!cursor) throw notFound('Message');
    const rows = this.stmts.historyBefore.all(channelId, cursor.created_at, cursor.created_at, cursor.rid, limit + 1) as MessageRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(1) : rows;
    if (page.length === 0) return { messages: [], hasMore: false };
    const extras = this.extrasFor(page);
    return { messages: page.map((row) => rowToRecord(row, extras)), hasMore };
  }

  get(channelId: string, messageId: string): MessageRecord | null {
    const row = this.stmts.byId.get(messageId, channelId) as MessageRow | undefined;
    return row ? rowToRecord(row, this.extrasFor([row])) : null;
  }

  /** The channel a message (not deleted) belongs to, or null. */
  channelOf(messageId: string): string | null {
    const row = this.stmts.channelOf.get(messageId) as { channel_id: string } | undefined;
    return row?.channel_id ?? null;
  }

  /** The URL a preview is (or was) wanted for, or null. */
  previewUrlOf(channelId: string, messageId: string): string | null {
    const row = this.stmts.byId.get(messageId, channelId) as MessageRow | undefined;
    return row && !row.preview_removed && !row.deleted_at ? row.preview_url : null;
  }

  /** The author took the preview card off their message; it does not come back. */
  removePreview(channelId: string, messageId: string): MessageRecord {
    const existing = this.get(channelId, messageId);
    if (!existing || existing.deleted) throw notFound('Message');
    this.stmts.removePreview.run(messageId, channelId);
    return { ...existing, preview: null };
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
    // Deleted messages keep their row (soft delete) but their pictures are gone for good.
    this.uploads.deleteForMessage(messageId);
    return { ...existing, text: '', deleted: true, attachments: [], preview: null };
  }

  prune(channelId: string): number {
    const keep = this.config.limits.messageRetentionPerChannel;
    // Rows cascade; the files behind them need a hand.
    const files = this.stmts.attachmentsToPrune.all(channelId, channelId, keep) as Array<{ stored_name: string; preview_name: string | null }>;
    if (files.length > 0) this.uploads.removeFiles(files.map((file) => ({ storedName: file.stored_name, previewName: file.preview_name })));
    return this.stmts.prune.run(channelId, channelId, keep).changes;
  }

  count(channelId?: string): number {
    const row = (channelId ? this.stmts.countChannel.get(channelId) : this.stmts.countAll.get()) as { n: number };
    return Number(row.n);
  }
}
