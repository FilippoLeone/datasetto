/**
 * Session (bellwick.md §13 test 10): Party Tale on the real platform (HTTP, Socket.IO, the action lane,
 * the hub and match server) with a fake clock. Drop-in next to the longest-present hero; the 60 s grace
 * and resume; the 10-minute away limit; 3 minutes without input rests a hero and the session then does
 * no work; the host can leave and the tale keeps saving into the host's slot; the save on the end;
 * restart sends PHASE 4 and a HANDOVER with each hero's place. Plus the wipe, which is pure.
 */
import { inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { b64url, utf8Decode } from '../../../src/arcade/core/bytes.js';
import { fromBase64, parseSave } from '../../../src/arcade/core/bellwick/codec.js';
import { content } from '../../../src/arcade/core/bellwick/content/parse.js';
import { createBellwick, type BellwickMatch, type PartyHandover } from '../../../src/arcade/core/bellwick/runtime.js';
import { downHero } from '../../../src/arcade/core/bellwick/sim/party.js';
import { activateRoom } from '../../../src/arcade/core/bellwick/sim/room.js';
import type { HeroRec } from '../../../src/arcade/core/bellwick/sim/state.js';
import { touchProgress } from '../../../src/arcade/core/bellwick/sim/world.js';
import { Btn, Status } from '../../../src/arcade/core/bellwick/types.js';
import { CLOSE, KEY_REASON, PHASE, S2C, VIS, type ServerMsg } from '../../../src/arcade/core/net/lane.js';
import { bellwickRunning } from '../../../src/arcade/rooms/bellwick.js';
import { startArcadeServer, type ArcadeTestServer, type TestAccount, type TestSocket } from '../harness/server.js';
import { dungeonSave } from './helpers.js';
import { bwLane, type BwLane } from './live.js';

let server: ArcadeTestServer;

beforeEach(async () => {
  server = await startArcadeServer();
});

afterEach(async () => {
  await server.close();
});

const tick = (ms = 100, step = 34) => server.clock.run(ms, step);
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

interface Member {
  account: TestAccount;
  socket: TestSocket;
  lane: BwLane;
}

const member = async (): Promise<{ account: TestAccount; socket: TestSocket }> => {
  const account = await server.account();
  const socket = await account.socket();
  await account.joinVoice(server.voiceChannel, socket);
  return { account, socket };
};

const ticketFor = async (socket: TestSocket, lobbyId: string): Promise<string> => {
  const t = await socket.request<{ ok: boolean; ticket: string }>('arcade:ticket', { id: lobbyId });
  expect(t.ok).toBe(true);
  return t.ticket;
};

/** n members in voice, a started Party Tale from the host's slot 0, every lane welcomed and keyed. */
const party = async (n: number): Promise<{ members: Member[]; lobbyId: string; core: BellwickMatch }> => {
  const people = [];
  for (let i = 0; i < n; i += 1) people.push(await member());
  const host = people[0]!;
  const created = await host.socket.request<{ ok: boolean; lobby: { id: string }; code?: string }>('arcade:lobby:create', {
    ch: server.voiceChannel,
    game: 'bellwick',
    mode: 'party',
    cfg: { tale: 'new', slot: 0 },
  });
  expect(created).toMatchObject({ ok: true });
  const lobbyId = created.lobby.id;
  for (const p of people.slice(1)) expect(await p.socket.request('arcade:lobby:join', { id: lobbyId, as: 'player' })).toMatchObject({ ok: true });
  expect(await host.socket.request('arcade:lobby:start', { id: lobbyId })).toMatchObject({ ok: true });
  const members: Member[] = [];
  for (const p of people) {
    const lane = await bwLane(server.url, await ticketFor(p.socket, lobbyId));
    members.push({ ...p, lane });
  }
  await settle();
  await tick(100);
  for (const m of members) await m.lane.next(S2C.KEYFRAME);
  const core = bellwickRunning().at(-1) as BellwickMatch;
  expect(core).toBeDefined();
  return { members, lobbyId, core };
};

const hero = (core: BellwickMatch, slot: number): HeroRec => core.world.heroes[slot] as HeroRec;

const savedTale = (ownerId: string) => {
  const row = server.ctx.db.prepare("SELECT data, members FROM arcade_saves WHERE owner_id = ? AND game = 'bellwick' AND slot = 0").get(ownerId) as
    | { data: Buffer; members: string }
    | undefined;
  if (!row) return null;
  return { save: parseSave(JSON.parse(utf8Decode(new Uint8Array(row.data)))), members: JSON.parse(row.members) as string[] };
};

/** Presses `buttons` on a lane for `ticks` device ticks, the clock moving with it. */
const walk = async (lane: BwLane, buttons: number, ticks: number): Promise<void> => {
  for (let i = 0; i < ticks; i += 1) {
    lane.press(buttons);
    await tick(34);
  }
  await settle();
};

describe('Bellwick Party Tale on the platform', () => {
  it('drops a joiner in beside the longest-present hero and saves into the host slot under each account', async () => {
    const { members, lobbyId, core } = await party(2);
    const [host, guest] = members as [Member, Member];
    expect(hero(core, 0).present && hero(core, 1).present).toBe(true);
    expect(hero(core, 1).room).toBe(hero(core, 0).room);
    // The host walks; the guest sees it move.
    const x0 = hero(core, 0).x;
    await walk(host.lane, Btn.right, 20);
    expect(hero(core, 0).x).toBeGreaterThan(x0 + 300);
    await tick(200);
    await settle();
    const seen = guest.lane.mirror.others.find((o) => o.on && o.slot === 0);
    expect(seen?.x).toBeGreaterThan(x0 >> 4);
    // A third member drops in while it runs.
    const late = await member();
    expect(await late.socket.request('arcade:lobby:join', { id: lobbyId, as: 'player' })).toMatchObject({ ok: true });
    const lane = await bwLane(server.url, await ticketFor(late.socket, lobbyId));
    await settle();
    await tick(100);
    const welcome = (await lane.next(S2C.WELCOME)) as Extract<ServerMsg, { t: 'welcome' }>;
    expect(welcome.slot).toBe(2);
    await lane.next(S2C.KEYFRAME);
    expect(hero(core, 2).room).toBe(hero(core, 0).room);
    expect(lane.mirror.room).toBe(hero(core, 0).room);
    // Autosaves name the heroes by account, in the host's slot.
    touchProgress(core.world);
    core.world.party.purse = 7;
    await tick(2500, 100);
    const tale = savedTale(host.account.id);
    expect(tale?.save?.purse).toBe(7);
    expect(Object.keys(tale?.save?.heroes ?? {}).sort()).toEqual([host.account.id, guest.account.id, late.account.id].sort());
    expect(tale?.save?.online).toBe(true);
    expect(tale?.members.sort()).toEqual([host.account.id, guest.account.id, late.account.id].sort());
  });

  it('rests a dropped hero, restores it on resume within 60 s, and lets it leave after the grace', async () => {
    const { members, core } = await party(2);
    const guest = members[1] as Member;
    const token = b64url(guest.lane.welcome!.resumeToken);
    guest.lane.ws.terminate();
    await settle();
    await tick(2000, 100);
    expect(hero(core, 1).status).toBe(Status.Resting);
    const back = await bwLane(server.url, token, { resume: true, slot: 1 });
    await settle();
    await tick(100);
    const key = (await back.next(S2C.KEYFRAME)) as Extract<ServerMsg, { t: 'keyframe' }>;
    expect(key.reason).toBe(KEY_REASON.resume);
    expect(hero(core, 1).status).toBe(Status.Active);
    // Gone for good this time: after 60 s the hero leaves; its record stays in the tale.
    back.ws.terminate();
    await settle();
    // The host keeps playing so the session does not go idle.
    for (let s = 0; s < 62; s += 1) {
      members[0]!.lane.press(s % 2 ? Btn.left : Btn.right);
      await tick(1000, 250);
    }
    expect(hero(core, 1).present).toBe(false);
    const tale = savedTale(members[0]!.account.id);
    expect(Object.keys(tale?.save?.heroes ?? {})).toContain(guest.account.id);
  });

  it('closes a lane hidden for 10 minutes with 4000', async () => {
    const { members } = await party(2);
    const [hidden, playing] = members as [Member, Member];
    hidden.lane.sendVis(VIS.away);
    await settle();
    for (let s = 0; s < 605; s += 5) {
      playing.lane.press(s % 10 ? Btn.left : Btn.right);
      await tick(5000, 1000);
    }
    expect(await hidden.lane.closed()).toBe(CLOSE.away);
  });

  it('rests a visible hero after 3 minutes without input, does no work while everyone rests, and wakes on input', async () => {
    const { members, core } = await party(1);
    const me = members[0] as Member;
    await tick(181_000, 1000);
    expect(hero(core, 0).status).toBe(Status.Resting);
    expect(core.idle).toBe(true);
    const t0 = core.tick;
    await tick(5000, 500);
    expect(core.tick).toBe(t0);
    await walk(me.lane, Btn.down, 6);
    await tick(100);
    expect(hero(core, 0).status).toBe(Status.Active);
    expect(core.tick).toBeGreaterThan(t0);
  });

  it('keeps saving into the host slot after the host leaves, and saves when the session ends', async () => {
    const { members, core } = await party(2);
    const [host, guest] = members as [Member, Member];
    host.lane.close(1000);
    await settle();
    await tick(200);
    expect(hero(core, 0).present).toBe(false);
    touchProgress(core.world);
    core.world.party.purse = 42;
    await walk(guest.lane, Btn.right, 4);
    await tick(2500, 100);
    expect(savedTale(host.account.id)?.save?.purse).toBe(42);
    // The last hero leaves: the session ends after 60 s without humans; the tale has both heroes.
    guest.lane.close(1000);
    await settle();
    await tick(61_000, 1000);
    expect(bellwickRunning().length).toBe(0);
    const tale = savedTale(host.account.id);
    expect(Object.keys(tale?.save?.heroes ?? {}).sort()).toEqual([host.account.id, guest.account.id].sort());
  });

  it('on restart sends PHASE 4 and a HANDOVER with the tale and each hero’s place, then closes with 1012', async () => {
    const { members, core } = await party(2);
    touchProgress(core.world);
    core.world.party.purse = 9;
    await server.sockets.arcade.onRestarting();
    await settle();
    for (const m of members) {
      const phase = (await m.lane.next(S2C.PHASE)) as Extract<ServerMsg, { t: 'phase' }>;
      expect(phase.phase).toBe(PHASE.ending);
      const handover = (await m.lane.next(S2C.HANDOVER)) as Extract<ServerMsg, { t: 'handover' }>;
      const body = JSON.parse(utf8Decode(inflateRawSync(handover.body))) as PartyHandover;
      expect(body.save.purse).toBe(9);
      expect(body.place.map((p) => p.s).sort()).toEqual([0, 1]);
      expect(await m.lane.closed()).toBe(CLOSE.restart);
    }
    expect(savedTale(members[0]!.account.id)?.save?.purse).toBe(9);
  });
});

describe('Bellwick wipe', () => {
  it('respawns everyone at the lantern 3 s after the last standing hero falls; enemies reset, cleared rooms stay', () => {
    const save = dungeonSave(3);
    const core = createBellwick({ seed: 3, mode: 'server', save: { data: save, flags: fromBase64(save.flags, 32)! }, taleSlot: 0, matchId: 'wipe' });
    core.setSeat(0, 'live');
    core.setSeat(1, 'live');
    const nave = content().byKey.nave!.id;
    const room = activateRoom(core.world, nave);
    for (const s of [0, 1]) {
      const h = hero(core, s);
      h.room = nave;
      // Far enough apart that nobody revives anybody.
      h.x = 1024 + s * 1024;
      h.y = 1152;
    }
    core.world.party.cleared |= 1 << 1;
    for (let i = 0; i < 30; i += 1) core.step();
    const first = room.en.find((e) => e.kind !== 0)!;
    first.hp = 1;
    downHero(core.world, hero(core, 0));
    for (let i = 0; i < 120; i += 1) core.step();
    // One still standing: no wipe.
    expect(hero(core, 0).status).toBe(Status.Downed);
    downHero(core.world, hero(core, 1));
    for (let i = 0; i < 89; i += 1) core.step();
    expect(hero(core, 1).status).toBe(Status.Downed);
    core.step();
    core.step();
    for (const s of [0, 1]) {
      expect(hero(core, s).status).toBe(Status.Active);
      expect(hero(core, s).room).toBe(content().lanterns[core.world.party.lantern]!.room);
    }
    expect(core.world.party.cleared & (1 << 1)).not.toBe(0);
  });
});
