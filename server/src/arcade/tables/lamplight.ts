/**
 * Lamplight Hold'em on the server (lamplight.md §5, §7–§12): event-driven tables on the main socket's
 * table lane, no tick. The server shuffles with `crypto.randomInt`, deals, runs the clocks, validates
 * every intent with the shared engine and moves chips through the wallet. Only `core/lamplight/views`
 * serializes what clients see: public events to the table room, each player's own hole cards (with
 * their salts) to that account's room, and snaps. A per-hand deck commitment (salted leaves, a root
 * sent before any card is visible) lets players check afterwards that the deck did not change.
 *
 * One timer per table, armed for the earliest of: the action deadline, a bot's act time, the next
 * runout street, the next hand, a coalesced seat update or an idle check. Nothing is armed while no
 * hand can run.
 */
import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import { z } from 'zod';
import { b64url } from '../core/bytes.js';
import { BOT_LEVELS, BOT_TRIALS, BOTS, CHEAP_TRIALS, createThinker, SLICE_TRIALS, thinkMs } from '../core/lamplight/bots.js';
import { newDeck, shuffle, type Card } from '../core/lamplight/cards.js';
import {
  act,
  advance,
  canStartHand,
  createTable,
  creditDeadline,
  dealPositions,
  handNet,
  pendingDelay,
  seat as seatPlayer,
  setLevel,
  showUncontested,
  startBank,
  startHand,
  timeout,
  unseat,
  updateSeat,
  voidHand,
  type Action,
  type BotLevel,
  type EngineEvent,
  type Format,
  type PostChoice,
  type TableState,
  type Tier,
} from '../core/lamplight/engine.js';
import { revealPositions, buildProof, commitSync } from '../core/lamplight/proof.js';
import { BUY_IN_BB, cashLevel, CUP_BUY_INS, levelAt, tableConfig, TIER_BLINDS, tierLabel, TIERS, TRIO_BUY_INS } from '../core/lamplight/schedule.js';
import { VERSION } from '../core/lamplight/version.js';
import { holeEvent, publicEvent, snapFor, stampMs, type WireOut } from '../core/lamplight/views.js';
import type { DB } from '../../db/index.js';
import { escrowAccount, walletAccount } from '../wallet.js';
import { statBoard, type BoardDef } from '../stats.js';
import { abandonedPrizes, createTournament, finalPlaces, finalPrizes, recordBusts, settle, type Tournament } from './cup.js';
import { drawTrio, LAMPLIGHT_DEFAULTS, lamplightSettingsSchema, settingsOf } from './trio.js';
import type { ActivityEntry, LedgerAccount, LobbyRecord, TableApi, TableGame, TableGameDef } from './types.js';

// ------------------------------------------------------------------------------------------------
// Constants (lamplight.md §5, §9.2)
// ------------------------------------------------------------------------------------------------

export const RING_SIZE = 64;
export const ACCEPT_LATE_MS = 500;
export const QUEUE_CREDIT_AFTER_MS = 250;
export const QUEUE_CREDIT_MAX_MS = 3000;
export const DISCONNECT_SIT_OUT_HANDS = 2;
export const RELEASE_DISCONNECTED_MS = 5 * 60_000;
export const RELEASE_SITTING_OUT_MS = 10 * 60_000;
export const IDLE_EMPTY_MS = 2 * 60_000;
export const IDLE_ALL_OUT_MS = 5 * 60_000;
export const RETURN_STACK_MS = 10 * 60_000;
export const ABANDON_MS = 10 * 60_000;
export const EMOTE_GAP_MS = 3000;
export const SEAT_COALESCE_MS = 2000;
export const BOT_CPU_NS = 2_000_000n;
export const BOT_MAX_BUYINS = 3;
export const TRIO_DEAL_MS = 3500;
export const PROOF_DAYS_MS = 30 * 86_400_000;
export const SLOW_INTENT_NS = 20_000_000n;
export const SPECTATORS = 8;

const ROOM = (t: string): string => 'table:' + t;

// ------------------------------------------------------------------------------------------------
// Hand rows (arcade_poker_hands)
// ------------------------------------------------------------------------------------------------

export interface HandRow {
  tableRef: string;
  handNo: number;
  format: Format;
  /** Human account ids dealt in. */
  seats: string[];
  root: Uint8Array;
  secret: Uint8Array;
  deck: Uint8Array;
  record: HandRecordJson;
  createdAt: number;
}

export interface HandRecordJson {
  no: number;
  f: Format;
  tier: Tier | null;
  lv: [number, number, number];
  btn: number;
  /** [seat, accountId, botId, startStack] */
  seats: [number, string | null, string | null, number][];
  /** Seats in deal order (positions of the deck proof). */
  dealt: number[];
  acts: [number, number, string, number][];
  board: Card[];
  pots: { a: number; w: number[] }[];
  net: [number, number][];
  /** Hands turned face up: [seat, card, card]. */
  shown: [number, Card, Card][];
  cr: string;
}

export interface HandStore {
  insert(row: HandRow): void;
  page(accountId: string, before: number | null, since: number, limit: number): { id: number; row: HandRow }[];
  get(tableRef: string, handNo: number): HandRow | null;
}

/** Hand rows in SQLite when the platform hands us the database, otherwise in memory (tests, M1). */
export const createHandStore = (db: DB | null): HandStore => {
  if (!db) {
    const rows: { id: number; row: HandRow }[] = [];
    return {
      insert(row) {
        rows.push({ id: rows.length + 1, row });
        if (rows.length > 4000) rows.splice(0, rows.length - 4000);
      },
      page(accountId, before, since, limit) {
        return rows
          .filter((r) => r.row.seats.includes(accountId) && r.row.createdAt >= since && (before === null || r.id < before))
          .sort((a, b) => b.id - a.id)
          .slice(0, limit);
      },
      get: (ref, no) => rows.find((r) => r.row.tableRef === ref && r.row.handNo === no)?.row ?? null,
    };
  }
  const ins = db.prepare(
    'INSERT INTO arcade_poker_hands (table_ref, hand_no, format, seats, commit_root, hand_secret, deck, record, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const one = db.prepare('SELECT * FROM arcade_poker_hands WHERE table_ref = ? AND hand_no = ? ORDER BY id DESC LIMIT 1');
  const list = db.prepare(
    "SELECT * FROM arcade_poker_hands WHERE created_at >= ? AND (? IS NULL OR id < ?) AND EXISTS (SELECT 1 FROM json_each(seats) WHERE value = ?) ORDER BY id DESC LIMIT ?",
  );
  type Raw = { id: number; table_ref: string; hand_no: number; format: Format; seats: string; commit_root: Buffer; hand_secret: Buffer; deck: Buffer; record: string; created_at: number };
  const fromRaw = (r: Raw): HandRow => ({
    tableRef: r.table_ref,
    handNo: r.hand_no,
    format: r.format,
    seats: JSON.parse(r.seats) as string[],
    root: new Uint8Array(r.commit_root),
    secret: new Uint8Array(r.hand_secret),
    deck: new Uint8Array(r.deck),
    record: JSON.parse(r.record) as HandRecordJson,
    createdAt: r.created_at,
  });
  return {
    insert(row) {
      ins.run(row.tableRef, row.handNo, row.format, JSON.stringify(row.seats), Buffer.from(row.root), Buffer.from(row.secret), Buffer.from(row.deck), JSON.stringify(row.record), row.createdAt);
    },
    page(accountId, before, since, limit) {
      return (list.all(since, before, before, accountId, limit) as Raw[]).map((r) => ({ id: r.id, row: fromRaw(r) }));
    },
    get(ref, no) {
      const r = one.get(ref, no) as Raw | undefined;
      return r ? fromRaw(r) : null;
    },
  };
};

// ------------------------------------------------------------------------------------------------
// Deck commitment (lamplight.md §8.2)
// ------------------------------------------------------------------------------------------------

const sha256 = (d: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(d).digest());
const saltsOf = (secret: Uint8Array): Uint8Array[] => {
  const out: Uint8Array[] = [];
  for (let i = 0; i < 52; i++) out.push(new Uint8Array(createHmac('sha256', secret).update(Uint8Array.of(i)).digest()).subarray(0, 16));
  return out;
};

interface Commitment {
  secret: Uint8Array;
  salts: Uint8Array[];
  leaves: Uint8Array;
  root: Uint8Array;
  cr: string;
}

const commitDeck = (deck: readonly Card[], secret: Uint8Array): Commitment => {
  const salts = saltsOf(secret);
  const { leaves, root } = commitSync(deck, salts, sha256);
  return { secret, salts, leaves, root, cr: b64url(root) };
};

/** A proof for `accountId`'s view of a stored hand: board, own cards, shown hands. */
export const proofFor = (row: HandRow, accountId: string): { ok: true; root: string; L: string; rv: { i: number; c: number; s: string }[] } | null => {
  const rec = row.record;
  const mine = rec.seats.find((s) => s[1] === accountId);
  if (!mine) return null;
  const salts = saltsOf(row.secret);
  const deck = Array.from(row.deck);
  const { leaves, root } = commitSync(deck, salts, sha256);
  const positions = revealPositions({ dealt: rec.dealt, board: rec.board.length, shown: rec.shown.map((s) => s[0]), viewer: mine[0] });
  const proof = buildProof(leaves, root, positions.map((i) => ({ i, c: deck[i], salt: salts[i] })));
  return { ok: true, ...proof };
};

/** A stored hand as `accountId` may see it: own cards and shown ones only. */
export const recordFor = (row: HandRow, accountId: string): Record<string, unknown> | null => {
  const rec = row.record;
  const mine = rec.seats.find((s) => s[1] === accountId);
  if (!mine) return null;
  const n = rec.dealt.length;
  const k = rec.dealt.indexOf(mine[0]);
  const own = k >= 0 ? [row.deck[k], row.deck[n + k]] : null;
  return { t: row.tableRef, h: row.handNo, at: row.createdAt, ...rec, own };
};

// ------------------------------------------------------------------------------------------------
// Settings, config and boards
// ------------------------------------------------------------------------------------------------

const cfgSchema = z
  .object({
    tier: z.enum(TIERS as unknown as [Tier, ...Tier[]]).optional(),
    players: z.coerce.number().int().min(2).max(9).optional(),
    seats: z.coerce.number().int().min(2).max(9).optional(),
    bots: z.union([z.enum(BOT_LEVELS as unknown as [BotLevel, ...BotLevel[]]), z.literal('off'), z.null()]).optional(),
    buyIn: z.coerce.number().int().optional(),
  })
  .passthrough();

export interface LamplightCfg {
  tier: Tier;
  seats: number;
  bots: BotLevel | null;
  buyIn: number;
}

/** A lobby's cfg for a mode; null when it is not allowed (bad buy-in, bots where they may not sit). */
export const parseCfg = (mode: string, raw: unknown): LamplightCfg | null => {
  const p = cfgSchema.safeParse(raw ?? {});
  if (!p.success) return null;
  const c = p.data;
  const bots = c.bots && c.bots !== 'off' ? c.bots : null;
  if (mode === 'open') {
    const tier = c.tier ?? 'pebble';
    return { tier, seats: c.seats ?? c.players ?? 6, bots, buyIn: 0 };
  }
  if (mode === 'cup') {
    const buyIn = c.buyIn ?? 2000;
    if (!(CUP_BUY_INS as readonly number[]).includes(buyIn)) return null;
    return { tier: 'pebble', seats: c.seats ?? c.players ?? 6, bots, buyIn };
  }
  if (mode === 'trio') {
    const buyIn = c.buyIn ?? 1000;
    if (!(TRIO_BUY_INS as readonly number[]).includes(buyIn)) return null;
    return { tier: 'pebble', seats: 3, bots, buyIn };
  }
  return null;
};

/** ISO week key, e.g. 2026-W43 (the weekly-net board). */
export const isoWeek = (ms: number): string => {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / 604_800_000 - ((firstThursday.getUTCDay() + 6) % 7 - 3) / 7);
  return thursday.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
};

const BOARDS: readonly BoardDef[] = [
  {
    id: 'net-week',
    label: 'Net chips this week',
    query: (db, limit) =>
      db
        .prepare('SELECT account_id AS accountId, value FROM arcade_stats WHERE game = ? AND stat = ? ORDER BY value DESC, updated_at ASC LIMIT ?')
        .all('lamplight', 'net:' + isoWeek(Date.now()), Math.max(1, Math.min(100, limit))) as { accountId: string; value: number }[],
  },
  statBoard('lamplight', 'net:all', 'net-all', 'Net chips, all time'),
  statBoard('lamplight', 'cup_wins', 'cup-wins', 'Lamplight Cup wins'),
  statBoard('lamplight', 'trio_best', 'trio-best', 'Best Firefly prize'),
  statBoard('lamplight', 'pot_best', 'pot-best', 'Biggest pot won'),
];

// ------------------------------------------------------------------------------------------------
// Tables
// ------------------------------------------------------------------------------------------------

interface SeatInfo {
  level: BotLevel | null;
  buyIns: number;
  /** Fold at your next turn and leave after the hand (cash). */
  leaveNow: boolean;
  leaveAfter: boolean;
  disconnectedAt: number | null;
  handsDisconnected: number;
  sitOutSince: number | null;
  lastAct: { h: number; q: number; k: string; a: number | null } | null;
  emoteAt: number;
  /** A seat event is due (coalesced connection changes). */
  dirtyAt: number | null;
}

const freshInfo = (): SeatInfo => ({
  level: null,
  buyIns: 0,
  leaveNow: false,
  leaveAfter: false,
  disconnectedAt: null,
  handsDisconnected: 0,
  sitOutSince: null,
  lastAct: null,
  emoteAt: 0,
  dirtyAt: null,
});

interface RingEntry {
  q: number;
  out: WireOut;
  /** For `hand` events: the hand number (the requester's hole follows it in a replay). */
  hand: number | null;
}

type Wake = 'clock' | 'advance' | 'nextHand' | 'botAct' | 'seats' | 'idle' | 'trioDeal';

interface Table {
  id: string;
  channelId: string;
  mode: Format;
  ref: string;
  host: string;
  cfg: LamplightCfg;
  state: TableState;
  info: SeatInfo[];
  ring: RingEntry[];
  commit: Commitment | null;
  /** Deck of the current hand (kept for the hand row). */
  deck: Card[];
  holes: Map<number, { c: [Card, Card]; s: [string, string] }>;
  timer: unknown;
  wake: { at: number; what: Wake } | null;
  watchers: Set<string>;
  away: Map<string, number>;
  nextHandAt: number;
  handOpen: boolean;
  bot: { key: string; startedAt: number; thinkMs: number; action: Action | null; readyAt: number; cancel: () => void } | null;
  credited: { key: string; ms: number };
  closed: boolean;
  emptySince: number | null;
  allOutSince: number | null;
  tournament: Tournament | null;
  started: boolean;
  /** Registrants before the start (Cup and Trio). */
  registered: string[];
  trioDealAt: number;
  createdAt: number;
  showUntil: number;
  slow: number;
}

export interface LamplightDeps {
  /** Uniform integer in [0, n) for the shuffle and the first button (crypto.randomInt by default). */
  randInt?(n: number): number;
  /** 32 random bytes for the hand secret (crypto.randomBytes by default). */
  secret?(): Uint8Array;
  /** Uniform integer in [0, 1,000,000) for the Firefly draw. */
  trioDraw?(): number;
  /** The database for hand rows (the platform's TableApi from M2 carries it as `db`). */
  db?: DB | null;
}

export interface LamplightGame extends TableGame {
  /** For tests and admin: the open tables. */
  readonly tables: ReadonlyMap<string, Table>;
}

export const createLamplight = (api: TableApi, deps: LamplightDeps = {}): LamplightGame => {
  const clock = api.clock;
  const rand = deps.randInt ?? ((n: number) => randomInt(n));
  const newSecret = deps.secret ?? (() => new Uint8Array(randomBytes(32)));
  const store = createHandStore(deps.db ?? (api as unknown as { db?: DB }).db ?? null);
  const tables = new Map<string, Table>();
  /** Which table each socket watches (one per socket). */
  const watching = new Map<string, string>();
  /** One Lamplight seat or registration per account. */
  const seatOf = new Map<string, { t: string; seat: number }>();
  /** Cash stacks of players who left, for the 10-minute return rule. */
  const leftWith = new Map<string, { t: string; stack: number; at: number }>();
  let botsInUse = 0;

  const settings = () => settingsOf(api.settings().gameSettings.lamplight ?? LAMPLIGHT_DEFAULTS);
  const humanConnected = (tb: Table): boolean => tb.state.seats.some((s) => s.player?.accountId && s.connected);

  // -------------------------------------------------------------- emitting
  const holeFor = (tb: Table, seat: number): { t: string; no: number; c: [Card, Card]; s: [string, string] } | null => {
    const h = holeEvent(tb.state, seat, tb.id);
    const hole = tb.holes.get(seat);
    return h && hole ? { ...h, s: hole.s } : null;
  };

  const snapForSocket = (tb: Table, accountId: string | null): Record<string, unknown> => {
    const me = accountId ? (tb.state.seats.find((s) => s.player?.accountId === accountId)?.seat ?? null) : null;
    const snap = snapFor(tb.state, me, tb.id, clock.now()) as unknown as Record<string, unknown>;
    if (me !== null && tb.holes.has(me) && tb.state.seats[me].inHand) snap.s = tb.holes.get(me)?.s;
    if (tb.commit && tb.state.hand && tb.state.hand.street !== 'done') snap.cr = tb.commit.cr;
    if (tb.tournament) {
      snap.bi = tb.tournament.buyIn;
      snap.pay = tb.tournament.prizes;
      snap.pool = tb.tournament.pool;
      if (tb.tournament.mult !== null) snap.mult = tb.tournament.mult;
    } else if (tb.mode !== 'open') {
      snap.bi = tb.cfg.buyIn;
      snap.reg = tb.registered.length;
    }
    return snap;
  };

  const sendSnap = (tb: Table, socketId: string, accountId: string | null): void => {
    const hand = tb.state.hand;
    const dl = hand && hand.toAct >= 0 ? hand.deadline : null;
    api.emit(socketId, 'lamplight:snap', snapForSocket(tb, accountId), {
      queue: 'lamplight',
      stamp: (data, sentAt) => {
        const d = data as { h?: { ms?: number } | null };
        if (dl !== null && d.h) d.h.ms = Math.max(0, Math.round(dl - sentAt));
        return d;
      },
    });
  };

  const emitEvents = (tb: Table, events: readonly EngineEvent[]): void => {
    for (const e of events) {
      const out = publicEvent(e, tb.id);
      if (e.ev === 'hand' && tb.commit) out.data.cr = tb.commit.cr;
      tb.ring.push({ q: e.q, out, hand: e.ev === 'hand' ? e.no : null });
      if (tb.ring.length > RING_SIZE) tb.ring.shift();
      const turnKey = (e.ev === 'hand' || e.ev === 'act' || e.ev === 'street') && e.n >= 0 ? tb.state.hand?.handNo + ':' + e.q : null;
      api.emitRoom(ROOM(tb.id), out.name, () => out.data, {
        queue: 'lamplight',
        stamp: (data, sentAt) => stampMs(data as Record<string, unknown>, out.dl, sentAt),
        onSent: turnKey ? (waited) => queueCredit(tb, turnKey, waited) : undefined,
      });
      if (e.ev === 'hand') {
        for (const s of tb.state.seats) {
          if (!s.inHand || !s.player?.accountId) continue;
          const hole = holeFor(tb, s.seat);
          if (hole) api.emitAccount(s.player.accountId, 'lamplight:hole', hole, { queue: 'lamplight' });
        }
      }
    }
  };

  /** A turn's event waited in the queue: extend that turn's deadline by the wait (≤ 3 s per turn). */
  const queueCredit = (tb: Table, key: string, waited: number): void => {
    const hand = tb.state.hand;
    if (!hand || waited <= QUEUE_CREDIT_AFTER_MS || hand.toAct < 0 || hand.handNo + ':' + hand.turnQ !== key) return;
    if (tb.credited.key !== key) tb.credited = { key, ms: 0 };
    const add = Math.min(QUEUE_CREDIT_MAX_MS - tb.credited.ms, Math.round(waited));
    if (add <= 0) return;
    tb.credited.ms += add;
    emitEvents(tb, creditDeadline(tb.state, add));
    arm(tb);
  };

  // -------------------------------------------------------------- table life
  const activityLabel = (tb: Table): string =>
    tb.mode === 'open' ? tierLabel(tb.cfg.tier) : (tb.mode === 'cup' ? 'Cup ' : 'Trio ') + (tb.cfg.buyIn >= 1000 ? tb.cfg.buyIn / 1000 + 'k' : String(tb.cfg.buyIn));

  const ensureTable = (lobby: LobbyRecord): Table | null => {
    const existing = tables.get(lobby.id);
    if (existing) return existing.closed ? null : existing;
    const cfg = parseCfg(lobby.mode, lobby.cfg);
    if (!cfg) return null;
    const mode = lobby.mode as Format;
    const config = tableConfig({ format: mode, tier: cfg.tier, seats: cfg.seats, bots: cfg.bots });
    const level = mode === 'open' ? cashLevel(cfg.tier) : levelAt(mode, { elapsedMs: 0, startedAt: clock.now() });
    const tb: Table = {
      id: lobby.id,
      channelId: lobby.channelId,
      mode,
      ref: (mode === 'open' ? 'lamplight:' : mode + ':') + lobby.id,
      host: lobby.host,
      cfg,
      state: createTable(lobby.id, config, level),
      info: Array.from({ length: config.seats }, freshInfo),
      ring: [],
      commit: null,
      deck: [],
      holes: new Map(),
      timer: null,
      wake: null,
      watchers: new Set(),
      away: new Map(),
      nextHandAt: 0,
      handOpen: false,
      bot: null,
      credited: { key: '', ms: 0 },
      closed: false,
      emptySince: clock.now(),
      allOutSince: null,
      tournament: null,
      started: mode === 'open',
      registered: [],
      trioDealAt: 0,
      createdAt: clock.now(),
      showUntil: 0,
      slow: 0,
    };
    tables.set(lobby.id, tb);
    if (mode === 'open' && cfg.bots) seatBots(tb);
    return tb;
  };

  /** Online cash bots: Pebble and Cobble only, house-backed, within the server-wide cap. */
  const seatBots = (tb: Table): void => {
    if (!tb.cfg.bots || !botsAllowed(tb)) return;
    const want = Math.min(tb.state.seats.length - 1, 3);
    for (let n = tb.state.seats.length - 1, placed = 0; n >= 0 && placed < want; n--) {
      if (tb.state.seats[n].player) continue;
      if (!api.hub.bots.take(1)) break;
      botsInUse++;
      const stack = BUY_IN_BB.default * TIER_BLINDS[tb.cfg.tier].bb;
      const id = BOTS[(n + tb.id.length) % BOTS.length].id;
      const r = api.wallet.transfer('buyin', tb.ref, 'system', 'bot:' + tb.id + ':' + n + ':1', [
        { account: 'house' as LedgerAccount, delta: -stack },
        { account: escrowAccount(tb.ref, 'bot:' + n), delta: stack },
      ]);
      if (!r.ok) {
        api.hub.bots.give(1);
        botsInUse--;
        continue;
      }
      seatPlayer(tb.state, n, { accountId: null, botId: id, avatarSeed: n * 977 }, stack);
      tb.state.seats[n].status = 'active';
      tb.state.seats[n].post = null;
      tb.info[n] = { ...freshInfo(), level: tb.cfg.bots, buyIns: 1 };
      placed++;
    }
  };

  const botsAllowed = (tb: Table): boolean => api.settings().serverBots && (tb.mode === 'cup' || tb.cfg.tier === 'pebble' || tb.cfg.tier === 'cobble');

  /** Cash a bot out (or re-buy it, at most three buy-ins per table session). */
  const botCashout = (tb: Table, n: number): void => {
    const s = tb.state.seats[n];
    if (!s.player?.botId) return;
    const stack = s.stack;
    if (stack > 0) api.wallet.transfer('cashout', tb.ref, 'system', 'botout:' + tb.id + ':' + n + ':' + tb.state.handsPlayed, [
      { account: escrowAccount(tb.ref, 'bot:' + n), delta: -stack },
      { account: 'house' as LedgerAccount, delta: stack },
    ]);
    emitEvents(tb, unseat(tb.state, n).events);
    tb.info[n] = freshInfo();
    api.hub.bots.give(1);
    botsInUse--;
  };

  const cashout = (tb: Table, n: number, reason: string): void => {
    const s = tb.state.seats[n];
    const a = s.player?.accountId;
    if (!a) return;
    if (tb.mode === 'open') {
      const stack = s.stack;
      if (stack > 0) {
        api.wallet.transfer('cashout', tb.ref, a, 'out:' + tb.id + ':' + n + ':' + tb.state.handsPlayed + ':' + reason, [
          { account: escrowAccount(tb.ref, a), delta: -stack },
          { account: walletAccount(a), delta: stack },
        ]);
        leftWith.set(a, { t: tb.id, stack, at: clock.now() });
      }
    }
    seatOf.delete(a);
    emitEvents(tb, unseat(tb.state, n).events);
    tb.info[n] = freshInfo();
    api.hub.activityChanged(tb.channelId);
  };

  const closeTable = (tb: Table, reason: string): void => {
    if (tb.closed) return;
    disarm(tb);
    tb.bot?.cancel();
    for (const s of tb.state.seats) {
      if (s.player?.botId) botCashout(tb, s.seat);
      else if (s.player?.accountId && tb.mode === 'open') cashout(tb, s.seat, 'close');
    }
    if (tb.mode !== 'open' && tb.tournament && !tb.tournament.ended) {
      api.wallet.refund(tb.ref, 'refund');
      tb.tournament.ended = true;
    } else if (tb.mode !== 'open' && !tb.started) api.wallet.refund(tb.ref, 'refund');
    for (const a of tb.registered) if (seatOf.get(a)?.t === tb.id) seatOf.delete(a);
    for (const s of tb.state.seats) if (s.player?.accountId && seatOf.get(s.player.accountId)?.t === tb.id) seatOf.delete(s.player.accountId);
    tb.closed = true;
    for (const sid of tb.watchers) {
      api.rooms.leave(sid, ROOM(tb.id));
      if (watching.get(sid) === tb.id) watching.delete(sid);
    }
    tables.delete(tb.id);
    api.hub.close(tb.id, reason);
    api.hub.activityChanged(tb.channelId);
  };

  // -------------------------------------------------------------- the clock
  const disarm = (tb: Table): void => {
    if (tb.timer !== null) clock.clearTimeout(tb.timer);
    tb.timer = null;
    tb.wake = null;
  };

  const setWake = (tb: Table, at: number, what: Wake): void => {
    if (tb.wake && tb.wake.at <= at) return;
    if (tb.timer !== null) clock.clearTimeout(tb.timer);
    tb.wake = { at, what };
    tb.timer = clock.setTimeout(() => onWake(tb), Math.max(0, at - clock.now()));
  };

  const humanDealable = (tb: Table): boolean =>
    tb.state.seats.some((s) => s.player?.accountId && s.stack > 0 && (s.status === 'active' || s.status === 'waiting' || (tb.mode !== 'open' && s.status === 'sittingOut')));

  /** Run what is due now, then arm one timer for the next thing. */
  const arm = (tb: Table): void => {
    if (tb.closed) return;
    disarm(tb);
    const now = clock.now();
    const hand = tb.state.hand;
    for (let guard = 0; guard < 16; guard++) {
      const delay = pendingDelay(tb.state);
      if (delay === null) break;
      if (delay > 0) {
        setWake(tb, now + delay, 'advance');
        break;
      }
      runAdvance(tb);
    }
    if (tb.closed) return;
    for (const info of tb.info) if (info.dirtyAt !== null) setWake(tb, info.dirtyAt, 'seats');
    if (!hand || hand.street === 'done' || !tb.state.hand || tb.state.hand.street === 'done') {
      if (tb.trioDealAt > 0) setWake(tb, tb.trioDealAt, 'trioDeal');
      else if (tb.started && canStartHand(tb.state) && humanDealable(tb)) setWake(tb, Math.max(now, tb.nextHandAt), 'nextHand');
      setIdleWake(tb, now);
      return;
    }
    const h = tb.state.hand;
    if (h.pending) return;
    const seatNo = h.toAct;
    if (seatNo < 0) return;
    const s = tb.state.seats[seatNo];
    const info = tb.info[seatNo];
    if (s.player?.botId) {
      thinkBot(tb, seatNo);
      if (tb.bot?.action) setWake(tb, tb.bot.readyAt, 'botAct');
      return;
    }
    // Sitting out (two timeouts, or a tournament seat away) or leaving now: act at once.
    const instant = info.leaveNow || s.timeouts >= 2 || (tb.mode !== 'open' && s.status === 'sittingOut');
    setWake(tb, instant ? now : h.deadline + ACCEPT_LATE_MS, 'clock');
  };

  const setIdleWake = (tb: Table, now: number): void => {
    if (tb.emptySince !== null) setWake(tb, tb.emptySince + IDLE_EMPTY_MS, 'idle');
    if (tb.allOutSince !== null) setWake(tb, tb.allOutSince + IDLE_ALL_OUT_MS, 'idle');
    for (const s of tb.state.seats) {
      const info = tb.info[s.seat];
      if (!s.player?.accountId) continue;
      if (info.disconnectedAt !== null && tb.mode === 'open') setWake(tb, info.disconnectedAt + RELEASE_DISCONNECTED_MS, 'idle');
      if (info.sitOutSince !== null && tb.mode === 'open') setWake(tb, info.sitOutSince + RELEASE_SITTING_OUT_MS, 'idle');
    }
    if (tb.tournament && !tb.tournament.ended && !humanConnected(tb)) {
      const since = Math.max(...tb.state.seats.filter((s) => s.player?.accountId).map((s) => tb.info[s.seat].disconnectedAt ?? now));
      setWake(tb, since + ABANDON_MS, 'idle');
    }
    void now;
  };

  const onWake = (tb: Table): void => {
    tb.timer = null;
    const w = tb.wake;
    tb.wake = null;
    if (!w || tb.closed) return;
    const now = clock.now();
    const hand = tb.state.hand;
    switch (w.what) {
      case 'advance':
        runAdvance(tb);
        break;
      case 'nextHand':
      case 'trioDeal':
        tb.trioDealAt = 0;
        dealNext(tb);
        break;
      case 'botAct':
        if (hand && tb.bot?.action && tb.bot.key === turnKey(tb)) {
          const seatNo = hand.toAct;
          const r = act(tb.state, seatNo, tb.bot.action, now);
          tb.bot = null;
          emitEvents(tb, r.ok ? r.events : timeoutAt(tb, seatNo));
        }
        break;
      case 'clock':
        if (hand && hand.toAct >= 0 && !hand.pending) {
          const seatNo = hand.toAct;
          const s = tb.state.seats[seatNo];
          const info = tb.info[seatNo];
          if (info.leaveNow) {
            const r = act(tb.state, seatNo, { kind: 'fold' }, now);
            if (r.ok) emitEvents(tb, r.events);
          } else if (now < hand.deadline + ACCEPT_LATE_MS && !(s.timeouts >= 2 || (tb.mode !== 'open' && s.status === 'sittingOut'))) {
            // Re-armed early (a credit moved the deadline).
          } else if (!hand.bank && s.timeBankMs > 0 && s.connected && s.timeouts < 2 && now >= hand.deadline) {
            emitEvents(tb, startBank(tb.state, now));
          } else emitEvents(tb, timeoutAt(tb, seatNo));
        }
        break;
      case 'seats':
        flushSeats(tb, now);
        break;
      case 'idle':
        checkIdle(tb, now);
        break;
    }
    arm(tb);
  };

  const timeoutAt = (tb: Table, seatNo: number): EngineEvent[] => {
    const r = timeout(tb.state, seatNo, clock.now());
    if (!r.ok) return [];
    if (tb.state.seats[seatNo].status === 'sittingOut' && tb.info[seatNo].sitOutSince === null) tb.info[seatNo].sitOutSince = clock.now();
    return r.events;
  };

  const turnKey = (tb: Table): string => (tb.state.hand ? tb.state.hand.handNo + ':' + tb.state.hand.turnQ : '');

  // -------------------------------------------------------------- bots (≤ 2 ms of CPU per decision, in slices)
  const thinkBot = (tb: Table, seatNo: number): void => {
    const key = turnKey(tb);
    if (tb.bot?.key === key) return;
    tb.bot?.cancel();
    const level = tb.info[seatNo].level ?? 'regular';
    const cheap = !humanConnected(tb);
    const th = createThinker(viewForBot(tb, seatNo), seatNo, level, (rand(0x7fffffff) + 1) >>> 0, { maxTrials: cheap ? CHEAP_TRIALS : BOT_TRIALS.server[level] });
    const started = clock.now();
    const think = tb.mode === 'trio' ? thinkMs('trio', false, rand(1000) / 1000) : thinkMs(tb.mode, false, rand(1000) / 1000);
    let cancelled = false;
    let spent = 0n;
    let slice: unknown = null;
    const bot = { key, startedAt: started, thinkMs: think, action: null as Action | null, readyAt: 0, cancel: () => {
      cancelled = true;
      if (slice !== null) clock.clearTimeout(slice);
    } };
    tb.bot = bot;
    const run = (): void => {
      slice = null;
      if (cancelled || tb.closed) return;
      const t0 = clock.hr();
      const done = th.step(SLICE_TRIALS);
      spent += clock.hr() - t0;
      if (done || spent >= BOT_CPU_NS) {
        bot.action = th.decide();
        bot.readyAt = Math.max(started + think, clock.now());
        if (tb.bot === bot) setWake(tb, bot.readyAt, 'botAct');
        return;
      }
      slice = clock.setTimeout(run, 0);
    };
    run();
  };

  /** Bots decide from their own view only, never the table state. */
  const viewForBot = (tb: Table, seatNo: number): TableState => {
    const v = JSON.parse(JSON.stringify(tb.state)) as TableState;
    if (v.hand) v.hand.deck = [];
    for (const s of v.seats) if (s.seat !== seatNo && !s.shown) s.hole = null;
    return v;
  };

  // -------------------------------------------------------------- hands
  const dealNext = (tb: Table): void => {
    if (tb.closed || !tb.started) return;
    const now = clock.now();
    betweenHands(tb, now);
    if (tb.closed || !canStartHand(tb.state) || !humanDealable(tb)) return;
    if (tb.mode !== 'open' && tb.tournament) {
      const lv = levelAt(tb.mode, { elapsedMs: now - tb.tournament.startedAt, startedAt: tb.tournament.startedAt });
      if (lv.index !== tb.state.level.index) emitEvents(tb, setLevel(tb.state, lv));
    }
    const deck = shuffle(newDeck(), rand);
    tb.commit = commitDeck(deck, newSecret());
    tb.deck = deck;
    const r = startHand(tb.state, deck, now, rand(tb.state.seats.length));
    if (!r.ok) return;
    tb.handOpen = true;
    tb.holes.clear();
    const pos = dealPositions(tb.state);
    for (const [seatNo, [i, j]] of pos.holes) {
      const s = tb.state.seats[seatNo];
      if (s.hole && tb.commit) tb.holes.set(seatNo, { c: s.hole, s: [b64url(tb.commit.salts[i]), b64url(tb.commit.salts[j])] });
    }
    for (const s of tb.state.seats) if (s.inHand && !s.connected && s.player?.accountId) tb.info[s.seat].handsDisconnected++;
    emitEvents(tb, r.events);
  };

  const runAdvance = (tb: Table): void => {
    const events = advance(tb.state, clock.now());
    emitEvents(tb, events);
    const end = events.find((e) => e.ev === 'end');
    if (end && end.ev === 'end') {
      tb.nextHandAt = clock.now() + end.next;
      if (tb.state.hand?.uncontested) tb.showUntil = clock.now() + 4000;
      endOfHand(tb);
    }
  };

  /** One transaction per hand: the `hand` txn (cash), the hand row and the stats. */
  const endOfHand = (tb: Table): void => {
    const state = tb.state;
    const hand = state.hand;
    if (!hand || !tb.handOpen) return;
    tb.handOpen = false;
    const net = handNet(state);
    const humans = state.seats.filter((s) => s.inHand && s.player?.accountId);
    const record = handRecord(tb, net);
    const now = clock.now();
    api.wallet.tx(() => {
      if (tb.mode === 'open') {
        const legs = state.seats
          .filter((s) => s.inHand && net[s.seat] !== 0 && s.player)
          .map((s) => ({ account: escrowAccount(tb.ref, s.player?.accountId ?? 'bot:' + s.seat), delta: net[s.seat] }));
        if (legs.length > 0) api.wallet.transfer('hand', tb.ref, 'system', 'hand:' + tb.id + ':' + hand.handNo + ':' + tb.createdAt, legs);
      }
      if (tb.commit) {
        store.insert({
          tableRef: tb.id,
          handNo: hand.handNo,
          format: tb.mode,
          seats: humans.map((s) => s.player?.accountId as string),
          root: tb.commit.root,
          secret: tb.commit.secret,
          deck: Uint8Array.from(tb.deck),
          record,
          createdAt: now,
        });
      }
      if (humans.length >= 2) {
        const week = 'net:' + isoWeek(now);
        let pot = 0;
        for (const p of record.pots) pot += p.a;
        for (const s of humans) {
          const a = s.player?.accountId as string;
          api.stats.add(a, 'lamplight', 'hands', 1);
          if (tb.mode === 'open') {
            api.stats.add(a, 'lamplight', week, net[s.seat]);
            api.stats.add(a, 'lamplight', 'net:all', net[s.seat]);
            if (record.pots.some((p) => p.w.includes(s.seat))) api.stats.max(a, 'lamplight', 'pot_best', pot);
          }
        }
      }
    });
    tb.commit = null;
    if (tb.tournament && recordBusts(tb.tournament, state)) finishTournament(tb, false);
  };

  const handRecord = (tb: Table, net: number[]): HandRecordJson => {
    const state = tb.state;
    const hand = state.hand;
    const dealt: number[] = [];
    if (hand) for (let i = 1; i <= state.seats.length; i++) if (state.seats[(hand.button + i) % state.seats.length].inHand) dealt.push((hand.button + i) % state.seats.length);
    const pots = tb.ring.filter((r) => r.out.name === 'lamplight:show' && Array.isArray(r.out.data.pots) && r.hand === null).slice(-1)[0]?.out.data.pots as { a: number; w: number[] }[] | undefined;
    return {
      no: hand?.handNo ?? 0,
      f: tb.mode,
      tier: tb.mode === 'open' ? tb.cfg.tier : null,
      lv: [state.level.sb, state.level.bb, state.level.ante],
      btn: hand?.button ?? 0,
      seats: state.seats.filter((s) => s.inHand).map((s) => [s.seat, s.player?.accountId ?? null, s.player?.botId ?? null, s.startStack]),
      dealt,
      acts: (hand?.log ?? []).map((l) => [l[0], l[1], l[2], l[3]]),
      board: hand?.board.slice() ?? [],
      pots: (pots ?? []).map((p) => ({ a: p.a, w: p.w })),
      net: state.seats.filter((s) => s.inHand).map((s) => [s.seat, net[s.seat]]),
      shown: state.seats.filter((s) => s.inHand && s.shown && s.hole).map((s) => [s.seat, (s.hole as [Card, Card])[0], (s.hole as [Card, Card])[1]]),
      cr: tb.commit?.cr ?? '',
    };
  };

  /** Between hands: leaves, releases, bot rebuys, disconnected seats sitting out. */
  const betweenHands = (tb: Table, now: number): void => {
    for (const s of tb.state.seats) {
      const info = tb.info[s.seat];
      if (s.player?.botId) {
        if (s.stack === 0 && tb.mode === 'open') {
          if (info.buyIns >= BOT_MAX_BUYINS) botCashout(tb, s.seat);
          else {
            const stack = BUY_IN_BB.default * TIER_BLINDS[tb.cfg.tier].bb;
            info.buyIns++;
            const r = api.wallet.transfer('buyin', tb.ref, 'system', 'bot:' + tb.id + ':' + s.seat + ':' + info.buyIns, [
              { account: 'house' as LedgerAccount, delta: -stack },
              { account: escrowAccount(tb.ref, 'bot:' + s.seat), delta: stack },
            ]);
            if (r.ok) emitEvents(tb, updateSeat(tb.state, s.seat, { stack, status: 'active' }));
          }
        }
        continue;
      }
      if (!s.player?.accountId) continue;
      if (tb.mode === 'open') {
        if (info.leaveAfter || info.leaveNow) {
          cashout(tb, s.seat, 'leave');
          continue;
        }
        if (info.disconnectedAt !== null && now - info.disconnectedAt >= RELEASE_DISCONNECTED_MS) {
          cashout(tb, s.seat, 'gone');
          continue;
        }
        if (s.status === 'sittingOut' && info.sitOutSince !== null && now - info.sitOutSince >= RELEASE_SITTING_OUT_MS) {
          cashout(tb, s.seat, 'away');
          continue;
        }
      }
      if (info.disconnectedAt !== null && info.handsDisconnected >= DISCONNECT_SIT_OUT_HANDS && s.status === 'active') {
        emitEvents(tb, updateSeat(tb.state, s.seat, { status: 'sittingOut' }));
        info.sitOutSince = now;
      }
    }
    refreshIdle(tb, now);
  };

  const refreshIdle = (tb: Table, now: number): void => {
    const humans = tb.state.seats.filter((s) => s.player?.accountId);
    tb.emptySince = humans.length === 0 && tb.started ? (tb.emptySince ?? now) : null;
    const allOut = tb.mode === 'open' && humans.length > 0 && humans.every((s) => s.status === 'sittingOut' || s.status === 'busted');
    tb.allOutSince = allOut ? (tb.allOutSince ?? now) : null;
  };

  const checkIdle = (tb: Table, now: number): void => {
    if (tb.emptySince !== null && now - tb.emptySince >= IDLE_EMPTY_MS) return closeTable(tb, 'idle');
    if (tb.allOutSince !== null && now - tb.allOutSince >= IDLE_ALL_OUT_MS) return closeTable(tb, 'idle');
    if (tb.tournament && !tb.tournament.ended && !humanConnected(tb)) {
      const since = Math.max(...tb.state.seats.filter((s) => s.player?.accountId).map((s) => tb.info[s.seat].disconnectedAt ?? now));
      if (now - since >= ABANDON_MS) return finishTournament(tb, true);
    }
    // Releases of single seats happen between hands; if no hand runs, do them now.
    if (!tb.state.hand || tb.state.hand.street === 'done') betweenHands(tb, now);
  };

  const flushSeats = (tb: Table, now: number): void => {
    for (let n = 0; n < tb.info.length; n++) {
      const info = tb.info[n];
      if (info.dirtyAt !== null && info.dirtyAt <= now) {
        info.dirtyAt = null;
        if (tb.state.seats[n].player) emitEvents(tb, updateSeat(tb.state, n, {}));
      }
    }
  };

  // -------------------------------------------------------------- tournaments
  const startTournament = (tb: Table): void => {
    if (tb.started || tb.closed) return;
    const humans = tb.registered.slice();
    if (humans.length < 2) return;
    const now = clock.now();
    let trio: { mult: number; pool: number; pay: number[] } | undefined;
    if (tb.mode === 'trio') {
      const d = drawTrio(settings().trioTable, tb.cfg.buyIn, deps.trioDraw?.());
      trio = { mult: d.mult, pool: d.pool, pay: d.pay };
    }
    tb.tournament = createTournament({ kind: tb.mode as 'cup' | 'trio', ref: tb.ref, buyIn: tb.cfg.buyIn, humans, startedAt: now, trio });
    // Cup bots: only with at least 2 humans, they buy in nothing and never take a prize.
    if (tb.mode === 'cup' && tb.cfg.bots && botsAllowed(tb)) {
      for (const s of tb.state.seats) {
        if (s.player || !api.hub.bots.take(1)) continue;
        botsInUse++;
        seatPlayer(tb.state, s.seat, { accountId: null, botId: BOTS[s.seat % BOTS.length].id, avatarSeed: s.seat * 977 }, tb.state.seats.find((x) => x.player)?.stack ?? 1500);
        tb.info[s.seat] = { ...freshInfo(), level: tb.cfg.bots };
      }
    }
    tb.started = true;
    tb.state.prizePool = tb.tournament.pool;
    if (trio) {
      tb.state.multiplier = trio.mult;
      tb.state.q += 1;
      const ev: EngineEvent = { ev: 'trio', q: tb.state.q, mult: trio.mult, pool: trio.pool, pay: trio.pay };
      emitEvents(tb, [ev]);
      tb.trioDealAt = now + TRIO_DEAL_MS;
    } else tb.nextHandAt = now + 1000;
    for (const sid of tb.watchers) sendSnap(tb, sid, null);
    for (const a of humans) for (const sid of api.presence.socketsOf(a)) sendSnap(tb, sid, a);
    api.hub.publish(tb.id);
    api.hub.activityChanged(tb.channelId);
  };

  const finishTournament = (tb: Table, abandoned: boolean): void => {
    const t = tb.tournament;
    if (!t || t.ended) return;
    const prizes = abandoned ? abandonedPrizes(t, tb.state) : finalPrizes(t, tb.state);
    const places = finalPlaces(t, tb.state);
    api.wallet.tx(() => {
      settle(api.wallet, t, prizes);
      const now = clock.now();
      api.results.record(
        { game: 'lamplight', mode: tb.mode, channelId: tb.channelId, humans: t.humans.length, startedAt: t.startedAt, endedAt: now, summary: { buyIn: t.buyIn, mult: t.mult, pool: t.pool, hands: tb.state.handsPlayed, abandoned } },
        t.humans.map((a) => ({ accountId: a, place: places.get(a) ?? null, score: null, chipsDelta: (prizes.get(a) ?? 0) - t.buyIn })),
      );
      if (t.humans.length >= 2) {
        for (const a of t.humans) {
          if (tb.mode === 'cup' && places.get(a) === 1) api.stats.add(a, 'lamplight', 'cup_wins', 1);
          if (tb.mode === 'trio') api.stats.max(a, 'lamplight', 'trio_best', prizes.get(a) ?? 0);
        }
      }
    });
    tb.state.q += 1;
    const ev: EngineEvent = {
      ev: 'cupEnd',
      q: tb.state.q,
      places: t.humans.map((a) => ({ a, b: null, p: places.get(a) ?? t.humans.length, won: prizes.get(a) ?? 0 })).sort((x, y) => x.p - y.p),
    };
    emitEvents(tb, [ev]);
    closeTable(tb, abandoned ? 'abandoned' : 'done');
  };

  // -------------------------------------------------------------- seat helpers
  const seatIndexOf = (tb: Table, accountId: string): number => tb.state.seats.findIndex((s) => s.player?.accountId === accountId);

  const markConnected = (tb: Table, n: number, on: boolean): void => {
    const s = tb.state.seats[n];
    const info = tb.info[n];
    if (s.connected === on) return;
    s.connected = on;
    if (on) {
      info.disconnectedAt = null;
      info.handsDisconnected = 0;
    } else info.disconnectedAt = clock.now();
    const now = clock.now();
    info.dirtyAt = info.dirtyAt ?? now + (on ? 0 : SEAT_COALESCE_MS);
    arm(tb);
  };

  const join = (socketId: string, tb: Table): void => {
    const prev = watching.get(socketId);
    if (prev && prev !== tb.id) {
      api.rooms.leave(socketId, ROOM(prev));
      tables.get(prev)?.watchers.delete(socketId);
    }
    watching.set(socketId, tb.id);
    tb.watchers.add(socketId);
    tb.away.delete(socketId);
    api.rooms.join(socketId, ROOM(tb.id));
  };

  const spectators = (tb: Table): number => {
    let n = 0;
    for (const sid of tb.watchers) {
      const a = accountOfSocket.get(sid);
      if (!a || seatIndexOf(tb, a) < 0) n++;
    }
    return n;
  };
  const accountOfSocket = new Map<string, string>();

  const ok = { ok: true } as const;
  const no = (code: string) => ({ ok: false, code }) as const;

  const timed = <T>(tb: Table | null, fn: () => T): T => {
    const t0 = clock.hr();
    const out = fn();
    const spent = clock.hr() - t0;
    if (tb && spent > SLOW_INTENT_NS) {
      tb.slow++;
      api.log.warn({ table: tb.id, ms: Number(spent / 1_000_000n), hand: tb.state.hand?.handNo, deck: tb.deck, acts: tb.state.hand?.log }, 'lamplight: slow intent');
      if (tb.slow >= 2) voidTable(tb, 'overload');
    }
    return out;
  };

  const voidTable = (tb: Table, reason: string): void => {
    emitEvents(tb, voidHand(tb.state, reason));
    tb.handOpen = false;
    closeTable(tb, reason);
  };

  const tableOf = (t: string): Table | null => {
    const tb = tables.get(t);
    if (tb && !tb.closed) return tb;
    const lobby = api.hub.get(t);
    return lobby && lobby.game === 'lamplight' ? ensureTable(lobby) : null;
  };

  // -------------------------------------------------------------- intents
  const tId = z.string().min(1).max(40);
  const idem = z.string().min(1).max(64);

  api.queuePolicy('lamplight', {
    maxEvents: 32,
    maxAgeMs: 2000,
    onOverflow(socketId) {
      const t = watching.get(socketId);
      const tb = t ? tables.get(t) : null;
      return tb ? { ev: 'lamplight:snap', data: snapForSocket(tb, accountOfSocket.get(socketId) ?? null) } : null;
    },
  });

  api.on('lamplight:sync', { schema: z.object({ t: tId, since: z.number().int().min(-1) }), limiter: 'arcade', acked: true }, (c, p) => {
    const tb = tableOf(p.t);
    if (!tb) return no('gone');
    accountOfSocket.set(c.socketId, c.accountId);
    const seatNo = seatIndexOf(tb, c.accountId);
    const registered = tb.registered.includes(c.accountId);
    if (seatNo < 0 && !registered && !tb.watchers.has(c.socketId)) {
      if (!api.presence.isVoiceMember(c.accountId, tb.channelId) && c.voiceChannelId !== tb.channelId) return no('forbidden');
      if (spectators(tb) >= SPECTATORS) return no('full');
    }
    join(c.socketId, tb);
    if (seatNo >= 0) markConnected(tb, seatNo, true);
    const first = tb.ring[0];
    if (p.since >= 0 && first && p.since >= first.q - 1 && p.since <= tb.state.q) {
      const hand = tb.state.hand;
      for (const r of tb.ring) {
        if (r.q <= p.since) continue;
        api.emit(c.socketId, r.out.name, r.out.data, { queue: 'lamplight', stamp: (d, sentAt) => stampMs(d as Record<string, unknown>, r.out.dl, sentAt) });
        if (r.hand !== null && hand && r.hand === hand.handNo && seatNo >= 0) {
          const hole = holeFor(tb, seatNo);
          if (hole) api.emit(c.socketId, 'lamplight:hole', hole, { queue: 'lamplight' });
        }
      }
      return { ok: true, mode: 'events' };
    }
    sendSnap(tb, c.socketId, c.accountId);
    return { ok: true, mode: 'snap' };
  });

  const actSchema = z.object({ t: tId, h: z.number().int().min(1), q: z.number().int().min(0), k: z.enum(['f', 'x', 'c', 'b', 'r', 'a']), a: z.number().int().min(0).optional() });
  api.on('lamplight:act', { schema: actSchema, limiter: 'arcadeAct', acked: true }, (c, p) => {
    const tb = tables.get(p.t);
    if (!tb || tb.closed) return no('gone');
    return timed(tb, () => {
      const seatNo = seatIndexOf(tb, c.accountId);
      if (seatNo < 0) return no('not_your_turn');
      const info = tb.info[seatNo];
      const last = info.lastAct;
      if (last && last.h === p.h && last.q === p.q && last.k === p.k && last.a === (p.a ?? null)) return { ok: true, dup: true };
      const hand = tb.state.hand;
      if (!hand || hand.toAct !== seatNo) return no('not_your_turn');
      if (clock.now() > hand.deadline + ACCEPT_LATE_MS) return no('stale');
      const kind = ({ f: 'fold', x: 'check', c: 'call', b: 'bet', r: 'raise', a: 'allin' } as const)[p.k];
      const action = (kind === 'bet' || kind === 'raise' ? { kind, to: p.a ?? 0 } : { kind }) as Action;
      const r = act(tb.state, seatNo, action, clock.now(), { h: p.h, q: p.q });
      if (!r.ok) return no(r.code);
      info.lastAct = { h: p.h, q: p.q, k: p.k, a: p.a ?? null };
      // Acting brings a seat back from sitting out (cash) and clears a disconnect.
      const s = tb.state.seats[seatNo];
      emitEvents(tb, r.events);
      if (s.status === 'sittingOut' && tb.mode === 'open') {
        info.sitOutSince = null;
        emitEvents(tb, updateSeat(tb.state, seatNo, { status: 'active' }));
      }
      arm(tb);
      return ok;
    });
  });

  api.on(
    'lamplight:sit',
    { schema: z.object({ t: tId, seat: z.number().int().min(0).max(8).optional(), buyIn: z.number().int().min(1), post: z.enum(['now', 'wait']).optional(), id: idem }), limiter: 'arcadeAct', acked: true, voiceMember: true },
    (c, p) => {
      const tb = tableOf(p.t);
      if (!tb) return no('gone');
      if (tb.mode !== 'open') return no('illegal');
      if (api.prefs.hidden(c.accountId, 'lamplight')) return no('hidden');
      const held = seatOf.get(c.accountId);
      if (held && held.t !== tb.id) return no('seated');
      if (held) return ok;
      const free = p.seat !== undefined && !tb.state.seats[p.seat]?.player ? p.seat : tb.state.seats.findIndex((s) => !s.player);
      if (free < 0 || free >= tb.state.seats.length) return no('full');
      const cfg = tb.state.config;
      const back = leftWith.get(c.accountId);
      const floor = back && back.t === tb.id && clock.now() - back.at < RETURN_STACK_MS ? Math.min(cfg.buyInMax, Math.max(cfg.buyInMin, back.stack)) : cfg.buyInMin;
      if (p.buyIn < floor || p.buyIn > Math.max(cfg.buyInMax, floor)) return no('amount');
      const r = api.wallet.transfer('buyin', tb.ref, c.accountId, p.id, [
        { account: walletAccount(c.accountId), delta: -p.buyIn },
        { account: escrowAccount(tb.ref, c.accountId), delta: p.buyIn },
      ]);
      if (!r.ok) return no(r.code === 'funds' ? 'funds' : 'busy');
      if (r.dup) return ok;
      seatOf.set(c.accountId, { t: tb.id, seat: free });
      accountOfSocket.set(c.socketId, c.accountId);
      emitEvents(tb, seatPlayer(tb.state, free, { accountId: c.accountId, botId: null, avatarSeed: 0 }, p.buyIn, (p.post ?? 'wait') as PostChoice));
      tb.info[free] = freshInfo();
      join(c.socketId, tb);
      sendSnap(tb, c.socketId, c.accountId);
      refreshIdle(tb, clock.now());
      api.hub.activityChanged(tb.channelId);
      arm(tb);
      return ok;
    },
  );

  api.on('lamplight:leave', { schema: z.object({ t: tId, now: z.boolean().optional(), id: idem }), limiter: 'arcadeAct', acked: true }, (c, p) => {
    const tb = tables.get(p.t);
    if (!tb) return ok;
    const n = seatIndexOf(tb, c.accountId);
    if (n < 0 || tb.mode !== 'open') return ok;
    const s = tb.state.seats[n];
    const running = tb.state.hand && tb.state.hand.street !== 'done' && s.inHand && !s.folded;
    if (!running) {
      cashout(tb, n, 'leave');
      refreshIdle(tb, clock.now());
    } else if (p.now) tb.info[n].leaveNow = true;
    else tb.info[n].leaveAfter = true;
    arm(tb);
    return ok;
  });

  api.on('lamplight:sitOut', { schema: z.object({ t: tId, on: z.boolean(), post: z.enum(['now', 'wait']).optional() }), limiter: 'arcadeAct', acked: true }, (c, p) => {
    const tb = tables.get(p.t);
    if (!tb || tb.mode !== 'open') return no('illegal');
    const n = seatIndexOf(tb, c.accountId);
    if (n < 0) return no('illegal');
    const s = tb.state.seats[n];
    if (p.on && (s.status === 'active' || s.status === 'waiting')) {
      tb.info[n].sitOutSince = clock.now();
      emitEvents(tb, updateSeat(tb.state, n, { status: 'sittingOut' }));
    } else if (!p.on && s.status === 'sittingOut') {
      s.timeouts = 0;
      tb.info[n].sitOutSince = null;
      emitEvents(tb, updateSeat(tb.state, n, s.missedBB ? { status: 'waiting', post: p.post ?? 'wait' } : { status: 'active' }));
    }
    refreshIdle(tb, clock.now());
    arm(tb);
    return ok;
  });

  api.on('lamplight:topUp', { schema: z.object({ t: tId, amount: z.number().int().min(1), id: idem }), limiter: 'arcadeAct', acked: true }, (c, p) => {
    const tb = tables.get(p.t);
    if (!tb || tb.mode !== 'open') return no('illegal');
    const n = seatIndexOf(tb, c.accountId);
    if (n < 0) return no('illegal');
    const s = tb.state.seats[n];
    if (tb.state.hand && tb.state.hand.street !== 'done' && s.inHand) return no('busy');
    const want = Math.min(p.amount, tb.state.config.buyInMax - s.stack);
    if (want <= 0 || (s.stack === 0 && want < tb.state.config.buyInMin)) return no('amount');
    const r = api.wallet.transfer('buyin', tb.ref, c.accountId, p.id, [
      { account: walletAccount(c.accountId), delta: -want },
      { account: escrowAccount(tb.ref, c.accountId), delta: want },
    ]);
    if (!r.ok) return no('funds');
    if (r.dup) return ok;
    emitEvents(tb, updateSeat(tb.state, n, { stack: s.stack + want, status: s.status === 'busted' ? 'waiting' : s.status, post: s.status === 'busted' ? 'wait' : s.post }));
    refreshIdle(tb, clock.now());
    arm(tb);
    return ok;
  });

  api.on('lamplight:show', { schema: z.object({ t: tId, h: z.number().int().min(1) }), limiter: 'arcadeAct', acked: true }, (c, p) => {
    const tb = tables.get(p.t);
    if (!tb || tb.state.hand?.handNo !== p.h || clock.now() > tb.showUntil) return no('illegal');
    const n = seatIndexOf(tb, c.accountId);
    if (n < 0) return no('illegal');
    emitEvents(tb, showUncontested(tb.state, n));
    return ok;
  });

  api.on('lamplight:emote', { schema: z.object({ t: tId, id: z.number().int().min(0).max(5) }), limiter: 'arcadeAct', acked: true }, (c, p) => {
    const tb = tables.get(p.t);
    if (!tb) return no('gone');
    const n = seatIndexOf(tb, c.accountId);
    if (n < 0) return no('illegal');
    const now = clock.now();
    if (now - tb.info[n].emoteAt < EMOTE_GAP_MS) return no('busy');
    tb.info[n].emoteAt = now;
    api.emitRoom(ROOM(tb.id), 'lamplight:emote', () => ({ t: tb.id, s: n, id: p.id }), { queue: 'lamplight', coalesce: 'emote:' + tb.id + ':' + n });
    return ok;
  });

  api.on('lamplight:hands', { schema: z.object({ t: tId.optional(), before: z.number().int().min(1).optional() }), limiter: 'arcade', acked: true }, (c, p) => {
    const since = clock.now() - PROOF_DAYS_MS;
    const rows = store.page(c.accountId, p.before ?? null, since, 20).map(({ id, row }) => {
      const mine = row.record.seats.find((s) => s[1] === c.accountId);
      const net = mine ? (row.record.net.find((x) => x[0] === mine[0])?.[1] ?? 0) : 0;
      let pot = 0;
      for (const x of row.record.pots) pot += x.a;
      return { id, t: row.tableRef, h: row.handNo, at: row.createdAt, f: row.format, tier: row.record.tier, net, pot };
    });
    return { ok: true, rows };
  });

  api.on('lamplight:record', { schema: z.object({ t: tId, h: z.number().int().min(1) }), limiter: 'arcade', acked: true }, (c, p) => {
    const row = store.get(p.t, p.h);
    if (!row || clock.now() - row.createdAt > PROOF_DAYS_MS) return no('gone');
    const rec = recordFor(row, c.accountId);
    return rec ? { ok: true, record: rec } : no('forbidden');
  });

  api.on('lamplight:proof', { schema: z.object({ t: tId, h: z.number().int().min(1) }), limiter: 'arcade', acked: true }, (c, p) => {
    const tb = tables.get(p.t);
    if (tb?.state.hand && tb.state.hand.handNo === p.h && tb.state.hand.street !== 'done') return no('busy');
    const row = store.get(p.t, p.h);
    if (!row || clock.now() - row.createdAt > PROOF_DAYS_MS) return no('gone');
    return proofFor(row, c.accountId) ?? no('forbidden');
  });

  // -------------------------------------------------------------- the TableGame
  const countIn = (channelId: string | null): number => {
    let n = 0;
    for (const tb of tables.values()) if (channelId === null || tb.channelId === channelId) n++;
    return n;
  };

  const game: LamplightGame = {
    tables,
    lobby: {
      onCreate(c, cfg) {
        const limits = api.hub.limits();
        if (countIn(c.voiceChannelId) >= limits.tablesPerChannel || countIn(null) >= limits.tables) return no('limit');
        if (api.prefs.hidden(c.accountId, 'lamplight')) return no('hidden');
        const raw = (cfg ?? {}) as { mode?: string };
        const mode = typeof raw.mode === 'string' ? raw.mode : 'open';
        const parsed = parseCfg(mode, cfg);
        if (!parsed) return no('invalid');
        if (parsed.bots) {
          if (mode === 'trio') return no('bots');
          if (!api.settings().serverBots) return no('bots');
          if (mode === 'open' && parsed.tier !== 'pebble' && parsed.tier !== 'cobble') return no('bots');
        }
        return ok;
      },
      onJoin(c, lobby, as) {
        const tb = ensureTable(lobby);
        if (!tb) return no('gone');
        accountOfSocket.set(c.socketId, c.accountId);
        if (as === 'spectator' || tb.mode === 'open') {
          if (seatIndexOf(tb, c.accountId) < 0 && spectators(tb) >= SPECTATORS && !tb.watchers.has(c.socketId)) return no('full');
          join(c.socketId, tb);
          sendSnap(tb, c.socketId, c.accountId);
          return ok;
        }
        // Register for a Cup or Trio: the buy-in goes into escrow in the same transaction.
        if (tb.started) return no('started');
        if (api.prefs.hidden(c.accountId, 'lamplight')) return no('hidden');
        const held = seatOf.get(c.accountId);
        if (held) return held.t === tb.id ? ok : no('seated');
        const free = tb.state.seats.findIndex((s) => !s.player);
        if (free < 0) return no('full');
        const r = api.wallet.transfer('buyin', tb.ref, c.accountId, 'reg:' + tb.id, [
          { account: walletAccount(c.accountId), delta: -tb.cfg.buyIn },
          { account: escrowAccount(tb.ref, c.accountId), delta: tb.cfg.buyIn },
        ]);
        if (!r.ok) return no(r.code === 'funds' ? 'funds' : 'busy');
        const stack = tb.mode === 'cup' ? 1500 : 500;
        seatPlayer(tb.state, free, { accountId: c.accountId, botId: null, avatarSeed: 0 }, stack);
        tb.registered.push(c.accountId);
        seatOf.set(c.accountId, { t: tb.id, seat: free });
        join(c.socketId, tb);
        api.hub.publish(tb.id);
        api.hub.activityChanged(tb.channelId);
        // The Trio starts with its third human; a Cup when every seat is taken.
        if (tb.mode === 'trio' && tb.registered.length === 3) startTournament(tb);
        else if (tb.mode === 'cup' && tb.registered.length === tb.state.seats.length) startTournament(tb);
        else for (const sid of tb.watchers) sendSnap(tb, sid, accountOfSocket.get(sid) ?? null);
        arm(tb);
        return ok;
      },
      onLeave(c, lobby) {
        const tb = tables.get(lobby.id);
        if (!tb) return;
        if (tb.watchers.has(c.socketId)) {
          tb.watchers.delete(c.socketId);
          api.rooms.leave(c.socketId, ROOM(tb.id));
          watching.delete(c.socketId);
        }
        // Unregistering refunds the buy-in, but only before the start (and never after the Firefly draw).
        if (tb.mode !== 'open' && !tb.started && tb.registered.includes(c.accountId)) {
          api.wallet.transfer('refund', tb.ref, c.accountId, 'unreg:' + tb.id + ':' + tb.registered.length, [
            { account: escrowAccount(tb.ref, c.accountId), delta: -tb.cfg.buyIn },
            { account: walletAccount(c.accountId), delta: tb.cfg.buyIn },
          ]);
          tb.registered = tb.registered.filter((a) => a !== c.accountId);
          seatOf.delete(c.accountId);
          const n = seatIndexOf(tb, c.accountId);
          if (n >= 0) emitEvents(tb, unseat(tb.state, n).events);
          api.hub.publish(tb.id);
          api.hub.activityChanged(tb.channelId);
        }
      },
      onStart(lobby) {
        const tb = tables.get(lobby.id);
        if (!tb || tb.mode === 'open') return no('illegal');
        if (tb.mode === 'trio') return no('illegal');
        if (tb.registered.length < 2) return no('players');
        startTournament(tb);
        arm(tb);
        return ok;
      },
    },
    onAway(socketId, id) {
      const tb = tables.get(id);
      if (!tb || !tb.watchers.has(socketId)) return;
      const a = accountOfSocket.get(socketId);
      // Seated players keep the small event stream; only spectators go away.
      if (a && seatIndexOf(tb, a) >= 0) return;
      tb.away.set(socketId, clock.now());
      api.rooms.leave(socketId, ROOM(tb.id));
    },
    onBack(socketId, id, since) {
      const tb = tables.get(id);
      if (!tb || !tb.away.has(socketId)) return;
      tb.away.delete(socketId);
      api.rooms.join(socketId, ROOM(tb.id));
      const first = tb.ring[0];
      if (since >= 0 && first && since >= first.q - 1) {
        for (const r of tb.ring) if (r.q > since) api.emit(socketId, r.out.name, r.out.data, { queue: 'lamplight', stamp: (d, sentAt) => stampMs(d as Record<string, unknown>, r.out.dl, sentAt) });
      } else sendSnap(tb, socketId, accountOfSocket.get(socketId) ?? null);
    },
    onVoiceLeft() {
      // Leaving voice later does not unseat you (membership is checked when sitting down only).
    },
    onSocketGone(accountId, socketId) {
      const t = watching.get(socketId);
      watching.delete(socketId);
      accountOfSocket.delete(socketId);
      if (t) {
        const tb = tables.get(t);
        tb?.watchers.delete(socketId);
        tb?.away.delete(socketId);
      }
      if (api.presence.socketsOf(accountId).length > 0) return;
      const held = seatOf.get(accountId);
      const tb = held ? tables.get(held.t) : null;
      if (!tb) return;
      const n = seatIndexOf(tb, accountId);
      if (n >= 0) markConnected(tb, n, false);
    },
    onRestarting() {
      for (const tb of [...tables.values()]) {
        if (tb.state.hand && tb.state.hand.street !== 'done') emitEvents(tb, voidHand(tb.state, 'restart'));
        tb.handOpen = false;
        disarm(tb);
        tb.bot?.cancel();
        tb.closed = true;
      }
      api.wallet.refund('lamplight:', 'restart-refund');
      api.wallet.refund('cup:', 'restart-refund');
      api.wallet.refund('trio:', 'restart-refund');
      for (const tb of tables.values()) api.hub.close(tb.id, 'restart');
      tables.clear();
      seatOf.clear();
      api.hub.bots.give(botsInUse);
      botsInUse = 0;
    },
    onBoot() {
      // Escrow left by a crash: every stack and buy-in back to its owner, bot rows to the house.
      api.wallet.refund('lamplight:', 'restart-refund');
      api.wallet.refund('cup:', 'restart-refund');
      api.wallet.refund('trio:', 'restart-refund');
    },
    daily() {
      // Hand rows are pruned by the platform's daily job (30 days, 2,000 per table).
    },
    onDisable() {
      for (const tb of [...tables.values()]) voidTable(tb, 'admin');
      api.wallet.refund('lamplight:', 'restart-refund');
      api.wallet.refund('cup:', 'restart-refund');
      api.wallet.refund('trio:', 'restart-refund');
    },
    activity(channelId) {
      const out: ActivityEntry[] = [];
      for (const tb of tables.values()) {
        if (tb.channelId !== channelId || tb.closed) continue;
        const players = tb.state.seats.filter((s) => s.player).length;
        out.push({
          g: 'lamplight',
          id: tb.id,
          st: tb.mode === 'open' ? (players < tb.state.seats.length ? 'open' : 'live') : tb.started ? 'live' : 'lobby',
          n: players,
          max: tb.state.seats.length,
          w: spectators(tb),
          x: activityLabel(tb),
        });
      }
      return out;
    },
    stop() {
      for (const tb of tables.values()) {
        disarm(tb);
        tb.bot?.cancel();
      }
    },
  };
  return game;
};

const lamplight: TableGameDef = {
  game: 'lamplight',
  proto: VERSION.proto,
  modes: ['open', 'cup', 'trio'],
  cfgSchema: cfgSchema as unknown as z.ZodType<unknown>,
  settings: {
    schema: lamplightSettingsSchema as unknown as z.ZodType<unknown>,
    defaults: LAMPLIGHT_DEFAULTS,
    fields: [{ key: 'trioTable', label: 'Firefly Trio multiplier table', help: 'Rows of {mult, weight, pay: [1st, 2nd, 3rd]}; weights add up to 1,000,000 and the average stays below 3.', kind: 'json' }],
  },
  boards: BOARDS,
  start: (api) => createLamplight(api),
};

export default lamplight;
