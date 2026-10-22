/**
 * Bench plugin for Bellwick's Party Tale (bellwick.md §13 test 14): three Node bot heroes and the shaped
 * client in the boss room.
 *
 * - The host bot's account gets a tale in slot 0 that stands at the Belfry's antechamber lantern with
 *   the boss door open (the dungeon walkthrough bot's save there), and the lobby continues it.
 * - Each bot is a real hero: the core's client mirror fed from its lane, the walkthrough bot's buttons
 *   ("boss" fights Old Clapper), UPs and EVTs as the device sends them, ACKs per §5.2, a PING every 2 s.
 * - `enter(page, lobby)`: the shaped client joins the lobby once the bots are in the Belfry and plays
 *   through the app's own remote host (its 1 B inputs are not hero states, so its hero stands beside
 *   the first bot, where it lands, and only receives the room's traffic: what the bench measures).
 */
import { connectMain } from '../lib/clients.mjs';
import { loadServer, serverRequire } from '../lib/paths.mjs';

const WebSocket = serverRequire('ws');

export const scenarios = ['3g', '3g-loss'];
export const game = 'bellwick';
export const humans = 4;

const TICK_MS = 1000 / 30;

let core = null;
const loadCore = async () => {
  if (core) return core;
  const [lane, version, bytes, client, bot, helpers, saves] = await Promise.all([
    loadServer('src/arcade/core/net/lane.ts'),
    loadServer('src/arcade/core/version.ts'),
    loadServer('src/arcade/core/bytes.ts'),
    loadServer('src/arcade/core/bellwick/client.ts'),
    loadServer('src/arcade/core/bellwick/bots/hero.ts'),
    loadServer('test/arcade/bellwick/helpers.ts'),
    loadServer('src/arcade/saves.ts'),
  ]);
  core = { lane, version, bytes, client, bot, helpers, saves };
  return core;
};

/** The dungeon bot's tale at the antechamber, before the Buckler step and the fight. */
const bossTale = (c) => {
  const script = c.helpers.dungeonScript();
  const r = c.helpers.botRun(77, { save: c.helpers.dungeonSave(77), script });
  const at = script.indexOf('item buckler');
  for (let t = 0; t < 30000 && r.bot.step < at; t += 1) r.play(1);
  if (r.bot.step !== at) throw new Error('bellwick bench: the walkthrough bot did not reach the antechamber');
  return r.run.core.save();
};

const waitFor = async (fn, timeoutMs, label) => {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error('timeout waiting for ' + label);
    await new Promise((r) => setTimeout(r, 50));
  }
};

/** One bot hero on its own lane: mirror, walkthrough bot, 30 Hz steps on its estimate of the server clock. */
const openHero = async (c, { url, ticket, script }) => {
  const L = c.lane;
  const ws = new WebSocket(url.replace(/^http/, 'ws') + '/arcade/ws');
  ws.binaryType = 'nodebuffer';
  const stats = { welcome: 0, frames: 0, keyframes: 0, ups: 0, evts: 0, acks: 0, pings: 0, closed: null, room: -1, hp: 0, step: 0 };
  let mirror = c.client.createClientWorld(0);
  const hero = c.bot.createHeroBot(script);
  let anchor = null;
  let ackFrame = 0;
  let frameAt = 0;
  let upSeq = 0;
  let evSeq = 0;
  let lastUpAt = -Infinity;
  const send = (bytes) => ws.readyState === WebSocket.OPEN && ws.send(bytes);
  const out = {
    up: (p) => {
      upSeq = (upSeq + 1) & 0xffff;
      send(L.writeUp(upSeq, ackFrame, Math.round(performance.now() - frameAt), p));
      lastUpAt = performance.now();
      stats.ups += 1;
    },
    evt: (p) => {
      evSeq = (evSeq % 0xffff) + 1;
      send(L.writeEvt(evSeq, p));
      stats.evts += 1;
    },
  };
  const w = new c.bytes.ByteWriter(8);
  const codec = await loadServer('src/arcade/core/bellwick/codec.ts');
  const actions = {
    buy: (i) => out.evt(codec.writeBuy(w.reset(), i).copy()),
    brew: () => out.evt(codec.writeUseBrew(w.reset()).copy()),
    respawn: () => out.evt(codec.writeRespawn(w.reset()).copy()),
  };
  const block = { count: 0, r: null, tick: 0 };
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const m = L.readServer(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
    if (!m) return;
    if (m.t === 'welcome') {
      stats.welcome += 1;
      anchor = { tick: m.tick, at: performance.now() };
      mirror = c.client.createClientWorld(m.slot);
      c.client.onWelcome(mirror, m.cfg);
    } else if (m.t === 'keyframe') {
      stats.keyframes += 1;
      ackFrame = m.frameSeq;
      frameAt = performance.now();
      const tick = anchor ? L.extendTick(m.tick, anchor.tick) : m.tick;
      c.client.onKeyframe(mirror, new c.bytes.ByteReader(m.body), tick);
    } else if (m.t === 'frame') {
      stats.frames += 1;
      ackFrame = m.frameSeq;
      frameAt = performance.now();
      const tick = anchor ? L.extendTick(m.tick, anchor.tick) : m.tick;
      // The newest frame anchors the clock (the bots' link is local, so its delay is about 0).
      if (anchor && tick > anchor.tick) anchor = { tick, at: performance.now() };
      let events = null;
      if (m.events) {
        block.count = m.events.count;
        block.r = new c.bytes.ByteReader(m.events.bytes);
        block.tick = tick;
        events = block;
      }
      c.client.onFrame(mirror, tick, m.snapshot ? new c.bytes.ByteReader(m.snapshot) : null, events);
    }
  });
  ws.on('close', (code) => {
    stats.closed = code;
    clearInterval(stepTimer);
    clearInterval(ackTimer);
    clearInterval(pingTimer);
  });
  ws.on('error', () => undefined);
  let heroClock = -1;
  const stepTimer = setInterval(() => {
    if (!anchor || !mirror.hasRoom || hero.done) return;
    const target = Math.floor(anchor.tick + (performance.now() - anchor.at) / TICK_MS) + 1;
    if (heroClock < 0 || target - heroClock > 30) heroClock = target - 1;
    for (let i = 0; i < 4 && heroClock < target; i += 1) {
      heroClock += 1;
      c.client.stepOwn(mirror, hero.tick(mirror, actions), heroClock, mirror.snapTick, out, 2);
    }
    stats.room = mirror.room;
    stats.hp = mirror.me.hp;
    stats.step = hero.step;
  }, TICK_MS);
  const ackTimer = setInterval(() => {
    if (frameAt === 0 || performance.now() - lastUpAt < 250) return;
    send(L.writeAck(ackFrame, Math.round(performance.now() - frameAt)));
    stats.acks += 1;
  }, 250);
  const pingTimer = setInterval(() => {
    send(L.writePing(Math.floor(performance.now()) >>> 0));
    stats.pings += 1;
  }, 2000);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lane did not open')), 8000);
    ws.once('open', () => {
      clearTimeout(timer);
      ws.send(JSON.stringify({ t: 'hello', proto: c.version.PROTO, codec: { bellwick: c.version.CODEC.bellwick }, ticket }));
      resolve();
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      reject(new Error('lane upgrade refused: ' + res.statusCode));
    });
  });
  return {
    stats,
    get mirror() {
      return mirror;
    },
    close() {
      clearInterval(stepTimer);
      clearInterval(ackTimer);
      clearInterval(pingTimer);
      try {
        ws.close(1000);
      } catch {
        ws.terminate();
      }
    },
  };
};

export async function startBots(server, n) {
  const c = await loadCore();
  const bots = [];
  for (let i = 0; i < n; i += 1) {
    const account = await server.account('Bench hero ' + (i + 1));
    const main = await connectMain(server.url, account.token);
    await main.joinVoice(server.voiceChannel);
    bots.push({ account, main, hero: null });
  }
  const host = bots[0];
  // The host's slot 0: the tale at the antechamber.
  const save = bossTale(c);
  const saves = c.saves.createSaves(server.ctx.db, { now: () => Date.now() }, () => false);
  saves.put(host.account.id, 'bellwick', 0, 1, c.bytes.utf8Encode(JSON.stringify(save)), [host.account.id]);
  let latest = null;
  host.main.raw.on('arcade:lobby', (view) => {
    if (!latest || view.v >= latest.v) latest = view;
  });
  const created = await host.main.request('arcade:lobby:create', { ch: server.voiceChannel, game, mode: 'party', cfg: { slot: 0 } });
  if (!created?.ok) throw new Error('lobby create refused: ' + created?.code);
  const id = created.lobby.id;
  for (const bot of bots.slice(1)) {
    const joined = await bot.main.request('arcade:lobby:join', { id, as: 'player' });
    if (!joined?.ok) throw new Error('bot lobby join refused: ' + joined?.code);
  }
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const lobby = { id, ch: server.voiceChannel, game, started };
  // Spread out first: a bot is deterministic, so bots from one spot would move as one.
  const firsts = ['go ante 3,3', 'go ante 8,3', 'go ante 3,6', 'go ante 8,6'];
  return {
    lobby,
    async start() {
      const r = await host.main.request('arcade:lobby:start', { id });
      if (!r?.ok) throw new Error('start refused: ' + r?.code);
      await Promise.all(
        bots.map(async (bot, i) => {
          const t = await bot.main.request('arcade:ticket', { id });
          if (!t?.ok) throw new Error('bot ticket refused: ' + t?.code);
          bot.hero = await openHero(c, { url: server.url, ticket: t.ticket, script: [firsts[i % 4], 'go ante 5,1', 'item buckler', 'boss'] });
        }),
      );
      // The shaped client drops in once the first bot fights in the Belfry, so it lands beside it.
      await waitFor(() => bots[0].hero && bots[0].hero.stats.room === 44, 60000, 'the first bot in the Belfry');
      resolveStarted();
    },
    stats: () => bots.map((b) => ({ name: b.account.name, ...(b.hero ? b.hero.stats : {}) })),
    async stop() {
      for (const bot of bots) {
        try {
          bot.hero?.close();
        } catch {
          /* closed */
        }
        bot.main.close();
      }
    },
  };
}

/** The shaped client joins the running Party Tale (drop-in) and plays through the app's remote host. */
export async function enter(page, lobby) {
  await lobby.started;
  await page.join(lobby.ch, lobby.id);
  await page.play(lobby.id, { game, upEveryMs: 66, moveMs: 4000, cycleMs: 5000, probeEveryMs: 2100 });
}
