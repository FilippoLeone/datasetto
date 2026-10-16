import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { permissionsInputSchema } from '../core/validation.js';
import { parseJson, type DB } from '../db/index.js';
import { CHANNEL_TYPES, type ChannelPermissions, type CreatableChannelType } from '../types.js';
import { clonePermissions, normalizePermissions } from './channels.js';

/** Permission templates applied to new channels, per channel kind (absent = server default). */
export type ChannelPermissionTemplates = Partial<Record<CreatableChannelType, ChannelPermissions>>;

export interface ServerSettings {
  channelPermissionTemplates: ChannelPermissionTemplates;
}

const templatesInputSchema = z
  .object({
    text: permissionsInputSchema.nullable().optional(),
    voice: permissionsInputSchema.nullable().optional(),
    stream: permissionsInputSchema.nullable().optional(),
    screenshare: permissionsInputSchema.nullable().optional(),
  })
  .partial();

export type ChannelPermissionTemplatesInput = z.infer<typeof templatesInputSchema>;

export const settingsUpdateSchema = z
  .object({
    channelPermissionTemplates: templatesInputSchema.optional(),
  })
  .partial();

export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

/**
 * Small key/value store for settings admins change at runtime. Values are
 * JSON; every key has a parser so a stale or hand-edited row cannot break
 * the server. Environment configuration stays in config.ts.
 */
export class SettingsService {
  private readonly stmts;

  constructor(db: DB) {
    this.stmts = {
      get: db.prepare('SELECT value FROM settings WHERE key = ?'),
      set: db.prepare(`
        INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
      `),
      remove: db.prepare('DELETE FROM settings WHERE key = ?'),
    };
  }

  private read<T>(key: string, fallback: T): T {
    const row = this.stmts.get.get(key) as { value: string } | undefined;
    return row ? parseJson<T>(row.value, fallback) : fallback;
  }

  private write(key: string, value: unknown, updatedBy: string | null): void {
    this.stmts.set.run(key, JSON.stringify(value), Date.now(), updatedBy);
  }

  all(): ServerSettings {
    return { channelPermissionTemplates: this.channelPermissionTemplates() };
  }

  /**
   * A random secret that survives restarts (e.g. for signing media tickets):
   * generated on first use and kept in the settings table.
   */
  secret(key: string): Buffer {
    const existing = this.read<string | null>(key, null);
    if (typeof existing === 'string' && existing.length >= 32) return Buffer.from(existing, 'base64url');
    const fresh = randomBytes(32);
    this.write(key, fresh.toString('base64url'), null);
    return fresh;
  }

  channelPermissionTemplates(): ChannelPermissionTemplates {
    const raw = this.read<Record<string, unknown>>('channelPermissionTemplates', {});
    const result: ChannelPermissionTemplates = {};
    for (const type of CHANNEL_TYPES) {
      const entry = raw[type];
      if (entry && typeof entry === 'object') result[type] = clonePermissions(entry as Partial<ChannelPermissions>);
    }
    return result;
  }

  /** Template for one kind, or null to use the server default (everyone, manage = admins). */
  channelPermissionTemplate(type: CreatableChannelType): ChannelPermissions | null {
    return this.channelPermissionTemplates()[type] ?? null;
  }

  /**
   * Merge an update. A template given as `null` clears that kind's template;
   * a partial template is normalised against the default permissions.
   */
  update(input: SettingsUpdate, updatedBy: string | null): ServerSettings {
    const parsed = settingsUpdateSchema.parse(input);
    if (parsed.channelPermissionTemplates) {
      const next = this.channelPermissionTemplates();
      for (const type of CHANNEL_TYPES) {
        if (!(type in parsed.channelPermissionTemplates)) continue;
        const entry = parsed.channelPermissionTemplates[type];
        if (entry === null || entry === undefined) delete next[type];
        else next[type] = normalizePermissions(entry);
      }
      this.write('channelPermissionTemplates', next, updatedBy);
    }
    return this.all();
  }
}
