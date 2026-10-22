/**
 * Lamplight on the real server (lamplight.md §18.2): the hub creates the table, two players sit
 * down through the table lane and a third person watches, each running the client's mirror on the
 * events it receives. Every message is scanned: nobody receives another seat's hole cards unless
 * they were shown, the spectator never receives a hole event, and a proof checks against the
 * commitment received live and reveals only what the caller saw.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { legal, type TableState } from '../../../src/arcade/core/lamplight/engine.js';
import { verify, type Proof } from '../../../src/arcade/core/lamplight/proof.js';
import { applyEvent, fromSnap, type WireSnap } from '../../../src/arcade/core/lamplight/views.js';
import { checkInvariant } from '../../../src/arcade/wallet.js';
import { startArcadeServer, type ArcadeTestServer, type TestSocket } from '../harness/server.js';

const sha = async (d: Uint8Array) => new Uint8Array(createHash('sha256').update(d).digest());

interface Ev {
  ev: string;
  data: Record<string, unknown>;
}

/** A client: every event in order, and the shared mirror over them. */
const client = (sock: TestSocket, me: string | null) => {
  const log: Ev[] = [];
  sock.raw.onAny((ev: string, data: unknown) => log.push({ ev, data: (data ?? {}) as Record<string, unknown> }));
  let view: TableState | null = null;
  let seat: number | null = null;
  let cursor = 0;
  let applied = 0;
  return {
    sock,
    log,
    get view() {
      return view;
    },
    get seat() {
      return seat;
    },
    get applied() {
      return applied;
    },
    drain() {
      for (; cursor < log.length; cursor++) {
        const { ev, data } = log[cursor];
        if (!ev.startsWith('lamplight:')) continue;
        if (ev === 'lamplight:snap') {
          view = fromSnap(data as unknown as WireSnap, 0);
          seat = typeof data.me === 'number' ? data.me : null;
          continue;
        }
        if (!view || ev === 'lamplight:emote') continue;
        if (typeof data.q === 'number' && data.q <= view.q) continue;
        const ok = applyEvent(view, ev, data, 0, seat);
        expect(ok, ev + ' did not fit the mirror (' + JSON.stringify(data) + ')').toBe(true);
        if (seat === null && me) seat = view.seats.find((s) => s.player?.accountId === me)?.seat ?? null;
        applied++;
      }
    },
  };
};

/** Cards anywhere under `c`, `hole` or `board` keys of a payload. */
const cardsIn = (v: unknown, out: number[] = [], key = ''): number[] => {
  if (Array.isArray(v)) {
    if ((key === 'c' || key === 'hole' || key === 'board') && v.every((x) => typeof x === 'number')) out.push(...(v as number[]));
    else for (const x of v) cardsIn(x, out, key);
  } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) cardsIn(x, out, k);
  return out;
};

let server: ArcadeTestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('Lamplight online', () => {
  it('plays hands through the hub and the table lane without leaking a card', async () => {
    server = await startArcadeServer();
    const s = server;
    const [alice, bob, cleo] = await Promise.all([s.account('Alice'), s.account('Bob'), s.account('Cleo')]);
    const [a, b, c] = await Promise.all([alice.socket(), bob.socket(), cleo.socket()]);
    const ca = client(a, alice.id);
    const cb = client(b, bob.id);
    const cc = client(c, null);
    await alice.joinVoice(s.voiceChannel, a);
    await bob.joinVoice(s.voiceChannel, b);
    await cleo.joinVoice(s.voiceChannel, c);
    // The game runs on the fake clock, many hands per real second; the 4/s act limiter (real time,
    // tested by the platform) would refuse that pace, so it is opened up for these sockets.
    for (const socket of s.sockets.io.sockets.sockets.values()) {
      const limiters = (socket.data as { ctx?: { limiters: Record<string, { hit(key: string): unknown }> } }).ctx?.limiters;
      if (limiters) limiters.arcadeAct.hit = () => ({ allowed: true, remaining: 1, resetAt: 0 });
    }

    // Alice opens a Pebble table with bots; a cash table is live at once.
    const created = await a.request<{ ok: boolean; lobby: { id: string }; code?: string }>('arcade:lobby:create', {
      ch: s.voiceChannel,
      game: 'lamplight',
      mode: 'open',
      cfg: { tier: 'pebble', players: 4, onlineBots: true, bots: 'greenhorn' },
    });
    expect(created.ok, created.code).toBe(true);
    const t = created.lobby.id;
    await s.clock.run(50, 10);

    // Bob joins the lobby, Cleo watches, everyone syncs, and the two players sit down.
    expect(await b.request<{ ok: boolean }>('arcade:lobby:join', { id: t, as: 'player' })).toMatchObject({ ok: true });
    expect(await c.request<{ ok: boolean }>('arcade:lobby:join', { id: t, as: 'spectator' })).toMatchObject({ ok: true });
    for (const sock of [a, b, c]) expect(await sock.request('lamplight:sync', { t, since: -1 })).toMatchObject({ ok: true, mode: 'snap' });
    expect(await a.request('lamplight:sit', { t, buyIn: 1000, post: 'wait', id: 'a1' })).toEqual({ ok: true });
    expect(await b.request('lamplight:sit', { t, buyIn: 1000, post: 'wait', id: 'b1' })).toEqual({ ok: true });
    await s.clock.run(1000, 50);

    // The hub's lobby record follows the table's seats.
    const views = ca.log.filter((e) => e.ev === 'arcade:lobby' && e.data.id === t).map((e) => e.data as { st: string; seats: { a: string | null; bot: boolean }[] });
    const last = views.at(-1);
    expect(last?.st).toBe('live');
    expect(last?.seats.filter((x) => x.a !== null).map((x) => x.a).sort()).toEqual([alice.id, bob.id].sort());
    expect(last?.seats.filter((x) => x.bot).length).toBe(2);

    // Play: each socket's mirror follows its own events; the humans act on their turn.
    let hands = 0;
    for (let step = 0; step < 3000 && hands < 6; step++) {
      for (const cl of [ca, cb, cc]) cl.drain();
      hands = ca.view?.handsPlayed ?? 0;
      let acted = false;
      for (const cl of [ca, cb]) {
        const v = cl.view;
        if (!v?.hand || cl.seat === null || v.hand.toAct !== cl.seat || v.hand.pending) continue;
        const lg = legal(v, cl.seat);
        if (!lg) continue;
        const k = lg.canCheck ? 'x' : lg.toCall <= 40 ? 'c' : 'f';
        const ack = await cl.sock.request<{ ok: boolean; code?: string }>('lamplight:act', { t, h: v.hand.handNo, q: v.q, k });
        expect(ack.ok, ack.code).toBe(true);
        acted = true;
      }
      if (!acted) await s.clock.run(300, 30);
      else await new Promise((resolve) => setImmediate(resolve));
    }
    for (const cl of [ca, cb, cc]) cl.drain();
    expect(hands).toBeGreaterThanOrEqual(6);
    expect(ca.applied).toBeGreaterThan(40);
    expect(cc.applied).toBeGreaterThan(40);

    // Hidden cards: holes go only to their owner; another seat's cards only ever arrive face up.
    const holes = (cl: typeof ca) => cl.log.filter((e) => e.ev === 'lamplight:hole').map((e) => e.data as { no: number; c: number[] });
    expect(holes(cc)).toEqual([]);
    for (const [me, other] of [
      [ca, cb],
      [cb, ca],
    ] as const) {
      const theirs = new Map(holes(other).map((h) => [h.no, h.c]));
      let handNo = 0;
      for (const { ev, data } of me.log) {
        if (!ev.startsWith('lamplight:')) continue;
        if (ev === 'lamplight:hand') handNo = data.no as number;
        if (ev === 'lamplight:show') continue;
        const hidden = theirs.get(handNo) ?? [];
        const cards = cardsIn(data);
        for (const x of hidden) expect(cards.includes(x), ev + ' leaked a card').toBe(false);
      }
    }

    // The deck proof of the first hand checks against the live commitment and shows only what Alice saw.
    const firstHand = ca.log.find((e) => e.ev === 'lamplight:hand')!.data as { no: number; cr: string };
    expect(firstHand.cr).toHaveLength(43);
    const proof = await a.request<Proof & { ok: boolean }>('lamplight:proof', { t, h: firstHand.no });
    expect(proof.ok).toBe(true);
    expect(await verify(proof, firstHand.cr, proof.rv.map((x) => ({ i: x.i, c: x.c })), sha)).toEqual({ ok: true });
    const shownFirst = new Set<number>();
    let inFirst = false;
    for (const { ev, data } of ca.log) {
      if (ev === 'lamplight:hand') inFirst = data.no === firstHand.no;
      if (inFirst && ev === 'lamplight:show') for (const r of (data.rv as { c: number[] }[]) ?? []) for (const x of r.c) shownFirst.add(x);
    }
    const bobsFirst = holes(cb).find((h) => h.no === firstHand.no)?.c ?? [];
    for (const x of bobsFirst) if (!shownFirst.has(x)) expect(proof.rv.map((r) => r.c)).not.toContain(x);
    expect(await c.request('lamplight:proof', { t, h: firstHand.no })).toEqual({ ok: false, code: 'forbidden' });

    // Bob's connection drops: through the platform's real disconnect path his seat shows as away.
    const bobSeat = cb.seat!;
    expect(ca.view!.seats[bobSeat].connected).toBe(true);
    b.raw.disconnect();
    for (let i = 0; i < 50 && ca.view!.seats[bobSeat].connected; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await s.clock.run(200, 10);
      ca.drain();
    }
    expect(ca.view!.seats[bobSeat].connected).toBe(false);

    // Leaving cashes out; the ledger balances.
    await a.request('lamplight:leave', { t, now: true, id: 'a-out' });
    await s.clock.run(20_000, 200);
    expect(checkInvariant(s.ctx.db)).toEqual([]);
  });
});
