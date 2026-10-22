/**
 * The Arcade integration harness (plan.md §2.6.5): a real HTTP server with Socket.IO and the
 * action lane, accounts created through the context (the auth limiter is per process), signed-in
 * test sockets, voice joins and lane clients that speak the binary envelope.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import WebSocket from 'ws';
import { b64url } from '../../../src/arcade/core/bytes.js';
import { readServer, S2C, writeAck, writeEvt, writePing, writeUp, writeVis, type ServerMsg } from '../../../src/arcade/core/net/lane.js';
import { CODEC, PROTO, type ActionGameId } from '../../../src/arcade/core/version.js';
import type { ArcadeOptions } from '../../../src/arcade/index.js';
import { normalizeSettings, saveSettings, type ArcadeSettings } from '../../../src/arcade/settings.js';
import type { AppContext } from '../../../src/context.js';
import { createHttpApp } from '../../../src/http/app.js';
import { createSocketServer, type SocketServer } from '../../../src/socket/index.js';
import { makeContext } from '../../helpers.js';
import { createFakeClock, type FakeClock } from './clock.js';

export interface TestSocket {
  readonly raw: Socket;
  request<T>(ev: string, data?: unknown, timeoutMs?: number): Promise<T>;
  /** Payloads received so far, optionally for one event. */
  received(ev?: string): readonly unknown[];
  /** Resolves with the next payload of `ev` (or one already received after `since`). */
  next<T>(ev: string, timeoutMs?: number): Promise<T>;
  close(): void;
}

export interface TestLane {
  readonly ws: WebSocket;
  sendUp(p: Uint8Array, upSeq?: number): void;
  sendEvt(p: Uint8Array, evSeq?: number): void;
  sendVis(s: number): void;
  sendAck(frameSeq: number): void;
  sendPing(ms: number): void;
  sendRaw(bytes: Uint8Array | string): void;
  next(type?: number, timeoutMs?: number): Promise<ServerMsg>;
  readonly received: readonly ServerMsg[];
  /** The close code once closed. */
  closed(timeoutMs?: number): Promise<number>;
  close(code?: number): void;
}

export interface TestAccount {
  id: string;
  name: string;
  socket(): Promise<TestSocket>;
  joinVoice(channelId: string, socket?: TestSocket): Promise<void>;
  /** `game` picks the codec the HELLO announces (default Fuseyard); `codec` overrides its version. */
  lane(ticketOrResume: string, o?: { resume?: boolean; origin?: string; codec?: number; game?: ActionGameId }): Promise<TestLane>;
}

export interface ArcadeTestServer {
  url: string;
  ctx: AppContext;
  clock: FakeClock;
  sockets: SocketServer;
  server: http.Server;
  voiceChannel: string;
  close(): Promise<void>;
  account(name?: string): Promise<TestAccount>;
}

const once = <T>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ' + event)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

let accounts = 0;

export const startArcadeServer = async (
  o: { clock?: FakeClock; settings?: Partial<ArcadeSettings>; arcade?: Omit<ArcadeOptions, 'clock'>; env?: Record<string, string> } = {},
): Promise<ArcadeTestServer> => {
  const clock = o.clock ?? createFakeClock();
  const ctx = makeContext(o.env ?? {});
  if (o.settings) saveSettings(ctx.db, normalizeSettings(o.settings), null, clock.now());
  const app = createHttpApp(ctx);
  const server = http.createServer(app);
  const sockets = createSocketServer(server, ctx, { arcade: { clock, ...(o.arcade ?? {}) } });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const url = 'http://127.0.0.1:' + port;
  const voice = ctx.channels.list().find((channel) => channel.type === 'voice');
  if (!voice) throw new Error('harness: no voice channel seeded');
  const open: { close(): void }[] = [];

  const makeSocket = async (token: string): Promise<TestSocket> => {
    const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    await once(socket, 'connect');
    const got: { ev: string; data: unknown }[] = [];
    const waiters: { ev: string; resolve(v: unknown): void }[] = [];
    socket.onAny((ev: string, data: unknown) => {
      got.push({ ev, data });
      const i = waiters.findIndex((w) => w.ev === ev);
      if (i !== -1) (waiters.splice(i, 1)[0] as { resolve(v: unknown): void }).resolve(data);
    });
    const ok = once(socket, 'auth:success');
    socket.emit('auth:session', { token });
    await ok;
    const test: TestSocket = {
      raw: socket,
      request: <T>(ev: string, data: unknown = {}, timeoutMs = 3000) =>
        new Promise<T>((resolve, reject) => {
          socket.timeout(timeoutMs).emit(ev, data, (error: Error | null, response: T) => (error ? reject(error) : resolve(response)));
        }),
      received: (ev) => got.filter((entry) => ev === undefined || entry.ev === ev).map((entry) => entry.data),
      next: <T>(ev: string, timeoutMs = 3000) =>
        new Promise<T>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout waiting for ' + ev)), timeoutMs);
          waiters.push({
            ev,
            resolve: (v) => {
              clearTimeout(timer);
              resolve(v as T);
            },
          });
        }),
      close: () => socket.close(),
    };
    open.push(test);
    return test;
  };

  const makeLane = (claim: string, opts: { resume?: boolean; origin?: string; codec?: number; game?: ActionGameId } = {}): Promise<TestLane> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url.replace('http', 'ws') + '/arcade/ws', opts.origin ? { headers: { origin: opts.origin } } : {});
      ws.binaryType = 'nodebuffer';
      const received: ServerMsg[] = [];
      const waiters: { type: number | undefined; resolve(m: ServerMsg): void }[] = [];
      let closeCode: number | null = null;
      const closeWaiters: ((code: number) => void)[] = [];
      let evSeq = 0;
      let upSeq = 0;
      ws.on('message', (data: Buffer) => {
        const msg = readServer(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
        if (!msg) return;
        received.push(msg);
        const typeOf = (m: ServerMsg): number =>
          ({ welcome: S2C.WELCOME, frame: S2C.FRAME, keyframe: S2C.KEYFRAME, beat: S2C.BEAT, pong: S2C.PONG, phase: S2C.PHASE, handover: S2C.HANDOVER, bye: S2C.BYE })[m.t];
        const i = waiters.findIndex((w) => w.type === undefined || w.type === typeOf(msg));
        if (i !== -1) (waiters.splice(i, 1)[0] as { resolve(m: ServerMsg): void }).resolve(msg);
      });
      ws.on('close', (code: number) => {
        closeCode = code;
        for (const w of closeWaiters.splice(0)) w(code);
      });
      ws.on('error', () => undefined);
      ws.on('unexpected-response', (_req, res) => {
        closeCode = res.statusCode ?? 0;
        for (const w of closeWaiters.splice(0)) w(closeCode);
      });
      const lane: TestLane = {
        ws,
        sendUp: (p, seq) => ws.send(writeUp(seq ?? (upSeq = (upSeq + 1) & 0xffff), 0, 0, p)),
        sendEvt: (p, seq) => ws.send(writeEvt(seq ?? (evSeq = (evSeq + 1) & 0xffff), p)),
        sendVis: (s) => ws.send(writeVis(s)),
        sendAck: (frameSeq) => ws.send(writeAck(frameSeq, 0)),
        sendPing: (ms) => ws.send(writePing(ms)),
        sendRaw: (bytes) => ws.send(bytes),
        next: (type, timeoutMs = 3000) => {
          const typeOf = (m: ServerMsg): number =>
            ({ welcome: S2C.WELCOME, frame: S2C.FRAME, keyframe: S2C.KEYFRAME, beat: S2C.BEAT, pong: S2C.PONG, phase: S2C.PHASE, handover: S2C.HANDOVER, bye: S2C.BYE })[m.t];
          const already = received.find((m) => !consumed.has(m) && (type === undefined || typeOf(m) === type));
          if (already) {
            consumed.add(already);
            return Promise.resolve(already);
          }
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('timeout waiting for lane message ' + (type ?? 'any'))), timeoutMs);
            waiters.push({
              type,
              resolve: (m) => {
                clearTimeout(timer);
                consumed.add(m);
                res(m);
              },
            });
          });
        },
        get received() {
          return received;
        },
        closed: (timeoutMs = 3000) =>
          closeCode !== null
            ? Promise.resolve(closeCode)
            : new Promise((res, rej) => {
                const timer = setTimeout(() => rej(new Error('lane did not close')), timeoutMs);
                closeWaiters.push((code) => {
                  clearTimeout(timer);
                  res(code);
                });
              }),
        close: (code = 1000) => ws.close(code),
      };
      const consumed = new Set<ServerMsg>();
      open.push({ close: () => ws.terminate() });
      ws.once('open', () => {
        const hello = { t: 'hello', proto: PROTO, codec: { [opts.game ?? 'fuseyard']: opts.codec ?? CODEC[opts.game ?? 'fuseyard'] }, ...(opts.resume ? { resume: claim } : { ticket: claim }) };
        ws.send(JSON.stringify(hello));
        resolve(lane);
      });
      ws.once('unexpected-response', () => resolve(lane));
      setTimeout(() => reject(new Error('lane did not open')), 3000);
    });

  return {
    url,
    ctx,
    clock,
    sockets,
    server,
    voiceChannel: voice.id,
    async account(name) {
      accounts += 1;
      const label = name ?? 'Player ' + accounts;
      const created = await ctx.accounts.register({ username: 'p' + accounts + '-' + Date.now() + '@example.com', password: 'password123', displayName: label });
      const token = ctx.sessions.create(created.id).token;
      return {
        id: created.id,
        name: label,
        socket: () => makeSocket(token),
        async joinVoice(channelId, existing) {
          const socket = existing ?? (await makeSocket(token));
          const joined = once(socket.raw, 'voice:joined');
          socket.raw.emit('voice:join', channelId);
          await joined;
        },
        lane: (claim, opts) => makeLane(claim, opts),
      };
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const item of open.splice(0)) {
          try {
            item.close();
          } catch {
            /* closed */
          }
        }
        sockets.io.close(() => {
          server.close(() => {
            if (ctx.db.open) ctx.db.close();
            resolve();
          });
        });
        void sockets.arcade.stop();
      }),
  };
};

export { b64url };
