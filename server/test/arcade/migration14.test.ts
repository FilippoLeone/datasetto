/**
 * Migration 14 on a copy of a version 13 database (plan.md §3.2 "Removal"): every Arcade table
 * appears, the old scores table goes, and no other table loses or gains a row.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations, runMigrations } from '../../src/db/migrations.js';

const ARCADE_TABLES = [
  'arcade_wallets',
  'arcade_txns',
  'arcade_ledger',
  'arcade_ledger_months',
  'arcade_escrow',
  'arcade_jackpots',
  'arcade_pending',
  'arcade_stats',
  'arcade_results',
  'arcade_result_players',
  'arcade_poker_hands',
  'arcade_saves',
  'arcade_prefs',
];

const tables = (db: Database.Database): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name").all() as { name: string }[]).map(
    (row) => row.name,
  );

const counts = (db: Database.Database): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const name of tables(db)) out[name] = (db.prepare('SELECT COUNT(*) AS n FROM "' + name + '"').get() as { n: number }).n;
  return out;
};

const version13 = (): Database.Database => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const migration of migrations.filter((m) => m.version <= 13).sort((a, b) => a.version - b.version)) {
    db.exec(migration.up);
    db.pragma('user_version = ' + migration.version);
  }
  return db;
};

describe('migration 14', () => {
  it('is the last migration and is named arcade', () => {
    const last = migrations.reduce((a, b) => (b.version > a.version ? b : a));
    expect(last).toMatchObject({ version: 14, name: 'arcade' });
  });

  it('adds the Arcade tables, drops the old scores and keeps every other row', () => {
    const db = version13();
    const now = Date.now();
    db.prepare('INSERT INTO accounts (id, username, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('a1', 'a@example.com', 'A', 'x', now, now);
    db.prepare('INSERT INTO accounts (id, username, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('a2', 'b@example.com', 'B', 'x', now, now);
    db.prepare('INSERT INTO leaderboard (game_type, player_name, score, updated_at) VALUES (?, ?, ?, ?)').run('slither', 'A', 120, now);
    db.prepare('INSERT INTO leaderboard (game_type, player_name, score, updated_at) VALUES (?, ?, ?, ?)').run('pacman', 'B', 80, now);
    db.prepare('INSERT INTO usage_months (month, hls_egress_bytes, stream_seconds, updated_at) VALUES (?, ?, ?, ?)').run('2026-10', 1000, 60, now);
    db.prepare('INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)').run('k', '{}', now, null);

    const before = counts(db);
    expect(before.leaderboard).toBe(2);
    expect(runMigrations(db)).toBe(1);
    expect(db.pragma('user_version', { simple: true })).toBe(14);

    const after = counts(db);
    expect(after.leaderboard).toBeUndefined();
    for (const name of ARCADE_TABLES) expect(after[name], name).toBe(0);
    for (const [name, n] of Object.entries(before)) {
      if (name === 'leaderboard') continue;
      expect(after[name], name).toBe(n);
    }
    const usage = db.prepare('SELECT arcade_egress_bytes AS arcade FROM usage_months WHERE month = ?').get('2026-10') as { arcade: number };
    expect(usage.arcade).toBe(0);
    db.close();
  });

  it('enforces the ledger constraints', () => {
    const db = version13();
    runMigrations(db);
    const now = Date.now();
    db.prepare('INSERT INTO accounts (id, username, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('a1', 'a@example.com', 'A', 'x', now, now);
    expect(() => db.prepare('INSERT INTO arcade_wallets (account_id, balance, created_at, updated_at) VALUES (?, ?, ?, ?)').run('a1', -1, now, now)).toThrow();
    db.prepare('INSERT INTO arcade_wallets (account_id, balance, created_at, updated_at) VALUES (?, ?, ?, ?)').run('a1', 5, now, now);
    // System transfers deduplicate by (actor, idem) with actor 'system', which NULL would not.
    db.prepare('INSERT INTO arcade_txns (kind, ref, actor, idem, created_at) VALUES (?, ?, ?, ?, ?)').run('grant', null, 'system', 'grant:a1', now);
    expect(() => db.prepare('INSERT INTO arcade_txns (kind, ref, actor, idem, created_at) VALUES (?, ?, ?, ?, ?)').run('grant', null, 'system', 'grant:a1', now)).toThrow();
    expect(() => db.prepare('INSERT INTO arcade_saves (owner_id, game, slot, version, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('a1', 'bellwick', 3, 1, Buffer.alloc(1), now)).toThrow();
    expect(() => db.prepare('INSERT INTO arcade_saves (owner_id, game, slot, version, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('a1', 'bellwick', 0, 1, Buffer.alloc(4097), now)).toThrow();
    // Deleting an account removes its wallet and prefs.
    db.prepare('INSERT INTO arcade_prefs (account_id, hidden, games, updated_at) VALUES (?, ?, ?, ?)').run('a1', 1, '{}', now);
    db.prepare('DELETE FROM accounts WHERE id = ?').run('a1');
    expect(counts(db).arcade_wallets).toBe(0);
    expect(counts(db).arcade_prefs).toBe(0);
    db.close();
  });
});
