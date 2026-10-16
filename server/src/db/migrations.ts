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
