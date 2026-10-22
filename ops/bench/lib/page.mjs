/**
 * The page side of the shaped Chrome, run through CDP `Runtime.evaluate` in the real client served
 * by Vite. It imports the app's own modules (the socket client the app already uses, and the action
 * lane's remote host), so the bench measures the shipped code paths, not a copy.
 *
 * Do not write under client/ while it runs: after a Vite update a plain import returns a second
 * copy of a module. The bench's Vite runs with HMR off for the same reason.
 *
 * `window.__bench` keeps the samples (all `Date.now()`, the same clock as the server and the bench):
 * frames [t, divisor, lagging], keyframes [t, reason], chat [t, oneWayMs], probes [t, rttMs, ok],
 * lane / sock events, yields [t, on], game (a plugin's own samples, pushed from its enter()).
 * `drain()` hands them over and empties the lists. `init({ stage: true })` keeps the app's lobby
 * handling; `startProbes(ms)` starts the probe for a game that plays no lane.
 */

export const PAGE_SETUP = String.raw`(() => {
  if (window.__bench) return 'already';
  // 'game': a plugin's own samples (B.game.push(...) from its enter()); they arrive as store.game.
  const KEYS = ['frames', 'keyframes', 'chat', 'probes', 'lane', 'sock', 'yields', 'phases', 'errors', 'game'];
  const B = { ups: 0 };
  for (const k of KEYS) B[k] = [];
  window.__bench = B;

  // The lane client opens its WebSocket through the global at call time: count opens and closes.
  const NativeWebSocket = window.WebSocket;
  class BenchWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      if (String(url).includes('/arcade/ws')) {
        B.lane.push({ t: Date.now(), e: 'connect' });
        this.addEventListener('open', () => B.lane.push({ t: Date.now(), e: 'open' }));
        this.addEventListener('close', (ev) => B.lane.push({ t: Date.now(), e: 'close', code: ev.code, reason: ev.reason }));
      }
    }
  }
  window.WebSocket = BenchWebSocket;
  window.addEventListener('error', (e) => B.errors.push({ t: Date.now(), m: String(e.message) }));
  window.addEventListener('unhandledrejection', (e) => B.errors.push({ t: Date.now(), m: String((e.reason && e.reason.message) || e.reason) }));

  B.drain = () => {
    const out = { now: Date.now(), ups: B.ups };
    for (const k of KEYS) {
      out[k] = B[k];
      B[k] = [];
    }
    return out;
  };

  B.init = async (opts) => {
    const { socketClient } = await import('/src/services/socket/client.ts');
    B.sc = socketClient;
    const started = Date.now();
    while (!socketClient.connected) {
      if (Date.now() - started > 20000) throw new Error('main socket did not connect');
      await new Promise((r) => setTimeout(r, 100));
    }
    const raw = socketClient.socket;
    // The app opens its own stage (and a second lane for the same seat) when the lobby it is in goes
    // live. The bench drives the lane itself, so the app does not see lobby updates, unless the game
    // plays through the app's stage ({ stage: true }).
    if (!(opts && opts.stage)) {
      const emitEvent = raw.emitEvent;
      raw.emitEvent = function (args) {
        if (args && args[0] === 'arcade:lobby') return;
        return emitEvent.call(this, args);
      };
    }
    raw.on('bench:chat', (p) => B.chat.push([Date.now(), Date.now() - p.t]));
    raw.on('disconnect', (reason) => B.sock.push({ t: Date.now(), e: 'disconnect', reason }));
    raw.on('connect', () => B.sock.push({ t: Date.now(), e: 'connect' }));
    return raw.id;
  };

  B.join = async (ch, id) => {
    const sc = B.sc;
    await new Promise((resolve, reject) => {
      let off = () => undefined;
      const timer = setTimeout(() => {
        off();
        reject(new Error('voice:join timed out'));
      }, 10000);
      off = sc.on('voice:joined', () => {
        clearTimeout(timer);
        off();
        resolve();
      });
      sc.emit('voice:join', ch);
    });
    const r = await sc.request('arcade:lobby:join', { id, as: 'player' }, 10000);
    if (!r || !r.ok) throw new Error('lobby join refused: ' + (r && r.code));
    return true;
  };

  B.play = async (id, o) => {
    const sc = B.sc;
    const t = await sc.request('arcade:ticket', { id }, 10000);
    if (!t || !t.ok) throw new Error('ticket refused: ' + (t && t.code));
    const { createRemoteMatchHost } = await import('/src/arcade/runtime/net/remoteHost.ts');
    const host = createRemoteMatchHost({ lobbyId: id, ticket: t.ticket, game: o.game });
    B.host = host;
    host.onWelcome((w) => B.lane.push({ t: Date.now(), e: 'welcome', slot: w.slot }));
    host.onFrame((f) => {
      B.frames.push([Date.now(), f.divisor, f.lagging ? 1 : 0]);
      // Games consume the whole event block inside the callback (remoteHost.ts); so does the bench.
      if (f.events) f.events.r.skip(f.events.r.remaining);
    });
    host.onKeyframe((k) => {
      B.keyframes.push([Date.now(), k.reason]);
      k.body.skip(k.body.remaining);
    });
    host.onPhase((p) => B.phases.push([Date.now(), p.phase]));
    host.onClosed((code, reason) => B.lane.push({ t: Date.now(), e: 'final', code, reason }));
    host.onYield((y) => B.yields.push([Date.now(), y ? 1 : 0]));
    const payload = Uint8Array.of(1);
    B.upTimer = setInterval(() => {
      if (Date.now() % o.cycleMs >= o.moveMs) return;
      host.sendUp(payload);
      B.ups += 1;
    }, o.upEveryMs);
    B.startProbes(o.probeEveryMs);
    return true;
  };

  // The acked arcade:probe every everyMs (play() starts it; a game without a lane calls it itself).
  B.startProbes = (everyMs) => {
    if (B.probeTimer) return true;
    B.probeTimer = setInterval(() => {
      const at = Date.now();
      const t0 = performance.now();
      B.sc.request('arcade:probe', {}, 5000).then(
        (r) => B.probes.push([at, performance.now() - t0, r && r.ok ? 1 : 0]),
        () => B.probes.push([at, performance.now() - t0, -1]),
      );
    }, everyMs || 2100);
    return true;
  };

  B.stop = () => {
    clearInterval(B.upTimer);
    clearInterval(B.probeTimer);
    if (B.host) B.host.close();
    return true;
  };
  return 'ok';
})()`;

/** The shaped Chrome page as a bench client (same interface as `createNodeShaped`). */
export const pageClient = (page) => ({
  kind: 'chrome',
  page,
  init: (opts = {}) => page.eval(`window.__bench.init(${JSON.stringify(opts)})`),
  join: (ch, id) => page.eval(`window.__bench.join(${JSON.stringify(ch)}, ${JSON.stringify(id)})`),
  play: (id, o) => page.eval(`window.__bench.play(${JSON.stringify(id)}, ${JSON.stringify(o)})`),
  startProbes: (everyMs = 2100) => page.eval(`window.__bench.startProbes(${Number(everyMs)})`),
  drain: () => page.eval('window.__bench.drain()', 10000),
  stop: () => page.eval('window.__bench && window.__bench.stop ? window.__bench.stop() : true', 5000).catch(() => false),
});
