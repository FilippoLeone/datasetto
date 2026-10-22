/**
 * The action lane: a raw WebSocket at `/arcade/ws` on the app's HTTP server (platform.md §4.1).
 *
 * - One `upgrade` listener routes every upgrade: `/arcade/ws` to the lane, `/socket.io/…` to
 *   engine.io (the Socket.IO server runs with `destroyUpgrade: false`), anything else is destroyed.
 * - Origin as for Socket.IO (403), 503 while shutting down, at most `lanePerIp` sockets per IP (429).
 * - The first message is a text HELLO of at most 512 bytes within 5 s (else 4408); after it only binary
 *   frames (a text frame closes with 4400). Messages above 4 KB close the socket (`maxPayload`).
 * - Rate: at most 40 binary messages per second are handled, the rest dropped; more than 200 per
 *   second for 2 s closes with 4429; the 10th malformed message closes with 4400.
 * - Heartbeat: a WebSocket ping every 10 s; a socket that has not answered the previous one is
 *   terminated. The timer exists only while a lane is open.
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { AppContext } from '../context.js';
import { createOriginChecker } from '../http/origins.js';
import type { Clock } from './clock.js';
import { CLOSE, MAX_HELLO, MAX_MESSAGE, readClient, readHello, writeBye, type ClientMsg, type Hello } from './core/net/lane.js';
import type { LaneConn } from './match.js';

export const LANE_PATH = '/arcade/ws';
export const HELLO_TIMEOUT_MS = 5000;
export const HEARTBEAT_MS = 10_000;
export const RATE = { perSecond: 40, floodPerSecond: 200, floodSeconds: 2, malformed: 10 } as const;

export interface LaneHandlers {
  /** HELLO received: bind the connection (returns its message and close handlers) or refuse with a close code. */
  hello(conn: LaneConn, hello: Hello): { onMessage(msg: ClientMsg): void; onClose(code: number): void } | number;
}

export interface Lane {
  readonly connections: number;
  /** Close every lane (shutdown). */
  closeAll(code: number, reason: string): void;
  stop(): void;
}

export interface LaneOptions {
  ctx: AppContext;
  http: HttpServer;
  clock: Clock;
  lanePerIp(): number;
  handlers: LaneHandlers;
}

const reject = (socket: Duplex, status: number, text: string): void => {
  try {
    socket.end('HTTP/1.1 ' + status + ' ' + text + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  } catch {
    socket.destroy();
  }
};

const clientIp = (req: IncomingMessage, trustProxy: boolean): string => {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    if (first && first.trim()) return first.trim();
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real.trim()) return real.trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
};

const toBytes = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
};

export const createLane = (o: LaneOptions): Lane => {
  const { ctx, clock } = o;
  const isAllowedOrigin = createOriginChecker(ctx.config.cors);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false, clientTracking: false });
  const perIp = new Map<string, number>();
  const open = new Map<number, { ws: WebSocket; alive: boolean; conn: LaneConn }>();
  let nextId = 1;
  let heartbeat: unknown = null;

  const beat = (): void => {
    heartbeat = null;
    for (const entry of open.values()) {
      if (!entry.alive) {
        entry.ws.terminate();
        continue;
      }
      entry.alive = false;
      try {
        entry.ws.ping();
      } catch {
        /* closing */
      }
    }
    if (open.size > 0) heartbeat = clock.setTimeout(beat, HEARTBEAT_MS);
  };

  const onConnection = (ws: WebSocket, ip: string): void => {
    const id = nextId++;
    let bound: { onMessage(msg: ClientMsg): void; onClose(code: number): void } | null = null;
    let closing = false;
    let malformed = 0;
    let windowStart = clock.now();
    let inWindow = 0;
    let floodSeconds = 0;

    const conn: LaneConn = {
      id,
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
      send(bytes) {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(bytes, { binary: true });
      },
      close(code, reason) {
        if (closing) return;
        closing = true;
        try {
          if (ws.readyState === ws.OPEN) ws.send(writeBye(code, reason), { binary: true });
          ws.close(code, reason.slice(0, 64));
        } catch {
          ws.terminate();
        }
      },
    };
    open.set(id, { ws, alive: true, conn });
    if (heartbeat === null) heartbeat = clock.setTimeout(beat, HEARTBEAT_MS);

    const helloTimer = clock.setTimeout(() => {
      if (!bound) conn.close(CLOSE.helloTimeout, 'No hello');
    }, HELLO_TIMEOUT_MS);

    ws.on('pong', () => {
      const entry = open.get(id);
      if (entry) entry.alive = true;
    });

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (closing) return;
      if (!bound) {
        const text = isBinary ? null : Buffer.isBuffer(data) ? data : Buffer.from(toBytes(data));
        if (!text || text.length > MAX_HELLO) {
          clock.clearTimeout(helloTimer);
          conn.close(CLOSE.malformed, 'Expected hello');
          return;
        }
        const hello = readHello(text.toString('utf8'));
        clock.clearTimeout(helloTimer);
        if (!hello) {
          conn.close(CLOSE.malformed, 'Bad hello');
          return;
        }
        const result = o.handlers.hello(conn, hello);
        if (typeof result === 'number') {
          conn.close(result, result === CLOSE.update ? 'Update required' : result === CLOSE.gone ? 'Match gone' : 'Not allowed');
          return;
        }
        bound = result;
        return;
      }
      if (!isBinary) {
        conn.close(CLOSE.malformed, 'Text after hello');
        return;
      }
      const now = clock.now();
      if (now - windowStart >= 1000) {
        floodSeconds = inWindow > RATE.floodPerSecond ? floodSeconds + 1 : 0;
        windowStart = now;
        inWindow = 0;
      }
      inWindow += 1;
      if (inWindow > RATE.floodPerSecond && floodSeconds + 1 >= RATE.floodSeconds) {
        conn.close(CLOSE.rate, 'Too many messages');
        return;
      }
      if (inWindow > RATE.perSecond) return;
      const msg = readClient(toBytes(data));
      if (!msg) {
        malformed += 1;
        if (malformed >= RATE.malformed) conn.close(CLOSE.malformed, 'Malformed');
        return;
      }
      bound.onMessage(msg);
    });

    ws.on('close', (code: number) => {
      clock.clearTimeout(helloTimer);
      open.delete(id);
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left <= 0) perIp.delete(ip);
      else perIp.set(ip, left);
      if (open.size === 0 && heartbeat !== null) {
        clock.clearTimeout(heartbeat);
        heartbeat = null;
      }
      closing = true;
      bound?.onClose(code);
      bound = null;
    });

    ws.on('error', () => {
      /* followed by close */
    });
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (path === '/socket.io' || path.startsWith('/socket.io/')) return;
    if (path !== LANE_PATH) {
      socket.destroy();
      return;
    }
    if (ctx.runtime.shuttingDown) return reject(socket, 503, 'Service Unavailable');
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!isAllowedOrigin(origin)) return reject(socket, 403, 'Forbidden');
    const ip = clientIp(req, ctx.config.server.trustProxy);
    const count = perIp.get(ip) ?? 0;
    if (count >= o.lanePerIp()) return reject(socket, 429, 'Too Many Requests');
    perIp.set(ip, count + 1);
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip));
  };

  o.http.on('upgrade', onUpgrade);

  return {
    get connections() {
      return open.size;
    },
    closeAll(code, reason) {
      for (const entry of Array.from(open.values())) entry.conn.close(code, reason);
    },
    stop() {
      o.http.off('upgrade', onUpgrade);
      for (const entry of Array.from(open.values())) entry.ws.terminate();
      open.clear();
      if (heartbeat !== null) clock.clearTimeout(heartbeat);
      heartbeat = null;
      wss.close();
    },
  };
};
