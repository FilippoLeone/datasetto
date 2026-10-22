/**
 * Bench plugin for Fuseyard (fuseyard.md §12 "Shaped bench", platform §15.2): the real game
 * definition from the server's registry, a 4-fighter Brawl on Brickyard with 5 wins needed (so the
 * match outlasts the three scenarios).
 *
 * Seats: the shaped client, one Node player (the lobby host) and two of the server's own Fuseyard
 * bots (the lobby's bot fill). Fuseyard skips a FRAME when nothing changed, so the bench needs a board
 * that keeps moving: the server bots hunt, bomb, pick up and fight like real players, which also gives
 * a real event mix. Scripted Node players would stand against walls or blow themselves up.
 *
 * - `serverOptions`: none; the bench server keeps its own registry, which has Fuseyard.
 * - `startBots(server, n)`: n Node players sign in and join the seeded voice channel; the first
 *   creates the lobby. `start()` waits until every human is seated, starts the match, and each opens
 *   its lane and plays: an UP every 2 ticks carrying 2 real Fuseyard inputs (a wandering direction,
 *   no bombs), ACKs per §5.2, a PING every 2 s. Real inputs matter: Fuseyard ends a match after 120 s
 *   of play without any.
 * - `enter(page, lobby)`: the shaped client joins voice and the lobby, waits for the start, takes its
 *   ticket and plays through the app's own remote host (its fighter stands at its spawn).
 */
import { connectMain, openLane } from '../lib/clients.mjs';

export const scenarios = ['3g', '3g-loss', 'collapse'];
export const game = 'fuseyard';
/** The shaped client and one Node player; the other two seats are the server's bots. */
export const humans = 2;

export async function serverOptions() {
  return {};
}

const waitFor = async (fn, timeoutMs, label) => {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error('timeout waiting for ' + label);
    await new Promise((r) => setTimeout(r, 50));
  }
};

/**
 * A wandering player's UP payload: `u8 n = 2` and two inputs (rules.ts: direction in bits 0–2, 1 N,
 * 2 E, 3 S, 4 W). The same array is sent on every UP, so changing its bytes steers the player: a new
 * direction every 0.6–1.5 s.
 */
const wanderer = (seed) => {
  const payload = Uint8Array.of(2, 2, 2);
  let s = seed >>> 0 || 1;
  const rnd = (n) => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s % n;
  };
  let nextTurn = 0;
  const timer = setInterval(() => {
    const t = Date.now();
    if (t < nextTurn) return;
    const dir = 1 + rnd(4);
    payload[1] = dir;
    payload[2] = dir;
    nextTurn = t + 600 + rnd(900);
  }, 66);
  return { payload, stop: () => clearInterval(timer) };
};

export async function startBots(server, n) {
  const bots = [];
  for (let i = 0; i < n; i += 1) {
    const account = await server.account('Bench bot ' + (i + 1));
    const main = await connectMain(server.url, account.token);
    await main.joinVoice(server.voiceChannel);
    bots.push({ account, main, lane: null, walk: wanderer(0x9e3779b9 ^ (i + 1) * 2654435761) });
  }
  const host = bots[0];
  let latest = null;
  host.main.raw.on('arcade:lobby', (view) => {
    if (!latest || view.v >= latest.v) latest = view;
  });
  const created = await host.main.request('arcade:lobby:create', {
    ch: server.voiceChannel,
    game,
    mode: 'brawl',
    cfg: { arena: 'yard', fighters: 4, wins: 5, bots: 'scrapper' },
  });
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
  return {
    lobby,
    async start({ humans: wanted = humans } = {}) {
      await waitFor(() => latest && latest.seats.filter((s) => s.a && !s.bot).length >= wanted, 20000, wanted + ' seated players');
      const r = await host.main.request('arcade:lobby:start', { id });
      if (!r?.ok) throw new Error('start refused: ' + r?.code);
      resolveStarted();
      await Promise.all(
        bots.map(async (bot) => {
          const t = await bot.main.request('arcade:ticket', { id });
          if (!t?.ok) throw new Error('bot ticket refused: ' + t?.code);
          bot.lane = await openLane({ url: server.url, ticket: t.ticket, game, payload: bot.walk.payload, upEveryMs: 66 });
        }),
      );
    },
    stats: () => bots.map((b) => ({ name: b.account.name, ...(b.lane ? b.lane.stats : {}) })),
    async stop() {
      for (const bot of bots) {
        bot.walk.stop();
        try {
          bot.lane?.close();
        } catch {
          /* closed */
        }
        bot.main.close();
      }
    },
  };
}

/** Drive the shaped client (the Chrome page client, or the Node stand-in) into the match. */
export async function enter(page, lobby) {
  await page.join(lobby.ch, lobby.id);
  await lobby.started;
  await page.play(lobby.id, { game, upEveryMs: 66, moveMs: 4000, cycleMs: 5000, probeEveryMs: 2100 });
}
