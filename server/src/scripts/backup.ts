/**
 * Consistent online backup of the SQLite database.
 *
 *   node dist/scripts/backup.js /data/backups/datasetto-2026-10-16.db
 *
 * Uses SQLite's backup API, so it is safe while the server is running.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfigFromEnvFile } from '../config.js';

const main = async () => {
  const config = loadConfigFromEnvFile();
  const target = resolve(process.argv[2] ?? 'backups/datasetto-' + new Date().toISOString().slice(0, 10) + '.db');
  mkdirSync(dirname(target), { recursive: true });

  const db = new Database(config.database.path, { readonly: true });
  try {
    await db.backup(target);
  } finally {
    db.close();
  }
  console.log('backup written to ' + target);
};

main().catch((error) => {
  console.error('backup failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
