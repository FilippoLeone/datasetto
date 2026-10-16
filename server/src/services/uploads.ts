import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { newId } from '../core/ids.js';
import type { DB } from '../db/index.js';
import { AppError } from '../errors.js';
import type { AttachmentRecord, AttachmentView } from '../types.js';

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif';

export const IMAGE_TYPES: Record<ImageFormat, { mime: string; ext: string }> = {
  png: { mime: 'image/png', ext: 'png' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  webp: { mime: 'image/webp', ext: 'webp' },
  gif: { mime: 'image/gif', ext: 'gif' },
};

/** MIME types the upload endpoint accepts (what the client offers in its file picker). */
export const ACCEPTED_IMAGE_TYPES = Object.values(IMAGE_TYPES).map((type) => type.mime);

/** Uploads that are never bound to a message are removed after this long. */
export const PENDING_UPLOAD_TTL_MS = 60 * 60 * 1000;
/** Viewer tickets (the `t` query of file URLs) stay valid this long; clients renew them earlier. */
export const MEDIA_TICKET_TTL_MS = 24 * 60 * 60 * 1000;
/** Decoded images above this many pixels are refused (decompression bombs). */
const MAX_INPUT_PIXELS = 40_000_000;

const FILE_PATTERN = /^(att-[a-z0-9]{20})(\.preview\.webp|\.(?:png|jpg|webp|gif))$/;

/** Sniff the container signature so the extension or the declared type cannot lie. */
export const detectImageFormat = (bytes: Buffer): ImageFormat | null => {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'gif';
  return null;
};

/** A file name safe to store and echo back: no paths, no control characters, bounded. */
export const sanitizeFileName = (name: unknown, fallback: string): string => {
  if (typeof name !== 'string') return fallback;
  const cleaned = name
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 200);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
};

export interface UploadConfig {
  dataDir: string;
  maxBytes: number;
  previewMaxPx: number;
}

interface AttachmentRow {
  id: string;
  message_id: string | null;
  account_id: string;
  kind: string;
  file_name: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  stored_name: string;
  preview_name: string | null;
  preview_width: number | null;
  preview_height: number | null;
  created_at: number;
}

const rowToRecord = (row: AttachmentRow): AttachmentRecord => ({
  id: row.id,
  messageId: row.message_id,
  accountId: row.account_id,
  kind: 'image',
  fileName: row.file_name,
  mime: row.mime,
  size: row.size,
  width: row.width,
  height: row.height,
  storedName: row.stored_name,
  previewName: row.preview_name,
  previewWidth: row.preview_width,
  previewHeight: row.preview_height,
  createdAt: row.created_at,
});

/** The wire shape; the client appends its media ticket to the URLs. */
export const attachmentView = (record: AttachmentRecord): AttachmentView => ({
  id: record.id,
  kind: record.kind,
  fileName: record.fileName,
  mime: record.mime,
  size: record.size,
  width: record.width,
  height: record.height,
  url: '/api/uploads/' + record.storedName,
  previewUrl: '/api/uploads/' + (record.previewName ?? record.storedName),
  previewWidth: record.previewWidth ?? record.width,
  previewHeight: record.previewHeight ?? record.height,
});

export interface MediaTicket {
  accountId: string;
  expiresAt: number;
}

/**
 * Pictures posted in chat. Files live under `DATA_DIR/uploads`: the original as
 * `<id>.<ext>` (signature-checked, decoded once to prove it is an image) and a
 * resized WebP preview as `<id>.preview.webp`. Rows are created by the upload and
 * bound to a message when it is sent; unbound rows are swept after an hour.
 *
 * Files are served only to viewers who may read the message's channel. Since an
 * `<img>` cannot send a bearer token, viewers get a signed media ticket (bound to
 * their account, one day) that the client appends to every file URL.
 */
export class UploadService {
  readonly dir: string;
  private readonly stmts;

  constructor(
    db: DB,
    private readonly config: UploadConfig,
    private readonly secret: Buffer,
  ) {
    this.dir = resolve(config.dataDir, 'uploads');
    mkdirSync(this.dir, { recursive: true });
    this.stmts = {
      insert: db.prepare(`
        INSERT INTO message_attachments (id, message_id, account_id, kind, file_name, mime, size, width, height, stored_name, preview_name, preview_width, preview_height, created_at)
        VALUES (@id, NULL, @account_id, @kind, @file_name, @mime, @size, @width, @height, @stored_name, @preview_name, @preview_width, @preview_height, @created_at)
      `),
      byId: db.prepare('SELECT * FROM message_attachments WHERE id = ?'),
      byMessage: db.prepare('SELECT * FROM message_attachments WHERE message_id = ? ORDER BY created_at ASC, rowid ASC'),
      byChannel: db.prepare(`
        SELECT a.* FROM message_attachments a JOIN messages m ON m.id = a.message_id WHERE m.channel_id = ?
      `),
      bind: db.prepare('UPDATE message_attachments SET message_id = ? WHERE id = ? AND account_id = ? AND message_id IS NULL'),
      deleteById: db.prepare('DELETE FROM message_attachments WHERE id = ?'),
      deleteByMessage: db.prepare('DELETE FROM message_attachments WHERE message_id = ?'),
      stalePending: db.prepare('SELECT * FROM message_attachments WHERE message_id IS NULL AND created_at < ?'),
      countPendingByAccount: db.prepare('SELECT COUNT(*) AS n FROM message_attachments WHERE message_id IS NULL AND account_id = ?'),
      allIds: db.prepare('SELECT id FROM message_attachments'),
    };
    this.bindAll = db.transaction((messageId: string, accountId: string, ids: string[]) => {
      const bound: AttachmentRecord[] = [];
      for (const id of ids) {
        const changed = this.stmts.bind.run(messageId, id, accountId).changes;
        if (changed !== 1) throw new AppError('One of the pictures is no longer available', 'ATTACHMENT_UNAVAILABLE', 409);
        const row = this.stmts.byId.get(id) as AttachmentRow;
        bound.push(rowToRecord(row));
      }
      return bound;
    });
  }

  private readonly bindAll: (messageId: string, accountId: string, ids: string[]) => AttachmentRecord[];

  get maxBytes(): number {
    return this.config.maxBytes;
  }

  /**
   * Validate and store one picture for `accountId`. The bytes are sniffed (PNG, JPEG,
   * WebP, GIF), decoded to make sure they really are an image and to read the size,
   * then written as they came, next to a preview resized to at most `previewMaxPx`
   * on its longest side (EXIF orientation applied, animation dropped).
   */
  async store(accountId: string, input: { fileName: unknown; bytes: Buffer }): Promise<AttachmentRecord> {
    if (!/^[a-z0-9-]{1,64}$/.test(accountId)) throw new AppError('Invalid account id', 'INVALID_ACCOUNT', 400);
    if (input.bytes.length === 0) throw new AppError('The file is empty', 'UPLOAD_EMPTY', 400);
    if (input.bytes.length > this.config.maxBytes) {
      throw new AppError('Pictures must be ' + Math.floor(this.config.maxBytes / (1024 * 1024)) + ' MB or smaller', 'UPLOAD_TOO_LARGE', 413);
    }
    const format = detectImageFormat(input.bytes);
    if (!format) throw new AppError('Only PNG, JPEG, WebP and GIF pictures can be shared', 'UPLOAD_FORMAT', 415);
    // Too many half-finished uploads from one account: the composer never keeps more than a handful.
    const pending = Number((this.stmts.countPendingByAccount.get(accountId) as { n: number }).n);
    if (pending >= 40) throw new AppError('Send or remove your pending pictures first', 'UPLOAD_PENDING_LIMIT', 429);

    let width: number;
    let height: number;
    let preview: { data: Buffer; info: { width: number; height: number } };
    try {
      const image = sharp(input.bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });
      const meta = await image.metadata();
      if (meta.format !== format || !meta.width || !meta.height) throw new Error('not decodable');
      // Orientations 5 to 8 rotate the picture by 90 degrees: report what the viewer sees.
      const sideways = typeof meta.orientation === 'number' && meta.orientation >= 5;
      width = sideways ? meta.height : meta.width;
      height = sideways ? meta.width : meta.height;
      preview = await image
        .rotate()
        .resize({ width: this.config.previewMaxPx, height: this.config.previewMaxPx, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
    } catch {
      throw new AppError('The file could not be read as a picture', 'UPLOAD_FORMAT', 415);
    }

    const type = IMAGE_TYPES[format];
    const id = newId('att', 20);
    const record: AttachmentRecord = {
      id,
      messageId: null,
      accountId,
      kind: 'image',
      fileName: sanitizeFileName(input.fileName, 'image.' + type.ext),
      mime: type.mime,
      size: input.bytes.length,
      width,
      height,
      storedName: id + '.' + type.ext,
      previewName: id + '.preview.webp',
      previewWidth: preview.info.width,
      previewHeight: preview.info.height,
      createdAt: Date.now(),
    };
    this.writeFile(record.storedName, input.bytes);
    this.writeFile(record.previewName as string, preview.data);
    this.stmts.insert.run({
      id: record.id,
      account_id: record.accountId,
      kind: record.kind,
      file_name: record.fileName,
      mime: record.mime,
      size: record.size,
      width: record.width,
      height: record.height,
      stored_name: record.storedName,
      preview_name: record.previewName,
      preview_width: record.previewWidth,
      preview_height: record.previewHeight,
      created_at: record.createdAt,
    });
    return record;
  }

  private writeFile(name: string, bytes: Buffer): void {
    const target = join(this.dir, name);
    const temp = target + '.' + process.pid + '.tmp';
    writeFileSync(temp, bytes);
    renameSync(temp, target);
  }

  /**
   * Bind pending uploads of `accountId` to a message, in order. Every id must be
   * an unbound upload of that account, else nothing is bound.
   */
  attach(messageId: string, accountId: string, ids: readonly string[]): AttachmentRecord[] {
    const unique = Array.from(new Set(ids));
    if (unique.length === 0) return [];
    return this.bindAll(messageId, accountId, unique);
  }

  get(id: string): AttachmentRecord | null {
    const row = this.stmts.byId.get(id) as AttachmentRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  listForMessage(messageId: string): AttachmentRecord[] {
    return (this.stmts.byMessage.all(messageId) as AttachmentRow[]).map(rowToRecord);
  }

  /** Validate a file name from a URL; returns the attachment it belongs to and where the bytes are. */
  resolveFile(name: string): { record: AttachmentRecord; path: string; contentType: string; isPreview: boolean } | null {
    const match = FILE_PATTERN.exec(name);
    if (!match) return null;
    const record = this.get(match[1]);
    if (!record) return null;
    const isPreview = name === record.previewName;
    if (!isPreview && name !== record.storedName) return null;
    const path = join(this.dir, name);
    if (!path.startsWith(this.dir)) return null;
    return { record, path, contentType: isPreview ? 'image/webp' : record.mime, isPreview };
  }

  /** Drop pending uploads (files and rows) by id; bound ones are left alone. */
  discard(ids: readonly string[]): number {
    let removed = 0;
    for (const id of ids) {
      const record = this.get(id);
      if (!record || record.messageId !== null) continue;
      this.removeFiles([record]);
      this.stmts.deleteById.run(id);
      removed += 1;
    }
    return removed;
  }

  /** Delete the files and rows of a message's attachments. Returns how many attachments went. */
  deleteForMessage(messageId: string): number {
    const records = this.listForMessage(messageId);
    this.removeFiles(records);
    this.stmts.deleteByMessage.run(messageId);
    return records.length;
  }

  /** Delete the files of every attachment in a channel (rows cascade with the channel's messages). */
  deleteForChannel(channelId: string): number {
    const records = (this.stmts.byChannel.all(channelId) as AttachmentRow[]).map(rowToRecord);
    this.removeFiles(records);
    for (const record of records) this.stmts.deleteById.run(record.id);
    return records.length;
  }

  /** Remove the files behind attachments (rows are the caller's business). */
  removeFiles(records: readonly Pick<AttachmentRecord, 'storedName' | 'previewName'>[]): void {
    for (const record of records) {
      for (const name of [record.storedName, record.previewName]) {
        if (!name) continue;
        try {
          unlinkSync(join(this.dir, name));
        } catch {
          /* already gone */
        }
      }
    }
  }

  /**
   * Housekeeping, run hourly: uploads never sent are dropped after an hour, and
   * files whose row disappeared (channel deleted, retention pruning) are removed.
   */
  sweep(now = Date.now()): { pending: number; orphans: number } {
    const stale = (this.stmts.stalePending.all(now - PENDING_UPLOAD_TTL_MS) as AttachmentRow[]).map(rowToRecord);
    this.removeFiles(stale);
    for (const record of stale) this.stmts.deleteById.run(record.id);

    const known = new Set((this.stmts.allIds.all() as Array<{ id: string }>).map((row) => row.id));
    let orphans = 0;
    for (const name of readdirSync(this.dir)) {
      const match = FILE_PATTERN.exec(name);
      if (!match || known.has(match[1])) continue;
      try {
        unlinkSync(join(this.dir, name));
        orphans += 1;
      } catch {
        /* raced with another delete */
      }
    }
    return { pending: stale.length, orphans };
  }

  // ------------------------------------------------------------- tickets

  /** A signed ticket the client appends to file URLs (`?t=`), bound to the account. */
  issueTicket(accountId: string, now = Date.now()): { ticket: string; expiresAt: number } {
    const expiresAt = now + MEDIA_TICKET_TTL_MS;
    const body = Buffer.from(JSON.stringify({ k: 'media', a: accountId, e: expiresAt }), 'utf8').toString('base64url');
    return { ticket: body + '.' + this.sign(body), expiresAt };
  }

  verifyTicket(ticket: unknown, now = Date.now()): MediaTicket | null {
    if (typeof ticket !== 'string' || ticket.length > 512) return null;
    const dot = ticket.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = ticket.slice(0, dot);
    const signature = ticket.slice(dot + 1);
    const expected = this.sign(body);
    if (signature.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'))) return null;
    let claims: { k?: unknown; a?: unknown; e?: unknown };
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as typeof claims;
    } catch {
      return null;
    }
    if (claims.k !== 'media' || typeof claims.a !== 'string' || typeof claims.e !== 'number') return null;
    if (claims.e <= now) return null;
    return { accountId: claims.a, expiresAt: claims.e };
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}
