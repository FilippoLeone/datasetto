import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: `
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        email TEXT,
        bio TEXT,
        avatar_url TEXT,
        roles TEXT NOT NULL DEFAULT '["user"]',
        status TEXT NOT NULL DEFAULT 'active',
        password_hash TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        disabled_at INTEGER,
        disabled_reason TEXT
      );

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        user_agent TEXT,
        ip TEXT
      );
      CREATE INDEX sessions_account_idx ON sessions(account_id);
      CREATE INDEX sessions_expires_idx ON sessions(expires_at);

      CREATE TABLE channel_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        collapsed INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        type TEXT NOT NULL,
        group_id TEXT REFERENCES channel_groups(id) ON DELETE SET NULL,
        stream_key TEXT UNIQUE,
        permissions TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        account_id TEXT,
        author_name TEXT NOT NULL,
        text TEXT NOT NULL,
        roles TEXT NOT NULL DEFAULT '[]',
        is_superuser INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        edited_at INTEGER,
        deleted_at INTEGER,
        deleted_by TEXT
      );
      CREATE INDEX messages_channel_created_idx ON messages(channel_id, created_at);

      CREATE TABLE bans (
        account_id TEXT PRIMARY KEY,
        reason TEXT,
        banned_by TEXT,
        banned_at INTEGER NOT NULL,
        expires_at INTEGER
      );

      CREATE TABLE leaderboard (
        game_type TEXT NOT NULL,
        player_name TEXT NOT NULL,
        score REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (game_type, player_name)
      );
    `,
  },
  {
    version: 2,
    name: 'usage_months',
    up: `
      CREATE TABLE usage_months (
        month TEXT PRIMARY KEY,
        hls_egress_bytes INTEGER NOT NULL DEFAULT 0,
        stream_seconds INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: 'private_channels',
    up: `
      ALTER TABLE channels ADD COLUMN topic TEXT;
      ALTER TABLE channels ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
      ALTER TABLE channels ADD COLUMN join_password_hash TEXT;

      CREATE TABLE channel_members (
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        added_by TEXT,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, account_id)
      );
      CREATE INDEX channel_members_account_idx ON channel_members(account_id);
    `,
  },
  {
    version: 4,
    name: 'invite_tokens',
    up: `
      CREATE TABLE invite_tokens (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        note TEXT,
        max_uses INTEGER NOT NULL DEFAULT 1,
        uses INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER
      );
      ALTER TABLE accounts ADD COLUMN invite_token_id TEXT REFERENCES invite_tokens(id) ON DELETE SET NULL;
      CREATE INDEX accounts_invite_token_idx ON accounts(invite_token_id);
    `,
  },
  {
    version: 5,
    name: 'message_reactions',
    up: `
      CREATE TABLE message_reactions (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, account_id, emoji)
      );
      CREATE INDEX message_reactions_message_idx ON message_reactions(message_id);
    `,
  },
  {
    // Direct messages are channels of type 'dm' (two members in channel_members, no group).
    // last_message_at orders the DM list by recency.
    version: 6,
    name: 'direct_messages',
    up: `
      ALTER TABLE channels ADD COLUMN last_message_at INTEGER;
      CREATE INDEX channels_type_idx ON channels(type);
    `,
  },
  {
    // Admin-editable server settings as JSON values (e.g. permission templates for new channels).
    version: 7,
    name: 'settings',
    up: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT
      );
    `,
  },
  {
    // Admin user management: temporary passwords that must be changed, last activity, soft deletion.
    version: 8,
    name: 'account_management',
    up: `
      ALTER TABLE accounts ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE accounts ADD COLUMN last_seen_at INTEGER;
      ALTER TABLE accounts ADD COLUMN deleted_at INTEGER;
    `,
  },
  {
    // Full-text search over chat history: an FTS5 index that reads its text from
    // `messages` (external content, keyed by the table's rowid) and is kept in sync
    // by triggers. Soft-deleted rows stay indexed and are filtered out at query
    // time; hard deletes (retention pruning, channel deletion) drop the index entry.
    // The final statement indexes every row that already exists.
    // NOTE: never VACUUM this database by hand; VACUUM may renumber the rowids of
    // `messages` (TEXT primary key) and the index would then point at the wrong rows.
    // Rebuild it with INSERT INTO messages_fts(messages_fts) VALUES ('rebuild') if that ever happens.
    version: 9,
    name: 'message_search',
    up: `
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        text,
        content='messages',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
      CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      END;
      CREATE TRIGGER messages_fts_au AFTER UPDATE OF text ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
      INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
    `,
  },
  {
    // Web Push subscriptions: one row per browser (the endpoint is unique), owned by an account
    // and by the login that registered it (session_hash); rows whose session is gone are dropped
    // before sending, so a signed-out device stops receiving notifications.
    version: 10,
    name: 'push_subscriptions',
    up: `
      CREATE TABLE push_subscriptions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        session_hash TEXT,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_agent TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE INDEX push_subscriptions_account_idx ON push_subscriptions(account_id);
    `,
  },
  {
    // Pictures in chat and link previews.
    // message_attachments: one row per uploaded file. A row is created by the upload
    // (message_id NULL, owned by account_id) and bound to a message when it is sent;
    // rows that stay unbound are swept after an hour. Files live under DATA_DIR/uploads
    // as <stored_name> (the original) and <preview_name> (a resized WebP).
    // link_previews: what the first link of a message pointed at, cached per URL;
    // messages.preview_url names the row, preview_removed hides it for one message.
    // channels.link_previews is the per-channel switch (on by default).
    version: 11,
    name: 'attachments_and_link_previews',
    up: `
      CREATE TABLE message_attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        stored_name TEXT NOT NULL UNIQUE,
        preview_name TEXT,
        preview_width INTEGER,
        preview_height INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX message_attachments_message_idx ON message_attachments(message_id);
      CREATE INDEX message_attachments_pending_idx ON message_attachments(created_at) WHERE message_id IS NULL;

      CREATE TABLE link_previews (
        url TEXT PRIMARY KEY,
        final_url TEXT,
        title TEXT,
        description TEXT,
        image TEXT,
        site_name TEXT,
        ok INTEGER NOT NULL DEFAULT 1,
        fetched_at INTEGER NOT NULL
      );

      ALTER TABLE messages ADD COLUMN preview_url TEXT;
      ALTER TABLE messages ADD COLUMN preview_removed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE channels ADD COLUMN link_previews INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    // Closing a direct message hides it from one participant's channel list without
    // deleting anything: channel_members.closed_at is set for that member and cleared
    // again when a message arrives in the conversation or they open it themselves.
    version: 12,
    name: 'dm_closed',
    up: `
      ALTER TABLE channel_members ADD COLUMN closed_at INTEGER;
    `,
  },
  {
    // Replies, @mentions and per-device notification choices.
    // messages.reply_to_id names the message a reply quotes (same channel; the quote is
    // hydrated at read time, so a pruned or deleted original just shows as unavailable).
    // message_mentions holds who a message @-mentions, resolved when it is sent or edited
    // (name = the display name or username as it appears in the text), for highlighting,
    // sidebar badges and notifications. push_subscriptions.notify_* are the device's
    // choices from the Notifications settings (both on unless switched off).
    // Deleted messages become tombstones: history keeps the row, the text is cleared
    // (the FTS trigger drops it from the search index). Rows deleted before this
    // migration are cleared the same way so they leave the index too.
    version: 13,
    name: 'replies_mentions_tombstones',
    up: `
      ALTER TABLE messages ADD COLUMN reply_to_id TEXT;
      CREATE TABLE message_mentions (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (message_id, account_id)
      );
      CREATE INDEX message_mentions_account_idx ON message_mentions(account_id);
      ALTER TABLE push_subscriptions ADD COLUMN notify_mentions INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE push_subscriptions ADD COLUMN notify_dms INTEGER NOT NULL DEFAULT 1;
      UPDATE messages SET text = '' WHERE deleted_at IS NOT NULL AND text <> '';
    `,
  },
];

export const runMigrations = (db: Database.Database): number => {
  const current = Number(db.pragma('user_version', { simple: true }) ?? 0);
  const pending = migrations.filter((migration) => migration.version > current).sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.up);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }

  return pending.length;
};
