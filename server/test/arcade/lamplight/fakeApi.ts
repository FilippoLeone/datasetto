/**
 * A stand-in for the platform's TableApi (plan.md §2.6.4) around the real wallet, stats and results
 * on an in-memory database, with a virtual clock. It records every emit per socket (stamped at send
 * time, the way the paced emitter does) so tests can scan exactly what each client received.
 */
import { openDatabase, type DB } from '../../../src/db/index.js';
import type { Clock } from '../../../src/arcade/clock.js';
import { DEFAULT_LIMITS, DEFAULT_SETTINGS, type ArcadeSettings } from '../../../src/arcade/settings.js';
import { createResults, createStats } from '../../../src/arcade/stats.js';
import { createWallet } from '../../../src/arcade/wallet.js';
import type { CallerCtx, EmitOpts, LobbyRecord, QueuePolicy, TableApi } from '../../../src/arcade/tables/types.js';

export interface FakeSocket {
  id: string;
  accountId: string;
  received: { name: string; data: Record<string, unknown> }[];
}

export const virtualClock = (start = Date.UTC(2026, 9, 22, 12)) => {
  let now = start;
  let ns = 0n;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock & { advance(ms: number): void; run(ms: number): void; pending(): number; readonly t: number; burn(ns: bigint): void } = {
    now: () => now,
    hr: () => BigInt(now) * 1_000_000n + ns,
    setTimeout(fn, ms) {
      const h = ++seq;
      timers.set(h, { at: now + Math.max(0, ms), fn });
      return h;
    },
    clearTimeout(h) {
      timers.delete(h as number);
    },
    advance(ms) {
      now += ms;
    },
    /** Run every timer due within `ms`, in order. */
    run(ms) {
      const end = now + ms;
      for (let guard = 0; guard < 200_000; guard++) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at || (e[1].at === next[1].at && e[0] < next[0]))) next = e;
        if (!next) break;
        timers.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].fn();
      }
      now = end;
    },
    pending: () => timers.size,
    get t() {
      return now;
    },
    burn(n) {
      ns += n;
    },
  };
  return clock;
};

export const makeFakeApi = (o: { settings?: Partial<ArcadeSettings>; botCap?: number } = {}) => {
  const db: DB = openDatabase(':memory:', { memory: true });
  const clock = virtualClock();
  let settings: ArcadeSettings = { ...DEFAULT_SETTINGS, ...o.settings };
  const wallet = createWallet(db, { clock, settings: () => settings });
  const stats = createStats(db, clock);
  const results = createResults(db, clock);
  const handlers = new Map<string, { schema: { safeParse(v: unknown): { success: boolean; data?: unknown } }; voiceMember?: boolean; fn: (c: CallerCtx, p: unknown) => unknown }>();
  const sockets = new Map<string, FakeSocket>();
  const rooms = new Map<string, Set<string>>();
  const lobbies = new Map<string, LobbyRecord>();
  const closed: { id: string; reason: string }[] = [];
  const updates: { id: string; seats?: unknown; watchers?: readonly string[]; state?: string }[] = [];
  let policy: QueuePolicy | null = null;
  let bots = 0;
  const botCap = o.botCap ?? 6;
  const insertAccount = db.prepare("INSERT OR IGNORE INTO accounts (id, username, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, 'x', 0, 0)");

  const deliver = (sid: string, ev: string, data: unknown, opts: EmitOpts): void => {
    const s = sockets.get(sid);
    if (!s) return;
    const copy = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
    const stamped = (opts.stamp ? opts.stamp(copy, clock.now()) : copy) as Record<string, unknown>;
    s.received.push({ name: ev, data: stamped });
    opts.onSent?.(0);
  };

  const api: TableApi & { db: DB } = {
    db,
    on(event, opts, fn) {
      handlers.set(event, { schema: opts.schema as never, voiceMember: opts.voiceMember, fn: fn as never });
    },
    queuePolicy(_q, p) {
      policy = p;
    },
    emit(socketId, ev, data, opts) {
      deliver(socketId, ev, data, opts);
    },
    emitAccount(accountId, ev, data, opts) {
      for (const s of sockets.values()) if (s.accountId === accountId && s.id !== opts.except) deliver(s.id, ev, data, opts);
    },
    emitRoom(room, ev, build, opts) {
      for (const sid of rooms.get(room) ?? []) deliver(sid, ev, build(sid), opts);
    },
    rooms: {
      join(sid, room) {
        let r = rooms.get(room);
        if (!r) rooms.set(room, (r = new Set()));
        r.add(sid);
      },
      leave(sid, room) {
        rooms.get(room)?.delete(sid);
      },
      size: (room) => rooms.get(room)?.size ?? 0,
    },
    wallet,
    stats,
    results,
    hub: {
      get: (id) => lobbies.get(id) ?? null,
      publish: () => undefined,
      activityChanged: () => undefined,
      close(id, reason) {
        closed.push({ id, reason });
        lobbies.delete(id);
      },
      update(id, patch) {
        const l = lobbies.get(id);
        if (!l) return;
        updates.push({ id, ...patch });
        lobbies.set(id, { ...l, ...(patch.seats ? { seats: patch.seats } : {}), ...(patch.watchers ? { watchers: patch.watchers } : {}), ...(patch.state ? { state: patch.state } : {}) });
      },
      bots: {
        take(n) {
          if (bots + n > botCap) return false;
          bots += n;
          return true;
        },
        give(n) {
          bots = Math.max(0, bots - n);
        },
      },
      limits: () => DEFAULT_LIMITS,
    },
    presence: {
      isVoiceMember: () => true,
      socketsOf: (a) => [...sockets.values()].filter((s) => s.accountId === a).map((s) => s.id),
      dnd: () => false,
    },
    prefs: { hidden: () => false },
    ackRttMs: () => 0,
    clock,
    log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined } as unknown as TableApi['log'],
    settings: () => settings,
    pending: { get: () => null, put: () => undefined, remove: () => undefined, olderThan: () => [] } as unknown as TableApi['pending'],
  };

  let socketSeq = 0;
  const harness = {
    api,
    db,
    clock,
    wallet,
    lobbies,
    closed,
    updates,
    get bots() {
      return bots;
    },
    get policy() {
      return policy;
    },
    setSettings(next: Partial<ArcadeSettings>) {
      settings = { ...settings, ...next };
    },
    account(id: string): FakeSocket {
      insertAccount.run(id, id, id);
      wallet.view(id);
      const s: FakeSocket = { id: 'sock' + ++socketSeq, accountId: id, received: [] };
      sockets.set(s.id, s);
      return s;
    },
    drop(s: FakeSocket) {
      sockets.delete(s.id);
      for (const r of rooms.values()) r.delete(s.id);
    },
    lobby(id: string, mode: string, cfg: unknown, host = 'host', channelId = 'ch1'): LobbyRecord {
      const l: LobbyRecord = { id, game: 'lamplight', channelId, mode, cfg, host, seats: [], watchers: [], state: 'open' };
      lobbies.set(id, l);
      return l;
    },
    /** Call a C→S event the way handle() does: schema first, then the handler; the return value is the ack. */
    async call(s: FakeSocket, ev: string, payload: unknown): Promise<Record<string, unknown>> {
      const h = handlers.get(ev);
      if (!h) throw new Error('no handler for ' + ev);
      const parsed = h.schema.safeParse(payload);
      if (!parsed.success) return { ok: false, code: 'invalid' };
      const out = await h.fn({ accountId: s.accountId, socketId: s.id, voiceChannelId: 'ch1' }, parsed.data);
      return out as Record<string, unknown>;
    },
  };
  return harness;
};

export type FakeHarness = ReturnType<typeof makeFakeApi>;
