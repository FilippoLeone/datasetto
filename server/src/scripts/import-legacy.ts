/**
 * One-off import of the previous JSON stores (accounts.json / messages.json)
 * produced by the old server into the SQLite database.
 *
 *   npm run import-legacy -- ./old-storage
 *
 * Existing accounts (matched by email) are skipped; password hashes are kept
 * as-is because both versions use bcrypt.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfigFromEnvFile } from '../config.js';
import { normalizeRoles } from '../core/roles.js';
import { openDatabase } from '../db/index.js';
import { ChannelService } from '../services/channels.js';

interface LegacyAccount {
  id?: string;
  username?: string;
  displayName?: string;
  email?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  roles?: string[];
  status?: string;
  passwordHash?: string;
  createdAt?: number;
  updatedAt?: number;
  metadata?: Record<string, unknown>;
}

interface LegacyMessage {
  id?: string;
  channelId?: string;
  from?: string;
  fromId?: string;
  text?: string;
  ts?: number;
  roles?: string[];
  isSuperuser?: boolean;
  deleted?: boolean;
}

const readJson = <T>(path: string): T | null => {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
};

const main = () => {
  const dir = resolve(process.argv[2] ?? './storage');
  const config = loadConfigFromEnvFile();
  const db = openDatabase(config.database.path);
  const channels = new ChannelService(db, config);
  channels.seedDefaults();

  const accountsFile = readJson<{ accounts?: LegacyAccount[] }>(join(dir, 'accounts.json'));
  const insertAccount = db.prepare(`
    INSERT OR IGNORE INTO accounts (id, username, display_name, email, bio, avatar_url, roles, status, password_hash, metadata, created_at, updated_at)
    VALUES (@id, @username, @display_name, @email, @bio, @avatar_url, @roles, @status, @password_hash, @metadata, @created_at, @updated_at)
  `);
  let importedAccounts = 0;
  db.transaction(() => {
    for (const acct of accountsFile?.accounts ?? []) {
      if (!acct.id || !acct.username || !acct.passwordHash) continue;
      const now = Date.now();
      const result = insertAccount.run({
        id: acct.id,
        username: acct.username.toLowerCase(),
        display_name: acct.displayName || acct.username,
        email: acct.email ?? null,
        bio: acct.bio ?? null,
        avatar_url: acct.avatarUrl ?? null,
        roles: JSON.stringify(normalizeRoles(acct.roles)),
        status: acct.status === 'disabled' ? 'disabled' : 'active',
        password_hash: acct.passwordHash,
        metadata: JSON.stringify(acct.metadata ?? {}),
        created_at: acct.createdAt ?? now,
        updated_at: acct.updatedAt ?? now,
      });
      importedAccounts += result.changes;
    }
  })();

  // Messages were keyed by the old in-memory channel ids, which no longer
  // exist. Map them onto channels by name when the legacy file carries one.
  const messagesFile = readJson<Record<string, LegacyMessage[]> | { channels?: Record<string, LegacyMessage[]> }>(
    join(dir, 'messages.json'),
  );
  const buckets = (messagesFile && 'channels' in messagesFile && messagesFile.channels
    ? messagesFile.channels
    : (messagesFile as Record<string, LegacyMessage[]> | null)) ?? {};
  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO messages (id, channel_id, account_id, author_name, text, roles, is_superuser, created_at, deleted_at)
    VALUES (@id, @channel_id, NULL, @author_name, @text, @roles, @is_superuser, @created_at, @deleted_at)
  `);
  let importedMessages = 0;
  db.transaction(() => {
    for (const [key, list] of Object.entries(buckets)) {
      if (!Array.isArray(list)) continue;
      const channel = channels.resolve(key);
      if (!channel) continue;
      for (const msg of list) {
        if (!msg.id || !msg.text) continue;
        importedMessages += insertMessage.run({
          id: msg.id,
          channel_id: channel.id,
          author_name: msg.from || 'Unknown',
          text: msg.text,
          roles: JSON.stringify(normalizeRoles(msg.roles ?? [])),
          is_superuser: msg.isSuperuser ? 1 : 0,
          created_at: msg.ts ?? Date.now(),
          deleted_at: msg.deleted ? Date.now() : null,
        }).changes;
      }
    }
  })();

  db.close();
  console.log('imported ' + importedAccounts + ' account(s) and ' + importedMessages + ' message(s) from ' + dir);
};

main();
