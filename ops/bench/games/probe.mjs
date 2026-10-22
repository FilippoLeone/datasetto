/**
 * Bench plugin for the probe game (plan.md §2.6.5): the scriptable test game from
 * server/test/arcade/harness/probeGame.ts, registered in Fuseyard's place and shaped like it on the
 * wire (a 22 B snapshot for 4 fighters, a 2 B event per input, 15 frames/s per player).
 *
 * - `serverOptions` gives the bench's server its game registry.
 * - `startBots(server, n)`: n Node bots sign in, join the seeded voice channel, the first creates the
 *   lobby and the others join. `start()` waits until every human is seated, starts the match, and
 *   each bot opens its lane and plays: an UP every 2 ticks with one input byte, ACKs per §5.2, a PING
 *   every 2 s.
 * - `enter(page, lobby)`: the shaped client joins voice and the lobby, waits for the start, takes its
 *   ticket and plays through the app's own remote host.
 */
import { connectMain, openLane } from '../lib/clients.mjs';

export const scenarios = ['3g', '3g-loss', 'collapse'];
export const game = 'fuseyard';
export const humans = 4;

export async function serverOptions({ loadServer }) {
  const { probeGame, probeControl } = await loadServer('test/arcade/harness/probeGame.ts');
  // Fuseyard's snapshot with 4 fighters and no slides is 22 B (platform §5.3).
  probeControl.snapshotBytes = 22;
  return { matchGames: [probeGame(), null] };
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

export async function startBots(server, n) {
  const bots = [];
  for (let i = 0; i < n; i += 1) {
    const account = await server.account('Bench bot ' + (i + 1));
    const main = await connectMain(server.url, account.token);
    await main.joinVoice(server.voiceChannel);
    bots.push({ account, main, lane: null });
  }
  const host = bots[0];
  let latest = null;
  host.main.raw.on('arcade:lobby', (view) => {
    if (!latest || view.v >= latest.v) latest = view;
  });
  const created = await host.main.request('arcade:lobby:create', { ch: server.voiceChannel, game, mode: 'brawl', cfg: { fighters: 4 } });
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
          bot.lane = await openLane({ url: server.url, ticket: t.ticket, game });
        }),
      );
    },
    stats: () => bots.map((b) => ({ name: b.account.name, ...(b.lane ? b.lane.stats : {}) })),
    async stop() {
      for (const bot of bots) {
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
