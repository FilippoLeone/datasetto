/**
 * The chips wallet: a double-entry ledger shared by poker and slots (platform.md §11.2).
 * `transfer()` is the only way chips move. Every transfer is one row in `arcade_txns` whose legs in
 * `arcade_ledger` sum to zero; wallet, escrow and pot balances are never negative; `house` mints and
 * burns. Nothing can be bought, sold, transferred between players or cashed out.
 *
 * Accounts:
 * - `w:<accountId>`: a player's wallet (`arcade_wallets.balance`);
 * - `e:<ref>:<accountId | bot:n>`: escrow (`arcade_escrow`), e.g. a table stack or a tournament buy-in;
 * - `p:<scope>`: a jackpot pool (`arcade_jackpots.pool`), e.g. `p:glimmer`;
 * - `house`.
 *
 * `balance_after` of a `house` ledger row is the house's running total (the sum of every house
 * delta so far, so it is negative while the house has minted more than it burned). Each new house
 * row adds its delta to the newest house row's value; `foldLedger` never folds the txn holding that
 * row, so the chain is never broken.
 */
import type { DB } from '../db/index.js';
import type { Clock } from './clock.js';
import type { ArcadeSettings } from './settings.js';

export type LedgerAccount = `w:${string}` | `e:${string}` | `p:${string}` | 'house';

export type TxnKind =
  | 'grant'
  | 'claim'
  | 'buyin'
  | 'cashout'
  | 'hand'
  | 'prize'
  | 'spin'
  | 'feature'
  | 'pot_seed'
  | 'refund'
  | 'restart-refund'
  | 'admin'
  | 'fold';

export const TXN_KINDS: readonly TxnKind[] = ['grant', 'claim', 'buyin', 'cashout', 'hand', 'prize', 'spin', 'feature', 'pot_seed', 'refund', 'restart-refund', 'admin', 'fold'];

/** Kinds whose ledger rows fold into months after 7 days (their txn rows are then deleted); all others fold after 90. */
export const SHORT_RETENTION_KINDS: readonly TxnKind[] = ['spin', 'feature'];

export interface Leg {
  account: LedgerAccount;
  delta: number;
}

export interface TransferOpts {
  /** Minimum balances checked before the legs apply, e.g. `{ 'w:<id>': bet }` (spin legs are net). */
  min?: Readonly<Record<string, number>>;
  /** Compact JSON stored in `arcade_txns.result` and returned on a retry (cleared after 24 h). */
  receipt?: string;
}

export type Transfer =
  | { ok: true; dup: false; txnId: number; balances: ReadonlyMap<LedgerAccount, number> }
  | { ok: true; dup: true; receipt: string | null }
  | { ok: false; code: 'funds' | 'min' | 'unbalanced' };

export interface Wallet {
  /**
   * Move chips. `actor` is the account that caused it, or `'system'`; `(actor, idem)` makes it
   * idempotent (a retry returns the stored receipt and changes nothing).
   */
  transfer(kind: TxnKind, ref: string, actor: string, idem: string | null, legs: readonly Leg[], opts?: TransferOpts): Transfer;
  /** One db transaction around several transfers and the game's own rows. */
  tx<T>(fn: () => T): T;
  /** Grants the start chips on the first read. */
  view(accountId: string): { bal: number; esc: number; claim: boolean };
  /** `max(claimMin, claimFloor − (bal + esc))`, once per UTC day. */
  claim(accountId: string): { ok: boolean; bal: number; got: number };
  escrowRows(refPrefix: string): readonly { ref: string; account: string; amount: number; kind: 'stack' | 'buyin' }[];
  /** Refund every escrow row under `refPrefix` to its wallet; bot escrow goes back to the house. Returns chips refunded. */
  refund(refPrefix: string, kind: 'refund' | 'restart-refund'): number;
  pot(scope: string): { pool: number; carryE4: number; last: { accountId: string; amount: number; at: number } | null };
  /** Add sub-chip carry (1e-4 chips); returns the whole chips to move house → `p:<scope>` in the same txn. */
  addCarry(scope: string, e4: number): number;
  potWon(scope: string, accountId: string, amount: number, atMs: number): void;
  receipt(actor: string, idem: string): string | null;
}

/** The escrow ledger account for a reference and holder (`e:<ref>:<accountId | bot:n>`). */
export const escrowAccount = (ref: string, holder: string): LedgerAccount => ('e:' + ref + ':' + holder) as LedgerAccount;
export const walletAccount = (accountId: string): LedgerAccount => ('w:' + accountId) as LedgerAccount;
export const potAccount = (scope: string): LedgerAccount => ('p:' + scope) as LedgerAccount;

// ---------------------------------------------------------------------------------------------
// Persistence (migration 14)
// ---------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
/** Receipts (`arcade_txns.result`) are cleared after this long. */
export const RECEIPT_TTL_MS = DAY_MS;
/** `spin` and `feature` ledger rows fold into months after this long. */
export const SHORT_RETENTION_MS = 7 * DAY_MS;
/** Every other kind folds after this long. */
export const LONG_RETENTION_MS = 90 * DAY_MS;
/** Poker hands are kept this long, and at most `HANDS_PER_TABLE` per table. */
export const HAND_RETENTION_MS = 30 * DAY_MS;
export const HANDS_PER_TABLE = 2000;
/** Ref of the grant and claim txns. */
export const WALLET_REF = 'wallet';

/** UTC `YYYY-MM-DD` of a wall-clock time (the daily-claim day). */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export type ParsedAccount =
  | { type: 'wallet'; accountId: string }
  | { type: 'escrow'; ref: string; holder: string }
  | { type: 'pot'; scope: string }
  | { type: 'house' };

/**
 * Split a ledger account name. An escrow holder is the last segment, or `bot:<n>` when the segment
 * before it is `bot` (so a ref must not end in a `:bot` segment). Returns null for a malformed name.
 */
export const parseLedgerAccount = (account: string): ParsedAccount | null => {
  if (account === 'house') return { type: 'house' };
  const body = account.slice(2);
  if (account.startsWith('w:')) return body ? { type: 'wallet', accountId: body } : null;
  if (account.startsWith('p:')) return body ? { type: 'pot', scope: body } : null;
  if (!account.startsWith('e:')) return null;
  const cut = body.lastIndexOf(':');
  if (cut <= 0 || cut === body.length - 1) return null;
  let ref = body.slice(0, cut);
  let holder = body.slice(cut + 1);
  if (ref.endsWith(':bot') && ref.length > 4) {
    ref = ref.slice(0, -4);
    holder = 'bot:' + holder;
  }
  return { type: 'escrow', ref, holder };
};

export const isBotHolder = (holder: string): boolean => holder.startsWith('bot:');

export interface WalletDeps {
  clock: Clock;
  settings(): ArcadeSettings;
  /** Wallet account ids whose balance changed, called after the change commits. Must not throw. */
  onChange?(accountIds: readonly string[]): void;
}

/** Thrown inside a transfer to roll its savepoint back; never escapes `transfer()`. */
class Refused extends Error {
  readonly code = 'funds' as const;
}

interface MergedLeg {
  account: LedgerAccount;
  parsed: ParsedAccount;
  delta: number;
}

const mergeLegs = (legs: readonly Leg[]): MergedLeg[] => {
  const merged = new Map<string, MergedLeg>();
  for (const leg of legs) {
    if (!Number.isSafeInteger(leg.delta)) throw new TypeError('wallet: leg delta must be a safe integer: ' + leg.account);
    const found = merged.get(leg.account);
    if (found) {
      found.delta += leg.delta;
      continue;
    }
    const parsed = parseLedgerAccount(leg.account);
    if (!parsed) throw new TypeError('wallet: malformed ledger account: ' + leg.account);
    merged.set(leg.account, { account: leg.account, parsed, delta: leg.delta });
  }
  return [...merged.values()];
};

/** Segment-aware ref matching: `''` matches all; `'a:'` matches `a:*`; `'a:b'` matches `a:b` and `a:b:*`, never `a:bc`. */
const refFilter = (prefix: string): { sql: string; args: (string | number)[] } => {
  if (prefix === '') return { sql: '1', args: [] };
  if (prefix.endsWith(':')) return { sql: 'substr(ref, 1, ?) = ?', args: [prefix.length, prefix] };
  return { sql: '(ref = ? OR substr(ref, 1, ?) = ?)', args: [prefix, prefix.length + 1, prefix + ':'] };
};

type EscrowRow = { ref: string; account: string; amount: number; kind: 'stack' | 'buyin' };

export const createWallet = (db: DB, deps: WalletDeps): Wallet => {
  const st = {
    findTxn: db.prepare('SELECT id, result FROM arcade_txns WHERE actor = ? AND idem = ?'),
    txnExists: db.prepare('SELECT 1 FROM arcade_txns WHERE id = ?').pluck(),
    insertTxn: db.prepare('INSERT INTO arcade_txns (kind, ref, actor, idem, result, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    insertLeg: db.prepare('INSERT INTO arcade_ledger (txn_id, account, delta, balance_after, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    walletGet: db.prepare('SELECT balance, claim_day AS claimDay FROM arcade_wallets WHERE account_id = ?'),
    walletCreate: db.prepare('INSERT OR IGNORE INTO arcade_wallets (account_id, balance, claim_day, created_at, updated_at) VALUES (?, 0, NULL, ?, ?)'),
    walletAdd: db.prepare('UPDATE arcade_wallets SET balance = balance + ?, updated_at = ? WHERE account_id = ? AND balance + ? >= 0 RETURNING balance'),
    walletClaimDay: db.prepare('UPDATE arcade_wallets SET claim_day = ?, updated_at = ? WHERE account_id = ?'),
    escrowGet: db.prepare('SELECT amount FROM arcade_escrow WHERE ref = ? AND account_id = ?').pluck(),
    escrowInsert: db.prepare('INSERT INTO arcade_escrow (ref, account_id, amount, kind, updated_at) VALUES (?, ?, ?, ?, ?)'),
    escrowSet: db.prepare('UPDATE arcade_escrow SET amount = ?, updated_at = ? WHERE ref = ? AND account_id = ?'),
    escrowDelete: db.prepare('DELETE FROM arcade_escrow WHERE ref = ? AND account_id = ?'),
    escrowSum: db.prepare('SELECT COALESCE(SUM(amount), 0) FROM arcade_escrow WHERE account_id = ?').pluck(),
    potGet: db.prepare(
      'SELECT pool, carry_e4 AS carryE4, last_winner AS lastWinner, last_amount AS lastAmount, last_won_at AS lastWonAt FROM arcade_jackpots WHERE scope = ?',
    ),
    potCreate: db.prepare('INSERT OR IGNORE INTO arcade_jackpots (scope, pool, carry_e4, updated_at) VALUES (?, 0, 0, ?)'),
    potAdd: db.prepare('UPDATE arcade_jackpots SET pool = pool + ?, updated_at = ? WHERE scope = ? AND pool + ? >= 0 RETURNING pool'),
    potCarry: db.prepare('UPDATE arcade_jackpots SET carry_e4 = ?, updated_at = ? WHERE scope = ?'),
    potWon: db.prepare('UPDATE arcade_jackpots SET last_winner = ?, last_amount = ?, last_won_at = ?, updated_at = ? WHERE scope = ?'),
    // `+account` keeps the planner on the primary key, scanned backwards from the newest txn.
    houseLast: db.prepare("SELECT balance_after FROM arcade_ledger WHERE +account = 'house' ORDER BY txn_id DESC LIMIT 1").pluck(),
    houseMonths: db.prepare("SELECT COALESCE(SUM(delta), 0) FROM arcade_ledger_months WHERE account = 'house'").pluck(),
    accountExists: db.prepare('SELECT 1 FROM accounts WHERE id = ?').pluck(),
  };

  // Change notifications: at once for a top-level transfer; after the outermost transaction for a
  // nested one (skipped when its txn was rolled back).
  const pending: { txnId: number; ids: readonly string[] }[] = [];
  let flushQueued = false;
  const emit = (ids: readonly string[]): void => {
    try {
      deps.onChange?.(ids);
    } catch {
      // A failing listener must never undo or block a committed transfer.
    }
  };
  const flush = (): void => {
    flushQueued = false;
    if (pending.length === 0) return;
    if (db.inTransaction) {
      flushQueued = true;
      setImmediate(flush);
      return;
    }
    const ids = new Set<string>();
    for (const p of pending.splice(0)) if (st.txnExists.get(p.txnId)) for (const id of p.ids) ids.add(id);
    if (ids.size > 0) emit([...ids]);
  };
  const notify = (txnId: number, ids: readonly string[]): void => {
    if (!deps.onChange || ids.length === 0) return;
    if (!db.inTransaction) {
      emit(ids);
      return;
    }
    pending.push({ txnId, ids });
    if (!flushQueued) {
      flushQueued = true;
      queueMicrotask(flush);
    }
  };

  const balanceOf = (account: string): number => {
    const parsed = parseLedgerAccount(account);
    if (!parsed) throw new TypeError('wallet: malformed ledger account: ' + account);
    switch (parsed.type) {
      case 'wallet':
        return (st.walletGet.get(parsed.accountId) as { balance: number } | undefined)?.balance ?? 0;
      case 'escrow':
        return (st.escrowGet.get(parsed.ref, parsed.holder) as number | undefined) ?? 0;
      case 'pot':
        return (st.potGet.get(parsed.scope) as { pool: number } | undefined)?.pool ?? 0;
      case 'house':
        return Number.POSITIVE_INFINITY;
    }
  };

  const applyLeg = (leg: MergedLeg, kind: TxnKind, now: number): number => {
    const { parsed, delta } = leg;
    switch (parsed.type) {
      case 'wallet': {
        let row = st.walletAdd.get(delta, now, parsed.accountId, delta) as { balance: number } | undefined;
        if (!row && !st.walletGet.get(parsed.accountId)) {
          st.walletCreate.run(parsed.accountId, now, now);
          row = st.walletAdd.get(delta, now, parsed.accountId, delta) as { balance: number } | undefined;
        }
        if (!row) throw new Refused('funds');
        return row.balance;
      }
      case 'escrow': {
        const current = st.escrowGet.get(parsed.ref, parsed.holder) as number | undefined;
        const next = (current ?? 0) + delta;
        if (next < 0) throw new Refused('funds');
        if (next === 0) {
          if (current !== undefined) st.escrowDelete.run(parsed.ref, parsed.holder);
        } else if (current !== undefined) {
          st.escrowSet.run(next, now, parsed.ref, parsed.holder);
        } else {
          st.escrowInsert.run(parsed.ref, parsed.holder, next, kind === 'buyin' ? 'buyin' : 'stack', now);
        }
        return next;
      }
      case 'pot': {
        st.potCreate.run(parsed.scope, now);
        const row = st.potAdd.get(delta, now, parsed.scope, delta) as { pool: number } | undefined;
        if (!row) throw new Refused('funds');
        return row.pool;
      }
      case 'house': {
        const last = st.houseLast.get() as number | undefined;
        return (last ?? (st.houseMonths.get() as number)) + delta;
      }
    }
  };

  const runTransfer = db.transaction(
    (kind: TxnKind, ref: string, actor: string, idem: string | null, legs: readonly MergedLeg[], opts: TransferOpts): Transfer => {
      if (idem !== null) {
        const found = st.findTxn.get(actor, idem) as { id: number; result: string | null } | undefined;
        if (found) return { ok: true, dup: true, receipt: found.result ?? null };
      }
      if (legs.length === 0 || legs.reduce((sum, leg) => sum + leg.delta, 0) !== 0) return { ok: false, code: 'unbalanced' };
      if (opts.min) for (const [account, min] of Object.entries(opts.min)) if (balanceOf(account) < min) return { ok: false, code: 'min' };
      const now = deps.clock.now();
      const txnId = Number(st.insertTxn.run(kind, ref, actor, idem, opts.receipt ?? null, now).lastInsertRowid);
      const balances = new Map<LedgerAccount, number>();
      for (const leg of legs) {
        const after = applyLeg(leg, kind, now);
        st.insertLeg.run(txnId, leg.account, leg.delta, after, kind, now);
        balances.set(leg.account, after);
      }
      return { ok: true, dup: false, txnId, balances };
    },
  );

  const transfer: Wallet['transfer'] = (kind, ref, actor, idem, legs, opts = {}) => {
    if (!TXN_KINDS.includes(kind)) throw new TypeError('wallet: unknown txn kind: ' + String(kind));
    const merged = mergeLegs(legs);
    let result: Transfer;
    try {
      result = runTransfer(kind, ref, actor, idem, merged, opts);
    } catch (err) {
      if (err instanceof Refused) return { ok: false, code: err.code };
      throw err;
    }
    if (result.ok && !result.dup) {
      const ids: string[] = [];
      for (const leg of merged) if (leg.parsed.type === 'wallet') ids.push(leg.parsed.accountId);
      notify(result.txnId, ids);
    }
    return result;
  };

  const tx = <T>(fn: () => T): T => {
    const out = db.transaction(fn)();
    if (!db.inTransaction && pending.length > 0) flush();
    return out;
  };

  const grantLegs = (accountId: string, chips: number): Leg[] => [
    { account: 'house', delta: -chips },
    { account: walletAccount(accountId), delta: chips },
  ];

  const view: Wallet['view'] = (accountId) => {
    let row = st.walletGet.get(accountId) as { balance: number; claimDay: string | null } | undefined;
    if (!row || !st.findTxn.get('system', 'grant:' + accountId)) {
      const chips = Math.max(0, Math.floor(deps.settings().startChips));
      transfer('grant', WALLET_REF, 'system', 'grant:' + accountId, grantLegs(accountId, chips));
      row = st.walletGet.get(accountId) as { balance: number; claimDay: string | null };
    }
    const esc = st.escrowSum.get(accountId) as number;
    return { bal: row.balance, esc, claim: row.claimDay !== utcDay(deps.clock.now()) };
  };

  const claim: Wallet['claim'] = (accountId) =>
    tx(() => {
      const current = view(accountId);
      if (!current.claim) return { ok: false, bal: current.bal, got: 0 };
      const now = deps.clock.now();
      const day = utcDay(now);
      const settings = deps.settings();
      const got = Math.max(0, Math.floor(Math.max(settings.claimMin, settings.claimFloor - (current.bal + current.esc))));
      const result = transfer('claim', WALLET_REF, 'system', 'claim:' + accountId + ':' + day, grantLegs(accountId, got));
      st.walletClaimDay.run(day, now, accountId);
      if (result.ok && !result.dup) return { ok: true, bal: result.balances.get(walletAccount(accountId)) ?? current.bal + got, got };
      return { ok: false, bal: current.bal, got: 0 };
    });

  const escrowStmts = new Map<string, { all(...args: (string | number)[]): unknown[] }>();
  const escrowRows: Wallet['escrowRows'] = (refPrefix) => {
    const filter = refFilter(refPrefix);
    let stmt = escrowStmts.get(filter.sql);
    if (!stmt) {
      stmt = db.prepare<(string | number)[]>(
        'SELECT ref, account_id AS account, amount, kind FROM arcade_escrow WHERE ' + filter.sql + ' ORDER BY ref, account_id',
      );
      escrowStmts.set(filter.sql, stmt);
    }
    return stmt.all(...filter.args) as EscrowRow[];
  };

  const refund: Wallet['refund'] = (refPrefix, kind) =>
    tx(() => {
      const byRef = new Map<string, EscrowRow[]>();
      for (const row of escrowRows(refPrefix)) {
        const list = byRef.get(row.ref);
        if (list) list.push(row);
        else byRef.set(row.ref, [row]);
      }
      let total = 0;
      for (const [ref, rows] of byRef) {
        const legs: Leg[] = [];
        for (const row of rows) {
          // Bot chips, and chips of an account that no longer exists, go back to the house.
          const home = isBotHolder(row.account) || !st.accountExists.get(row.account) ? 'house' : walletAccount(row.account);
          legs.push({ account: escrowAccount(ref, row.account), delta: -row.amount }, { account: home, delta: row.amount });
          total += row.amount;
        }
        const base = kind + ':' + ref + ':' + deps.clock.now();
        for (let attempt = 0; ; attempt++) {
          const result = transfer(kind, ref, 'system', attempt === 0 ? base : base + ':' + attempt, legs);
          if (!result.ok) throw new Error('wallet: refund of ' + ref + ' refused: ' + result.code);
          if (!result.dup) break;
        }
      }
      return total;
    });

  const pot: Wallet['pot'] = (scope) => {
    const row = st.potGet.get(scope) as
      | { pool: number; carryE4: number; lastWinner: string | null; lastAmount: number | null; lastWonAt: number | null }
      | undefined;
    if (!row) return { pool: 0, carryE4: 0, last: null };
    return {
      pool: row.pool,
      carryE4: row.carryE4,
      last: row.lastWinner === null ? null : { accountId: row.lastWinner, amount: row.lastAmount ?? 0, at: row.lastWonAt ?? 0 },
    };
  };

  const addCarry: Wallet['addCarry'] = (scope, e4) => {
    if (!Number.isSafeInteger(e4) || e4 < 0) throw new RangeError('wallet: carry must be a non-negative integer');
    const now = deps.clock.now();
    st.potCreate.run(scope, now);
    const total = (st.potGet.get(scope) as { carryE4: number }).carryE4 + e4;
    const whole = Math.floor(total / 10_000);
    st.potCarry.run(total - whole * 10_000, now, scope);
    return whole;
  };

  const potWon: Wallet['potWon'] = (scope, accountId, amount, atMs) => {
    st.potCreate.run(scope, deps.clock.now());
    st.potWon.run(accountId, amount, atMs, deps.clock.now(), scope);
  };

  const receipt: Wallet['receipt'] = (actor, idem) => (st.findTxn.get(actor, idem) as { result: string | null } | undefined)?.result ?? null;

  return { transfer, tx, view, claim, escrowRows, refund, pot, addCarry, potWon, receipt };
};

const SHORT_KINDS_SQL = SHORT_RETENTION_KINDS.map((kind) => "'" + kind + "'").join(', ');

/**
 * Daily job: ledger rows of `spin` and `feature` older than 7 days, and of every other kind older
 * than 90 days, fold into `arcade_ledger_months` per (account, UTC month, kind). Spin and feature
 * txn rows left without ledger rows are then deleted (unless an open `arcade_pending` row points at
 * one); other kinds keep their txn rows so their idempotency keys still dedupe. The txn holding the
 * newest house row is never folded, so the house's running total (`balance_after`) stays readable.
 */
export const foldLedger = (db: DB, nowMs: number): { folded: number } => {
  const due = 'created_at < @short AND (kind IN (' + SHORT_KINDS_SQL + ') OR created_at < @long) AND txn_id != @keep';
  return db.transaction(() => {
    const keep = (db.prepare("SELECT txn_id FROM arcade_ledger WHERE +account = 'house' ORDER BY txn_id DESC LIMIT 1").pluck().get() as number | undefined) ?? -1;
    const args = { short: nowMs - SHORT_RETENTION_MS, long: nowMs - LONG_RETENTION_MS, keep };
    db.prepare(
      `INSERT INTO arcade_ledger_months (account, month, kind, delta, "rows")
       SELECT account, strftime('%Y-%m', created_at / 1000, 'unixepoch'), kind, SUM(delta), COUNT(*)
       FROM arcade_ledger WHERE ${due} GROUP BY 1, 2, 3
       ON CONFLICT (account, month, kind) DO UPDATE SET delta = delta + excluded.delta, "rows" = "rows" + excluded."rows"`,
    ).run(args);
    const folded = db.prepare('DELETE FROM arcade_ledger WHERE ' + due).run(args).changes;
    db.prepare(
      `DELETE FROM arcade_txns WHERE kind IN (${SHORT_KINDS_SQL}) AND created_at < ?
         AND NOT EXISTS (SELECT 1 FROM arcade_ledger l WHERE l.txn_id = arcade_txns.id)
         AND NOT EXISTS (SELECT 1 FROM arcade_pending p WHERE p.txn_id = arcade_txns.id)`,
    ).run(args.short);
    return { folded };
  })();
};

/** Daily job: drop receipts older than 24 h (the txn rows stay, so retries still dedupe). Returns rows cleared. */
export const clearReceipts = (db: DB, nowMs: number): number =>
  db.prepare('UPDATE arcade_txns SET result = NULL WHERE result IS NOT NULL AND created_at < ?').run(nowMs - RECEIPT_TTL_MS).changes;

/** Daily job: delete poker hands older than 30 days and beyond the newest 2,000 per table. Returns rows deleted. */
export const pruneHands = (db: DB, nowMs: number): number =>
  db.transaction(() => {
    const old = db.prepare('DELETE FROM arcade_poker_hands WHERE created_at < ?').run(nowMs - HAND_RETENTION_MS).changes;
    const extra = db
      .prepare(
        `DELETE FROM arcade_poker_hands WHERE id IN (
           SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY table_ref ORDER BY id DESC) AS n FROM arcade_poker_hands) WHERE n > ?)`,
      )
      .run(HANDS_PER_TABLE).changes;
    return old + extra;
  })();

/**
 * The ledger invariant (platform.md §11.2), for tests and the admin check: every txn's legs sum to
 * 0; each `w:`, `e:` and `p:` account's ledger sum (detailed plus folded) equals its balance row (0
 * when there is none); the newest `balance_after` matches (always for the house; for other accounts
 * while none of their rows are folded); nothing is negative.
 * Returns one message per violation (empty when the ledger is sound).
 */
const INVARIANT_SQL = {
  txns: 'SELECT txn_id AS id, SUM(delta) AS s FROM arcade_ledger GROUP BY txn_id HAVING s != 0',
  ledger: 'SELECT account, SUM(delta) AS s, MAX(txn_id) AS t, balance_after AS b FROM arcade_ledger GROUP BY account',
  months: 'SELECT account, SUM(delta) AS s FROM arcade_ledger_months GROUP BY account',
  wallets: 'SELECT account_id AS id, balance FROM arcade_wallets',
  escrow: 'SELECT ref, account_id AS id, amount FROM arcade_escrow',
  pots: 'SELECT scope, pool, carry_e4 AS carry FROM arcade_jackpots',
} as const;
const invariantStmts = new WeakMap<DB, Record<keyof typeof INVARIANT_SQL, { all(): unknown[] }>>();

export const checkInvariant = (db: DB): string[] => {
  let q = invariantStmts.get(db);
  if (!q) {
    q = Object.fromEntries(Object.entries(INVARIANT_SQL).map(([key, sql]) => [key, db.prepare(sql)])) as unknown as Record<keyof typeof INVARIANT_SQL, { all(): unknown[] }>;
    invariantStmts.set(db, q);
  }
  const out: string[] = [];
  for (const row of q.txns.all() as { id: number; s: number }[]) {
    out.push(`txn ${row.id}: legs sum to ${row.s}`);
  }

  const sums = new Map<string, number>();
  const newest = new Map<string, number>();
  for (const row of q.ledger.all() as {
    account: string;
    s: number;
    b: number;
  }[]) {
    sums.set(row.account, row.s);
    newest.set(row.account, row.b);
  }
  const folded = new Set<string>();
  for (const row of q.months.all() as { account: string; s: number }[]) {
    sums.set(row.account, (sums.get(row.account) ?? 0) + row.s);
    folded.add(row.account);
  }

  const balances = new Map<string, number>();
  for (const row of q.wallets.all() as { id: string; balance: number }[]) {
    balances.set('w:' + row.id, row.balance);
  }
  for (const row of q.escrow.all() as { ref: string; id: string; amount: number }[]) {
    balances.set(escrowAccount(row.ref, row.id), row.amount);
    if (row.amount === 0) out.push(`${escrowAccount(row.ref, row.id)}: empty escrow row was not deleted`);
  }
  for (const row of q.pots.all() as { scope: string; pool: number; carry: number }[]) {
    balances.set('p:' + row.scope, row.pool);
    if (row.carry < 0 || row.carry > 9999) out.push(`p:${row.scope}: carry_e4 ${row.carry} out of range`);
  }

  for (const [account, balance] of balances) {
    if (balance < 0) out.push(`${account}: negative balance ${balance}`);
    if (!sums.has(account) && balance !== 0) out.push(`${account}: balance ${balance} but no ledger rows`);
  }
  for (const [account, sum] of sums) {
    const parsed = parseLedgerAccount(account);
    if (!parsed) {
      out.push(`${account}: malformed ledger account`);
      continue;
    }
    const expected = parsed.type === 'house' ? sum : (balances.get(account) ?? 0);
    if (parsed.type !== 'house' && sum !== expected) out.push(`${account}: ledger sums to ${sum}, balance is ${expected}`);
    // A folded row may be newer than every detailed one, except for the house (the fold keeps its newest txn).
    const last = parsed.type === 'house' || !folded.has(account) ? newest.get(account) : undefined;
    if (last !== undefined && last !== expected) out.push(`${account}: newest balance_after ${last}, expected ${expected}`);
  }
  return out;
};
