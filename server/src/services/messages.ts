import type { AppConfig } from '../config.js';
import { newId } from '../core/ids.js';
import { normalizeRoles } from '../core/roles.js';
import { messageTextSchema } from '../core/validation.js';
import { parseJson, type DB } from '../db/index.js';
import { notFound } from '../errors.js';
import type { ConnectedUser, MessageRecord } from '../types.js';

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

const rowToRecord = (row: MessageRow): MessageRecord => ({
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
    return rows.map(rowToRecord);
  }

  get(channelId: string, messageId: string): MessageRecord | null {
    const row = this.stmts.byId.get(messageId, channelId) as MessageRow | undefined;
    return row ? rowToRecord(row) : null;
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
