/**
 * Node clients for the bench: the main socket (socket.io-client, signed in with `auth:session`) and
 * an action-lane client that speaks the binary envelope (platform.md §4.1, §5.2):
 * - HELLO as the one text frame, binary after it;
 * - an UP every `upEveryMs` (2 ticks) while `moving()`, carrying `ackFrame` and `ackDelay`;
 * - an ACK when a frame arrived since the last ACK or UP and no UP went out for 250 ms;
 * - 5 PINGs 200 ms apart after WELCOME, then one every 2 s.
 * With `record`, every frame, keyframe and close is logged in the same shape as the page script's.
 */
import { loadServer, serverRequire } from './paths.mjs';

const { io: connectIo } = serverRequire('socket.io-client');
const WebSocket = serverRequire('ws');

const once = (socket, event, timeoutMs) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ' + event)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

export const connectMain = async (url, token) => {
  const socket = connectIo(url, { path: '/socket.io/', transports: ['websocket'], forceNew: true, reconnection: false });
  await once(socket, 'connect', 8000);
  const ok = once(socket, 'auth:success', 8000);
  socket.emit('auth:session', { token });
  await ok;
  const request = (ev, data = {}, timeoutMs = 8000) =>
    new Promise((resolve, reject) => {
      socket.timeout(timeoutMs).emit(ev, data, (error, response) => (error ? reject(error) : resolve(response)));
    });
  return {
    raw: socket,
    request,
    async joinVoice(channelId) {
      const joined = once(socket, 'voice:joined', 8000);
      socket.emit('voice:join', channelId);
      await joined;
    },
    close: () => socket.close(),
  };
};

let codec = null;
const loadCodec = async () => {
  if (!codec) {
    const lane = await loadServer('src/arcade/core/net/lane.ts');
    const version = await loadServer('src/arcade/core/version.ts');
    codec = { ...lane, PROTO: version.PROTO, CODEC: version.CODEC };
  }
  return codec;
};

export const openLane = async ({ url, ticket, game = 'fuseyard', payload = Uint8Array.of(1), upEveryMs = 66, moving = () => true, record = null }) => {
  const c = await loadCodec();
  const ws = new WebSocket(url.replace(/^http/, 'ws') + '/arcade/ws');
  ws.binaryType = 'nodebuffer';
  const stats = { welcome: 0, frames: 0, keyframes: 0, beats: 0, pongs: 0, ups: 0, acks: 0, pings: 0, closed: null, gaps: 0 };
  let ready = false;
  let upSeq = 0;
  let ackFrame = 0;
  let frameAt = 0;
  let ackPending = false;
  let lastUpAt = -Infinity;
  let lastAckAt = -Infinity;
  let expected = null;
  let pings = 0;
  let pingTimer = null;
  const now = () => performance.now();
  const send = (bytes) => {
    if (ready && ws.readyState === WebSocket.OPEN) ws.send(bytes);
  };

  const ping = () => {
    pings += 1;
    pingTimer = setTimeout(ping, pings < 5 ? 200 : 2000);
    send(c.writePing(Math.floor(now()) >>> 0));
    stats.pings += 1;
  };

  const gotFrame = (m) => {
    ackFrame = m.frameSeq;
    frameAt = now();
    ackPending = true;
  };

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const m = c.readServer(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
    if (!m) return;
    switch (m.t) {
      case 'welcome':
        ready = true;
        stats.welcome += 1;
        record?.lane.push({ t: Date.now(), e: 'welcome', slot: m.slot });
        clearTimeout(pingTimer);
        pings = 0;
        ping();
        break;
      case 'keyframe':
        gotFrame(m);
        expected = (m.frameSeq + 1) & 0xffff;
        stats.keyframes += 1;
        record?.keyframes.push([Date.now(), m.reason]);
        break;
      case 'frame':
        gotFrame(m);
        if (expected !== null && m.frameSeq !== expected) stats.gaps += 1;
        expected = (m.frameSeq + 1) & 0xffff;
        stats.frames += 1;
        record?.frames.push([Date.now(), m.divisor, m.lagging ? 1 : 0]);
        break;
      case 'beat':
        stats.beats += 1;
        break;
      case 'pong':
        stats.pongs += 1;
        break;
      default:
        break;
    }
  });

  const upTimer = setInterval(() => {
    if (!ready || !moving()) return;
    upSeq = (upSeq + 1) & 0xffff;
    const t = now();
    send(c.writeUp(upSeq, ackFrame, t - frameAt, payload));
    lastUpAt = t;
    ackPending = false;
    stats.ups += 1;
  }, upEveryMs);

  const ackTimer = setInterval(() => {
    if (!ready || !ackPending) return;
    const t = now();
    if (t - lastUpAt < 250 || t - lastAckAt < 250) return;
    send(c.writeAck(ackFrame, t - frameAt));
    lastAckAt = t;
    ackPending = false;
    stats.acks += 1;
  }, 50);

  const stopTimers = () => {
    clearInterval(upTimer);
    clearInterval(ackTimer);
    clearTimeout(pingTimer);
  };

  ws.on('close', (code, reason) => {
    stopTimers();
    stats.closed = code;
    record?.lane.push({ t: Date.now(), e: 'close', code, reason: String(reason) });
  });
  ws.on('error', () => undefined);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lane did not open')), 8000);
    ws.once('open', () => {
      clearTimeout(timer);
      record?.lane.push({ t: Date.now(), e: 'open' });
      ws.send(JSON.stringify({ t: 'hello', proto: c.PROTO, codec: { [game]: c.CODEC[game] }, ticket }));
      resolve();
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      reject(new Error('lane upgrade refused: ' + res.statusCode));
    });
  });

  return {
    stats,
    close(code = 1000) {
      stopTimers();
      if (ready && ws.readyState === WebSocket.OPEN) ws.send(c.writeVis(c.VIS.leaving));
      try {
        ws.close(code);
      } catch {
        ws.terminate();
      }
    },
    terminate: () => ws.terminate(),
  };
};

/**
 * The shaped client in Node (`--client node`, a dry run without the browser): the same samples as
 * the page script, from a socket.io-client main socket and a lane client, through the shaper (or
 * through Vite in front of it).
 */
export const createNodeShaped = async ({ url, token, moveMs = 4000, cycleMs = 5000, probeEveryMs = 2100 }) => {
  const B = { frames: [], keyframes: [], chat: [], probes: [], lane: [], sock: [], yields: [], phases: [], errors: [], ups: 0 };
  const main = await connectMain(url, token);
  main.raw.on('bench:chat', (p) => B.chat.push([Date.now(), Date.now() - p.t]));
  main.raw.on('disconnect', (reason) => B.sock.push({ t: Date.now(), e: 'disconnect', reason }));
  let lane = null;
  let probeTimer = null;
  return {
    kind: 'node',
    async join(ch, id) {
      await main.joinVoice(ch);
      const r = await main.request('arcade:lobby:join', { id, as: 'player' });
      if (!r?.ok) throw new Error('lobby join refused: ' + r?.code);
    },
    async play(id, o) {
      const t = await main.request('arcade:ticket', { id });
      if (!t?.ok) throw new Error('ticket refused: ' + t?.code);
      lane = await openLane({ url, ticket: t.ticket, game: o.game, record: B, moving: () => Date.now() % cycleMs < moveMs });
      probeTimer = setInterval(() => {
        const at = Date.now();
        const t0 = performance.now();
        main.request('arcade:probe', {}, 5000).then(
          (r) => B.probes.push([at, performance.now() - t0, r?.ok ? 1 : 0]),
          () => B.probes.push([at, performance.now() - t0, -1]),
        );
      }, probeEveryMs);
    },
    async drain() {
      const out = { now: Date.now(), ups: lane ? lane.stats.ups : 0 };
      for (const k of ['frames', 'keyframes', 'chat', 'probes', 'lane', 'sock', 'yields', 'phases', 'errors']) {
        out[k] = B[k];
        B[k] = [];
      }
      return out;
    },
    async stop() {
      clearInterval(probeTimer);
      lane?.close();
      main.close();
    },
  };
};
