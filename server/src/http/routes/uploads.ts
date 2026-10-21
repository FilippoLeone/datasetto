import { Readable, Transform } from 'node:stream';
import { Router, type Request, type Response } from 'express';
import type { AppContext } from '../../context.js';
import { RateLimiter } from '../../core/rateLimit.js';
import { AppError } from '../../errors.js';
import { attachmentView } from '../../services/uploads.js';
import type { AccountRecord, AttachmentRecord } from '../../types.js';

/** Files one request may carry; the composer sends them one at a time anyway. */
export const MAX_FILES_PER_REQUEST = 10;
/** Uploads per account per minute. */
export const UPLOADS_PER_MINUTE = 30;

const bearerToken = (req: Request): string | null => {
  const header = req.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
};

/** Read a multipart/form-data body (every `files` or `file` part) with a hard byte ceiling. */
const readMultipart = async (req: Request, maxBytes: number): Promise<Array<{ name: string; bytes: Buffer }>> => {
  const contentType = req.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new AppError('Send the files as multipart/form-data', 'UPLOAD_FORMAT', 415);
  }
  const declared = Number(req.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new AppError('The upload is too large', 'UPLOAD_TOO_LARGE', 413);

  let received = 0;
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) {
        callback(new AppError('The upload is too large', 'UPLOAD_TOO_LARGE', 413));
        return;
      }
      callback(null, chunk);
    },
  });
  const body = new Response(Readable.toWeb(req.pipe(guard)) as ReadableStream, { headers: { 'content-type': contentType } });
  let form: FormData;
  try {
    form = await body.formData();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('The upload could not be read', 'UPLOAD_MALFORMED', 400);
  }
  const files: Array<{ name: string; bytes: Buffer }> = [];
  for (const [field, value] of form) {
    if ((field !== 'files' && field !== 'file') || typeof value === 'string') continue;
    if (files.length >= MAX_FILES_PER_REQUEST) throw new AppError('At most ' + MAX_FILES_PER_REQUEST + ' files per upload', 'UPLOAD_TOO_MANY', 400);
    files.push({ name: value.name, bytes: Buffer.from(await value.arrayBuffer()) });
  }
  if (files.length === 0) throw new AppError('No file in the upload', 'UPLOAD_EMPTY', 400);
  return files;
};

/**
 * Pictures and videos in chat.
 * - `POST /api/uploads` (Bearer session token, multipart/form-data with one or more
 *   `files` parts) checks and stores each file and answers with the attachments
 *   to put in the next `chat` event (`attachmentIds`). Unsent uploads vanish after an hour.
 * - `GET /api/uploads/:file?t=<media ticket>` serves originals and previews to signed-in
 *   viewers who may read the message's channel; private channels and DMs stay private.
 *   The ticket comes with `auth:success` (`media`) and `media:ticket`. Range requests
 *   are honoured, so a `<video>` can seek.
 */
export const uploadsRouter = (ctx: AppContext): Router => {
  const router = Router();
  const accountLimiter = new RateLimiter(UPLOADS_PER_MINUTE, 60_000);
  const ipLimiter = new RateLimiter(UPLOADS_PER_MINUTE * 3, 60_000);

  const activeAccount = (accountId: string): AccountRecord | null => {
    const record = ctx.accounts.getById(accountId);
    if (!record || record.status !== 'active' || ctx.moderation.getBan(record.id)) return null;
    return record;
  };

  const requireAccount = (req: Request): AccountRecord => {
    const session = ctx.sessions.resume(bearerToken(req));
    const record = session ? activeAccount(session.accountId) : null;
    if (!record) throw new AppError('Sign in to share files', 'NOT_AUTHENTICATED', 401);
    return record;
  };

  const notFound = (res: Response) => res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });

  router.get('/api/uploads/:file', (req, res) => {
    const file = ctx.uploads.resolveFile(String(req.params.file ?? ''));
    if (!file) {
      notFound(res);
      return;
    }
    const ticket = ctx.uploads.verifyTicket(typeof req.query.t === 'string' ? req.query.t : req.get('x-media-ticket'));
    const viewer = ticket ? activeAccount(ticket.accountId) : null;
    if (!viewer) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(401).json({ error: 'A valid media ticket is required', code: 'NOT_AUTHENTICATED' });
      return;
    }
    const { record } = file;
    // Pending uploads belong to their uploader; sent ones to whoever may read the channel.
    let allowed = false;
    if (record.messageId === null) {
      allowed = record.accountId === viewer.id;
    } else {
      const channel = ctx.channels.get(ctx.messages.channelOf(record.messageId));
      const subject = { accountId: viewer.id, roles: viewer.roles, isSuperuser: viewer.roles.includes('superuser') };
      allowed = Boolean(channel) && ctx.channels.canAccess(channel, subject, 'view');
    }
    if (!allowed) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(403).json({ error: 'No permission to view this file', code: 'FORBIDDEN' });
      return;
    }
    const name = (file.isPreview ? record.fileName.replace(/\.[^.]+$/, '') + '.webp' : record.fileName).replace(/["\\\r\n]/g, '_');
    res.sendFile(
      file.path,
      {
        headers: {
          'Content-Type': file.contentType,
          // The URL carries the viewer's ticket, so the entry is private to this browser; the bytes never change.
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': 'inline; filename="' + name + '"',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        },
        dotfiles: 'deny',
      },
      (error) => {
        if (error && !res.headersSent) notFound(res);
      },
    );
  });

  router.post('/api/uploads', async (req, res) => {
    if (!ipLimiter.hit(req.ip ?? 'unknown').allowed) {
      res.status(429).json({ error: 'Too many uploads', code: 'RATE_LIMITED' });
      return;
    }
    const account = requireAccount(req);
    if (!accountLimiter.hit(account.id).allowed) {
      res.status(429).json({ error: 'Too many uploads, try again in a minute', code: 'RATE_LIMITED' });
      return;
    }
    // A request carries up to ten pictures and one clip-sized video, plus some room for the multipart
    // framing; the body is read into memory, so this is also the bound on what one request may cost.
    const files = await readMultipart(req, MAX_FILES_PER_REQUEST * ctx.uploads.maxBytes + ctx.uploads.videoMaxBytes + 64 * 1024);
    const stored: AttachmentRecord[] = [];
    try {
      for (const file of files) stored.push(await ctx.uploads.store(account.id, { fileName: file.name, bytes: file.bytes }));
    } catch (error) {
      // All or nothing: a request with one bad file leaves nothing behind.
      ctx.uploads.discard(stored.map((record) => record.id));
      throw error;
    }
    ctx.log.info({ accountId: account.id, files: stored.length, bytes: files.reduce((sum, file) => sum + file.bytes.length, 0) }, 'files uploaded');
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ attachments: stored.map(attachmentView) });
  });

  return router;
};
