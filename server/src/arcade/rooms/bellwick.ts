/**
 * Bellwick's MatchGameDef (plan.md §2.6.3; bellwick.md §4.10, §5, §6): Party Tale, up to 4 heroes from
 * the voice channel, dropping in and out of the host's tale.
 *
 * The pure runtime (core/bellwick/runtime.ts) knows heroes by seat and join order; this room adds what
 * only the server knows: which account each hero is. Persist events carry the match id, so `persist`
 * (which gets `accountOf` for the seats at that moment) learns each new hero's account at its first
 * save, a tick after it joins, and the next step gives the hero its saved tunic, Hearthbrew and counts.
 * The save belongs to the host who started it and keeps every hero under its account, at most 16.
 */
import { deflateRawSync } from 'node:zlib';
import { z } from 'zod';
import { BUDGET } from '../core/bellwick/budget.js';
import { fromBase64, parseSave, type SaveHero, type SaveV1 } from '../core/bellwick/codec.js';
import { flagId } from '../core/bellwick/content/flags.js';
import { maxHp } from '../core/bellwick/rules.js';
import { createBellwick, type BellwickMatch, type PartyHero, type PartyPersist } from '../core/bellwick/runtime.js';
import { Status } from '../core/bellwick/types.js';
import { utf8Decode, utf8Encode } from '../core/bytes.js';
import type { CoreMatch } from '../core/net/match.js';
import { SAVE_MAX_BYTES } from '../saves.js';
import { statBoard } from '../stats.js';
import type { MatchGameDef, PersistApi, SaveSlot, SaveSummary } from './types.js';
import { wrapCore } from './wrap.js';

const GAME = 'bellwick' as const;

export const bellwickCfgSchema = z.object({
  tale: z.enum(['new', 'slot']).default('new'),
  slot: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0),
});

interface Counted {
  d: number;
  f: number;
  r: number;
}

/** What the room knows about one running session (keyed by match id). */
interface Session {
  owner: string | null;
  slot: SaveSlot | null;
  channelId: string;
  /** The tale was started online (a new Party Tale, or a save marked so) and never imported. */
  online: boolean;
  imported: boolean;
  startedAt: number;
  /** Join order → account, learned at the first save after a hero joins. */
  byJoin: Map<number, string>;
  /** Counts already added to `arcade_stats`, per join order. */
  counted: Map<number, Counted>;
  /** Saved heroes of accounts not playing right now (restored when one joins). */
  keep: Record<string, SaveHero>;
  restored: Set<number>;
  members: string[];
  cleared: boolean;
  core: BellwickMatch | null;
}

const sessions = new Map<string, Session>();

/** Test hook: the runtimes of the sessions running now (each is removed on dispose). */
export const bellwickRunning = (): BellwickMatch[] => [...sessions.values()].flatMap((s) => (s.core ? [s.core] : []));

const readSave = (data: Uint8Array | null): SaveV1 | null => {
  if (!data) return null;
  try {
    return parseSave(JSON.parse(utf8Decode(data)));
  } catch {
    return null;
  }
};

// ------------------------------------------------------------------ replay (watchdog dumps)

const LOG_TICKS = 300;
const REPLAY_MAX = 8192;
const LOG_MAX = 1200;

/** The last 10 s of accepted UPs and EVTs: tick u32, slot u8, kind u8 (0 UP, 1 EVT), length u8, bytes. */
const createInputLog = () => {
  const ticks = new Int32Array(LOG_MAX);
  const meta = new Uint16Array(LOG_MAX);
  const data: Uint8Array[] = Array.from({ length: LOG_MAX }, () => new Uint8Array(20));
  const lens = new Uint8Array(LOG_MAX);
  let head = 0;
  let size = 0;
  return {
    add(tick: number, slot: number, kind: number, p: Uint8Array): void {
      if (p.length > 20) return;
      ticks[head] = tick;
      meta[head] = (slot << 8) | kind;
      (data[head] as Uint8Array).set(p);
      lens[head] = p.length;
      head = (head + 1) % LOG_MAX;
      size = Math.min(LOG_MAX, size + 1);
    },
    /** Entries from `tick - LOG_TICKS` on, oldest first, skipping the oldest `skip`. */
    bytes(tick: number, skip: number): Uint8Array {
      const parts: number[] = [];
      let n = 0;
      for (let k = size; k > 0; k -= 1) {
        const i = (head - k + LOG_MAX) % LOG_MAX;
        if ((ticks[i] as number) < tick - LOG_TICKS) continue;
        if (n++ < skip) continue;
        const m = meta[i] as number;
        const len = lens[i] as number;
        const t = ticks[i] as number;
        parts.push(t & 255, (t >>> 8) & 255, (t >>> 16) & 255, (t >>> 24) & 255, m >> 8, m & 255, len);
        for (let b = 0; b < len; b += 1) parts.push((data[i] as Uint8Array)[b] as number);
      }
      return Uint8Array.from(parts);
    },
    count(tick: number): number {
      let n = 0;
      for (let k = size; k > 0; k -= 1) if ((ticks[(head - k + LOG_MAX) % LOG_MAX] as number) >= tick - LOG_TICKS) n += 1;
      return n;
    },
  };
};

// ------------------------------------------------------------------ persist

const addCounts = (api: PersistApi, account: string, before: Counted, h: PartyHero): void => {
  if (h.d > before.d) api.stats.add(account, GAME, 'downs', h.d - before.d);
  if (h.f > before.f) api.stats.add(account, GAME, 'foes', h.f - before.f);
  if (h.r > before.r) api.stats.add(account, GAME, 'revives', h.r - before.r);
};

const recordClear = (sess: Session, v: NonNullable<PartyPersist['v']>, api: PersistApi): void => {
  const boss: string[] = [];
  for (const j of v.boss) {
    const account = sess.byJoin.get(j);
    if (account && !boss.includes(account)) boss.push(account);
  }
  for (const account of boss) api.stats.add(account, GAME, 'clears', 1);
  // Solo clears stay on the device (plan.md §1.3 #11): results and the board need 2 heroes at the bell.
  if (boss.length < 2) return;
  api.results.record(
    { game: GAME, mode: 'party', channelId: sess.channelId, humans: boss.length, startedAt: sess.startedAt, endedAt: Date.now(), summary: { s: v.sec, slot: sess.slot } },
    boss.map((accountId) => ({ accountId, place: null, score: v.sec, chipsDelta: 0 })),
  );
  if (!sess.online || sess.imported) return;
  for (const account of boss) {
    const best = api.stats.get(account, GAME, 'best_clear_s');
    if (best === 0 || v.sec < best) api.stats.add(account, GAME, 'best_clear_s', v.sec - best);
  }
};

const persistBody = (body: PartyPersist, api: PersistApi): void => {
  const sess = sessions.get(body.m);
  if (!sess) return;
  // Accounts of heroes seated now (a joiner's first save, a tick after it joined).
  for (const h of body.hs) {
    if (h.s < 0 || sess.byJoin.has(h.j)) continue;
    const account = api.accountOf(h.s);
    if (!account) continue;
    sess.byJoin.set(h.j, account);
    if (!sess.members.includes(account)) sess.members.push(account);
  }
  for (const h of body.hs) {
    const account = sess.byJoin.get(h.j);
    if (!account) continue;
    const before = sess.counted.get(h.j) ?? { d: 0, f: 0, r: 0 };
    addCounts(api, account, before, h);
    sess.counted.set(h.j, { d: Math.max(before.d, h.d), f: Math.max(before.f, h.f), r: Math.max(before.r, h.r) });
  }
  if (body.v && !sess.cleared) {
    sess.cleared = true;
    recordClear(sess, body.v, api);
  }
  if (!sess.owner || sess.slot === null) return;
  // Heroes by account: saved ones first, then departed (oldest first), then those playing now.
  const heroes: Record<string, SaveHero> = { ...sess.keep };
  const present = new Set<string>();
  for (let i = body.hs.length - 1; i >= 0; i -= 1) {
    const h = body.hs[i] as PartyHero;
    const account = sess.byJoin.get(h.j);
    if (!account) continue;
    delete heroes[account];
    heroes[account] = { tunic: h.t, brew: h.b, downs: h.d, defeats: h.f };
    if (h.s >= 0) present.add(account);
  }
  // Someone who left is restored from here if they come back.
  for (const [account, hero] of Object.entries(heroes)) if (!present.has(account)) sess.keep[account] = hero;
  const save: SaveV1 = { ...body.save, heroes };
  if (sess.online) save.online = true;
  if (sess.imported) save.imported = true;
  let bytes = utf8Encode(JSON.stringify(save));
  // At most 16 heroes and 4 KB: the oldest records go first.
  for (let keys = Object.keys(heroes); (keys.length > 16 || bytes.length > SAVE_MAX_BYTES) && keys.length > 0; keys = Object.keys(heroes)) {
    const oldest = keys.find((k) => !present.has(k));
    if (!oldest) break;
    delete heroes[oldest];
    bytes = utf8Encode(JSON.stringify(save));
  }
  if (bytes.length > SAVE_MAX_BYTES) return;
  const before = api.saves.get(sess.owner, GAME, sess.slot)?.members ?? [];
  api.saves.put(sess.owner, GAME, sess.slot, 1, bytes, [...before, ...sess.members]);
};

// ------------------------------------------------------------------ the def

const BOSS_DOWN = flagId('boss_down');

const bellwick: MatchGameDef = {
  game: GAME,
  wireId: 2,
  seats: { min: 1, max: 4 },
  spectators: 0,
  join: 'dropIn',
  host: 'longestPresent',
  grace: { episodeMs: 60_000, matchMs: null, awayLimitMs: 600_000, after: 'leave' },
  idle: { noHumanMs: 60_000, noInputMs: 300_000 },
  sender: { skipUnchanged: false, budget: BUDGET },
  serverLimit: 3,
  botFill: false,
  cfgSchema: bellwickCfgSchema,

  create(ctx) {
    const parsed = bellwickCfgSchema.safeParse(ctx.cfg ?? {});
    const cfg = parsed.success ? parsed.data : { tale: 'new' as const, slot: 0 as const };
    const save = cfg.tale === 'slot' ? readSave(ctx.save?.data ?? null) : null;
    const flags = save ? fromBase64(save.flags, 32) : null;
    const loaded = save && flags ? { data: save, flags } : null;
    const sess: Session = {
      owner: ctx.save?.ownerId ?? null,
      slot: ctx.save && (ctx.save.slot === 0 || ctx.save.slot === 1 || ctx.save.slot === 2) ? ctx.save.slot : null,
      channelId: ctx.channelId,
      online: loaded ? loaded.data.online === true : true,
      imported: loaded?.data.imported === true,
      startedAt: Date.now(),
      byJoin: new Map(),
      counted: new Map(),
      keep: loaded ? { ...loaded.data.heroes } : {},
      restored: new Set(),
      members: [],
      cleared: false,
      core: null,
    };
    sessions.set(ctx.id, sess);
    const core = createBellwick({
      seed: loaded ? loaded.data.seed : ctx.seed >>> 0,
      mode: 'server',
      save: loaded,
      taleSlot: loaded ? (ctx.save?.slot ?? 0xff) : 0xff,
      matchId: ctx.id,
    });
    sess.core = core;
    const log = createInputLog();

    /** Saved heroes for accounts the room has just learned; the longest-present hero marks the host. */
    const beforeStep = (): void => {
      let host = -1;
      let hostOrder = Infinity;
      for (let slot = 0; slot < 4; slot += 1) {
        const h = core.world.heroes[slot];
        if (!h?.present) continue;
        if (h.status !== Status.Resting && h.joinOrder < hostOrder) {
          hostOrder = h.joinOrder;
          host = slot;
        }
        if (sess.restored.has(h.joinOrder)) continue;
        const account = sess.byJoin.get(h.joinOrder);
        if (!account) continue;
        sess.restored.add(h.joinOrder);
        const saved = sess.keep[account];
        if (!saved) continue;
        core.restoreHero(slot, saved);
        delete sess.keep[account];
        const c = sess.counted.get(h.joinOrder) ?? { d: 0, f: 0, r: 0 };
        sess.counted.set(h.joinOrder, { d: c.d + saved.downs, f: c.f + saved.defeats, r: c.r });
      }
      if (host >= 0) core.hostSlot = host;
    };

    const match: CoreMatch = {
      get idle() {
        return core.idle;
      },
      get tick() {
        return core.tick;
      },
      step() {
        beforeStep();
        core.step();
      },
      onUp(slot, payload, upSeq) {
        log.add(core.tick, slot, 0, payload);
        core.onUp(slot, payload, upSeq);
      },
      onEvent(slot, payload) {
        log.add(core.tick, slot, 1, payload);
        core.onEvent(slot, payload);
      },
      ackUp: (slot) => core.ackUp(slot),
      setSeat: (slot, cmd) => core.setSeat(slot, cmd),
      setRtt: (slot, rttMs) => core.setRtt(slot, rttMs),
      welcomeCfg: () => core.welcomeCfg(),
      snapshotFor: (r) => core.snapshotFor(r),
      keyframeFor: (r) => core.keyframeFor(r),
      takeEvents: (r) => core.takeEvents(r),
      takeHostEvents: () => core.takeHostEvents(),
      dump: () => core.dump(),
    };

    return wrapCore(GAME, ctx.id, match, {
      handover: () => core.handover(),
      replay() {
        // The world now plus the last 10 s of input, deflated, at most 8 KB (cut from the oldest end).
        const dump = core.dump();
        const total = log.count(core.tick);
        const pack = (skip: number): Uint8Array => {
          const inputs = log.bytes(core.tick, skip);
          const body = new Uint8Array(4 + dump.length + inputs.length);
          new DataView(body.buffer).setUint32(0, dump.length, true);
          body.set(dump, 4);
          body.set(inputs, 4 + dump.length);
          return deflateRawSync(body);
        };
        let skip = 0;
        let z = pack(0);
        while (z.length > REPLAY_MAX && skip < total) {
          skip = Math.min(total, Math.max(skip + 8, Math.ceil(skip * 1.5)));
          z = pack(skip);
        }
        return z.length <= REPLAY_MAX ? z : new Uint8Array(0);
      },
      dispose() {
        sessions.delete(ctx.id);
      },
    });
  },

  persist(e, api) {
    if (e.t !== 'persist') return;
    let body: PartyPersist;
    try {
      body = JSON.parse(utf8Decode(e.data)) as PartyPersist;
    } catch {
      return;
    }
    if (!body || typeof body.m !== 'string' || !Array.isArray(body.hs) || !body.save) return;
    persistBody(body, api);
  },

  summarizeSave(data): SaveSummary {
    const save = readSave(data);
    if (!save) return { broken: true };
    const flags = fromBase64(save.flags, 32);
    const done = flags ? ((flags[BOSS_DOWN >> 3] as number) & (1 << (BOSS_DOWN & 7))) !== 0 : false;
    const items = [save.sword, save.buckler, save.hook, save.map, save.compass, save.bossKey].filter(Boolean).length;
    return { playSec: save.playSec, hearts: maxHp(save.vessels, save.shards) / 2, items, done };
  },

  boards: [statBoard(GAME, 'best_clear_s', 'fastest', 'Fastest clear', 'asc')],
};

export default bellwick;
