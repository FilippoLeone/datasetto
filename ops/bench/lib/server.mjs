/**
 * The bench's in-process server: the real HTTP app, Socket.IO and the Arcade (real clock), on a
 * file-less database as the tests use (`makeContext` from server/test/helpers.ts), on a free port.
 *
 * Instrumentation, all from outside server/src:
 * - every `/arcade/ws` upgrade is seen first (a prepended `upgrade` listener) and its TCP socket is
 *   sampled every 20 ms. With permessage-deflate off, `ws.bufferedAmount` is exactly that socket's
 *   `writableLength`. A socket is "shaped" when it came through the shaper (its remote port is one
 *   of the shaper's outgoing ports); the bots connect directly.
 * - the shaped account's main socket: engine.io's `writeBuffer` length and the WebSocket transport's
 *   `bufferedAmount`, sampled the same way;
 * - Socket.IO disconnects with their reason (`ping timeout`, `transport close`, …);
 * - the chat prober: once a second a ~200 B `bench:chat {t}` to the shaped account's sockets.
 */
import http from 'node:http';
import { rmSync } from 'node:fs';
import { loadServer } from './paths.mjs';

const PAD = 'x'.repeat(150);
let accountSeq = 0;

export const startBenchServer = async ({ corsOrigins, arcade = {}, env = {} }) => {
  const { makeContext, testDataDir } = await loadServer('test/helpers.ts');
  const { createHttpApp } = await loadServer('src/http/app.ts');
  const { createSocketServer } = await loadServer('src/socket/index.ts');

  const ctx = makeContext({ CORS_ORIGINS: corsOrigins.join(','), LOG_LEVEL: 'silent', ...env });
  const app = createHttpApp(ctx);
  const server = http.createServer(app);
  // No `clock`: the Arcade runs on real time.
  const sockets = createSocketServer(server, ctx, { arcade });
  let isShaped = () => false;

  const lanes = [];
  const disconnects = [];
  const perSecond = new Map();
  const sec = () => {
    const s = Math.floor(Date.now() / 1000);
    let b = perSecond.get(s);
    if (!b) {
      b = { sec: s, laneShaped: 0, laneBots: 0, mainShaped: 0, mainWriteBuffer: 0, chatSent: 0 };
      perSecond.set(s, b);
      if (perSecond.size > 600) perSecond.delete(perSecond.keys().next().value);
    }
    return b;
  };

  server.prependListener('upgrade', (req, socket) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/arcade/ws') return;
    const entry = { socket, shaped: isShaped(socket.remotePort), openedAt: Date.now(), closedAt: null, hadError: false, maxBuffered: 0 };
    lanes.push(entry);
    socket.once('close', (hadError) => {
      entry.closedAt = Date.now();
      entry.hadError = hadError;
    });
  });

  sockets.io.on('connection', (s) => {
    const shaped = isShaped(s.request?.socket?.remotePort);
    s.on('disconnect', (reason) => disconnects.push({ t: Date.now(), id: s.id, shaped, reason }));
  });

  let shapedAccount = null;
  const mainSockets = () => (shapedAccount ? ctx.presence.getSocketsByAccount(shapedAccount) : []);

  const sampler = setInterval(() => {
    const b = sec();
    for (const lane of lanes) {
      if (lane.closedAt !== null) continue;
      const n = lane.socket.writableLength;
      lane.maxBuffered = Math.max(lane.maxBuffered, n);
      if (lane.shaped) b.laneShaped = Math.max(b.laneShaped, n);
      else b.laneBots = Math.max(b.laneBots, n);
    }
    for (const id of mainSockets()) {
      const conn = sockets.io.sockets.sockets.get(id)?.conn;
      if (!conn) continue;
      b.mainWriteBuffer = Math.max(b.mainWriteBuffer, Array.isArray(conn.writeBuffer) ? conn.writeBuffer.length : 0);
      const ws = conn.transport?.socket;
      if (ws && typeof ws.bufferedAmount === 'number') b.mainShaped = Math.max(b.mainShaped, ws.bufferedAmount);
    }
  }, 20);
  sampler.unref();

  let chatTimer = null;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const voice = ctx.channels.list().find((channel) => channel.type === 'voice');
  if (!voice) throw new Error('bench: no voice channel seeded');

  return {
    url: 'http://127.0.0.1:' + port,
    port,
    ctx,
    io: sockets.io,
    voiceChannel: voice.id,
    loadServer,
    setShapedCheck(fn) {
      isShaped = fn;
    },
    async account(name) {
      accountSeq += 1;
      const created = await ctx.accounts.register({ username: 'nb' + accountSeq + '-' + Date.now() + '@example.com', password: 'netbench-pass-1', displayName: name });
      return { id: created.id, name, token: ctx.sessions.create(created.id).token };
    },
    /** True once the account has an authenticated main socket. */
    signedIn: (accountId) => ctx.presence.getSocketsByAccount(accountId).length > 0,
    startChat(accountId) {
      shapedAccount = accountId;
      if (chatTimer) return;
      chatTimer = setInterval(() => {
        for (const id of mainSockets()) {
          sockets.io.to(id).emit('bench:chat', { t: Date.now(), p: PAD });
          sec().chatSent += 1;
        }
      }, 1000);
    },
    watch(accountId) {
      shapedAccount = accountId;
    },
    lanes: () => lanes.map(({ socket: _s, ...rest }) => rest),
    disconnects: () => disconnects.slice(),
    seconds(fromMs, toMs) {
      const out = [];
      for (const b of perSecond.values()) if (b.sec * 1000 >= fromMs && b.sec * 1000 < toMs) out.push(b);
      return out.sort((a, b) => a.sec - b.sec);
    },
    close: () =>
      new Promise((resolve) => {
        clearInterval(sampler);
        if (chatTimer) clearInterval(chatTimer);
        for (const lane of lanes) lane.socket.destroy();
        void sockets.arcade.stop();
        sockets.io.close(() => {
          server.close(() => {
            if (ctx.db.open) ctx.db.close();
            try {
              rmSync(testDataDir, { recursive: true, force: true });
            } catch {
              /* still in use */
            }
            resolve();
          });
        });
        server.closeAllConnections?.();
      }),
  };
};
