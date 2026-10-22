/**
 * Bench plugin for Glimmerhall (plan.md §4.3 "Performance and real smoke", glimmerhall.md §18.2): one
 * shaped headless Chrome runs the real client and auto-spins in a hall where 3 Node bots spin at about
 * 2 a second (the server's spin limit) and react to it every 3 s, on the non-voice share of 3G for 25 s.
 *
 * Checks: chat one-way p50 < 300 ms, Glimmerhall down ≤ 4 kbit/s (its own Socket.IO events and the
 * spin acks, as the shaper counts them), no disconnect or ping timeout on the shaped socket.
 *
 * Plugin contract (ops/bench/arcade-netbench.mjs, plan.md §2.6.5): `scenarios`, `game`, `humans`,
 * `startBots`, `enter`, plus three fields asked of the netbench for table games, which send no lane
 * frames: `ready` (replaces the wait for the first frames), `criteria` (replaces the scenario's
 * frame criteria) and `stage` (the app opens its own stage instead of the bench driving a lane).
 *
 * Until the netbench runs table games, this file runs the 3G scenario itself with the bench's own
 * libraries, unchanged:
 *
 *   node ops/bench/games/glimmer.mjs [--out <dir>] [--measure 25] [--settle 5]
 *
 * Everything it starts (Chrome, Vite, the server) is stopped at the end; Chrome is killed by PID.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectMain } from '../lib/clients.mjs';
import { launchChrome, sleep } from '../lib/chrome.mjs';
import { PAGE_SETUP, pageClient } from '../lib/page.mjs';
import { loadServer, unloadServer } from '../lib/paths.mjs';
import { freePort } from '../lib/ports.mjs';
import { evaluate, quantile } from '../lib/report.mjs';
import { startBenchServer } from '../lib/server.mjs';
import { createShaper, link3g } from '../lib/shaper.mjs';
import { startVite } from '../lib/vite.mjs';

export const scenarios = ['3g'];
export const game = 'glimmer';
export const humans = 4;
/** The hall is ready as soon as `enter` returns (it waits for auto-spin to run). */
export const ready = () => true;
/** Socket.IO kinds that are Glimmerhall's on the shaped socket: its events and the request acks. */
export const GLIMMER_KINDS = ['glimmer:', 'ack'];
export const criteria = { '3g': { chatP50: 300, sioDownKbps: { kinds: GLIMMER_KINDS, max: 4 } } };
export const stage = true;

/** The bots' spin cadence: the server allows 2 spins a second per account (real time). */
const BOT_SPIN_MS = 520;
const BOT_REACT_MS = 3000;

let wire = null;
const loadWire = async () => {
  if (!wire) {
    const w = await loadServer('src/arcade/core/glimmer/wire.ts');
    const v = await loadServer('src/arcade/core/version.ts');
    wire = { STOP_ALPHABET: w.STOP_ALPHABET, ID_CHARS: w.ID_CHARS, V: v.DEFS.glimmer };
  }
  return wire;
};

const spinId = (w) => {
  let id = '';
  for (let i = 0; i < w.ID_CHARS; i += 1) id += w.STOP_ALPHABET.charAt(Math.floor(Math.random() * w.STOP_ALPHABET.length));
  return id;
};

export async function startBots(server, n) {
  const w = await loadWire();
  const bots = [];
  for (let i = 0; i < n; i += 1) {
    const account = await server.account('Bench bot ' + (i + 1));
    const main = await connectMain(server.url, account.token);
    await main.joinVoice(server.voiceChannel);
    bots.push({ account, main, slot: -1, timers: [], stats: { spins: 0, refused: {}, picks: 0, reacts: 0, feeds: 0, ackMs: [] } });
  }
  const created = await bots[0].main.request('arcade:lobby:create', { ch: server.voiceChannel, game, mode: 'hall', cfg: {} });
  if (!created?.ok) throw new Error('hall create refused: ' + created?.code);
  const id = created.lobby.id;
  for (const bot of bots.slice(1)) {
    const joined = await bot.main.request('arcade:lobby:join', { id, as: 'player' });
    if (!joined?.ok) throw new Error('bot hall join refused: ' + joined?.code);
  }
  for (const bot of bots) {
    const entered = await bot.main.request('glimmer:enter', { ch: server.voiceChannel, v: w.V });
    if (!entered?.ok) throw new Error('bot enter refused: ' + entered?.code);
    bot.slot = entered.me;
    bot.main.raw.on('glimmer:feed', () => (bot.stats.feeds += 1));
  }
  const lobby = { id, ch: server.voiceChannel, game, started: Promise.resolve(), phoneSlot: null };
  let stopped = false;
  const spin = async (bot, i) => {
    if (stopped) return;
    const t0 = performance.now();
    const m = i % 3;
    const ack = await bot.main.request('glimmer:spin', { m, b: m === 0 ? 25 : 20, id: spinId(w) }, 8000).catch(() => null);
    if (!ack) return;
    bot.stats.ackMs.push(performance.now() - t0);
    if (!ack.ok) {
      bot.stats.refused[ack.code] = (bot.stats.refused[ack.code] ?? 0) + 1;
      return;
    }
    bot.stats.spins += 1;
    // A vault holds further spins until a door is opened.
    if (ack.v) {
      const pick = await bot.main.request('glimmer:pick', { door: 0, id: spinId(w) }, 8000).catch(() => null);
      if (pick?.ok) bot.stats.picks += 1;
    }
  };
  return {
    lobby,
    async start() {
      bots.forEach((bot, b) => {
        let i = b;
        bot.timers.push(
          setInterval(() => {
            i += 1;
            void spin(bot, i);
          }, BOT_SPIN_MS),
        );
        bot.timers.push(
          setInterval(() => {
            if (lobby.phoneSlot === null) return;
            void bot.main.request('glimmer:react', { to: lobby.phoneSlot, e: (bot.stats.reacts % 6) | 0 }, 8000).then(() => (bot.stats.reacts += 1), () => undefined);
          }, BOT_REACT_MS + b * 97),
        );
      });
    },
    stats: () =>
      bots.map((b) => ({
        name: b.account.name,
        spins: b.stats.spins,
        picks: b.stats.picks,
        reacts: b.stats.reacts,
        feeds: b.stats.feeds,
        refused: b.stats.refused,
        ackP95Ms: Math.round(quantile(b.stats.ackMs, 0.95) ?? 0),
      })),
    async stop() {
      stopped = true;
      for (const bot of bots) {
        for (const t of bot.timers) clearInterval(t);
        bot.main.close();
      }
    },
  };
}

/** The page side: time Glimmerhall's requests and count its messages on the main socket. */
const PAGE_GLIMMER = String.raw`(() => {
  const B = window.__bench;
  if (B.gh) return 'already';
  const G = (B.gh = { acks: [], down: [], spins: 0, autoStarts: 0, errors: [] });
  const raw = B.sc.socket;
  // The app's stage must open when the hall goes live: undo the bench's lobby-event filter.
  delete raw.emitEvent;
  const request = B.sc.request.bind(B.sc);
  B.sc.request = (ev, data, timeoutMs) => {
    const t0 = performance.now();
    const p = request(ev, data, timeoutMs);
    if (String(ev).startsWith('glimmer:')) {
      if (ev === 'glimmer:spin') G.spins += 1;
      p.then((r) => G.acks.push([Date.now(), ev, Math.round(performance.now() - t0), r && r.ok ? 1 : 0]), () => G.acks.push([Date.now(), ev, Math.round(performance.now() - t0), -1]));
    }
    return p;
  };
  // Every Socket.IO message the main socket receives: [t, kind, bytes on the WebSocket]. Engine.io has
  // already taken its '4' (message) off: events start with '2', acks with '3'.
  raw.io.engine.on('packet', (packet) => {
    if (packet.type !== 'message' || typeof packet.data !== 'string') return;
    const d = packet.data;
    const kind = d.startsWith('2') ? ((/^2\d*\["([^"]{1,40})"/.exec(d) || [])[1] || 'other') : d.startsWith('3') ? 'ack' : 'other';
    G.down.push([Date.now(), kind, d.length + 1]);
  });
  // Join voice the way a person does (the channel's view holds the game stage), then the hall through
  // the app's own join, which opens the stage.
  G.join = async (ch, id) => {
    const wait = async (fn, ms, label) => {
      const t0 = Date.now();
      while (!fn()) {
        if (Date.now() - t0 > ms) throw new Error('timeout: ' + label);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const section = () => [...document.querySelectorAll('nav[aria-label="Channels"] section')].find((x) => x.textContent.includes('Voice channels'));
    await wait(() => section() && section().querySelector('ul li button'), 20000, 'voice channel list');
    section().querySelector('ul li button').click();
    await wait(() => (document.querySelector('.motion-dock')?.textContent ?? '').includes('Voice connected'), 20000, 'voice connected');
    const { joinGame } = await import('/src/features/arcade/remote.ts');
    const error = await joinGame(id, 'player');
    if (error) throw new Error('hall join refused: ' + error);
    return true;
  };
  G.drain = () => {
    const out = { acks: G.acks, down: G.down, spins: G.spins, autoStarts: G.autoStarts };
    G.acks = [];
    G.down = [];
    return out;
  };
  // The hall's buttons take a pointer press released over them, or a click without a pointer (keyboard).
  const tap = (el) => el.click();
  // Keep auto-spin running: it stops on any feature, a big win and its own spin count.
  G.keep = () => {
    const auto = document.querySelector('.gh-auto');
    const spin = document.querySelector('.gh-spin');
    if (!auto || !spin) return 'no hall';
    const ok = [...document.querySelectorAll('.gh-sheet .gh-go')].find((b) => b.textContent === 'Got it');
    if (ok) ok.click();
    const doors = document.querySelector('.gh-hits');
    if (doors && !doors.hidden) {
      const door = doors.querySelector('button');
      if (door) tap(door);
      return 'door';
    }
    if (auto.classList.contains('on')) return 'on';
    if (spin.disabled || spin.classList.contains('busy') || spin.textContent !== 'SPIN') return 'busy';
    const start = [...document.querySelectorAll('.gh-sheet .gh-go')].find((b) => b.textContent === 'Start');
    if (start) {
      const options = [...document.querySelectorAll('.gh-sheet .gh-opt')];
      for (const label of ['50', '50 %']) {
        const b = options.find((o) => o.textContent === label);
        if (b) b.click();
      }
      start.click();
      G.autoStarts += 1;
      return 'started';
    }
    for (const x of document.querySelectorAll('.gh-sheet .gh-x')) x.click();
    tap(auto);
    return 'opening';
  };
  G.keeper = setInterval(() => {
    try {
      G.keep();
    } catch (e) {
      G.errors.push(String(e && e.message));
    }
  }, 500);
  return 'ok';
})()`;

/** Drive the shaped Chrome into the hall: join voice, join the hall as the app does (its stage opens), auto-spin. */
export async function enter(client, lobby) {
  const page = client.page;
  if (!page) throw new Error('Glimmerhall needs the Chrome page client (the real app)');
  await page.eval(PAGE_GLIMMER);
  await page.eval(`window.__bench.gh.join(${JSON.stringify(lobby.ch)}, ${JSON.stringify(lobby.id)})`);
  const started = Date.now();
  for (;;) {
    const state = await page.eval(`window.__bench.gh.keep()`);
    if (state === 'on') break;
    if (Date.now() - started > 30000) throw new Error('auto-spin never started (last: ' + state + ')');
    await sleep(250);
  }
  lobby.phoneSlot = await page.eval(`(() => { const me = document.querySelector('.gh-friends .gh-mem.me'); return me ? Number(me.dataset.slot) : null; })()`);
}

// ---------------------------------------------------------------- standalone 3G run

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

const standalone = async () => {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = argv.indexOf('--' + name);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : fallback;
  };
  const measureS = Number(arg('measure', '25'));
  const settleS = Number(arg('settle', '5'));
  const out = arg('out', join(tmpdir(), 'arcade-netbench', 'glimmer-' + new Date().toISOString().replace(/[:.]/g, '-')));
  mkdirSync(out, { recursive: true });
  process.env.LOG_LEVEL ??= 'info';
  process.env.LOG_FORMAT ??= 'json';
  const wallStart = Date.now();
  const log = (...parts) => console.log('[' + ((Date.now() - wallStart) / 1000).toFixed(1).padStart(5) + ' s]', ...parts);
  const cleanups = [];
  const cleanup = async () => {
    for (const fn of cleanups.reverse()) {
      try {
        await Promise.race([fn(), sleep(5000)]);
      } catch (error) {
        console.error('cleanup:', error?.message ?? error);
      }
    }
    await unloadServer().catch(() => undefined);
  };
  // Setup plus one scenario: never more than 100 s in all, whatever happens.
  const hardCap = setTimeout(() => {
    console.error('glimmer bench: hard cap reached');
    void cleanup().then(() => process.exit(3));
  }, 100_000);
  hardCap.unref();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => void cleanup().then(() => process.exit(130)));

  const store = { frames: [], keyframes: [], chat: [], probes: [], lane: [], sock: [], yields: [], phases: [], errors: [] };
  const gh = { acks: [], down: [], spins: 0, autoStarts: 0 };
  let verdict = 'ERROR';
  let report = null;
  try {
    const vitePort = await freePort(new Set());
    const corsOrigins = [`http://127.0.0.1:${vitePort}`, `http://localhost:${vitePort}`];
    const server = await startBenchServer({ corsOrigins });
    cleanups.push(() => server.close());
    const shaper = await createShaper({ target: { host: '127.0.0.1', port: server.port }, link: link3g() });
    cleanups.push(() => shaper.close());
    server.setShapedCheck((port) => shaper.localPorts.has(port));
    log('server :' + server.port + ', shaper :' + shaper.port + ', vite :' + vitePort);
    const [vite, chrome] = await Promise.all([
      startVite({ port: vitePort, proxy: 'http://127.0.0.1:' + shaper.port, logFile: join(out, 'vite.log') }).then((v) => {
        cleanups.push(() => v.kill());
        return v;
      }),
      launchChrome({ name: 'shaped' }).then((c) => {
        cleanups.push(() => c.kill());
        return c;
      }),
    ]);
    log('vite (pid ' + vite.pid + ') and chrome (pid ' + chrome.pid + ') up');
    const bots = await startBots(server, humans - 1);
    cleanups.push(() => bots.stop());
    log('3 bots in the hall, lobby ' + bots.lobby.id);

    const phone = await server.account('Bench phone');
    server.watch(phone.id);
    const page = chrome.page;
    await page.goto(vite.url + '/robots.txt');
    await page.eval(`localStorage.setItem('datasetto.auth.v2', ${JSON.stringify(JSON.stringify({ token: phone.token, account: null }))}); true`);
    await page.goto(vite.url + '/');
    for (let t = Date.now(); !server.signedIn(phone.id); await sleep(100)) if (Date.now() - t > 40000) throw new Error('the page never signed in');
    await page.eval(PAGE_SETUP);
    const client = pageClient(page);
    await client.init();
    cleanups.push(() => client.stop());
    log('page signed in');
    await enter(client, bots.lobby);
    log('the phone auto-spins in the hall (slot ' + bots.lobby.phoneSlot + ')');
    await bots.start();
    server.startChat(phone.id);

    const drain = async () => {
      const d = await client.drain();
      for (const k of Object.keys(store)) if (Array.isArray(d[k])) store[k].push(...d[k]);
      const g = await page.eval('window.__bench.gh.drain()');
      gh.acks.push(...g.acks);
      gh.down.push(...g.down);
      gh.spins = g.spins;
      gh.autoStarts = g.autoStarts;
    };
    shaper.setLink(link3g());
    const settleAt = Date.now();
    log('3G: settle ' + settleS + ' s, measure ' + measureS + ' s');
    while (Date.now() < settleAt + settleS * 1000) {
      await sleep(500);
      await drain();
    }
    const mStart = Date.now();
    const mEnd = mStart + measureS * 1000;
    while (Date.now() < mEnd) {
      await sleep(1000);
      await drain();
      const now = Date.now();
      const chat = store.chat.filter(([t]) => t >= now - 1500).map((c) => c[1]);
      // The last whole second (the current one is still filling).
      const sec = shaper.seconds(Math.floor(now / 1000) * 1000 - 1000, Math.floor(now / 1000) * 1000)[0];
      const glimmerDown = sec ? sum(Object.entries(sec.sio?.down ?? {}).filter(([k]) => GLIMMER_KINDS.some((p) => k.startsWith(p))).map(([, v]) => v)) : 0;
      log(`  +${((now - mStart) / 1000).toFixed(0)} s: chat ${chat.join(',') || '-'} ms, glimmer down ${glimmerDown} B/s, spins ${gh.spins}`);
    }
    await sleep(300);
    await drain();
    const now = Date.now();
    const def = { id: '3g', label: '3G', measureS, criteria: { chatP95: 300 } };
    const e = evaluate({
      def,
      store,
      shaperSeconds: shaper.seconds(settleAt - 1000, now + 1000),
      serverSeconds: server.seconds(settleAt - 1000, now + 1000),
      serverDisconnects: server.disconnects(),
      serverLanes: server.lanes(),
      laneLog: shaper.laneLog(settleAt - 1000, now + 1000),
      adminStats: [],
      settleAt,
      mStart,
      mEnd,
      now: Math.min(now, mEnd),
      final: true,
    });
    // Glimmerhall's own bytes over the measured whole seconds, from the shaper (payload) and the page (messages).
    const measured = shaper.seconds(Math.ceil(mStart / 1000) * 1000, Math.floor(mEnd / 1000) * 1000);
    const glimmerPerSecond = measured.map((b) => sum(Object.entries(b.sio?.down ?? {}).filter(([k]) => GLIMMER_KINDS.some((p) => k.startsWith(p))).map(([, v]) => v)));
    const glimmerUpPerSecond = measured.map((b) => sum(Object.entries(b.sio?.up ?? {}).filter(([k]) => k.startsWith('glimmer:')).map(([, v]) => v)));
    const downKbps = glimmerPerSecond.length ? (sum(glimmerPerSecond) * 8) / 1000 / glimmerPerSecond.length : null;
    const upKbps = glimmerUpPerSecond.length ? (sum(glimmerUpPerSecond) * 8) / 1000 / glimmerUpPerSecond.length : null;
    const inWindow = gh.down.filter(([t]) => t >= mStart && t < mEnd);
    const glimmerMsgs = inWindow.filter(([, k]) => GLIMMER_KINDS.some((p) => k.startsWith(p)));
    // Framing per message as the platform budgets a table-lane push (core/net/budget.ts).
    const FRAMING = (await loadServer('src/arcade/core/net/budget.ts')).OVERHEAD.tableDown;
    const wireKbps = ((sum(glimmerMsgs.map((x) => x[2])) + glimmerMsgs.length * FRAMING) * 8) / 1000 / measureS;
    const spinAcks = gh.acks.filter(([t, ev]) => t >= mStart && t < mEnd && ev === 'glimmer:spin').map((a) => a[2]);
    const chatP50 = e.metrics.chatOneWayMs.p50;
    const checks = [...e.checks];
    checks.push({ id: 'chat-p50', label: 'chat one-way p50 (ms)', value: chatP50, limit: '< 300', pass: chatP50 !== null && chatP50 < 300 });
    checks.push({ id: 'glimmer-down', label: 'Glimmerhall down, Socket.IO payload (kbit/s)', value: downKbps === null ? null : Math.round(downKbps * 100) / 100, limit: '<= 4', pass: downKbps !== null && downKbps <= 4 });
    checks.push({ id: 'phone-spins', label: 'phone spins in the window (auto-spin ran)', value: spinAcks.length, limit: '>= ' + Math.floor(measureS / 2), pass: spinAcks.length >= Math.floor(measureS / 2) });
    const botStats = bots.stats();
    const botSpins = sum(botStats.map((b) => b.spins));
    checks.push({ id: 'bot-spins', label: 'bot spins per second (3 bots)', value: Math.round((botSpins / ((Date.now() - settleAt) / 1000)) * 10) / 10, limit: '>= 5', pass: botSpins / ((Date.now() - settleAt) / 1000) >= 5 });
    verdict = checks.every((c) => c.pass !== false) ? 'PASS' : 'FAIL';
    report = {
      game,
      link: '600/100 kbit/s, 300 ms RTT, 64 KB buffers',
      setupS: Math.round((settleAt - wallStart) / 100) / 10,
      measureS,
      verdict,
      checks,
      glimmer: {
        downKbps: downKbps === null ? null : Math.round(downKbps * 100) / 100,
        downMax1sBytes: glimmerPerSecond.length ? Math.max(...glimmerPerSecond) : null,
        downPerSecond: glimmerPerSecond,
        upKbps: upKbps === null ? null : Math.round(upKbps * 100) / 100,
        wireEstimateKbps: Math.round(wireKbps * 100) / 100,
        messages: glimmerMsgs.length,
        byKind: Object.fromEntries([...new Set(glimmerMsgs.map((x) => x[1]))].map((k) => [k, { n: glimmerMsgs.filter((x) => x[1] === k).length, bytes: sum(glimmerMsgs.filter((x) => x[1] === k).map((x) => x[2])) }])),
        spinAckMs: { n: spinAcks.length, p50: Math.round(quantile(spinAcks, 0.5) ?? 0), p95: Math.round(quantile(spinAcks, 0.95) ?? 0), max: spinAcks.length ? Math.max(...spinAcks) : null },
        autoStarts: gh.autoStarts,
      },
      chat: e.metrics.chatOneWayMs,
      socketIoDownBytes: e.metrics.serverSend.socketIoDownBytes,
      shaper: e.metrics.shaper,
      server: e.metrics.server,
      disconnects: e.metrics.disconnects,
      bots: botStats,
      console: page.console.filter((c) => c.type === 'error' || c.type === 'exception').slice(-20),
      pageErrors: store.errors.slice(-20),
    };
  } catch (error) {
    console.error('glimmer bench failed:', error?.stack ?? error);
    report = { game, verdict: 'ERROR', error: String(error?.message ?? error) };
  }
  await cleanup();
  clearTimeout(hardCap);
  report.wallS = Math.round((Date.now() - wallStart) / 100) / 10;
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  const lines = ['Glimmerhall bench, 3G (' + (report.link ?? '-') + '), wall ' + report.wallS + ' s, setup ' + (report.setupS ?? '-') + ' s'];
  for (const c of report.checks ?? []) lines.push('  ' + (c.pass === true ? 'PASS' : c.pass === false ? 'FAIL' : 'n/a ') + '  ' + c.label + ': ' + (c.value ?? '-') + ' (' + c.limit + ')');
  if (report.glimmer) {
    const g = report.glimmer;
    lines.push('  glimmer: down ' + g.downKbps + ' kbit/s payload (max ' + g.downMax1sBytes + ' B in 1 s), ~' + g.wireEstimateKbps + ' kbit/s with framing, ' + g.messages + ' messages ' + JSON.stringify(g.byKind) + '; up ' + g.upKbps + ' kbit/s');
    lines.push('  spin acks: ' + JSON.stringify(g.spinAckMs) + '; chat: ' + JSON.stringify(report.chat) + '; auto-spin starts ' + g.autoStarts);
    lines.push('  bots: ' + JSON.stringify(report.bots));
  }
  if (report.error) lines.push('  error: ' + report.error);
  lines.push('overall: ' + report.verdict);
  writeFileSync(join(out, 'summary.txt'), lines.join('\n') + '\n');
  console.log('\n' + lines.join('\n') + '\n\nresults: ' + out);
  process.exit(report.verdict === 'PASS' ? 0 : 1);
};

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase();
if (isMain) await standalone();
