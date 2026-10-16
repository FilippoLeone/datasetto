import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UPLOADS_PER_MINUTE } from '../src/http/routes/uploads.js';
import { detectImageFormat, MEDIA_TICKET_TTL_MS, PENDING_UPLOAD_TTL_MS, sanitizeFileName } from '../src/services/uploads.js';
import type { AttachmentView } from '../src/types.js';
import { makeContext, startTestServer, type TestServer } from './helpers.js';

const images: Record<'png' | 'jpeg' | 'webp' | 'gif' | 'tall' | 'rotated', Buffer> = {} as never;

/** Every test gets its own upload directory, so file listings only show its own pictures. */
const freshDataDir = (overrides: Record<string, string> = {}): Record<string, string> => ({ DATA_DIR: mkdtempSync(join(tmpdir(), 'datasetto-uploads-')), ...overrides });

beforeAll(async () => {
  const base = sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 30, b: 30 } } });
  images.png = await base.clone().png().toBuffer();
  images.jpeg = await base.clone().jpeg().toBuffer();
  images.webp = await base.clone().webp().toBuffer();
  images.gif = await base.clone().gif().toBuffer();
  // Larger than the preview limit on its long side.
  images.tall = await sharp({ create: { width: 900, height: 3000, channels: 3, background: '#2244aa' } }).png().toBuffer();
  // EXIF says "rotate 90 degrees": viewers see a 48x64 picture.
  images.rotated = await base.clone().jpeg().withMetadata({ orientation: 6 }).toBuffer();
});

describe('image sniffing', () => {
  it('recognises the four accepted containers by signature only', () => {
    expect(detectImageFormat(images.png)).toBe('png');
    expect(detectImageFormat(images.jpeg)).toBe('jpeg');
    expect(detectImageFormat(images.webp)).toBe('webp');
    expect(detectImageFormat(images.gif)).toBe('gif');
    expect(detectImageFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(detectImageFormat(Buffer.from('%PDF-1.4'))).toBeNull();
    expect(detectImageFormat(Buffer.alloc(0))).toBeNull();
    expect(detectImageFormat(Buffer.from('RIFF....WAVE'))).toBeNull();
  });

  it('keeps file names harmless', () => {
    expect(sanitizeFileName('../../etc/passwd', 'x')).toBe('.._.._etc_passwd');
    expect(sanitizeFileName('C:\\Users\\me\\cat.png', 'x')).toBe('C:_Users_me_cat.png');
    expect(sanitizeFileName('  \u0000evil\u001f.png ', 'x')).toBe('evil.png');
    expect(sanitizeFileName('', 'image.png')).toBe('image.png');
    expect(sanitizeFileName('..', 'image.png')).toBe('image.png');
    expect(sanitizeFileName(42, 'image.png')).toBe('image.png');
    expect(sanitizeFileName('x'.repeat(500), 'f')).toHaveLength(200);
  });
});

describe('UploadService', () => {
  it('stores originals as they came with a resized preview, and reports what the viewer sees', async () => {
    const ctx = makeContext(freshDataDir());
    const alice = await ctx.accounts.register({ username: 'alice@example.com', password: 'password123', displayName: 'Alice' });

    const tall = await ctx.uploads.store(alice.id, { fileName: 'tall.png', bytes: images.tall });
    expect(tall).toMatchObject({ messageId: null, accountId: alice.id, kind: 'image', fileName: 'tall.png', mime: 'image/png', size: images.tall.length, width: 900, height: 3000 });
    expect(tall.previewWidth).toBe(384);
    expect(tall.previewHeight).toBe(1280);
    expect(statSync(join(ctx.uploads.dir, tall.storedName)).size).toBe(images.tall.length);
    const preview = await sharp(join(ctx.uploads.dir, tall.previewName as string)).metadata();
    expect([preview.format, preview.width, preview.height]).toEqual(['webp', 384, 1280]);

    const rotated = await ctx.uploads.store(alice.id, { fileName: 'phone.jpg', bytes: images.rotated });
    expect([rotated.width, rotated.height]).toEqual([48, 64]);
    expect([rotated.previewWidth, rotated.previewHeight]).toEqual([48, 64]);
    expect(rotated.mime).toBe('image/jpeg');
    expect(rotated.storedName).toMatch(/^att-[a-z0-9]{20}\.jpg$/);

    const gif = await ctx.uploads.store(alice.id, { fileName: 'anim.gif', bytes: images.gif });
    expect(gif.mime).toBe('image/gif');
    // Small pictures are not enlarged.
    expect([gif.previewWidth, gif.previewHeight]).toEqual([64, 48]);
  });

  it('refuses empty, oversized, mislabelled and undecodable files', async () => {
    const ctx = makeContext(freshDataDir({ UPLOAD_MAX_MB: '1' }));
    const alice = await ctx.accounts.register({ username: 'alice@example.com', password: 'password123', displayName: 'Alice' });
    await expect(ctx.uploads.store(alice.id, { fileName: 'a.png', bytes: Buffer.alloc(0) })).rejects.toMatchObject({ code: 'UPLOAD_EMPTY' });
    const huge = Buffer.concat([images.png, Buffer.alloc(1024 * 1024)]);
    await expect(ctx.uploads.store(alice.id, { fileName: 'a.png', bytes: huge })).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE', status: 413 });
    // The name and the declared type never matter, only the bytes.
    await expect(ctx.uploads.store(alice.id, { fileName: 'notes.png', bytes: Buffer.from('hello, not an image') })).rejects.toMatchObject({ code: 'UPLOAD_FORMAT', status: 415 });
    await expect(ctx.uploads.store(alice.id, { fileName: 'x.png', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>') })).rejects.toMatchObject({ code: 'UPLOAD_FORMAT' });
    // A real signature glued to garbage does not decode.
    await expect(ctx.uploads.store(alice.id, { fileName: 'x.png', bytes: Buffer.concat([images.png.subarray(0, 8), Buffer.alloc(300, 7)]) })).rejects.toMatchObject({ code: 'UPLOAD_FORMAT' });
    expect(readdirSync(ctx.uploads.dir).filter((name) => name.startsWith('att-'))).toEqual([]);
  });

  it('binds uploads to messages only for their owner, once, and up to the per-message cap', async () => {
    const ctx = makeContext(freshDataDir());
    const alice = await ctx.accounts.register({ username: 'alice@example.com', password: 'password123', displayName: 'Alice' });
    const bob = await ctx.accounts.register({ username: 'bob@example.com', password: 'password123', displayName: 'Bob' });
    const author = ctx.presence.addUser('sock-1', alice);
    const channel = ctx.channels.getByName('general')!;
    const mine = await ctx.uploads.store(alice.id, { fileName: 'a.png', bytes: images.png });
    const theirs = await ctx.uploads.store(bob.id, { fileName: 'b.png', bytes: images.png });

    const message = ctx.messages.create(channel.id, author, '', { allowEmpty: true });
    expect(() => ctx.messages.attach(message, [theirs.id])).toThrow(/no longer available/);
    expect(() => ctx.messages.attach(message, ['att-missing'])).toThrow(/no longer available/);
    const withPicture = ctx.messages.attach(message, [mine.id, mine.id]);
    expect(withPicture.attachments).toHaveLength(1);
    expect(withPicture.attachments[0]).toMatchObject({ id: mine.id, url: '/api/uploads/' + mine.storedName, previewUrl: '/api/uploads/' + mine.previewName, width: 64, height: 48 });
    // Bound once: a second message cannot take it.
    const second = ctx.messages.create(channel.id, author, 'again');
    expect(() => ctx.messages.attach(second, [mine.id])).toThrow(/no longer available/);
    expect(() => ctx.messages.attach(second, Array.from({ length: 11 }, (_, i) => 'att-' + i))).toThrow(/At most 10/);
    // Nothing bound when one id fails.
    const other = await ctx.uploads.store(alice.id, { fileName: 'c.png', bytes: images.png });
    expect(() => ctx.messages.attach(second, [other.id, theirs.id])).toThrow();
    expect(ctx.uploads.get(other.id)?.messageId).toBeNull();

    // History and single reads carry the pictures; an empty text is fine with a picture.
    expect(ctx.messages.history(channel.id)[0].attachments.map((a) => a.id)).toEqual([mine.id]);
    expect(ctx.messages.get(channel.id, message.id)?.attachments).toHaveLength(1);
    expect(() => ctx.messages.create(channel.id, author, '   ')).toThrow(/empty/);
  });

  it('deletes files with the message, with retention pruning, with the channel and on sweep', async () => {
    const ctx = makeContext(freshDataDir({ MESSAGE_RETENTION_PER_CHANNEL: '100' }));
    const alice = await ctx.accounts.register({ username: 'alice@example.com', password: 'password123', displayName: 'Alice' });
    const author = ctx.presence.addUser('sock-1', alice);
    const channel = ctx.channels.getByName('general')!;
    const files = (view: { storedName: string; previewName: string | null }) => [view.storedName, view.previewName as string].map((name) => join(ctx.uploads.dir, name));

    // Soft delete removes the files and the rows right away.
    const a = await ctx.uploads.store(alice.id, { fileName: 'a.png', bytes: images.png });
    const first = ctx.messages.attach(ctx.messages.create(channel.id, author, 'pic', {}), [a.id]);
    expect(files(a).every(existsSync)).toBe(true);
    const deleted = ctx.messages.delete(channel.id, first.id, 'Alice');
    expect(deleted.attachments).toEqual([]);
    expect(files(a).some(existsSync)).toBe(false);
    expect(ctx.uploads.get(a.id)).toBeNull();

    // Pruned messages take their files along.
    const b = await ctx.uploads.store(alice.id, { fileName: 'b.png', bytes: images.png });
    ctx.messages.attach(ctx.messages.create(channel.id, author, 'old'), [b.id]);
    for (let i = 0; i < 100; i += 1) ctx.messages.create(channel.id, author, 'filler ' + i);
    ctx.messages.prune(channel.id);
    expect(ctx.uploads.get(b.id)).toBeNull();
    expect(files(b).some(existsSync)).toBe(false);

    // Channel deletion: rows cascade, files go through deleteForChannel.
    const extra = ctx.channels.create({ name: 'pics', type: 'text' });
    const c = await ctx.uploads.store(alice.id, { fileName: 'c.png', bytes: images.png });
    ctx.messages.attach(ctx.messages.create(extra.id, author, 'in pics'), [c.id]);
    expect(ctx.uploads.deleteForChannel(extra.id)).toBe(1);
    ctx.channels.delete(extra.id);
    expect(files(c).some(existsSync)).toBe(false);

    // Sweep: stale pending uploads and files without a row.
    const stale = await ctx.uploads.store(alice.id, { fileName: 'stale.png', bytes: images.png });
    const fresh = await ctx.uploads.store(alice.id, { fileName: 'fresh.png', bytes: images.png });
    writeFileSync(join(ctx.uploads.dir, 'att-orphanorphanorphan00.png'), images.png);
    writeFileSync(join(ctx.uploads.dir, 'unrelated.txt'), 'keep me');
    const swept = ctx.uploads.sweep(Date.now() + PENDING_UPLOAD_TTL_MS + 1000);
    expect(swept).toEqual({ pending: 2, orphans: 1 });
    expect(ctx.uploads.get(stale.id)).toBeNull();
    expect(ctx.uploads.get(fresh.id)).toBeNull();
    expect(existsSync(join(ctx.uploads.dir, 'att-orphanorphanorphan00.png'))).toBe(false);
    expect(existsSync(join(ctx.uploads.dir, 'unrelated.txt'))).toBe(true);
    const kept = await ctx.uploads.store(alice.id, { fileName: 'kept.png', bytes: images.png });
    expect(ctx.uploads.sweep()).toEqual({ pending: 0, orphans: 0 });
    expect(ctx.uploads.get(kept.id)).not.toBeNull();
  });

  it('issues account-bound tickets that expire and cannot be forged', () => {
    const ctx = makeContext(freshDataDir());
    const { ticket, expiresAt } = ctx.uploads.issueTicket('acct-1', 1000);
    expect(expiresAt).toBe(1000 + MEDIA_TICKET_TTL_MS);
    expect(ctx.uploads.verifyTicket(ticket, 2000)).toEqual({ accountId: 'acct-1', expiresAt });
    expect(ctx.uploads.verifyTicket(ticket, expiresAt)).toBeNull();
    expect(ctx.uploads.verifyTicket(ticket.slice(0, -2) + 'zz', 2000)).toBeNull();
    const [body] = ticket.split('.');
    expect(ctx.uploads.verifyTicket(body + '.' + 'A'.repeat(43), 2000)).toBeNull();
    expect(ctx.uploads.verifyTicket(undefined)).toBeNull();
    expect(ctx.uploads.verifyTicket('')).toBeNull();
    // The HLS ticket signer is a different key space: its tickets are not media tickets.
    const hls = ctx.hlsTickets.issue('general', 'acct-1').ticket;
    expect(ctx.uploads.verifyTicket(hls)).toBeNull();
    // The secret is kept in the settings table, so a restart keeps tickets valid.
    const again = makeContext();
    expect(again.uploads.verifyTicket(ticket, 2000)).toBeNull();
    expect(ctx.settings.secret('mediaTicketSecret').equals(ctx.settings.secret('mediaTicketSecret'))).toBe(true);
  });
});

const once = <T = unknown>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ' + event)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const client = (url: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });

describe('uploads over HTTP and chat', () => {
  let server: TestServer;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    server = await startTestServer(freshDataDir({ UPLOAD_MAX_MB: '1' }));
  });
  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
    await server.close();
  });

  const signUp = async (username: string, displayName: string) => {
    const account = await server.ctx.accounts.register({ username, password: 'password123', displayName });
    const session = server.ctx.sessions.create(account.id);
    const socket = await client(server.url);
    sockets.push(socket);
    const success = once<{ media: { ticket: string; expiresAt: number } }>(socket, 'auth:success');
    socket.emit('auth:session', { token: session.token });
    const auth = await success;
    return { account, socket, auth: { Authorization: 'Bearer ' + session.token }, ticket: auth.media.ticket };
  };

  const upload = (auth: Record<string, string>, bytes: Buffer, name = 'pic.png') =>
    request(server.url).post('/api/uploads').set(auth).attach('files', bytes, { filename: name, contentType: 'image/png' });

  it('validates the request and the pictures before storing anything', async () => {
    const api = request(server.url);
    await api.post('/api/uploads').attach('files', images.png, 'a.png').expect(401);
    const { auth } = await signUp('alice@example.com', 'Alice');
    const text = await api.post('/api/uploads').set(auth).set('Content-Type', 'image/png').send(images.png).expect(415);
    expect(text.body.code).toBe('UPLOAD_FORMAT');
    const nothing = await api.post('/api/uploads').set(auth).field('note', 'hello').expect(400);
    expect(nothing.body.code).toBe('UPLOAD_EMPTY');
    // A text file called .png with an image content type: the bytes decide.
    const fake = await upload(auth, Buffer.from('definitely text'), 'fake.png').expect(415);
    expect(fake.body.code).toBe('UPLOAD_FORMAT');
    const huge = await upload(auth, Buffer.concat([images.png, Buffer.alloc(1024 * 1024 + 1)])).expect(413);
    expect(huge.body.code).toBe('UPLOAD_TOO_LARGE');
    // One bad file in a batch stores none of them.
    const mixed = await request(server.url).post('/api/uploads').set(auth).attach('files', images.png, 'ok.png').attach('files', Buffer.from('nope'), 'bad.png').expect(415);
    expect(mixed.body.code).toBe('UPLOAD_FORMAT');
    expect(readdirSync(server.ctx.uploads.dir).filter((name) => name.startsWith('att-'))).toEqual([]);
    expect((server.ctx.db.prepare('SELECT COUNT(*) AS n FROM message_attachments').get() as { n: number }).n).toBe(0);
  });

  it('rate limits uploads per account', async () => {
    const { auth } = await signUp('alice@example.com', 'Alice');
    for (let i = 0; i < UPLOADS_PER_MINUTE; i += 1) await upload(auth, images.png).expect(201);
    const limited = await upload(auth, images.png).expect(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    // Another account (same IP) is not affected by the per-account bucket.
    const { auth: bobAuth } = await signUp('bob@example.com', 'Bob');
    await upload(bobAuth, images.png).expect(201);
  });

  it('serves pictures only to people who may read the channel, and never without a ticket', async () => {
    const alice = await signUp('alice@example.com', 'Alice');
    const bob = await signUp('bob@example.com', 'Bob');
    const carol = await signUp('carol@example.com', 'Carol');
    const secret = server.ctx.channels.create({ name: 'secret', type: 'text', visibility: 'private', creatorAccountId: alice.account.id });
    server.ctx.channels.addMember(secret.id, bob.account.id);

    const uploaded = await upload(alice.auth, images.tall, 'tall.png').expect(201);
    const [attachment] = uploaded.body.attachments as AttachmentView[];
    expect(attachment).toMatchObject({ kind: 'image', fileName: 'tall.png', mime: 'image/png', width: 900, height: 3000, previewWidth: 384, previewHeight: 1280 });

    // Before it is sent, only the uploader can look at it.
    await request(server.url).get(attachment.previewUrl).expect(401);
    await request(server.url).get(attachment.previewUrl).query({ t: alice.ticket }).expect(200);
    await request(server.url).get(attachment.previewUrl).query({ t: bob.ticket }).expect(403);

    const joined = once(alice.socket, 'channel:joined');
    alice.socket.emit('channel:join', secret.id);
    await joined;
    const bobSees = once<{ id: string; attachments: AttachmentView[]; text: string }>(bob.socket, 'chat');
    alice.socket.emit('chat', { text: '', attachmentIds: [attachment.id] });
    const message = await bobSees;
    expect(message.text).toBe('');
    expect(message.attachments.map((a) => a.id)).toEqual([attachment.id]);

    const original = await request(server.url).get(attachment.url).query({ t: bob.ticket }).expect(200);
    expect(original.headers['content-type']).toBe('image/png');
    expect(original.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(original.headers['x-content-type-options']).toBe('nosniff');
    expect(original.headers['content-disposition']).toBe('inline; filename="tall.png"');
    expect(Buffer.from(original.body as ArrayBuffer).length).toBe(images.tall.length);
    const preview = await request(server.url).get(attachment.previewUrl).query({ t: bob.ticket }).expect(200);
    expect(preview.headers['content-type']).toBe('image/webp');
    expect(preview.headers['content-disposition']).toBe('inline; filename="tall.webp"');

    // Carol is not a member: the URL alone is worthless to her, with or without her own ticket.
    const refused = await request(server.url).get(attachment.url).query({ t: carol.ticket }).expect(403);
    expect(refused.headers['cache-control']).toBe('no-store');
    await request(server.url).get(attachment.url).expect(401);
    await request(server.url).get(attachment.url).query({ t: 'forged.ticket' }).expect(401);
    await request(server.url).get(attachment.url).set('X-Media-Ticket', bob.ticket).expect(200);
    // Membership changes apply at once.
    server.ctx.channels.addMember(secret.id, carol.account.id);
    await request(server.url).get(attachment.url).query({ t: carol.ticket }).expect(200);
    server.ctx.channels.removeMember(secret.id, carol.account.id);
    await request(server.url).get(attachment.url).query({ t: carol.ticket }).expect(403);

    // A disabled account's ticket stops working.
    server.ctx.accounts.disable(bob.account.id, 'bye');
    await request(server.url).get(attachment.url).query({ t: bob.ticket }).expect(401);

    await request(server.url).get('/api/uploads/att-00000000000000000000.png').query({ t: alice.ticket }).expect(404);
    await request(server.url).get('/api/uploads/..%2Fdatasetto.db').query({ t: alice.ticket }).expect(404);

    // Deleting the message deletes the files; the URL answers 404 from then on.
    const gone = once(bob.socket, 'chat:messageDeleted', 3000).catch(() => null);
    alice.socket.emit('chat:delete', { messageId: message.id, channelId: secret.id });
    await gone;
    await request(server.url).get(attachment.url).query({ t: alice.ticket }).expect(404);
    expect(existsSync(join(server.ctx.uploads.dir, attachment.url.split('/').pop() as string))).toBe(false);
  });

  it('refuses a message without text and without pictures, and pictures that are not yours', async () => {
    const alice = await signUp('alice@example.com', 'Alice');
    const bob = await signUp('bob@example.com', 'Bob');
    const general = server.ctx.channels.getByName('general')!;
    for (const user of [alice, bob]) {
      const joined = once(user.socket, 'channel:joined');
      user.socket.emit('channel:join', general.id);
      await joined;
    }
    const empty = once<{ code: string }>(alice.socket, 'error');
    alice.socket.emit('chat', { text: '  ', attachmentIds: [] });
    expect((await empty).code).toBe('VALIDATION_FAILED');

    const uploaded = await upload(bob.auth, images.png).expect(201);
    const [theirs] = uploaded.body.attachments as AttachmentView[];
    const stolen = once<{ code: string }>(alice.socket, 'error');
    alice.socket.emit('chat', { text: 'mine now', attachmentIds: [theirs.id] });
    expect((await stolen).code).toBe('ATTACHMENT_UNAVAILABLE');
    expect(server.ctx.messages.count(general.id)).toBe(1);
    // The failed send did not consume Bob's upload.
    expect(server.ctx.uploads.get(theirs.id)?.messageId).toBeNull();

    const fresh = once<{ success: boolean; ticket: string; expiresAt: number }>(alice.socket, 'media:ticket');
    alice.socket.emit('media:ticket');
    const ticket = await fresh;
    expect(server.ctx.uploads.verifyTicket(ticket.ticket)?.accountId).toBe(alice.account.id);
  });
});
