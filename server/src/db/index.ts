import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';

export type DB = Database.Database;

export interface OpenDatabaseOptions {
  /** Skip WAL (used for `:memory:` databases in tests). */
  memory?: boolean;
}

/**
 * Open (and create if needed) the SQLite database, apply pragmas suited to a
 * single long-lived process, and run pending migrations.
 */
export const openDatabase = (path: string, options: OpenDatabaseOptions = {}): DB => {
  const isMemory = options.memory || path === ':memory:';
  if (!isMemory) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!isMemory) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  runMigrations(db);
  return db;
};

export const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};
