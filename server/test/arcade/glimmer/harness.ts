/**
 * A table-lane stand-in for Glimmerhall's server tests: the real wallet, stats and results over an
 * in-memory migrated database, a virtual clock with timers, scripted presence, and every emit
 * recorded (with send-time stamping applied). Handlers run through their zod schemas like the
 * platform's `handle()`.
 */
import type { ZodType } from 'zod';
import { openDatabase, type DB } from '../../../src/db/index.js';
import type { Clock } from '../../../src/arcade/clock.js';
import { DEFAULT_SETTINGS, type ArcadeSettings } from '../../../src/arcade/settings.js';
import { createResults, createStats } from '../../../src/arcade/stats.js';
import type { CallerCtx, EmitOpts, TableApi } from '../../../src/arcade/tables/types.js';
import { createWallet, type Wallet } from '../../../src/arcade/wallet.js';
import { createPending } from '../../../src/arcade/pending.js';
import type { LobbyRecord } from '../../../src/arcade/tables/types.js';
import { startGlimmer, type GlimmerGame, type GlimmerOptions } from '../../../src/arcade/halls/glimmer.js';

export interface Emit {
  socketId: string;
  ev: string;
  data: unknown;
  opts: EmitOpts;
  at: number;
}

export const virtualClock = (start = Date.UTC(2026, 9, 22, 18, 0, 0)) => {
  let t = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock & { advance(ms: number): void; readonly pending: number } = {
    now: () => t,
    hr: () => BigInt(t) * 1_000_000n,
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: t + Math.max(0, ms), fn });
      return seq;
    },
    clearTimeout: (h) => {
      timers.delete(h as number);
    },
    advance(ms) {
      const end = t + ms;
      for (let guard = 0; guard < 100_000; guard += 1) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const e of timers) if (!next || e[1].at < next[1].at) next = e;
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
    get pending() {
      return timers.size;
    },
  };
  return clock;
};

export interface Harness {
  db: DB;
  clock: ReturnType<typeof virtualClock>;
  wallet: Wallet;
  game: GlimmerGame;
  emits: Emit[];
  activity: string[];
  settings: ArcadeSettings;
  voice: Map<string, string>;
  hidden: Set<string>;
  /** When false, emits stay "queued" (onSent is not called) until `flushSent()`. */
  autoSent: boolean;
  flushSent(): void;
  addAccount(...ids: string[]): void;
  call<T = any>(c: CallerCtx, ev: string, payload: unknown): T;
  /** The hub's lobby records (what `HubApi.get/update/close` see). */
  lobbies: Map<string, LobbyRecord>;
  /** The hub's lobby create flow for Glimmerhall: onCreate, then the record, then onCreated. */
  createLobby(c: CallerCtx): { ok: true; id: string } | { ok: false; code: string };
  /** The hub's join and leave for a table lobby. */
  joinLobby(c: CallerCtx, id: string): { ok: boolean; code?: string };
  leaveLobby(c: CallerCtx, id: string): void;
  ctx(accountId: string, socketId?: string): CallerCtx;
  to(socketId: string, ev?: string): unknown[];
}

export const createHarness = (
  o: GlimmerOptions & { settings?: Partial<ArcadeSettings>; /** Route every emit here instead of recording it (the link simulator). */ emit?: (socketId: string, ev: string, data: unknown, opts: EmitOpts) => void } = {},
): Harness => {
  const db = openDatabase(':memory:', { memory: true });
  const clock = virtualClock();
  const settings: ArcadeSettings = { ...DEFAULT_SETTINGS, ...o.settings, gameSettings: { glimmer: { slotsMaxBet: 500 }, ...o.settings?.gameSettings } };
  const wallet = createWallet(db, { clock, settings: () => settings });
  const handlers = new Map<string, { schema: ZodType<unknown>; fn: (c: CallerCtx, p: unknown) => unknown }>();
  const emits: Emit[] = [];
  const queued: (() => void)[] = [];
  const activity: string[] = [];
  const voice = new Map<string, string>();
  const hidden = new Set<string>();
  const insertAccount = db.prepare("INSERT INTO accounts (id, username, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, 'x', 0, 0)");
  const log = { warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined };
  const h: Partial<Harness> = { autoSent: true };
  const emit = (socketId: string, ev: string, data: unknown, opts: EmitOpts): void => {
    if (o.emit) {
      o.emit(socketId, ev, data, opts);
      return;
    }
    const at = clock.now();
    const stamped = opts.stamp ? opts.stamp(data, at) : data;
    // Coalesced emits replace a queued one with the same key.
    if (opts.coalesce && !h.autoSent) {
      const i = emits.findIndex((e) => e.socketId === socketId && e.opts.coalesce === opts.coalesce && (e as Emit & { open?: boolean }).open);
      if (i >= 0) emits.splice(i, 1);
    }
    const rec: Emit & { open?: boolean } = { socketId, ev, data: JSON.parse(JSON.stringify(stamped)), opts, at, open: !h.autoSent };
    emits.push(rec);
    const sent = (): void => {
      rec.open = false;
      opts.onSent?.(0);
    };
    if (h.autoSent) sent();
    else queued.push(sent);
  };
  const lobbies = new Map<string, LobbyRecord>();
  let lobbySeq = 0;
  const api: TableApi = {
    on: (event, opts, fn) => void handlers.set(event, { schema: opts.schema as ZodType<unknown>, fn: fn as (c: CallerCtx, p: unknown) => unknown }),
    queuePolicy: () => undefined,
    emit,
    emitAccount: (accountId, ev, data, opts) => emit('acct:' + accountId, ev, data, opts),
    emitRoom: () => undefined,
    rooms: { join: () => undefined, leave: () => undefined, size: () => 0 },
    wallet,
    stats: createStats(db, clock),
    results: createResults(db, clock),
    hub: {
      get: (id) => lobbies.get(id) ?? null,
      publish: () => undefined,
      activityChanged: (ch) => void activity.push(ch),
      close: (id) => {
        const r = lobbies.get(id);
        if (r) lobbies.set(id, { ...r, state: 'ended' });
      },
      update: (id, patch) => {
        const r = lobbies.get(id);
        if (!r || r.state === 'ended') return;
        lobbies.set(id, { ...r, ...(patch.seats ? { seats: patch.seats } : {}), ...(patch.state ? { state: patch.state } : {}), ...(patch.watchers ? { watchers: patch.watchers } : {}) });
      },
      bots: { take: () => false, give: () => undefined },
      limits: () => settings.limits,
    },
    presence: { isVoiceMember: (a, ch) => voice.get(a) === ch, socketsOf: () => [], dnd: () => false },
    prefs: { hidden: (a) => hidden.has(a) },
    ackRttMs: () => 0,
    clock,
    log: log as never,
    settings: () => settings,
    db,
    pending: createPending(db, clock),
  };
  const game = startGlimmer(api, o);
  Object.assign(h, {
    db,
    clock,
    wallet,
    game,
    emits,
    activity,
    settings,
    voice,
    hidden,
    flushSent: () => {
      for (const f of queued.splice(0)) f();
    },
    addAccount: (...ids: string[]) => {
      for (const id of ids) insertAccount.run(id, id, id);
    },
    call: (c: CallerCtx, ev: string, payload: unknown) => {
      const handler = handlers.get(ev);
      if (!handler) throw new Error('no handler for ' + ev);
      const parsed = handler.schema.safeParse(payload);
      if (!parsed.success) return { ok: false, code: 'invalid' };
      return handler.fn(c, parsed.data);
    },
    ctx: (accountId: string, socketId = 's-' + accountId) => ({ accountId, socketId, voiceChannelId: voice.get(accountId) ?? null }),
    lobbies,
    createLobby: (c: CallerCtx) => {
      const refusal = game.lobby?.onCreate(c, {});
      if (!refusal?.ok) return refusal as { ok: false; code: string };
      lobbySeq += 1;
      const id = 'L' + lobbySeq;
      const record: LobbyRecord = { id, game: 'glimmer', channelId: c.voiceChannelId as string, mode: 'hall', cfg: {}, host: c.accountId, seats: Array.from({ length: 9 }, (_, i) => ({ accountId: i === 0 ? c.accountId : null, bot: false, state: 0 })), watchers: [], state: 'open' };
      lobbies.set(id, record);
      game.lobby?.onCreated?.(c, record);
      return { ok: true, id };
    },
    joinLobby: (c: CallerCtx, id: string) => {
      const r = lobbies.get(id);
      if (!r || r.state === 'ended') return { ok: false, code: 'gone' };
      if (r.seats.some((s) => s.accountId === c.accountId)) return { ok: true };
      const free = r.seats.findIndex((s) => s.accountId === null && !s.bot);
      if (free < 0) return { ok: false, code: 'full' };
      const answer = game.lobby?.onJoin(c, r, 'player');
      if (answer && !answer.ok) return answer;
      const seatsNow = r.seats.slice();
      seatsNow[free] = { accountId: c.accountId, bot: false, state: 0 };
      lobbies.set(id, { ...r, seats: seatsNow });
      return { ok: true };
    },
    leaveLobby: (c: CallerCtx, id: string) => {
      const r = lobbies.get(id);
      if (!r) return;
      const seatsNow = r.seats.map((s) => (s.accountId === c.accountId ? { ...s, accountId: null } : s));
      lobbies.set(id, { ...r, seats: seatsNow });
      game.lobby?.onLeave(c, lobbies.get(id) as LobbyRecord);
    },
    to: (socketId: string, ev?: string) => emits.filter((e) => e.socketId === socketId && (!ev || e.ev === ev)).map((e) => e.data),
  });
  return h as Harness;
};

/** A seeded uniform integer source with scripted values first. */
export const scripted = (seed: number) => {
  let s = seed >>> 0 || 1;
  const queue: number[] = [];
  let calls = 0;
  const rng = (n: number): number => {
    calls += 1;
    if (queue.length > 0) return (queue.shift() as number) % n;
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s % n;
  };
  return {
    rng,
    push: (...v: number[]) => void queue.push(...v),
    get calls() {
      return calls;
    },
  };
};

let n = 0;
export const sid = (): string => ('z' + String(++n).padStart(11, '0')).slice(-12);
