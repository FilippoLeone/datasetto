/**
 * Glimmerhall end to end on the platform's live test server (plan.md §3.4 "Pacing" and
 * "Authority"): the hall as the channel's lobby over `arcade:lobby:create` / `:join`, spins over a
 * real socket, hall pushes through the paced emitter (at most once a second, merged while the main
 * socket is busy), away members get nothing, reactions are acknowledged. Draws are scripted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFS } from '../../../src/arcade/core/version.js';
import type { EnterOk, FeedView, SpinOk } from '../../../src/arcade/core/glimmer/wire.js';
import glimmer, { startGlimmer } from '../../../src/arcade/halls/glimmer.js';
import type { TableGameDef } from '../../../src/arcade/tables/types.js';
import { startArcadeServer, type ArcadeTestServer, type TestSocket } from '../harness/server.js';
import { scripted, sid } from './harness.js';

let server: ArcadeTestServer;
const r = scripted(61);
const busy = new Set<string>();

const rigged: TableGameDef = { ...glimmer, start: (api) => startGlimmer(api, { rng: r.rng, potRng: () => 999_999 }) };

beforeEach(async () => {
  busy.clear();
  server = await startArcadeServer({ arcade: { tableGames: [null, rigged], tableLaneBusy: (id) => busy.has(id) } });
});

afterEach(async () => {
  await server.close();
});

const settle = async (ms = 1200): Promise<void> => {
  await server.clock.run(ms, 50);
  await new Promise((resolve) => setTimeout(resolve, 30));
};

/** The `spin` limiter (2 per second) runs on real time. */
const spacing = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 520));

const player = async (name: string): Promise<{ id: string; socket: TestSocket }> => {
  const account = await server.account(name);
  const socket = await account.socket();
  await account.joinVoice(server.voiceChannel, socket);
  return { id: account.id, socket };
};

describe('Glimmerhall on the live test server', () => {
  it('opens the hall as the channel lobby, shares notable wins, merges pushes behind a busy socket and stops them while away', async () => {
    const a = await player('Ada');
    const b = await player('Bo');
    const ch = server.voiceChannel;
    const created = await a.socket.request<{ ok: boolean; lobby: { id: string; st: string } }>('arcade:lobby:create', { ch, game: 'glimmer', mode: 'hall', cfg: {} });
    expect(created.ok).toBe(true);
    const id = created.lobby.id;
    await settle(100);
    // Live at once (the stage opens on create and join); a second hall in the same channel is refused.
    expect(server.ctx.db).toBeTruthy();
    expect(await b.socket.request('arcade:lobby:create', { ch, game: 'glimmer', mode: 'hall', cfg: {} })).toEqual({ ok: false, code: 'exists' });
    expect(await b.socket.request<{ ok: boolean }>('arcade:lobby:join', { id, as: 'player' })).toMatchObject({ ok: true });
    const ea = await a.socket.request<EnterOk>('glimmer:enter', { ch, v: DEFS.glimmer });
    const eb = await b.socket.request<EnterOk>('glimmer:enter', { ch, v: DEFS.glimmer });
    expect([ea.ok, ea.me, eb.ok, eb.me]).toEqual([true, 0, true, 1]);
    expect(eb.bal).toBe(20_000);
    // Activity is coalesced to once per 2 s per channel.
    await settle(2500);
    // The channel's activity names the hall by its lobby id.
    const activity = b.socket.received('arcade:activity') as { ch: string; a: { g: string; id: string; n: number }[] }[];
    expect(activity.some((x) => x.a?.some((e) => e.g === 'glimmer' && e.id === id && e.n === 2))).toBe(true);

    // A five-octopus line for Ada (2,500 coins, plus the other lines those stops pay), shared with Bo.
    r.push(11, 11, 12, 11, 11);
    const big = await a.socket.request<SpinOk>('glimmer:spin', { m: 1, b: 20, id: sid() });
    expect(big.ok).toBe(true);
    expect(big.w).toBeGreaterThanOrEqual(2500);
    await settle();
    const feeds = () => b.socket.received('glimmer:feed') as FeedView[];
    const entries = () => feeds().flatMap((f) => f.e ?? []);
    expect(entries()).toContainEqual([0, 1, 20, big.w, 0]);
    for (const f of feeds()) expect(JSON.stringify(f)).not.toMatch(/"bal"/);

    // Bo's main socket is busy (chat in flight): pushes wait, then go as one merged push.
    busy.add(b.socket.raw.id as string);
    const before = feeds().length;
    await spacing();
    r.push(11, 11, 12, 11, 11);
    const s40 = await a.socket.request<SpinOk>('glimmer:spin', { m: 1, b: 40, id: sid() });
    await settle();
    await spacing();
    r.push(11, 11, 12, 11, 11);
    const s100 = await a.socket.request<SpinOk>('glimmer:spin', { m: 1, b: 100, id: sid() });
    expect(s100).toMatchObject({ ok: true });
    await settle();
    expect(feeds().length).toBe(before);
    busy.clear();
    await settle();
    // One push carries both wins (a later pot update may follow on its own).
    const after = feeds().slice(before).filter((f) => f.e);
    expect(after).toHaveLength(1);
    expect(after[0]?.e?.map((e) => e[3]).sort((x, y) => x - y)).toEqual([s40.w, s100.w]);

    // Reactions are acknowledged and reach the other member.
    expect(await b.socket.request('glimmer:react', { to: 0, e: 4 })).toEqual({ ok: true });
    await settle();
    expect((a.socket.received('glimmer:feed') as FeedView[]).flatMap((f) => f.r ?? [])).toContainEqual([1, 0, 4]);

    // Away: nothing more for Bo until he enters again.
    expect(await b.socket.request('glimmer:away', {})).toEqual({ ok: true });
    const awayAt = feeds().length;
    await spacing();
    r.push(11, 11, 12, 11, 11);
    await a.socket.request('glimmer:spin', { m: 1, b: 20, id: sid() });
    await settle(2500);
    expect(feeds().length).toBe(awayAt);

    // Refusals are quiet acks.
    await spacing();
    expect(await a.socket.request('glimmer:spin', { m: 1, b: 30, id: sid() })).toEqual({ ok: false, code: 'bet' });
    expect(await a.socket.request('glimmer:enter', { ch, v: DEFS.glimmer + 1 })).toEqual({ ok: false, code: 'update' });
  }, 20_000);
});
