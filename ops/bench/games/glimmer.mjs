/**
 * Bench plugin for Glimmerhall (plan.md §4.3 "Performance and real smoke", glimmerhall.md §18.2): the
 * shaped headless Chrome runs the real client and auto-spins in a hall where 3 Node bots spin at about
 * 2 a second (the server's spin limit) and react to it every 3 s, on the non-voice share of 3G.
 *
 *   node ops/bench/arcade-netbench.mjs --game glimmer
 *
 * Checks (3G, 25 s): chat one-way p50 and p95 < 300 ms, Glimmerhall down ≤ 4 kbit/s (its own Socket.IO
 * events plus acks, as the shaper counts them; the acks include the platform's 2.1 s probe, a few bytes
 * each), and the netbench's own: no disconnect or ping timeout.
 *
 * A table game sends no lane frames, so this plugin uses the netbench's table-game exports: `ready`
 * (the first spin answer at the phone), `criteria` and `stage` (the app opens its own stage). The
 * phone's samples go to `window.__bench.game`; `stats()` summarizes them for the report.
 */
import { connectMain } from '../lib/clients.mjs';
import { sleep } from '../lib/chrome.mjs';
import { loadServer } from '../lib/paths.mjs';
import { quantile } from '../lib/report.mjs';

export const scenarios = ['3g'];
export const game = 'glimmer';
export const humans = 4;
export const stage = true;
/** Socket.IO kinds that are Glimmerhall's on the shaped socket: its events and the request acks. */
export const GLIMMER_KINDS = ['glimmer:', 'ack'];
export const criteria = { '3g': { chatP50: 300, chatP95: 300, sioDownKbps: { kinds: GLIMMER_KINDS, max: 4 } } };

/** The netbench's sample store, kept from `ready` so `stats()` can summarize the phone's samples. */
let benchStore = null;
/** Ready once the phone has had a spin answered (auto-spin is running). */
export const ready = (store) => {
  benchStore = store;
  return store.game.some((s) => s[0] === 'ack' && s[2] === 'glimmer:spin' && s[4] === 1);
};

/** The bots' spin cadence: the server allows 2 spins a second per account (real time). */
const BOT_SPIN_MS = 520;
const BOT_REACT_MS = 3000;
/** Framing per message as the platform budgets a table-lane push (core/net/budget.ts). */
let framing = 92;

let wire = null;
const loadWire = async () => {
  if (!wire) {
    const w = await loadServer('src/arcade/core/glimmer/wire.ts');
    const v = await loadServer('src/arcade/core/version.ts');
    framing = (await loadServer('src/arcade/core/net/budget.ts')).OVERHEAD.tableDown;
    wire = { STOP_ALPHABET: w.STOP_ALPHABET, ID_CHARS: w.ID_CHARS, V: v.DEFS.glimmer };
  }
  return wire;
};

const spinId = (w) => {
  let id = '';
  for (let i = 0; i < w.ID_CHARS; i += 1) id += w.STOP_ALPHABET.charAt(Math.floor(Math.random() * w.STOP_ALPHABET.length));
  return id;
};

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** The phone's samples: spin answers and the Glimmerhall messages it received. */
const phoneStats = () => {
  const samples = benchStore?.game ?? [];
  const acks = samples.filter((s) => s[0] === 'ack' && s[2] === 'glimmer:spin').map((s) => s[3]);
  const down = samples.filter((s) => s[0] === 'down' && GLIMMER_KINDS.some((p) => s[2].startsWith(p)));
  const spanS = down.length > 1 ? (down[down.length - 1][1] - down[0][1]) / 1000 : 0;
  const byKind = {};
  for (const [, , kind, bytes] of down) {
    byKind[kind] ??= { n: 0, bytes: 0 };
    byKind[kind].n += 1;
    byKind[kind].bytes += bytes;
  }
  return {
    spins: acks.length,
    spinAckMs: { p50: Math.round(quantile(acks, 0.5) ?? 0), p95: Math.round(quantile(acks, 0.95) ?? 0), max: acks.length ? Math.max(...acks) : null },
    messages: byKind,
    // What those messages cost with framing, over the whole run (settle included).
    wireKbps: spanS > 0 ? Math.round(((sum(down.map((s) => s[3])) + down.length * framing) * 8) / 10 / spanS) / 100 : null,
    autoStarts: samples.filter((s) => s[0] === 'auto').length,
  };
};

export async function startBots(server, n) {
  const w = await loadWire();
  const bots = [];
  for (let i = 0; i < n; i += 1) {
    const account = await server.account('Bench bot ' + (i + 1));
    const main = await connectMain(server.url, account.token);
    await main.joinVoice(server.voiceChannel);
    bots.push({ account, main, timers: [], stats: { spins: 0, refused: {}, picks: 0, reacts: 0, feeds: 0, ackMs: [] } });
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
            void bot.main.request('glimmer:react', { to: lobby.phoneSlot, e: bot.stats.reacts % 6 }, 8000).then(() => (bot.stats.reacts += 1), () => undefined);
          }, BOT_REACT_MS + b * 97),
        );
      });
    },
    stats: () => ({
      phone: phoneStats(),
      bots: bots.map((b) => ({ name: b.account.name, spins: b.stats.spins, picks: b.stats.picks, reacts: b.stats.reacts, feeds: b.stats.feeds, refused: b.stats.refused, ackP95Ms: Math.round(quantile(b.stats.ackMs, 0.95) ?? 0) })),
    }),
    async stop() {
      stopped = true;
      for (const bot of bots) {
        for (const t of bot.timers) clearInterval(t);
        bot.main.close();
      }
    },
  };
}

/** The page side: record Glimmerhall's requests and messages, join the hall as a person does, keep auto-spin on. */
const PAGE_GLIMMER = String.raw`(() => {
  const B = window.__bench;
  if (B.gh) return 'already';
  const G = (B.gh = {});
  const raw = B.sc.socket;
  // Spin answers: ['ack', t, event, ms, ok].
  const request = B.sc.request.bind(B.sc);
  B.sc.request = (ev, data, timeoutMs) => {
    const t0 = performance.now();
    const p = request(ev, data, timeoutMs);
    if (String(ev).startsWith('glimmer:')) {
      p.then(
        (r) => B.game.push(['ack', Date.now(), ev, Math.round(performance.now() - t0), r && r.ok ? 1 : 0]),
        () => B.game.push(['ack', Date.now(), ev, Math.round(performance.now() - t0), -1]),
      );
    }
    return p;
  };
  // Every Socket.IO message the main socket receives: ['down', t, kind, bytes on the WebSocket]. Engine.io
  // has already taken its '4' (message) off: events start with '2', acks with '3'.
  raw.io.engine.on('packet', (packet) => {
    if (packet.type !== 'message' || typeof packet.data !== 'string') return;
    const d = packet.data;
    const kind = d.startsWith('2') ? ((/^2\d*\["([^"]{1,40})"/.exec(d) || [])[1] || 'other') : d.startsWith('3') ? 'ack' : 'other';
    B.game.push(['down', Date.now(), kind, d.length + 1]);
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
  // The hall's buttons take a pointer press released over them, or a click without a pointer
  // (keyboard activation); a synthetic pointer event has no position, so click.
  G.keep = () => {
    const auto = document.querySelector('.gh-auto');
    const spin = document.querySelector('.gh-spin');
    if (!auto || !spin) return 'no hall';
    const ok = [...document.querySelectorAll('.gh-sheet .gh-go')].find((b) => b.textContent === 'Got it');
    if (ok) ok.click();
    const doors = document.querySelector('.gh-hits');
    if (doors && !doors.hidden) {
      const door = doors.querySelector('button');
      if (door) door.click();
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
      B.game.push(['auto', Date.now()]);
      return 'started';
    }
    for (const x of document.querySelectorAll('.gh-sheet .gh-x')) x.click();
    auto.click();
    return 'opening';
  };
  // Keep auto-spin running: it stops on any feature, a win of 50 × and its own spin count.
  G.keeper = setInterval(() => {
    try {
      G.keep();
    } catch (e) {
      B.errors.push({ t: Date.now(), m: 'glimmer keeper: ' + String(e && e.message) });
    }
  }, 500);
  return 'ok';
})()`;

/** Drive the shaped Chrome into the hall: join voice, join the hall as the app does (its stage opens), auto-spin. */
export async function enter(client, lobby) {
  const page = client.page;
  if (!page) throw new Error('Glimmerhall needs the Chrome page client (the real app): run without --client node');
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
  await client.startProbes(2100);
}
