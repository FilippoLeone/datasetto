/**
 * Glimmer Dash on the server (glimmerhall.md §5.3): a timed tournament inside a hall.
 *
 * - Any hall member opens one: a machine, 3/5/10 minutes, a buy-in of 0/100/500/1,000. One per hall,
 *   at most `limits.dashes` server-wide. Buy-ins move wallet → `e:dash:<id>:<accountId>`.
 * - The lobby stays open up to 60 s or until the host starts; it needs 2 to 8 people. Fewer than 2
 *   at 60 s cancels it and refunds every buy-in.
 * - Each entrant gets 100 spins at a fixed 20-point bet. Dash spins touch no wallet, add nothing to
 *   the pot and write no ledger rows. A Three Vaults trigger opens at once (a server-random door).
 * - It ends when everyone has played or time runs out. The pool pays 100 / 70-30 / 50-30-20, ties
 *   split with the odd chip to whoever finished first, as one `prize` txn; a freeroll awards the
 *   trophy only. The result goes to `arcade_results`.
 *
 * One timer per Dash: the lobby deadline, then the end.
 */
import { randomBytes } from 'node:crypto';
import { dashPayout } from '../core/glimmer/dash.js';
import { shuffleDoors } from '../core/glimmer/feature.js';
import { DASH_BET, DASH_SPINS, machineDef, type MachineIdx } from '../core/glimmer/machines.js';
import { openVault, playFeature, spinBase, type FeatureResult, type Rng } from '../core/glimmer/spin.js';
import {
  DASH_BUYINS,
  DASH_LENGTHS,
  DASH_LOBBY_MS,
  DASH_MAX,
  DASH_MIN,
  DASH_ST,
  encodeStops,
  wireFeature,
  type DashSpinOk,
  type DashView,
  type Refused,
} from '../core/glimmer/wire.js';
import type { CallerCtx, Leg, TableApi } from '../tables/types.js';
import { escrowAccount, walletAccount } from '../wallet.js';

interface Entrant {
  accountId: string;
  slot: number;
  score: number;
  left: number;
  finishedAt: number;
  order: number;
  acks: Map<string, DashSpinOk>;
}

export interface Dash {
  id: string;
  ch: string;
  m: MachineIdx;
  len: number;
  buy: number;
  st: 0 | 1 | 2 | 3;
  host: string;
  deadline: number;
  startedAt: number;
  timer: unknown;
  entrants: Map<string, Entrant>;
  pay: number[] | null;
}

interface HallLike {
  ch: string;
  members: Map<string, { accountId: string; slot: number; away: boolean }>;
}

export interface DashDeps {
  api: TableApi;
  rng: Rng;
  hallOf(ch: string): HallLike | null;
  seatOf(accountId: string): { hall: string | null; slot: number } | null;
  /** Queue a Dash view for every member of the hall in `ch` who is not away. */
  pushDash(ch: string, view: DashView): void;
}

export interface Dashes {
  create(c: CallerCtx, p: { m: MachineIdx; len: number; buy: number }): { ok: true; dash: DashView; bal: number } | Refused;
  join(c: CallerCtx, id: string): { ok: true; bal: number } | Refused;
  leave(c: CallerCtx, id: string): { ok: true; bal: number } | Refused;
  start(c: CallerCtx, id: string): { ok: true } | Refused;
  spin(c: CallerCtx, d: string, sid: string): DashSpinOk | Refused;
  /** The hall's current Dash (lobby, running or the last result). */
  viewFor(ch: string): DashView | null;
  deadlineOf(id: string): number | null;
  /** A Dash is forming or running in this hall (the activity summary says `dash`). */
  live(ch: string): boolean;
  onMemberLeft(ch: string, accountId: string): void;
  voidAll(kind: 'refund' | 'restart-refund'): void;
  stop(): void;
  readonly all: ReadonlyMap<string, Dash>;
}

const refuse = (code: string): Refused => ({ ok: false, code });

export const createDashes = (deps: DashDeps): Dashes => {
  const { api, rng } = deps;
  const clock = api.clock;
  const byId = new Map<string, Dash>();
  const byHall = new Map<string, Dash>();

  const ref = (d: Dash): string => 'dash:' + d.id;
  const open = (d: Dash | undefined): d is Dash => !!d && (d.st === DASH_ST.lobby || d.st === DASH_ST.running);

  const view = (d: Dash): DashView => {
    const s: number[] = [];
    for (const e of [...d.entrants.values()].sort((a, b) => a.order - b.order)) s.push(e.slot, e.score, e.left);
    const host = d.entrants.get(d.host)?.slot ?? -1;
    const v: DashView = { id: d.id, st: d.st, m: d.m, len: d.len, buy: d.buy, host, t: open(d) ? Math.max(0, Math.ceil((d.deadline - clock.now()) / 1000)) : 0, s };
    if (d.pay) v.pay = d.pay;
    return v;
  };

  const push = (d: Dash): void => {
    deps.pushDash(d.ch, view(d));
    api.hub.activityChanged(d.ch);
  };

  const arm = (d: Dash, at: number, fn: () => void): void => {
    if (d.timer !== null) clock.clearTimeout(d.timer);
    d.timer = clock.setTimeout(() => {
      d.timer = null;
      fn();
    }, Math.max(0, at - clock.now()));
  };

  const balance = (accountId: string): number => api.wallet.view(accountId).bal;

  const escrowIn = (d: Dash, accountId: string): boolean => {
    if (d.buy === 0) return true;
    const t = api.wallet.transfer(
      'buyin',
      ref(d),
      accountId,
      'db:' + d.id + ':' + accountId + ':' + d.entrants.size,
      [
        { account: walletAccount(accountId), delta: -d.buy },
        { account: escrowAccount(ref(d), accountId), delta: d.buy },
      ],
      { min: { [walletAccount(accountId)]: d.buy } },
    );
    return t.ok;
  };

  const escrowOut = (d: Dash, accountId: string, kind: 'refund' | 'restart-refund'): void => {
    if (d.buy === 0) return;
    const rows = api.wallet.escrowRows(ref(d)).filter((r) => r.account === accountId);
    for (const row of rows) {
      api.wallet.transfer(kind, ref(d), 'system', kind + ':' + d.id + ':' + accountId + ':' + clock.now(), [
        { account: escrowAccount(ref(d), accountId), delta: -row.amount },
        { account: walletAccount(accountId), delta: row.amount },
      ]);
    }
  };

  const forget = (d: Dash): void => {
    if (d.timer !== null) clock.clearTimeout(d.timer);
    d.timer = null;
    byId.delete(d.id);
  };

  const cancel = (d: Dash, kind: 'refund' | 'restart-refund'): void => {
    if (!open(d)) return;
    if (d.buy > 0) api.wallet.refund(ref(d), kind);
    d.st = DASH_ST.void;
    forget(d);
    push(d);
  };

  const finish = (d: Dash): void => {
    if (d.st !== DASH_ST.running) return;
    const now = clock.now();
    for (const e of d.entrants.values()) if (e.left > 0) e.finishedAt = now;
    const entrants = [...d.entrants.values()];
    const pool = d.buy * entrants.length;
    const places = dashPayout(
      pool,
      entrants.map((e) => ({ key: e.accountId, score: e.score, finishedAt: e.finishedAt, order: e.order })),
    );
    const pay: number[] = [];
    api.wallet.tx(() => {
      if (pool > 0) {
        const legs: Leg[] = entrants.map((e) => ({ account: escrowAccount(ref(d), e.accountId), delta: -d.buy }));
        for (const p of places) if (p.prize > 0) legs.push({ account: walletAccount(p.key), delta: p.prize });
        const t = api.wallet.transfer('prize', ref(d), 'system', 'dp:' + d.id, legs);
        if (!t.ok) throw new Error('glimmer: Dash payout refused: ' + t.code);
      }
      for (const p of places) {
        api.stats.add(p.key, 'glimmer', 'dash.played', 1);
        if (p.place === 1) api.stats.add(p.key, 'glimmer', 'dash.wins', 1);
      }
      api.results.record(
        { game: 'glimmer', mode: 'dash', channelId: d.ch, humans: entrants.length, startedAt: d.startedAt, endedAt: now, summary: { m: d.m, len: d.len, buy: d.buy, n: entrants.length } },
        places.map((p) => ({ accountId: p.key, place: p.place, score: p.score, chipsDelta: p.prize - d.buy })),
      );
    });
    for (const p of places) {
      const slot = d.entrants.get(p.key)?.slot ?? -1;
      if (p.prize > 0 || (pool === 0 && p.place === 1)) pay.push(slot, p.prize);
    }
    d.pay = pay;
    d.st = DASH_ST.done;
    forget(d);
    push(d);
  };

  const startNow = (d: Dash): void => {
    const now = clock.now();
    d.st = DASH_ST.running;
    d.startedAt = now;
    d.deadline = now + d.len * 60_000;
    arm(d, d.deadline, () => finish(d));
    push(d);
  };

  const lobbyTimeout = (d: Dash): void => {
    if (d.st !== DASH_ST.lobby) return;
    if (d.entrants.size < DASH_MIN) cancel(d, 'refund');
    else startNow(d);
  };

  const memberOf = (c: CallerCtx): { ch: string; slot: number } | null => {
    const seat = deps.seatOf(c.accountId);
    if (!seat || !seat.hall) return null;
    return { ch: seat.hall, slot: seat.slot };
  };

  const newId = (): string => {
    for (let i = 0; i < 8; i += 1) {
      const id = randomBytes(4).toString('base64url').slice(0, 6);
      if (!byId.has(id)) return id;
    }
    return randomBytes(6).toString('base64url').slice(0, 8);
  };

  const entrantOf = (d: Dash, accountId: string, slot: number): Entrant => ({ accountId, slot, score: 0, left: DASH_SPINS, finishedAt: Infinity, order: d.entrants.size, acks: new Map() });

  return {
    all: byId,
    create(c, p) {
      const at = memberOf(c);
      if (!at) return refuse('nohall');
      if (!DASH_LENGTHS.includes(p.len as 3) || !DASH_BUYINS.includes(p.buy as 0)) return refuse('invalid');
      if (open(byHall.get(at.ch))) return refuse('state');
      if ([...byId.values()].filter(open).length >= api.hub.limits().dashes) return refuse('limit');
      if (balance(c.accountId) < p.buy) return refuse('funds');
      const now = clock.now();
      const d: Dash = { id: newId(), ch: at.ch, m: p.m, len: p.len, buy: p.buy, st: DASH_ST.lobby, host: c.accountId, deadline: now + DASH_LOBBY_MS, startedAt: 0, timer: null, entrants: new Map(), pay: null };
      if (!escrowIn(d, c.accountId)) return refuse('funds');
      d.entrants.set(c.accountId, entrantOf(d, c.accountId, at.slot));
      byId.set(d.id, d);
      byHall.set(at.ch, d);
      arm(d, d.deadline, () => lobbyTimeout(d));
      push(d);
      return { ok: true, dash: view(d), bal: balance(c.accountId) };
    },
    join(c, id) {
      const d = byId.get(id);
      const at = memberOf(c);
      if (!d) return refuse('gone');
      if (!at || at.ch !== d.ch) return refuse('nohall');
      if (d.st !== DASH_ST.lobby) return refuse('state');
      if (d.entrants.has(c.accountId)) return { ok: true, bal: balance(c.accountId) };
      if (d.entrants.size >= DASH_MAX) return refuse('full');
      if (!escrowIn(d, c.accountId)) return refuse('funds');
      d.entrants.set(c.accountId, entrantOf(d, c.accountId, at.slot));
      push(d);
      return { ok: true, bal: balance(c.accountId) };
    },
    leave(c, id) {
      const d = byId.get(id);
      if (!d || !d.entrants.has(c.accountId)) return refuse('gone');
      // In a running Dash an entry stays valid until it ends.
      if (d.st === DASH_ST.lobby) {
        escrowOut(d, c.accountId, 'refund');
        d.entrants.delete(c.accountId);
        if (d.entrants.size === 0) cancel(d, 'refund');
        else {
          if (d.host === c.accountId) d.host = [...d.entrants.values()].sort((a, b) => a.order - b.order)[0]?.accountId ?? d.host;
          push(d);
        }
      }
      return { ok: true, bal: balance(c.accountId) };
    },
    start(c, id) {
      const d = byId.get(id);
      if (!d) return refuse('gone');
      if (d.host !== c.accountId) return refuse('host');
      if (d.st !== DASH_ST.lobby) return refuse('state');
      if (d.entrants.size < DASH_MIN) return refuse('few');
      startNow(d);
      return { ok: true };
    },
    spin(c, did, sid) {
      const d = byId.get(did);
      if (!d) return refuse('gone');
      const e = d.entrants.get(c.accountId);
      if (!e) return refuse('state');
      const seen = e.acks.get(sid);
      if (seen) return seen;
      if (d.st !== DASH_ST.running || e.left <= 0) return refuse('state');
      const def = machineDef(d.m);
      const base = spinBase(def, DASH_BET, rng);
      let f: FeatureResult | null = null;
      if (base.trigger) {
        // In a Dash the Three Vaults open at once: the server draws the door.
        f = def.feature.kind === 'vault' ? openVault(def, DASH_BET, rng, shuffleDoors(rng), rng(3)) : playFeature(def, DASH_BET, rng);
      }
      e.score += base.win + (f?.win ?? 0);
      e.left -= 1;
      if (e.left === 0) e.finishedAt = clock.now();
      const ack: DashSpinOk = { ok: true, id: sid, st: encodeStops(base.stops), w: base.win, sc: e.score, left: e.left };
      if (f) ack.f = wireFeature(f.kind, f);
      e.acks.set(sid, ack);
      if (e.acks.size > 8) e.acks.delete(e.acks.keys().next().value as string);
      if ([...d.entrants.values()].every((x) => x.left === 0)) finish(d);
      else push(d);
      return ack;
    },
    viewFor(ch) {
      const d = byHall.get(ch);
      return d ? view(d) : null;
    },
    deadlineOf(id) {
      const d = byId.get(id);
      return d && open(d) ? d.deadline : null;
    },
    live: (ch) => open(byHall.get(ch)),
    onMemberLeft(ch, accountId) {
      const d = byHall.get(ch);
      if (!d) return;
      // Leaving the call: out of a forming Dash (buy-in back); an entry in a running Dash stays.
      if (d.st === DASH_ST.lobby && d.entrants.has(accountId)) {
        escrowOut(d, accountId, 'refund');
        d.entrants.delete(accountId);
        if (d.entrants.size === 0) cancel(d, 'refund');
        else {
          if (d.host === accountId) d.host = [...d.entrants.values()].sort((a, b) => a.order - b.order)[0]?.accountId ?? d.host;
          push(d);
        }
      }
      if (!deps.hallOf(ch)) byHall.delete(ch);
    },
    voidAll(kind) {
      for (const d of [...byId.values()]) cancel(d, kind);
    },
    stop() {
      for (const d of byId.values()) if (d.timer !== null) clock.clearTimeout(d.timer);
    },
  };
};
