#!/usr/bin/env node
/**
 * Arcade netbench: the real shaped smoke (docs/arcade/platform.md §15.5, plan.md §3.2).
 *
 *   node ops/bench/arcade-netbench.mjs --game probe [--max-wall 600] [--out <dir>]
 *   (or: npx --prefix server tsx ops/bench/arcade-netbench.mjs --game probe)
 *
 * One process starts the server with the Arcade (real clock, file-less database), a userland TCP
 * shaper in front of it carrying the non-voice share of 3G (600 kbit/s down, 100 up, 300 ms RTT),
 * Vite dev for the client proxied through the shaper, 3 unshaped Node bots and ONE shaped headless
 * Chrome (muted, silent fake microphone) running the real client. A chat prober sends a ~200 B
 * server message to the browser every second, and the page does an acked `arcade:probe` every 2 s.
 *
 * Scenarios (a 5 s settle before the first, 3 s before the others, then measurement; a scenario stops
 * as soon as a check has certainly failed; 60 s cap per scenario; `--max-wall` for the whole run; a
 * full default run takes about 140 s including setup):
 *   3g        25 s
 *   3g-loss   25 s, 1 % head-of-line loss
 *   collapse  35 s: 5 s 3G, 20 s at 120 kbit/s down, 10 s 3G
 *   squeeze   25 s: 5 s 3G, 12 s at 12 kbit/s down, 8 s 3G
 *
 * Other options:
 *   --client chrome|node   node: a Node stand-in for the browser (dry runs without Chrome)
 *   --via shaper|vite      node client: straight into the shaper, or through Vite's proxy
 *   --scenarios a,b        a subset
 *   --collapse-kbps 120    the collapsed down rate
 *   --squeeze-kbps 12      the squeezed down rate
 *   --settle 5 / --settle-next 3   settle before the first / the later scenarios (s)
 *   --scale 1              multiply scenario durations (quick dry runs)
 *   --full                 run every scenario to its end even after a check failed (≤ 60 s each)
 *   --plugin <file>        load the game plugin from this file instead of games/<game>.mjs
 *
 * Results: report.json and summary.txt in --out (default %TEMP%/arcade-netbench/<time>).
 * Everything it starts (Chrome, Vite) is killed by PID at the end.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectMain, createNodeShaped } from './lib/clients.mjs';
import { launchChrome, sleep } from './lib/chrome.mjs';
import { PAGE_SETUP, pageClient } from './lib/page.mjs';
import { BENCH_DIR, loadServer, unloadServer } from './lib/paths.mjs';
import { freePort } from './lib/ports.mjs';
import { evaluate, writeReport } from './lib/report.mjs';
import { startBenchServer } from './lib/server.mjs';
import { createShaper, link3g } from './lib/shaper.mjs';
import { startVite } from './lib/vite.mjs';

// ---------------------------------------------------------------- options

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const opts = {
  game: arg('game', 'probe'),
  plugin: arg('plugin', null),
  maxWallS: Number(arg('max-wall', '600')),
  client: arg('client', 'chrome'),
  via: arg('via', 'shaper'),
  scenarios: arg('scenarios', null),
  collapseKbps: Number(arg('collapse-kbps', '120')),
  squeezeKbps: Number(arg('squeeze-kbps', '12')),
  scale: Number(arg('scale', '1')),
  settleS: Number(arg('settle', '5')),
  settleNextS: Number(arg('settle-next', arg('settle', '3'))),
  full: argv.includes('--full'),
  out: arg('out', join(tmpdir(), 'arcade-netbench', new Date().toISOString().replace(/[:.]/g, '-'))),
};

// The server's logger reads these when it is first imported: JSON lines on stdout, info and up.
process.env.LOG_LEVEL ??= 'info';
process.env.LOG_FORMAT ??= 'json';

const SCENARIO_CAP_MS = 60_000;

const SCENARIOS = {
  '3g': (s) => ({ id: '3g', label: '3G', measureS: 25 * s, phases: [{ at: 0, link: link3g() }], criteria: { framesMedian: 13, chatP95: 300 } }),
  '3g-loss': (s) => ({ id: '3g-loss', label: '3G + 1 % HOL loss', measureS: 25 * s, phases: [{ at: 0, link: link3g({ lossEvery: 100 }) }], criteria: { framesMedian: 10, chatP95: 450 } }),
  collapse: (s) => drop({ id: 'collapse', kbps: opts.collapseKbps, leadS: 5 * s, downS: 20 * s, backS: 10 * s }),
  squeeze: (s) => drop({ id: 'squeeze', kbps: opts.squeezeKbps, leadS: 5 * s, downS: 12 * s, backS: 8 * s }),
};

/** 3G, then `kbps` down for `downS`, then 3G again (the collapse-style checks in report.mjs). */
function drop({ id, kbps, leadS, downS, backS }) {
  return {
    id,
    label: '3G, ' + kbps + ' kbit/s down for ' + downS + ' s',
    measureS: leadS + downS + backS,
    collapse: { fromS: leadS, toS: leadS + downS, kbps },
    phases: [
      { at: 0, link: link3g() },
      { at: leadS, link: link3g({ downKbps: kbps }), tag: 'drop' },
      { at: leadS + downS, link: link3g(), tag: 'return' },
    ],
    criteria: { collapse: true, recoverFrames: 13, probeMaxMs: 2000 },
  };
}

// ---------------------------------------------------------------- run state

const wallStart = Date.now();
const log = (...parts) => console.log('[' + ((Date.now() - wallStart) / 1000).toFixed(1).padStart(6) + ' s]', ...parts);
const cleanups = [];
let cleaning = null;
const cleanup = () => {
  cleaning ??= (async () => {
    for (const fn of cleanups.reverse()) {
      try {
        await Promise.race([fn(), sleep(5000)]);
      } catch (error) {
        console.error('cleanup:', error?.message ?? error);
      }
    }
    await unloadServer().catch(() => undefined);
  })();
  return cleaning;
};
let wallExceeded = false;
const wallTimer = setTimeout(() => {
  wallExceeded = true;
  log('max wall time reached: stopping');
}, opts.maxWallS * 1000);
wallTimer.unref();
// The last resort: never outlive the wall cap by more than 30 s.
setTimeout(() => {
  console.error('netbench: hard exit after the wall cap');
  process.exit(3);
}, (opts.maxWallS + 30) * 1000).unref();
// Whatever goes wrong, Chrome and Vite are killed before the process ends.
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (error) => {
    console.error('netbench: ' + ev + ':', error?.stack ?? error);
    void cleanup().then(() => process.exit(4));
  });
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('signal ' + sig + ': cleaning up');
    void cleanup().then(() => process.exit(130));
  });
}

let run = null;
const adminStats = [];
// `game`: a plugin's own samples (window.__bench.game in the page), for its `ready(store)`.
const store = { frames: [], keyframes: [], chat: [], probes: [], lane: [], sock: [], yields: [], phases: [], errors: [], game: [] };
let client = null;
let draining = null;
const drainNow = async () => {
  if (!client) return;
  draining ??= (async () => {
    try {
      const d = await client.drain();
      for (const k of Object.keys(store)) if (Array.isArray(d[k])) store[k].push(...d[k]);
      store.ups = d.ups;
    } catch (error) {
      store.errors.push({ t: Date.now(), m: 'drain: ' + (error?.message ?? error) });
    } finally {
      draining = null;
    }
  })();
  return draining;
};

const waitUntil = async (fn, timeoutMs, label) => {
  const started = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - started > timeoutMs) throw new Error('timeout waiting for ' + label);
    await sleep(100);
  }
};

// ---------------------------------------------------------------- main

const main = async () => {
  mkdirSync(opts.out, { recursive: true });
  const plugin = await import(pathToFileURL(opts.plugin ? resolve(opts.plugin) : join(BENCH_DIR, 'games', opts.game + '.mjs')).href);
  const wanted = (opts.scenarios ? opts.scenarios.split(',') : plugin.scenarios).filter((id) => plugin.scenarios.includes(id) && SCENARIOS[id]);
  run = {
    game: opts.game,
    client: opts.client + (opts.client === 'node' ? ' via ' + opts.via : ''),
    linkLabel: '600/100 kbit/s, 300 ms RTT, 64 KB buffers',
    startedAt: wallStart,
    options: opts,
    ports: {},
    scenarios: [],
    notes: [],
    verdict: 'FAIL',
    setupS: null,
    wallS: null,
  };

  const usePage = opts.client === 'chrome';
  const useVite = usePage || opts.via === 'vite';
  const taken = new Set();
  const vitePort = useVite ? await freePort(taken) : null;
  const shaperPort = await freePort(taken);
  const corsOrigins = vitePort ? [`http://127.0.0.1:${vitePort}`, `http://localhost:${vitePort}`] : ['http://localhost'];

  // Vite and Chrome start at once, in parallel with the server (Vite proxies to the shaper's port,
  // which is chosen now and listened on below).
  log('starting server (game ' + opts.game + '), vite and chrome');
  let vite = null;
  const viteStarting = useVite
    ? startVite({ port: vitePort, proxy: 'http://127.0.0.1:' + shaperPort, logFile: join(opts.out, 'vite.log') }).then((v) => {
        vite = v;
        cleanups.push(() => v.kill());
        log('vite up (pid ' + v.pid + ')');
        return v;
      })
    : Promise.resolve(null);
  const chromeStarting = usePage
    ? launchChrome({ name: 'shaped' }).then((c) => {
        cleanups.push(() => c.kill());
        log('chrome up (pid ' + c.pid + ')');
        return c;
      })
    : Promise.resolve(null);
  // Awaited after the server is up; until then a rejection must not count as unhandled.
  viteStarting.catch(() => undefined);
  chromeStarting.catch(() => undefined);
  const serverOptions = plugin.serverOptions ? await plugin.serverOptions({ loadServer }) : {};
  const server = await startBenchServer({ corsOrigins, arcade: serverOptions });
  cleanups.push(() => server.close());
  const shaper = await createShaper({ target: { host: '127.0.0.1', port: server.port }, port: shaperPort, link: link3g() });
  cleanups.push(() => shaper.close());
  server.setShapedCheck((port) => shaper.localPorts.has(port));
  run.ports = { server: server.port, shaper: shaper.port, vite: vitePort };
  log('server :' + server.port + ', shaper :' + shaper.port + (vitePort ? ', vite :' + vitePort : ''));

  // The first account on a fresh server is its admin: an unshaped observer that reads the Arcade's
  // watchdog (degrade level, loop delay, egress) every 2 s.
  const observer = await server.account('Bench observer');
  const observerSocket = await connectMain(server.url, observer.token);
  cleanups.push(() => observerSocket.close());
  const adminTimer = setInterval(() => {
    observerSocket.request('admin:arcade:get', {}, 3000).then(
      (r) => {
        if (r?.ok) adminStats.push({ t: Date.now(), level: r.stats.level, loopP99Ms: r.stats.loopP99Ms, egressKbps: r.stats.egressKbps, lanes: r.stats.lanes, matches: r.stats.matches });
      },
      () => undefined,
    );
  }, 2000);
  cleanups.push(() => clearInterval(adminTimer));

  // Settle every start before anything fails, so a refused start still gets its cleanup registered.
  const [viteResult, chromeResult] = await Promise.allSettled([viteStarting, chromeStarting]);
  if (viteResult.status === 'rejected') throw viteResult.reason;
  if (chromeResult.status === 'rejected') throw chromeResult.reason;
  const chrome = chromeResult.value;

  const bots = await plugin.startBots(server, (plugin.humans ?? 4) - 1);
  cleanups.push(() => bots.stop());
  log('bots signed in, lobby ' + bots.lobby.id);

  const shapedAccount = await server.account('Bench phone');
  server.watch(shapedAccount.id);
  if (usePage) {
    const page = chrome.page;
    await page.goto(vite.url + '/robots.txt');
    await page.eval(`localStorage.setItem('datasetto.auth.v2', ${JSON.stringify(JSON.stringify({ token: shapedAccount.token, account: null }))}); true`);
    await page.goto(vite.url + '/');
    await waitUntil(() => server.signedIn(shapedAccount.id), 40000, 'the page to sign in');
    await page.eval(PAGE_SETUP);
    client = pageClient(page);
    // A plugin exporting `stage = true` keeps the app's own lobby handling (its stage opens).
    await client.init({ stage: plugin.stage === true });
    log('page signed in');
  } else {
    client = await createNodeShaped({ url: opts.via === 'vite' ? vite.url : 'http://127.0.0.1:' + shaper.port, token: shapedAccount.token });
    log('node shaped client signed in');
  }
  cleanups.push(() => client.stop());

  const entering = plugin.enter(client, bots.lobby);
  // Awaited below; until then a rejection must not count as unhandled.
  entering.catch(() => undefined);
  await bots.start({ humans: plugin.humans ?? 4 });
  await entering;
  server.startChat(shapedAccount.id);
  const pump = setInterval(() => void drainNow(), 500);
  cleanups.push(() => clearInterval(pump));
  // A game without lane frames (a table game) says when it is ready with `ready(store)`.
  await waitUntil(
    async () => {
      await drainNow();
      return plugin.ready ? plugin.ready(store) === true : store.frames.length > 0;
    },
    15000,
    plugin.ready ? 'the game to be ready' : 'the first frames at the shaped client',
  );
  run.setupS = Math.round((Date.now() - wallStart) / 100) / 10;
  log((plugin.ready ? 'game ready' : 'match running') + '; setup took ' + run.setupS + ' s');

  for (const [i, id] of wanted.entries()) {
    if (wallExceeded) {
      run.notes.push('scenario ' + id + ' skipped: max wall time');
      continue;
    }
    const def = SCENARIOS[id](opts.scale);
    // A plugin's `criteria[id]` replaces the scenario's criteria (e.g. no frames check for a table game).
    if (plugin.criteria?.[id]) def.criteria = plugin.criteria[id];
    run.scenarios.push(await runScenario(def, { shaper, server, settleS: i === 0 ? opts.settleS : opts.settleNextS }));
  }

  await drainNow();
  run.bots = bots.stats();
  run.navigations = chrome ? chrome.page.navigations : [];
  if (chrome && chrome.page.navigations.length > 2) run.notes.push('the page navigated ' + chrome.page.navigations.length + ' times (a reload during the run invalidates it)');
  run.console = chrome ? chrome.page.console.filter((c) => c.type === 'error' || c.type === 'exception' || c.type === 'warning').slice(-60) : [];
  run.pageErrors = store.errors.slice(-40);
  run.shaperCounters = shaper.counters;
  run.watchdog = adminStats.slice();
  run.serverLanes = server.lanes();
  run.serverDisconnects = server.disconnects();
  run.verdict = run.scenarios.length === wanted.length && run.scenarios.every((s) => s.verdict === 'PASS') ? 'PASS' : 'FAIL';
  return run;
};

const runScenario = async (def, { shaper, server, settleS }) => {
  const settleMs = settleS * 1000;
  const settleAt = Date.now();
  shaper.setLink(def.phases[0].link);
  log('scenario ' + def.id + ' (' + def.label + '): settle ' + settleS + ' s, measure ' + def.measureS + ' s');
  while (Date.now() < settleAt + settleMs && !wallExceeded) await sleep(100);
  const mStart = Date.now();
  const mEnd = mStart + def.measureS * 1000;
  const timers = def.phases
    .filter((p) => p.at > 0)
    .map((p) =>
      setTimeout(() => {
        shaper.setLink(p.link);
        log('  link: ' + (p.tag ?? '') + ' down ' + p.link.down.kbps + ' kbit/s');
      }, p.at * 1000),
    );
  let aborted = null;
  let lastFrames = 0;
  const ev = (now, final) =>
    evaluate({
      def,
      store,
      shaperSeconds: shaper.seconds(settleAt - 1000, now + 1000),
      serverSeconds: server.seconds(settleAt - 1000, now + 1000),
      serverDisconnects: server.disconnects(),
      serverLanes: server.lanes(),
      laneLog: shaper.laneLog(settleAt - 1000, now + 1000),
      adminStats,
      settleAt,
      mStart,
      mEnd,
      now,
      final,
    });
  for (;;) {
    await sleep(1000);
    await drainNow();
    const now = Date.now();
    const recent = store.frames.filter(([t]) => t >= now - 1000).length;
    const chat = store.chat.filter(([t]) => t >= now - 1500).map((c) => c[1]);
    const probes = store.probes.filter(([t]) => t >= now - 3000).map((p) => Math.round(p[1]));
    const div = store.frames.length ? store.frames[store.frames.length - 1][1] : '-';
    const q = shaper.queued();
    const sent = shaper.laneLog(now - 1000, now).down.filter((x) => x[1] === 0x81);
    const sentDiv = sent.length ? sent[sent.length - 1][2] : '-';
    lastFrames = store.frames.length;
    log(`  ${def.id} +${((now - mStart) / 1000).toFixed(0)} s: frames ${recent}/s d=${div} (sent ${sent.length}/s d=${sentDiv}), chat ${chat.join(',') || '-'} ms, probe ${probes.join(',') || '-'} ms, queue dn ${q.down} B (lane ${q.downByClass.lane}, sio ${q.downByClass.sio}) up ${q.up} B`);
    const e = ev(now, false);
    if (e.certainFail && !opts.full) {
      aborted = 'failed: ' + e.checks.filter((c) => c.certainFail).map((c) => c.id).join(', ');
      break;
    }
    if (now >= mEnd) break;
    if (now - settleAt > SCENARIO_CAP_MS) {
      aborted = 'scenario cap 60 s';
      break;
    }
    if (wallExceeded) {
      aborted = 'max wall time';
      break;
    }
  }
  for (const t of timers) clearTimeout(t);
  await sleep(300);
  await drainNow();
  const result = ev(Math.min(Date.now(), mEnd), true);
  log('scenario ' + def.id + ': ' + result.verdict + (aborted ? ' (' + aborted + ')' : '') + ' frames ' + lastFrames);
  return { id: def.id, label: def.label, measureS: def.measureS, ...result, aborted, startedAt: settleAt, measuredFrom: mStart };
};

let exitCode = 1;
try {
  await main();
  exitCode = run.verdict === 'PASS' ? 0 : 1;
} catch (error) {
  console.error('netbench failed:', error?.stack ?? error);
  run ??= { game: opts.game, client: opts.client, linkLabel: '-', startedAt: wallStart, scenarios: [], notes: [], setupS: null };
  run.notes.push('setup or run error: ' + (error?.message ?? error));
  run.verdict = 'ERROR';
  exitCode = 2;
}
await cleanup();
run.wallS = Math.round((Date.now() - wallStart) / 100) / 10;
try {
  mkdirSync(opts.out, { recursive: true });
  const text = writeReport(opts.out, run);
  console.log('\n' + text);
  console.log('\nresults: ' + opts.out);
} catch (error) {
  console.error('report failed:', error);
  writeFileSync(join(opts.out, 'report-error.txt'), String(error?.stack ?? error));
}
process.exit(exitCode);
