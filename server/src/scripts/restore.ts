/**
 * Restore a backup made by scripts/backup.ts (or any copy of the database file)
 * over the live database. Run with the server STOPPED; ops/vps/restore.sh does
 * that around this script.
 *
 *   node dist/scripts/restore.js /restore/datasetto-2026-10-16_0400.db [--target /data/datasetto.db] [--dry-run]
 *
 * Checks before touching anything: the backup passes integrity_check, its schema
 * version is one this build knows (older is fine, the server migrates it at the
 * next start; newer is refused), and it has the expected tables. Then the live
 * file (with its -wal and -shm) is moved aside as *.pre-restore-<stamp>, the
 * backup is copied in through SQLite's backup API, and the result is verified:
 * integrity_check again and the same row counts as the backup. Exit code 0 only
 * when every check passed; `--dry-run` stops after the first checks.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfigFromEnvFile } from '../config.js';
import { migrations } from '../db/migrations.js';

const LATEST_SCHEMA = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
const COUNTED_TABLES = ['accounts', 'sessions', 'channels', 'messages', 'bans'] as const;

interface Inspection {
  schemaVersion: number;
  integrity: string;
  counts: Record<string, number>;
  tables: string[];
}

const inspect = (path: string): Inspection => {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = String((db.pragma('integrity_check', { simple: true }) as string) ?? 'unknown');
    const schemaVersion = Number(db.pragma('user_version', { simple: true }) ?? 0);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
    const counts: Record<string, number> = {};
    for (const table of COUNTED_TABLES) {
      if (!tables.includes(table)) continue;
      counts[table] = Number((db.prepare('SELECT COUNT(*) AS n FROM ' + table).get() as { n: number }).n);
    }
    return { schemaVersion, integrity, counts, tables };
  } finally {
    db.close();
  }
};

const describe = (label: string, info: Inspection) => {
  const counts = Object.entries(info.counts)
    .map(([table, n]) => table + '=' + n)
    .join(' ');
  console.log(`${label}: schema v${info.schemaVersion}, integrity ${info.integrity}, ${counts}`);
};

const fail = (message: string): never => {
  console.error('restore refused: ' + message);
  process.exit(1);
};

const main = async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const targetIndex = args.indexOf('--target');
  const source = args.find((arg, index) => !arg.startsWith('--') && (targetIndex === -1 || index !== targetIndex + 1));
  if (!source) fail('usage: restore.js <backup.db> [--target <database.db>] [--dry-run]');
  const config = loadConfigFromEnvFile();
  const target = resolve(targetIndex === -1 ? config.database.path : args[targetIndex + 1]);
  const given = resolve(source as string);

  if (!existsSync(given)) fail('backup file not found: ' + given);
  // Work from a private copy: a WAL-mode file needs its -shm next to it even to be read, and
  // the backup usually sits on a read-only mount (ops/vps/restore.sh) or in a backups folder
  // that should not collect side files.
  const scratch = mkdtempSync(join(tmpdir(), 'datasetto-restore-'));
  process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
  const backup = join(scratch, 'backup.db');
  copyFileSync(given, backup);
  const before = inspect(backup);
  describe('backup ' + given, before);
  if (before.integrity !== 'ok') fail('the backup does not pass integrity_check');
  if (!before.tables.includes('accounts') || !before.tables.includes('messages')) fail('the file is not a Datasetto database (no accounts/messages tables)');
  if (before.schemaVersion > LATEST_SCHEMA) fail(`schema v${before.schemaVersion} is newer than this build knows (v${LATEST_SCHEMA}); deploy a newer image first`);
  if (before.schemaVersion < LATEST_SCHEMA) console.log(`schema v${before.schemaVersion} is older than v${LATEST_SCHEMA}: the server migrates it at the next start`);

  if (existsSync(target)) {
    describe('current ' + target, inspect(target));
  } else {
    console.log('current ' + target + ': no database yet');
  }

  if (dryRun) {
    console.log('dry run: nothing changed');
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (existsSync(target)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(target + suffix)) renameSync(target + suffix, target + '.pre-restore-' + stamp + suffix);
    }
    console.log('previous database kept as ' + target + '.pre-restore-' + stamp);
  }

  const sourceDb = new Database(backup, { readonly: true, fileMustExist: true });
  try {
    await sourceDb.backup(target);
  } finally {
    sourceDb.close();
  }

  const after = inspect(target);
  describe('restored ' + target, after);
  if (after.integrity !== 'ok') fail('the restored file does not pass integrity_check');
  if (after.schemaVersion !== before.schemaVersion) fail('schema version changed during the copy');
  for (const table of Object.keys(before.counts)) {
    if (before.counts[table] !== after.counts[table]) fail(`row count of ${table} differs (${before.counts[table]} in the backup, ${after.counts[table]} restored)`);
  }
  console.log('restore ok');
};

main().catch((error) => {
  console.error('restore failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
