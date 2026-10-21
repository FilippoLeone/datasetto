import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notificationBody } from '../src/services/messageNotifications.js';
import { attachmentView } from '../src/services/uploads.js';
import { isWebm, readWebmInfo } from '../src/services/webm.js';
import type { AttachmentView, MessageRecord } from '../src/types.js';
import { makeContext, startTestServer, type TestServer } from './helpers.js';

// ---- a tiny EBML writer, enough to build WebM heads like the ones browsers record ----

const vint = (size: number): Buffer => {
  let length = 1;
  while (length < 8 && size >= 2 ** (7 * length) - 1) length += 1;
  const out = Buffer.alloc(length);
  let remaining = size;
  for (let index = length - 1; index >= 0; index -= 1) {
    out[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
};
const idBytes = (id: number): Buffer => {
  const bytes: number[] = [];
  let remaining = id;
  while (remaining > 0) {
    bytes.unshift(remaining % 256);
    remaining = Math.floor(remaining / 256);
  }
  return Buffer.from(bytes);
};
const UNKNOWN_SIZE = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const element = (id: number, payload: Buffer, unknownSize = false): Buffer => Buffer.concat([idBytes(id), unknownSize ? UNKNOWN_SIZE : vint(payload.length), payload]);
const uint = (id: number, value: number): Buffer => {
  const bytes: number[] = [];
  let remaining = value;
  do {
    bytes.unshift(remaining % 256);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  return element(id, Buffer.from(bytes));
};
const str = (id: number, value: string): Buffer => element(id, Buffer.from(value, 'latin1'));
const float = (id: number, value: number): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleBE(value);
  return element(id, bytes);
};

interface WebmOptions {
  docType?: string;
  width?: number;
  height?: number;
  /** Null leaves the Duration out, as a live recording does. */
  durationMs?: number | null;
  video?: boolean;
  unknownSegment?: boolean;
  clusterBytes?: number;
}

/** EBML header, Segment with Info and Tracks (a VP9 video track and an Opus audio track), one Cluster of filler. */
const webm = ({ docType = 'webm', width = 1280, height = 720, durationMs = 25583, video = true, unknownSegment = true, clusterBytes = 4096 }: WebmOptions = {}): Buffer => {
  const header = element(0x1a45dfa3, Buffer.concat([uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), str(0x4282, docType), uint(0x4287, 4), uint(0x4285, 2)]));
  const info = element(0x1549a966, Buffer.concat([uint(0x2ad7b1, 1_000_000), ...(durationMs === null ? [] : [float(0x4489, durationMs)]), str(0x4d80, 'test'), str(0x5741, 'test')]));
  const videoTrack = element(0xae, Buffer.concat([uint(0xd7, 1), uint(0x73c5, 1), uint(0x83, 1), str(0x86, 'V_VP9'), element(0xe0, Buffer.concat([uint(0xb0, width), uint(0xba, height)]))]));
  const audioTrack = element(0xae, Buffer.concat([uint(0xd7, 2), uint(0x73c5, 2), uint(0x83, 2), str(0x86, 'A_OPUS'), element(0xe1, Buffer.concat([float(0xb5, 48000), uint(0x9f, 2)]))]));
  const tracks = element(0x1654ae6b, Buffer.concat([...(video ? [videoTrack] : []), audioTrack]));
  const cluster = element(0x1f43b675, Buffer.concat([uint(0xe7, 0), Buffer.alloc(clusterBytes, 0x11)]), true);
  return Buffer.concat([header, element(0x18538067, Buffer.concat([info, tracks, cluster]), unknownSegment)]);
};

const freshDataDir = (overrides: Record<string, string> = {}): Record<string, string> => ({ DATA_DIR: mkdtempSync(join(tmpdir(), 'datasetto-videos-')), ...overrides });

describe('WebM sniffing', () => {
  it('recognises WebM by its DocType and reads the video size and the duration from the head', () => {
    const file = webm();
    expect(isWebm(file)).toBe(true);
    expect(readWebmInfo(file)).toEqual({ width: 1280, height: 720, durationMs: 25583 });
    // Matroska shares the magic but is not what browsers play as WebM.
    expect(isWebm(webm({ docType: 'matroska' }))).toBe(false);
    expect(readWebmInfo(webm({ docType: 'matroska' }))).toBeNull();
    expect(isWebm(Buffer.from('RIFF....WEBP'))).toBe(false);
    expect(isWebm(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(false);
    expect(isWebm(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe(false);
    expect(isWebm(Buffer.alloc(0))).toBe(false);
  });

  it('needs a video track, copes with a sized Segment and a missing Duration, and never reads past the head', () => {
    expect(readWebmInfo(webm({ video: false }))).toBeNull();
    expect(readWebmInfo(webm({ unknownSegment: false, durationMs: null, width: 640, height: 360 }))).toEqual({ width: 640, height: 360, durationMs: null });
    // Only the head counts: a truncated head is not a video, megabytes of clusters are never scanned.
    expect(readWebmInfo(webm().subarray(0, 40))).toBeNull();
    const long = webm({ clusterBytes: 3 * 1024 * 1024 });
    expect(readWebmInfo(long.subarray(0, 1024))).toEqual({ width: 1280, height: 720, durationMs: 25583 });
  });
});

describe('UploadService with videos', () => {
  it('stores a WebM as it came, with its size from the header and no preview', async () => {
    const ctx = makeContext(freshDataDir());
    const alice = await ctx.accounts.register({ username: 'alice@example.com', password: 'password123', displayName: 'Alice' });
    const file = webm();
    const record = await ctx.uploads.store(alice.id, { fileName: 'datasetto-clip-alices-screen-2026-10-21_20-40-09.webm', bytes: file });
    expect(record).toMatchObject({ messageId: null, accountId: alice.id, kind: 'video', mime: 'video/webm', size: file.length, width: 1280, height: 720, previewName: null, previewWidth: null, previewHeight: null });
    expect(record.fileName).toBe('datasetto-clip-alices-screen-2026-10-21_20-40-09.webm');
    expect(record.storedName).toMatch(/^att-[a-z0-9]{20}\.webm$/);
    expect(readFileSync(join(ctx.uploads.dir, record.storedName)).equals(file)).toBe(true);
    expect(readdirSync(ctx.uploads.dir).filter((name) => name.startsWith(record.id))).toEqual([record.storedName]);
    // The wire shape points both URLs at the file itself and reports the picture size as the preview size.
    expect(attachmentView(record)).toMatchObject({ kind: 'video', url: '/api/uploads/' + record.storedName, previewUrl: '/api/uploads/' + record.storedName, previewWidth: 1280, previewHeight: 720 });
    expect(ctx.uploads.resolveFile(record.storedName)).toMatchObject({ contentType: 'video/webm', isPreview: false });
    expect(ctx.uploads.get(record.id)?.kind).toBe('video');
    // A video never has a preview file to resolve.
    expect(ctx.uploads.resolveFile(record.id + '.preview.webp')).toBeNull();
    expect(ctx.uploads.discard([record.id])).toBe(1);
    expect(existsSync(join(ctx.uploads.dir, record.storedName))).toBe(false);
  });

  it('applies the video cap separately from the picture cap and refuses what is not a playable WebM', async () => {
    const ctx = makeContext(freshDataDir({ UPLOAD_MAX_MB: '1', UPLOAD_VIDEO_MAX_MB: '2' }));
    const alice = await ctx.accounts.register({ username: 'alice@example.com', password: 'password123', displayName: 'Alice' });
    expect(ctx.uploads.videoMaxBytes).toBe(2 * 1024 * 1024);
    // 1.5 MB is too much for a picture and fine for a video.
    const video = webm({ clusterBytes: 1.5 * 1024 * 1024 });
    await expect(ctx.uploads.store(alice.id, { fileName: 'c.webm', bytes: video })).resolves.toMatchObject({ kind: 'video', size: video.length });
    const huge = webm({ clusterBytes: 2 * 1024 * 1024 + 1 });
    await expect(ctx.uploads.store(alice.id, { fileName: 'huge.webm', bytes: huge })).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE', status: 413, message: 'Videos must be 2 MB or smaller' });
    await expect(ctx.uploads.store(alice.id, { fileName: 'audio.webm', bytes: webm({ video: false }) })).rejects.toMatchObject({ code: 'UPLOAD_FORMAT', status: 415, message: 'The file could not be read as a video' });
    await expect(ctx.uploads.store(alice.id, { fileName: 'film.mkv', bytes: webm({ docType: 'matroska' }) })).rejects.toMatchObject({ code: 'UPLOAD_FORMAT', status: 415 });
    await expect(ctx.uploads.store(alice.id, { fileName: 'clip.webm', bytes: Buffer.from('not a video at all') })).rejects.toMatchObject({ code: 'UPLOAD_FORMAT', message: 'Only PNG, JPEG, WebP and GIF pictures and WebM videos can be shared' });
    expect(readdirSync(ctx.uploads.dir).filter((name) => name.startsWith('att-'))).toHaveLength(1);
    // Orphaned video files are swept like pictures.
    writeFileSync(join(ctx.uploads.dir, 'att-orphanorphanorphan00.webm'), video);
    expect(ctx.uploads.sweep()).toEqual({ pending: 0, orphans: 1 });
  });
});

describe('notification bodies', () => {
  const message = (attachments: Array<{ kind: 'image' | 'video' }>, text = ''): MessageRecord => ({ text, attachments } as unknown as MessageRecord);
  it('say what a message without text carries', () => {
    expect(notificationBody(message([{ kind: 'video' }]))).toBe('Sent a video');
    expect(notificationBody(message([{ kind: 'image' }]))).toBe('Sent a picture');
    expect(notificationBody(message([{ kind: 'video' }, { kind: 'video' }]))).toBe('Sent 2 videos');
    expect(notificationBody(message([{ kind: 'image' }, { kind: 'image' }, { kind: 'image' }]))).toBe('Sent 3 pictures');
    expect(notificationBody(message([{ kind: 'image' }, { kind: 'video' }]))).toBe('Sent 2 files');
    expect(notificationBody(message([], ''))).toBe('');
    expect(notificationBody(message([{ kind: 'video' }], 'look'))).toBe('look');
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

describe('videos over HTTP and chat', () => {
  let server: TestServer;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    server = await startTestServer(freshDataDir({ UPLOAD_MAX_MB: '1', UPLOAD_VIDEO_MAX_MB: '2' }));
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

  const upload = (auth: Record<string, string>, bytes: Buffer, name = 'clip.webm') =>
    request(server.url).post('/api/uploads').set(auth).attach('files', bytes, { filename: name, contentType: 'video/webm' });

  it('tells the client both caps, takes a clip, posts it as a message and serves it with ranges to members', async () => {
    const config = await request(server.url).get('/api/config').expect(200);
    expect(config.body.uploads).toMatchObject({ maxBytes: 1024 * 1024, videoMaxBytes: 2 * 1024 * 1024, videoTypes: ['video/webm'], acceptedTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] });

    const alice = await signUp('alice@example.com', 'Alice');
    const bob = await signUp('bob@example.com', 'Bob');
    const general = server.ctx.channels.getByName('general')!;
    for (const user of [alice, bob]) {
      const joined = once(user.socket, 'channel:joined');
      user.socket.emit('channel:join', general.id);
      await joined;
    }

    const file = webm({ clusterBytes: 200_000 });
    const uploaded = await upload(alice.auth, file).expect(201);
    const [attachment] = uploaded.body.attachments as AttachmentView[];
    expect(attachment).toMatchObject({ kind: 'video', fileName: 'clip.webm', mime: 'video/webm', size: file.length, width: 1280, height: 720, previewWidth: 1280, previewHeight: 720 });
    expect(attachment.url).toMatch(/^\/api\/uploads\/att-[a-z0-9]{20}\.webm$/);
    expect(attachment.previewUrl).toBe(attachment.url);

    const bobSees = once<{ id: string; text: string; attachments: AttachmentView[] }>(bob.socket, 'chat');
    alice.socket.emit('chat', { text: '', channelId: general.id, attachmentIds: [attachment.id] });
    const message = await bobSees;
    expect(message.text).toBe('');
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]).toMatchObject({ id: attachment.id, kind: 'video', mime: 'video/webm' });
    expect(server.ctx.messages.history(general.id).find((entry) => entry.id === message.id)?.attachments[0].kind).toBe('video');

    const whole = await request(server.url).get(attachment.url).query({ t: bob.ticket }).expect(200);
    expect(whole.headers['content-type']).toBe('video/webm');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(whole.headers['content-disposition']).toBe('inline; filename="clip.webm"');
    expect(Buffer.from(whole.body as ArrayBuffer).equals(file)).toBe(true);
    // A <video> seeks with range requests.
    const part = await request(server.url).get(attachment.url).query({ t: bob.ticket }).set('Range', 'bytes=100-199').expect(206);
    expect(part.headers['content-range']).toBe('bytes 100-199/' + file.length);
    expect(Buffer.from(part.body as ArrayBuffer).equals(file.subarray(100, 200))).toBe(true);
    await request(server.url).get(attachment.url).expect(401);
    // A video file name is never served as a preview.
    await request(server.url).get(attachment.url.replace(/\.webm$/, '.preview.webp')).query({ t: bob.ticket }).expect(404);

    // Over the cap: the message names videos, and a picture keeps its own, smaller cap.
    const big = await upload(alice.auth, webm({ clusterBytes: 2 * 1024 * 1024 + 1 }), 'big.webm').expect(413);
    expect(big.body).toMatchObject({ code: 'UPLOAD_TOO_LARGE', error: 'Videos must be 2 MB or smaller' });
    const audio = await upload(alice.auth, webm({ video: false }), 'audio.webm').expect(415);
    expect(audio.body.code).toBe('UPLOAD_FORMAT');
    expect(readdirSync(server.ctx.uploads.dir).filter((name) => name.startsWith('att-'))).toEqual([attachment.url.split('/').pop()]);
  });
});
