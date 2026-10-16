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
