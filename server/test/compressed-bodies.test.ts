import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import express from 'express';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestServer, type TestServer } from './helpers.js';

/**
 * Request bodies are never decompressed (body parsers run with inflate: false), so a
 * request cannot reach zlib or Node's Brotli decoder (CVE-2026-111497). Compressed bodies
 * get 415 UNSUPPORTED_ENCODING before any route handler runs.
 */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

const COMPRESSORS = {
  br: (body: Buffer) => zlib.brotliCompressSync(body),
  gzip: (body: Buffer) => zlib.gzipSync(body),
  deflate: (body: Buffer) => zlib.deflateSync(body),
} as const;
const ENCODINGS = Object.keys(COMPRESSORS) as Array<keyof typeof COMPRESSORS>;

/** POST these exact bytes (supertest would re-serialize a Buffer sent as JSON). */
const post = async (url: string, body: Buffer, headers: Record<string, string>) => {
  const response = await fetch(url, { method: 'POST', headers, body });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> | null };
};

/** Watches the zlib decoders body-parser would create for gzip, deflate and br. */
const watchDecoders = () => [
  vi.spyOn(zlib, 'createBrotliDecompress'),
  vi.spyOn(zlib, 'createGunzip'),
  vi.spyOn(zlib, 'createInflate'),
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('body-parser decoder watch (control)', () => {
  it('sees the Brotli decoder when a parser is left at its default', async () => {
    // Proves the spies observe body-parser's zlib, so "not called" below means something.
    const decoders = watchDecoders();
    const app = express();
    app.use(express.json());
    app.post('/echo', (req, res) => {
      res.json(req.body);
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const { port } = server.address() as AddressInfo;
      const echoed = await post('http://127.0.0.1:' + port + '/echo', COMPRESSORS.br(Buffer.from('{"hello":"world"}')), {
        'Content-Type': 'application/json',
        'Content-Encoding': 'br',
      });
      expect(echoed).toEqual({ status: 200, body: { hello: 'world' } });
      expect(decoders[0]).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('compressed request bodies', () => {
  let server: TestServer;
  let decoders: ReturnType<typeof watchDecoders>;

  beforeEach(async () => {
    server = await startTestServer();
    decoders = watchDecoders();
  });

  afterEach(async () => {
    await server.close();
  });

  const expectNoDecoderUsed = () => {
    for (const decoder of decoders) expect(decoder).not.toHaveBeenCalled();
  };

  it('refuses compressed JSON and form bodies before the route runs, and still parses plain ones', async () => {
    const channel = server.ctx.channels.getByName('main-stream')!;
    // The key only travels in the body, so a 200 below proves the body was parsed.
    const fields = { name: 'main-stream', key: channel.streamKey!, clientid: '7', addr: '10.0.0.5' };
    const json = Buffer.from(JSON.stringify(fields));
    const form = Buffer.from(new URLSearchParams(fields).toString());
    const JSON_TYPE = { 'Content-Type': 'application/json' };
    const FORM_TYPE = { 'Content-Type': 'application/x-www-form-urlencoded' };

    for (const encoding of ENCODINGS) {
      for (const [type, body] of [[JSON_TYPE, json], [FORM_TYPE, form]] as const) {
        const refused = await post(server.url + '/internal/stream/publish', COMPRESSORS[encoding](body), { ...type, 'Content-Encoding': encoding });
        expect(refused, type['Content-Type'] + ' ' + encoding).toMatchObject({ status: 415, body: { code: 'UNSUPPORTED_ENCODING' } });
      }
    }
    // An unauthenticated API route is refused the same way.
    const anonymous = await post(server.url + '/api/stream/main-stream/ticket', COMPRESSORS.br(Buffer.from('{}')), { ...JSON_TYPE, 'Content-Encoding': 'br' });
    expect(anonymous).toMatchObject({ status: 415, body: { code: 'UNSUPPORTED_ENCODING' } });
    expect(server.ctx.presence.getStream(channel.id)).toBeFalsy();
    expectNoDecoderUsed();

    const published = await post(server.url + '/internal/stream/publish', json, JSON_TYPE);
    expect(published).toMatchObject({ status: 200, body: { allowed: true } });
    expect(server.ctx.presence.getStream(channel.id)).toBeTruthy();
    expect(await post(server.url + '/internal/stream/done', form, FORM_TYPE)).toMatchObject({ status: 200, body: { released: true } });
    expect(await post(server.url + '/internal/stream/publish', form, FORM_TYPE)).toMatchObject({ status: 200, body: { allowed: true } });
    // "identity" means uncompressed and is accepted.
    const done = await post(server.url + '/internal/stream/done', json, { ...JSON_TYPE, 'Content-Encoding': 'identity' });
    expect(done).toMatchObject({ status: 200, body: { released: true } });
    expect(server.ctx.presence.getStream(channel.id)).toBeFalsy();
  });

  it('refuses compressed avatar uploads before the handler runs, signed in or not', async () => {
    const account = await server.ctx.accounts.register({ username: 'alice@example.com', password: 'password123', displayName: 'Alice' });
    const auth = { Authorization: 'Bearer ' + server.ctx.sessions.create(account.id).token };
    // The handler's first look at the caller is resuming the session.
    const resume = vi.spyOn(server.ctx.sessions, 'resume');

    for (const encoding of ['br', 'gzip'] as const) {
      for (const headers of [auth, {}]) {
        const refused = await post(server.url + '/api/avatars', COMPRESSORS[encoding](PNG), {
          ...headers,
          'Content-Type': 'image/png',
          'Content-Encoding': encoding,
        });
        expect(refused, encoding).toMatchObject({ status: 415, body: { code: 'UNSUPPORTED_ENCODING' } });
      }
    }
    expect(resume).not.toHaveBeenCalled();
    expect(server.ctx.accounts.getById(account.id)?.avatarUrl).toBeNull();
    expect(server.ctx.avatars.urlFor(account.id)).toBeNull();
    expectNoDecoderUsed();

    const uploaded = await post(server.url + '/api/avatars', PNG, { ...auth, 'Content-Type': 'image/png' });
    expect(uploaded.status).toBe(200);
    expect(String(uploaded.body?.avatarUrl)).toContain('.png');
    expect(resume).toHaveBeenCalled();
  });

  it('leaves Socket.IO long-polling alone (engine.io reads its own bodies)', async () => {
    const account = await server.ctx.accounts.register({ username: 'bob@example.com', password: 'password123', displayName: 'Bob' });
    const token = server.ctx.sessions.create(account.id).token;
    const socket: Socket = connect(server.url, { transports: ['polling'], upgrade: false, forceNew: true, reconnection: false });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
      });
      expect(socket.io.engine.transport.name).toBe('polling');
      // auth:session goes up in a polling POST; auth:success comes back in a polling GET.
      const success = new Promise<{ account: { username: string } }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for auth:success')), 3000);
        socket.once('auth:success', (payload: { account: { username: string } }) => {
          clearTimeout(timer);
          resolve(payload);
        });
      });
      socket.emit('auth:session', { token });
      expect((await success).account.username).toBe('bob@example.com');
    } finally {
      socket.disconnect();
    }
  });
});
