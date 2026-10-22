/**
 * A userland TCP shaper (docs/arcade/platform.md §15.2, §15.5): one simulated bottleneck link between
 * the shaped client and the server, shared by every TCP connection through it, as on a phone.
 * Chrome's own network emulation does not delay WebSocket frames, hence a proxy.
 *
 * Per direction (`down` = server → client, `up` = client → server):
 * - a rate in bit/s; every segment (at most one MSS) is charged 74 B of framing (IPv4/TCP with
 *   timestamps 52 + one TLS 1.3 record 22, platform §5.1), and every segment delivered queues its
 *   TCP ACK (26 B, one 52 B ACK per two segments) on the reverse link, behind the data queued there
 *   (never preempting a segment already on the wire);
 * - a one-way delay (RTT / 2);
 * - a finite FIFO buffer shared by all connections. While it holds more than its size the shaper
 *   stops reading from the sending socket, so the backpressure reaches the sender's socket buffer and,
 *   on the server, `ws.bufferedAmount`, as on a mobile link. It reads again below half.
 * - optional head-of-line loss: every N-th segment, and everything behind it on the same connection,
 *   is held for RTO = max(200 ms, 2 × RTT). That is how TCP experiences one lost segment; other
 *   connections are not held.
 *
 * The link is changed live with `setLink`. Timers fire late (Windows), so the link keeps a virtual
 * "free at" time: lateness adds a little jitter but never loses capacity.
 */
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { createWsReader, sioKind } from './wsparse.mjs';

export const MSS = 1448;
export const SEGMENT_OVERHEAD = 74;
export const ACK_BYTES = 26;
const CLASSES = ['lane', 'sio', 'http', 'other'];

const classify = (chunk) => {
  const line = chunk.subarray(0, Math.min(chunk.length, 512)).toString('latin1').split('\r\n')[0] ?? '';
  const m = /^[A-Z]+ (\S+) HTTP\/1/.exec(line);
  if (!m) return 'other';
  if (m[1].startsWith('/arcade/ws')) return 'lane';
  if (m[1].startsWith('/socket.io')) return 'sio';
  return 'http';
};

const emptyClassMap = () => Object.fromEntries(CLASSES.map((c) => [c, 0]));
const DIVISORS = [2, 3, 4, 6];
const LOG_MAX = 20000;

/**
 * @param {{ target: { host: string, port: number }, link: LinkProfile, host?: string }} o
 * LinkProfile: { down: { kbps, delayMs, bufferBytes, lossEvery }, up: { ... }, rttMs }
 */
export const createShaper = async (o) => {
  const makeDir = (name) => ({ name, rateBps: 1, delayMs: 0, bufferBytes: 65536, lossEvery: 0, rtoMs: 200, queue: [], qBytes: 0, qClass: emptyClassMap(), freeAt: 0, seq: 0, paused: new Set() });
  // What went into the link and when (the sender's time): lane messages per direction, as
  // [t, type, detail] (detail: the FRAME divisor, the KEYFRAME reason, the VIS state, the PHASE).
  const laneLog = { down: [], up: [] };
  const dirs = { down: makeDir('down'), up: makeDir('up') };
  const conns = new Set();
  const localPorts = new Set();
  const seconds = new Map();
  const counters = { connections: 0, lostDown: 0, lostUp: 0, pausesDown: 0, pausesUp: 0 };
  let timer = null;
  let timerAt = Infinity;
  let closed = false;
  let current = null;

  const bucket = () => {
    const sec = Math.floor(Date.now() / 1000);
    let b = seconds.get(sec);
    if (!b) {
      b = {
        sec,
        payload: { down: emptyClassMap(), up: emptyClassMap() },
        wire: { down: emptyClassMap(), up: emptyClassMap() },
        acks: { down: 0, up: 0 },
        segments: { down: emptyClassMap(), up: emptyClassMap() },
        qMax: { down: 0, up: 0 },
        waitMax: { down: 0, up: 0 },
        lost: { down: 0, up: 0 },
        paused: { down: 0, up: 0 },
        over150: { down: null, up: null },
        qClassMax: { down: emptyClassMap(), up: emptyClassMap() },
        sio: { down: {}, up: {} },
      };
      seconds.set(sec, b);
      // Keep about 10 minutes.
      if (seconds.size > 600) seconds.delete(seconds.keys().next().value);
    }
    return b;
  };

  const applyLink = (link) => {
    current = JSON.parse(JSON.stringify(link));
    const rto = Math.max(200, 2 * link.rttMs);
    for (const name of ['down', 'up']) {
      const d = dirs[name];
      const p = link[name];
      d.rateBps = Math.max(1000, p.kbps * 1000);
      d.delayMs = p.delayMs ?? link.rttMs / 2;
      d.bufferBytes = p.bufferBytes ?? 65536;
      d.lossEvery = p.lossEvery ?? 0;
      d.rtoMs = rto;
    }
  };

  const schedule = (at) => {
    if (closed || at === Infinity) return;
    if (timer !== null && timerAt <= at + 0.5) return;
    if (timer !== null) clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(
      () => {
        timer = null;
        timerAt = Infinity;
        pump();
      },
      Math.max(0, Math.ceil(at - performance.now())),
    );
  };

  const serialization = (d, bytes) => ((bytes + SEGMENT_OVERHEAD) * 8000) / d.rateBps;
  // An ACK is a queue entry of its own (26 B, headers included), behind the data queued before it.
  const timeOf = (d, seg) => (seg.ack ? (ACK_BYTES * 8000) / d.rateBps : seg.buf ? serialization(d, seg.buf.length) : 0);

  const pump = () => {
    if (closed) return;
    const now = performance.now();
    let next = Infinity;
    for (const d of [dirs.down, dirs.up]) {
      while (d.queue.length > 0) {
        const seg = d.queue[0];
        const start = Math.max(d.freeAt, seg.at);
        const dep = start + timeOf(d, seg);
        if (dep > now) {
          next = Math.min(next, dep);
          break;
        }
        d.queue.shift();
        if (seg.ack) {
          d.freeAt = dep;
          bucket().acks[d.name] += ACK_BYTES;
          continue;
        }
        let at = dep + d.delayMs;
        if (seg.buf) {
          d.qBytes -= seg.buf.length;
          const cls = seg.conn.cls ?? 'other';
          d.qClass[cls] -= seg.buf.length;
          d.freeAt = dep;
          const b = bucket();
          b.payload[d.name][cls] += seg.buf.length;
          b.wire[d.name][cls] += seg.buf.length + SEGMENT_OVERHEAD;
          b.segments[d.name][cls] += 1;
          b.waitMax[d.name] = Math.max(b.waitMax[d.name], start - seg.at);
          if (start - seg.at > 150 && b.over150[d.name] === null) b.over150[d.name] = Date.now();
          if (d.lossEvery > 0 && ++d.seq % d.lossEvery === 0) {
            at += d.rtoMs;
            b.lost[d.name] += 1;
            if (d.name === 'down') counters.lostDown += 1;
            else counters.lostUp += 1;
          }
        }
        const side = seg.conn[d.name];
        at = Math.max(at, side.last);
        side.last = at;
        side.flight.push({ buf: seg.buf, at });
      }
      if (d.paused.size > 0 && d.qBytes < d.bufferBytes / 2) {
        for (const s of d.paused) if (!s.destroyed) s.resume();
        d.paused.clear();
      }
    }
    for (const conn of conns) {
      for (const name of ['down', 'up']) {
        const side = conn[name];
        const dest = name === 'down' ? conn.client : conn.server;
        while (side.flight.length > 0 && side.flight[0].at <= now) {
          const item = side.flight.shift();
          if (dest.destroyed) continue;
          if (item.buf === null) {
            dest.end();
            continue;
          }
          dest.write(item.buf);
          (name === 'down' ? dirs.up : dirs.down).queue.push({ ack: true, conn: null, buf: null, at: now });
        }
        if (side.flight.length > 0) next = Math.min(next, side.flight[0].at);
      }
      if (conn.gone && conn.down.flight.length === 0 && conn.up.flight.length === 0) {
        conns.delete(conn);
        if (conn.localPort) localPorts.delete(conn.localPort);
      }
    }
    // Deliveries above may have queued ACKs: the next departure on each link.
    for (const d of [dirs.down, dirs.up]) {
      const seg = d.queue[0];
      if (seg) next = Math.min(next, Math.max(d.freeAt, seg.at) + timeOf(d, seg));
    }
    schedule(next);
  };

  const enqueue = (d, conn, chunk, source) => {
    const now = performance.now();
    if (chunk === null) d.queue.push({ conn, buf: null, at: now });
    else {
      const cls = conn.cls ?? 'other';
      for (let i = 0; i < chunk.length; i += MSS) {
        const buf = chunk.subarray(i, Math.min(chunk.length, i + MSS));
        d.queue.push({ conn, buf, at: now });
        d.qBytes += buf.length;
        d.qClass[cls] += buf.length;
      }
      const b = bucket();
      b.qMax[d.name] = Math.max(b.qMax[d.name], d.qBytes);
      for (const c of CLASSES) b.qClassMax[d.name][c] = Math.max(b.qClassMax[d.name][c], d.qClass[c]);
      try {
        conn.readers?.[d.name]?.(chunk);
      } catch {
        conn.readers = null;
      }
      if (d.qBytes >= d.bufferBytes && source && !d.paused.has(source)) {
        source.pause();
        d.paused.add(source);
        b.paused[d.name] += 1;
        if (d.name === 'down') counters.pausesDown += 1;
        else counters.pausesUp += 1;
      }
    }
    pump();
  };

  const logPush = (list, entry) => {
    list.push(entry);
    if (list.length > LOG_MAX) list.splice(0, list.length - LOG_MAX);
  };
  const readersFor = (cls) => {
    if (cls === 'lane') {
      return {
        down: createWsReader((op, head) => {
          if (op !== 2 || head.length === 0) return;
          const t = head[0];
          const detail = t === 0x81 && head.length >= 8 ? DIVISORS[(head[7] >> 2) & 3] : t === 0x82 && head.length >= 8 ? head[7] : t === 0x85 && head.length >= 2 ? head[1] : null;
          logPush(laneLog.down, [Date.now(), t, detail]);
        }),
        up: createWsReader((op, head) => {
          if (op === 1) return logPush(laneLog.up, [Date.now(), 'hello', null]);
          if (op !== 2 || head.length === 0) return;
          const t = head[0];
          logPush(laneLog.up, [Date.now(), t, (t === 0x05 || t === 0x06) && head.length >= 2 ? head[1] : null]);
        }),
      };
    }
    if (cls === 'sio') {
      const count = (dir) =>
        createWsReader((op, head, len) => {
          if (op !== 1) return;
          const kind = sioKind(head);
          const m = bucket().sio[dir];
          m[kind] = (m[kind] ?? 0) + len;
        });
      return { down: count('down'), up: count('up') };
    }
    return null;
  };

  applyLink(o.link);

  const server = net.createServer({ allowHalfOpen: true, noDelay: true }, (client) => {
    counters.connections += 1;
    const upstream = net.connect({ host: o.target.host, port: o.target.port, allowHalfOpen: true, noDelay: true });
    const conn = { id: counters.connections, cls: null, client, server: upstream, localPort: 0, down: { flight: [], last: 0 }, up: { flight: [], last: 0 }, gone: false, openedAt: Date.now() };
    conns.add(conn);
    upstream.on('connect', () => {
      conn.localPort = upstream.localPort;
      localPorts.add(upstream.localPort);
    });
    client.on('data', (chunk) => {
      if (conn.cls === null) {
        conn.cls = classify(chunk);
        conn.readers = readersFor(conn.cls);
      }
      enqueue(dirs.up, conn, chunk, client);
    });
    upstream.on('data', (chunk) => enqueue(dirs.down, conn, chunk, upstream));
    // A FIN travels through the link like data, behind what was sent before it.
    const ended = { up: false, down: false };
    const endDir = (name) => {
      if (ended[name]) return;
      ended[name] = true;
      enqueue(dirs[name], conn, null, null);
    };
    client.on('end', () => endDir('up'));
    upstream.on('end', () => endDir('down'));
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    const closedSide = () => {
      if (!client.destroyed || !upstream.destroyed) return;
      conn.gone = true;
      dirs.up.paused.delete(client);
      dirs.down.paused.delete(upstream);
    };
    client.on('close', (hadError) => {
      if (hadError) upstream.destroy();
      else endDir('up');
      closedSide();
    });
    upstream.on('close', (hadError) => {
      if (hadError) client.destroy();
      else endDir('down');
      closedSide();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: o.port ?? 0, host: o.host ?? '127.0.0.1' }, resolve);
  });

  return {
    port: server.address().port,
    /** Local ports of the shaper's connections to the server (to tell shaped sockets from bots). */
    localPorts,
    get link() {
      return current;
    },
    /** Change the link now; queued segments continue at the new rate. */
    setLink(link) {
      pump();
      applyLink(link);
      pump();
    },
    /** Per-second buckets with `sec` in [fromMs, toMs). */
    seconds(fromMs, toMs) {
      const out = [];
      for (const b of seconds.values()) if (b.sec * 1000 >= fromMs && b.sec * 1000 < toMs) out.push(b);
      return out.sort((a, b) => a.sec - b.sec);
    },
    counters,
    /** Lane messages as they entered the link, in [fromMs, toMs). */
    laneLog: (fromMs, toMs) => ({
      down: laneLog.down.filter((e) => e[0] >= fromMs && e[0] < toMs),
      up: laneLog.up.filter((e) => e[0] >= fromMs && e[0] < toMs),
    }),
    queued: () => ({ down: dirs.down.qBytes, up: dirs.up.qBytes, downByClass: { ...dirs.down.qClass } }),
    openConnections: () => [...conns].filter((c) => !c.gone).map((c) => ({ id: c.id, cls: c.cls, openedAt: c.openedAt })),
    close: () =>
      new Promise((resolve) => {
        closed = true;
        if (timer !== null) clearTimeout(timer);
        for (const c of conns) {
          c.client.destroy();
          c.server.destroy();
        }
        conns.clear();
        server.close(() => resolve());
      }),
  };
};

/** The non-voice share of 3G (platform §15.5): 600 kbit/s down, 100 kbit/s up, 300 ms RTT. */
export const link3g = ({ downKbps = 600, upKbps = 100, rttMs = 300, lossEvery = 0, bufferBytes = 65536 } = {}) => ({
  rttMs,
  down: { kbps: downKbps, delayMs: rttMs / 2, bufferBytes, lossEvery },
  up: { kbps: upKbps, delayMs: rttMs / 2, bufferBytes, lossEvery },
});
