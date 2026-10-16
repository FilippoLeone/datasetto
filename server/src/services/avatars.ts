import { mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppError } from '../errors.js';

export type AvatarFormat = 'webp' | 'png';

/** Largest upload accepted (the client resizes to 256x256 first, so real files are far smaller). */
export const MAX_AVATAR_BYTES = 1024 * 1024;

const FILE_PATTERN = /^([a-z0-9-]{1,64})\.(webp|png)$/;

/** Sniff the container signature so a renamed file cannot be served under an image type. */
export const detectAvatarFormat = (bytes: Buffer): AvatarFormat | null => {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
};

export const avatarContentType = (format: AvatarFormat): string => (format === 'png' ? 'image/png' : 'image/webp');

/**
 * Uploaded profile pictures, one file per account under `DATA_DIR/avatars`.
 * The account's `avatar_url` points at `/api/avatars/<id>.<ext>?v=<time>`;
 * the version query lets the route send immutable cache headers.
 */
export class AvatarService {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = resolve(dataDir, 'avatars');
    mkdirSync(this.dir, { recursive: true });
  }

  /** Validate a file name from a URL and return its absolute path, or null. */
  resolveFile(name: string): { path: string; format: AvatarFormat; accountId: string } | null {
    const match = FILE_PATTERN.exec(name);
    if (!match) return null;
    const format = match[2] as AvatarFormat;
    const path = join(this.dir, match[1] + '.' + format);
    if (!path.startsWith(this.dir)) return null;
    return { path, format, accountId: match[1] };
  }

  /** Public URL for an account's current avatar file, or null when none is stored. */
  urlFor(accountId: string): string | null {
    for (const format of ['webp', 'png'] as AvatarFormat[]) {
      const path = join(this.dir, accountId + '.' + format);
      try {
        const stat = statSync(path);
        return '/api/avatars/' + accountId + '.' + format + '?v=' + Math.floor(stat.mtimeMs);
      } catch {
        /* not this format */
      }
    }
    return null;
  }

  /** Is this one of our avatar URLs (as opposed to an external link the user typed)? */
  static isLocalUrl(url: string | null | undefined): boolean {
    return typeof url === 'string' && /^\/api\/avatars\/[a-z0-9-]+\.(webp|png)(\?.*)?$/.test(url);
  }

  /** Store the image (sniffed as PNG or WebP) and return the new URL. Replaces any previous file. */
  save(accountId: string, bytes: Buffer): string {
    if (!/^[a-z0-9-]{1,64}$/.test(accountId)) throw new AppError('Invalid account id', 'INVALID_ACCOUNT', 400);
    if (bytes.length === 0) throw new AppError('Empty upload', 'AVATAR_EMPTY', 400);
    if (bytes.length > MAX_AVATAR_BYTES) throw new AppError('Avatar must be 1 MB or smaller', 'AVATAR_TOO_LARGE', 413);
    const format = detectAvatarFormat(bytes);
    if (!format) throw new AppError('Avatar must be a PNG or WebP image', 'AVATAR_FORMAT', 415);

    const target = join(this.dir, accountId + '.' + format);
    const temp = target + '.' + process.pid + '.tmp';
    writeFileSync(temp, bytes);
    renameSync(temp, target);
    // Only one format per account: drop the other one if it exists.
    const other = join(this.dir, accountId + '.' + (format === 'png' ? 'webp' : 'png'));
    try {
      unlinkSync(other);
    } catch {
      /* none */
    }
    return this.urlFor(accountId) ?? '/api/avatars/' + accountId + '.' + format;
  }

  /** Delete the stored file, if any. */
  remove(accountId: string): boolean {
    let removed = false;
    for (const format of ['webp', 'png'] as AvatarFormat[]) {
      try {
        unlinkSync(join(this.dir, accountId + '.' + format));
        removed = true;
      } catch {
        /* none */
      }
    }
    return removed;
  }
}
