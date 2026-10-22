/**
 * Wallet property test (plan.md §3.2 "Wallet", platform.md §11.2): 5,000 seeded operations with
 * the ledger invariant checked after every one, plus targeted cases for each rule.
 */
import { describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../../src/db/index.js';
import { DEFAULT_SETTINGS, type ArcadeSettings } from '../../src/arcade/settings.js';
import {
  checkInvariant,
  clearReceipts,
  createWallet,
  escrowAccount,
  foldLedger,
  parseLedgerAccount,
  potAccount,
  pruneHands,
  SHORT_RETENTION_KINDS,
  utcDay,
  walletAccount,
  type LedgerAccount,
  type Leg,
  type Transfer,
  type TxnKind,
} from '../../src/arcade/wallet.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const START = Date.UTC(2026, 0, 5, 10, 0, 0);

const makeClock = (start = START) => {
  let t = start;
  return {
    now: () => t,
    hr: () => BigInt(t) * 1_000_000n,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    advance(ms: number) {
      t += ms;
    },
    set(ms: number) {
      t = ms;
    },
  };
};

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const setup = (overrides: Partial<ArcadeSettings> = {}) => {
  const db = openDatabase(':memory:', { memory: true });
  const clock = makeClock();
  let settings: ArcadeSettings = { ...DEFAULT_SETTINGS, ...overrides };
  const changes: string[][] = [];
  const wallet = createWallet(db, { clock, settings: () => settings, onChange: (ids) => changes.push([...ids]) });
  const insertAccount = db.prepare("INSERT INTO accounts (id, username, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, 'x', 0, 0)");
  const addAccount = (...ids: string[]) => {
    for (const id of ids) insertAccount.run(id, id, id);
  };
  const setSettings = (next: Partial<ArcadeSettings>) => {
    settings = { ...settings, ...next };
  };
  return { db, clock, wallet, changes, addAccount, setSettings };
};

const count = (db: DB, table: string, where = '1'): number => db.prepare(`SELECT COUNT(*) FROM ${table} WHERE ${where}`).pluck().get() as number;
const ledgerTotal = (db: DB, account: string): number =>
  db
    .prepare('SELECT COALESCE(SUM(delta), 0) FROM (SELECT delta FROM arcade_ledger WHERE account = ? UNION ALL SELECT delta FROM arcade_ledger_months WHERE account = ?)')
    .pluck()
    .get(account, account) as number;

const ok = (r: Transfer): Extract<Transfer, { dup: false }> => {
  if (!r.ok || r.dup) throw new Error('expected a fresh transfer, got ' + JSON.stringify(r));
  return r;
};

class Rollback extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** One seeded sequence on a fresh ledger: the invariant and the model are checked after every operation. */
const runSequence = (seed: number, opsCount: number, tally: Record<string, number>): void => {
  const { db, clock, wallet, addAccount } = setup();
  const rnd = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

  const ACCTS = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'];
  const BOTS = ['bot:1', 'bot:2'];
  const TABLES = ['lamplight:t1', 'lamplight:t10'];
  const REFS = [...TABLES, 'cup:abc', 'cup:abcd', 'dash:d1', 'trio:r:1'];
  const PREFIXES = ['lamplight:t1', 'lamplight:', 'cup:abc', 'cup:', 'dash:d1', 'trio:r', 'trio:r:1', 'trio:'];
  const BETS = [1, 2, 5, 10, 25, 50, 100, 500, 2000];
  const POT = potAccount('glimmer');
  addAccount(...ACCTS);

  // The model: every non-house balance the ledger should hold.
  const model = new Map<string, number>();
  const bal = (account: string) => model.get(account) ?? 0;
  const add = (account: string, delta: number) => {
    if (account === 'house') return;
    const next = bal(account) + delta;
    if (next === 0 && account.startsWith('e:')) model.delete(account);
    else model.set(account, next);
  };
  const apply = (legs: readonly Leg[]) => {
    for (const leg of legs) add(leg.account, leg.delta);
  };
  const escOf = (accountId: string) => {
    let sum = 0;
    for (const [account, amount] of model) {
      const parsed = parseLedgerAccount(account);
      if (parsed?.type === 'escrow' && parsed.holder === accountId) sum += amount;
    }
    return sum;
  };
  const escrows = () => [...model.keys()].filter((a) => a.startsWith('e:'));
  const refMatches = (ref: string, prefix: string) =>
    prefix === '' || (prefix.endsWith(':') ? ref.startsWith(prefix) : ref === prefix || ref.startsWith(prefix + ':'));

  const granted = new Set<string>();
  const claimed = new Map<string, string>();
  const usedAdmin = new Set<number>();
  let carry = 0;
  let lastClear = Number.NEGATIVE_INFINITY;
  let seq = 0;
  type Done = { kind: TxnKind; ref: string; actor: string; idem: string; legs: Leg[]; receipt: string | null; at: number };
  const done: Done[] = [];
  const bump = (key: string) => {
    tally[key] = (tally[key] ?? 0) + 1;
  };

  const grantModel = (a: string) => {
    if (granted.has(a)) return;
    granted.add(a);
    add(walletAccount(a), 20_000);
  };
  const ensureWallet = (a: string) => {
    if (granted.has(a)) return;
    wallet.view(a);
    grantModel(a);
  };
  const record = (kind: TxnKind, ref: string, actor: string, idem: string, legs: Leg[], receipt: string | null = null) =>
    done.push({ kind, ref, actor, idem, legs, receipt, at: clock.now() });
  const expectCode = (r: Transfer, code: string, label: string) => {
    if (r.ok || r.code !== code) throw new Error(`${label}: expected ${code}, got ${JSON.stringify(r)}`);
    bump(code);
  };

  // Pot seeding is the caller's job.
  ok(wallet.transfer('pot_seed', 'glimmer', 'system', 'seed:0', [{ account: 'house', delta: -7500 }, { account: POT, delta: 7500 }]));
  add(POT, 7500);

  const ops: [number, string, () => void][] = [
    [6, 'view', () => {
      const a = pick(ACCTS);
      const r = wallet.view(a);
      grantModel(a);
      const w = walletAccount(a);
      if (r.bal !== bal(w) || r.esc !== escOf(a) || r.claim !== (claimed.get(a) !== utcDay(clock.now()))) {
        throw new Error(`view ${a}: ${JSON.stringify(r)} vs bal ${bal(w)} esc ${escOf(a)}`);
      }
    }],
    [5, 'claim', () => {
      const a = pick(ACCTS);
      grantModel(a);
      const w = walletAccount(a);
      const today = utcDay(clock.now());
      const expected = claimed.get(a) === today ? 0 : Math.max(2000, 10_000 - (bal(w) + escOf(a)));
      const r = wallet.claim(a);
      if (claimed.get(a) === today) {
        if (r.ok || r.got !== 0 || r.bal !== bal(w)) throw new Error('second claim the same day: ' + JSON.stringify(r));
        bump('claim-refused');
        return;
      }
      if (!r.ok || r.got !== expected) throw new Error(`claim ${a}: ${JSON.stringify(r)}, expected ${expected}`);
      const legs: Leg[] = [{ account: 'house', delta: -expected }, { account: w, delta: expected }];
      apply(legs);
      claimed.set(a, today);
      record('claim', 'wallet', 'system', `claim:${a}:${today}`, legs);
      if (r.bal !== bal(w)) throw new Error('claim balance');
      bump('claim');
    }],
    [12, 'buyin', () => {
      const a = pick(ACCTS);
      ensureWallet(a);
      const ref = pick(REFS);
      const w = walletAccount(a);
      const x = int(1, Math.floor(bal(w) * 1.1) + 10);
      const legs: Leg[] = [{ account: w, delta: -x }, { account: escrowAccount(ref, a), delta: x }];
      const idem = 'b' + seq++;
      const r = wallet.transfer('buyin', ref, a, idem, legs);
      if (x > bal(w)) return expectCode(r, 'funds', 'buyin');
      ok(r);
      apply(legs);
      record('buyin', ref, a, idem, legs);
    }],
    [5, 'bot-buyin', () => {
      const bot = pick(BOTS);
      const ref = pick(TABLES);
      const x = int(100, 5000);
      const legs: Leg[] = [{ account: 'house', delta: -x }, { account: escrowAccount(ref, bot), delta: x }];
      const idem = 'bb' + seq++;
      ok(wallet.transfer('buyin', ref, 'system', idem, legs));
      apply(legs);
      record('buyin', ref, 'system', idem, legs);
    }],
    [8, 'cashout', () => {
      const list = escrows();
      if (list.length === 0) return;
      const account = pick(list) as LedgerAccount;
      const parsed = parseLedgerAccount(account);
      if (parsed?.type !== 'escrow') throw new Error('bad escrow key ' + account);
      const amount = bal(account);
      const roll = rnd();
      const y = roll < 0.6 ? amount : roll < 0.9 ? int(1, amount) : amount + int(1, 50);
      const bot = parsed.holder.startsWith('bot:');
      const legs: Leg[] = [{ account, delta: -y }, { account: bot ? 'house' : walletAccount(parsed.holder), delta: y }];
      const actor = bot ? 'system' : parsed.holder;
      const idem = 'c' + seq++;
      const r = wallet.transfer('cashout', parsed.ref, actor, idem, legs);
      if (y > amount) return expectCode(r, 'funds', 'cashout');
      ok(r);
      apply(legs);
      record('cashout', parsed.ref, actor, idem, legs);
    }],
    [10, 'hand', () => {
      const byRef = new Map<string, string[]>();
      for (const account of escrows()) {
        const parsed = parseLedgerAccount(account);
        if (parsed?.type !== 'escrow') continue;
        byRef.set(parsed.ref, [...(byRef.get(parsed.ref) ?? []), account]);
      }
      const tables = [...byRef].filter(([, list]) => list.length >= 2);
      if (tables.length === 0) return;
      const [ref, seats] = pick(tables);
      const order = [...seats].sort(() => rnd() - 0.5);
      const losers = order.slice(0, int(1, order.length - 1));
      const winners = order.slice(losers.length);
      const overdraw = rnd() < 0.1;
      const legs: Leg[] = [];
      let pot = 0;
      losers.forEach((account, i) => {
        const loss = overdraw && i === 0 ? bal(account) + int(1, 100) : int(0, bal(account));
        legs.push({ account: account as LedgerAccount, delta: -loss });
        pot += loss;
      });
      winners.forEach((account, i) => {
        const share = i === winners.length - 1 ? pot : int(0, pot);
        pot -= share;
        legs.push({ account: account as LedgerAccount, delta: share });
      });
      const idem = 'h' + seq++;
      const r = wallet.transfer('hand', ref, 'system', idem, legs);
      if (overdraw) return expectCode(r, 'funds', 'hand');
      ok(r);
      apply(legs);
      record('hand', ref, 'system', idem, legs);
    }],
    [25, 'spin', () => {
      const a = pick(ACCTS);
      ensureWallet(a);
      const w = walletAccount(a);
      const bet = pick(BETS);
      const win = rnd() < 0.65 ? 0 : Math.floor(bet * pick([0.5, 1, 2, 5, 20, 100]));
      const hit = rnd() < 0.02;
      const idem = 'g:' + seq++;
      let outcome: { legs: Leg[]; receipt: string; whole: number; potWin: number } | string;
      try {
        outcome = wallet.tx(() => {
          const whole = wallet.addCarry('glimmer', bet * 75);
          const pool = wallet.pot('glimmer').pool;
          const potWin = hit ? pool + whole : 0;
          const legs: Leg[] = [{ account: w, delta: win - bet + potWin }];
          if (whole - potWin !== 0) legs.push({ account: POT, delta: whole - potWin });
          legs.push({ account: 'house', delta: -(win - bet + potWin) - (whole - potWin) });
          const receipt = JSON.stringify({ id: idem, w: win, pt: potWin });
          const r = wallet.transfer('spin', 'glimmer:orchard', a, idem, legs, { min: { [w]: bet }, receipt });
          if (!r.ok) throw new Rollback(r.code);
          if (r.dup) throw new Rollback('dup');
          if (potWin > 0) {
            ok(wallet.transfer('pot_seed', 'glimmer', 'system', 'seed:' + idem, [{ account: 'house', delta: -7500 }, { account: POT, delta: 7500 }]));
            wallet.potWon('glimmer', a, potWin, clock.now());
          }
          return { legs, receipt, whole, potWin };
        });
      } catch (err) {
        if (!(err instanceof Rollback)) throw err;
        outcome = err.code;
      }
      if (bal(w) < bet) {
        if (outcome !== 'min') throw new Error(`spin with ${bal(w)} < ${bet}: ${JSON.stringify(outcome)}`);
        bump('min');
      } else {
        if (typeof outcome === 'string') throw new Error('spin refused: ' + outcome);
        carry += bet * 75;
        const whole = Math.floor(carry / 10_000);
        carry -= whole * 10_000;
        if (outcome.whole !== whole) throw new Error('carry whole chips');
        apply(outcome.legs);
        if (outcome.potWin > 0) {
          add(POT, 7500);
          bump('pot-win');
          const last = wallet.pot('glimmer').last;
          if (last?.accountId !== a || last.amount !== outcome.potWin) throw new Error('pot winner');
        }
        record('spin', 'glimmer:orchard', a, idem, outcome.legs, outcome.receipt);
        bump(win > bet ? 'spin-up' : 'spin');
      }
      if (wallet.pot('glimmer').carryE4 !== carry) throw new Error('carry');
    }],
    [4, 'feature', () => {
      const a = pick(ACCTS);
      ensureWallet(a);
      const win = int(1, 3000);
      const legs: Leg[] = [{ account: 'house', delta: -win }, { account: walletAccount(a), delta: win }];
      const idem = 'gp:' + seq++;
      const receipt = JSON.stringify({ w: win });
      ok(wallet.transfer('feature', 'glimmer:embervault', a, idem, legs, { receipt }));
      apply(legs);
      record('feature', 'glimmer:embervault', a, idem, legs, receipt);
    }],
    [8, 'retry', () => {
      if (done.length === 0) return;
      const d = pick(done);
      // Spin and feature txn rows are deleted with their folded ledger rows after 7 days.
      if (SHORT_RETENTION_KINDS.includes(d.kind) && clock.now() - d.at >= 7 * DAY) return;
      const r = wallet.transfer(d.kind, d.ref, d.actor, d.idem, d.legs);
      const expected = d.at < lastClear - DAY ? null : d.receipt;
      if (!r.ok || !r.dup || r.receipt !== expected) throw new Error(`retry ${d.kind} ${d.idem}: ${JSON.stringify(r)}, expected receipt ${expected}`);
      if (wallet.receipt(d.actor, d.idem) !== expected) throw new Error('receipt()');
      bump('dup');
    }],
    [3, 'system-dup', () => {
      const k = int(0, 40);
      const a = ACCTS[k % ACCTS.length];
      const legs: Leg[] = [{ account: 'house', delta: -(10 + k) }, { account: walletAccount(a), delta: 10 + k }];
      const r = wallet.transfer('admin', 'admin', 'system', 'admin:' + k, legs);
      if (usedAdmin.has(k)) {
        if (!r.ok || !r.dup) throw new Error('system txn did not dedupe');
        bump('system-dup');
        return;
      }
      ok(r);
      usedAdmin.add(k);
      apply(legs);
      record('admin', 'admin', 'system', 'admin:' + k, legs);
    }],
    [2, 'unbalanced', () => {
      const a = pick(ACCTS);
      const r = wallet.transfer('admin', 'admin', 'system', 'u' + seq++, [{ account: walletAccount(a), delta: 5 }, { account: 'house', delta: -4 }]);
      expectCode(r, 'unbalanced', 'unbalanced');
    }],
    [4, 'refund', () => {
      const prefix = pick(PREFIXES);
      let expected = 0;
      const moves: Leg[] = [];
      for (const account of escrows()) {
        const parsed = parseLedgerAccount(account);
        if (parsed?.type !== 'escrow' || !refMatches(parsed.ref, prefix)) continue;
        const amount = bal(account);
        expected += amount;
        moves.push({ account: account as LedgerAccount, delta: -amount });
        moves.push({ account: parsed.holder.startsWith('bot:') ? 'house' : walletAccount(parsed.holder), delta: amount });
      }
      const got = wallet.refund(prefix, 'refund');
      if (got !== expected) throw new Error(`refund ${prefix}: ${got}, expected ${expected}`);
      apply(moves);
      if (expected > 0) bump('refund');
    }],
    [1, 'restart-refund', () => {
      let expected = 0;
      const moves: Leg[] = [];
      for (const account of escrows()) {
        const parsed = parseLedgerAccount(account);
        if (parsed?.type !== 'escrow') continue;
        expected += bal(account);
        moves.push({ account: account as LedgerAccount, delta: -bal(account) });
        moves.push({ account: parsed.holder.startsWith('bot:') ? 'house' : walletAccount(parsed.holder), delta: bal(account) });
      }
      if (wallet.refund('', 'restart-refund') !== expected) throw new Error('restart refund total');
      apply(moves);
      if (wallet.escrowRows('').length !== 0) throw new Error('escrow left after restart refund');
      bump('restart-refund');
    }],
    [6, 'time', () => {
      const roll = rnd();
      const ms = roll < 0.7 ? int(1, 90) * 60_000 : roll < 0.9 ? DAY + int(0, 6) * HOUR : roll < 0.97 ? 8 * DAY : 91 * DAY;
      clock.advance(ms);
      clearReceipts(db, clock.now());
      lastClear = clock.now();
      if (ms >= DAY) {
        if (foldLedger(db, clock.now()).folded > 0) bump(ms >= 91 * DAY ? 'fold-91' : ms >= 8 * DAY ? 'fold-8' : 'fold');
      }
    }],
  ];

  const totalWeight = ops.reduce((s, [w]) => s + w, 0);
  const choose = () => {
    let r = rnd() * totalWeight;
    for (const op of ops) {
      r -= op[0];
      if (r < 0) return op;
    }
    return ops[ops.length - 1];
  };

  const readWallets = db.prepare('SELECT account_id AS id, balance FROM arcade_wallets');
  const readEscrow = db.prepare('SELECT ref, account_id AS id, amount FROM arcade_escrow');
  const readPots = db.prepare('SELECT scope, pool FROM arcade_jackpots');
  const compare = (label: string) => {
    const seen = new Set<string>();
    const check = (account: string, actual: number) => {
      seen.add(account);
      if (actual !== bal(account)) throw new Error(`${label}: ${account} is ${actual}, model ${bal(account)}`);
    };
    for (const r of readWallets.all() as { id: string; balance: number }[]) check('w:' + r.id, r.balance);
    for (const r of readEscrow.all() as { ref: string; id: string; amount: number }[]) check(escrowAccount(r.ref, r.id), r.amount);
    for (const r of readPots.all() as { scope: string; pool: number }[]) check('p:' + r.scope, r.pool);
    for (const [account, amount] of model) if (!seen.has(account) && amount !== 0) throw new Error(`${label}: ${account} missing (model ${amount})`);
  };

  for (let i = 0; i < opsCount; i++) {
    const [, name, run] = choose();
    run();
    bump('op:' + name);
    const violations = checkInvariant(db);
    if (violations.length > 0) throw new Error(`seed ${seed}, after op ${i} (${name}): ${violations.join('; ')}`);
    compare(`seed ${seed}, after op ${i} (${name})`);
  }

  // Conservation over both ledger tables: the house minted exactly what everyone else holds.
  const total = db.prepare('SELECT (SELECT COALESCE(SUM(delta), 0) FROM arcade_ledger) + (SELECT COALESCE(SUM(delta), 0) FROM arcade_ledger_months)').pluck().get();
  expect(total).toBe(0);
  let held = 0;
  for (const amount of model.values()) held += amount;
  expect(ledgerTotal(db, 'house')).toBe(-held);
  tally['months:spin'] = (tally['months:spin'] ?? 0) + count(db, 'arcade_ledger_months', "kind = 'spin'");
  tally['months:buyin'] = (tally['months:buyin'] ?? 0) + count(db, 'arcade_ledger_months', "kind = 'buyin'");
  tally['months:merged'] = (tally['months:merged'] ?? 0) + count(db, 'arcade_ledger_months', '"rows" > 1');
  db.close();
};

describe('wallet property test', () => {
  // 20 seeded sequences of 250 operations, each on a fresh ledger: the full invariant check is
  // O(ledger rows), so short-lived ledgers keep 5,000 full checks inside the 2 s budget.
  it('keeps the invariant after each of 5,000 seeded operations', () => {
    const started = performance.now();
    const tally: Record<string, number> = {};
    for (let s = 0; s < 20; s++) runSequence(0x5eed1e + s * 7919, 250, tally);

    // Every path was exercised.
    for (const key of [
      'claim',
      'claim-refused',
      'funds',
      'min',
      'unbalanced',
      'dup',
      'system-dup',
      'refund',
      'restart-refund',
      'pot-win',
      'spin-up',
      'fold-8',
      'fold-91',
      'months:spin',
      'months:buyin',
      'months:merged',
    ]) {
      expect(tally[key] ?? 0, key).toBeGreaterThan(0);
    }
    // About 1–1.5 s alone (the plan's 2 s); the cap leaves room for a busy machine running every suite at once.
    expect(performance.now() - started).toBeLessThan(6000);
  });
});

describe('wallet rules', () => {
  it('grants the start chips once, on the first read', () => {
    const { db, wallet, addAccount, setSettings } = setup();
    addAccount('a', 'b');
    expect(wallet.view('a')).toEqual({ bal: 20_000, esc: 0, claim: true });
    expect(wallet.view('a')).toEqual({ bal: 20_000, esc: 0, claim: true });
    setSettings({ startChips: 50 });
    expect(wallet.view('a').bal).toBe(20_000);
    expect(count(db, 'arcade_txns', "kind = 'grant'")).toBe(1);
    expect(db.prepare("SELECT actor, idem, ref FROM arcade_txns WHERE kind = 'grant'").get()).toEqual({ actor: 'system', idem: 'grant:a', ref: 'wallet' });

    // A wallet first created by a transfer (no grant) still gets its grant on the first read, once.
    ok(wallet.transfer('admin', 'admin', 'system', 'admin:1', [{ account: 'house', delta: -7 }, { account: walletAccount('b'), delta: 7 }]));
    expect(wallet.view('b').bal).toBe(57);
    expect(wallet.view('b').bal).toBe(57);
    expect(checkInvariant(db)).toEqual([]);
  });

  it('claims max(2000, 10000 − (bal + esc)) once per UTC day', () => {
    const { db, clock, wallet, addAccount } = setup();
    addAccount('a', 'b');
    clock.set(Date.UTC(2026, 2, 1, 23, 0));
    expect(wallet.claim('a')).toEqual({ ok: true, bal: 22_000, got: 2000 });
    expect(wallet.claim('a')).toEqual({ ok: false, bal: 22_000, got: 0 });
    expect(wallet.view('a').claim).toBe(false);
    clock.set(Date.UTC(2026, 2, 1, 23, 59, 59, 999));
    expect(wallet.claim('a').ok).toBe(false);
    clock.set(Date.UTC(2026, 2, 2, 0, 0));
    expect(wallet.view('a').claim).toBe(true);

    // b: 3,000 left, 1,000 of it in escrow → 10,000 − 3,000 = 7,000.
    wallet.view('b');
    ok(wallet.transfer('admin', 'admin', 'system', 'drain', [{ account: walletAccount('b'), delta: -17_000 }, { account: 'house', delta: 17_000 }]));
    ok(wallet.transfer('buyin', 'cup:x', 'b', 'reg', [{ account: walletAccount('b'), delta: -1000 }, { account: escrowAccount('cup:x', 'b'), delta: 1000 }]));
    expect(wallet.view('b')).toEqual({ bal: 2000, esc: 1000, claim: true });
    expect(wallet.claim('b')).toEqual({ ok: true, bal: 9000, got: 7000 });
    expect(db.prepare("SELECT claim_day FROM arcade_wallets WHERE account_id = 'b'").pluck().get()).toBe('2026-03-02');
    expect(wallet.receipt('system', 'claim:b:2026-03-02')).toBeNull();
    expect(count(db, 'arcade_txns', "actor = 'system' AND idem = 'claim:b:2026-03-02'")).toBe(1);
    expect(checkInvariant(db)).toEqual([]);
  });

  it('the min guard refuses a spin the balance cannot cover, even when the win would', () => {
    const { db, wallet, addAccount } = setup({ startChips: 5 });
    addAccount('a');
    wallet.view('a');
    const w = walletAccount('a');
    const legs: Leg[] = [{ account: w, delta: 90 }, { account: 'house', delta: -90 }];
    const before = count(db, 'arcade_txns');
    expect(wallet.transfer('spin', 'glimmer:orchard', 'a', 'g:1', legs, { min: { [w]: 10 } })).toEqual({ ok: false, code: 'min' });
    expect(count(db, 'arcade_txns')).toBe(before);
    expect(wallet.view('a').bal).toBe(5);
    // The same net legs pass without the guard, and with a bet the balance covers.
    expect(wallet.transfer('spin', 'glimmer:orchard', 'a', 'g:2', legs, { min: { [w]: 5 } })).toMatchObject({ ok: true, dup: false });
    expect(wallet.view('a').bal).toBe(95);
  });

  it('a funds refusal rolls back every leg', () => {
    const { db, wallet, addAccount, changes } = setup();
    addAccount('a', 'b');
    wallet.view('a');
    wallet.view('b');
    changes.length = 0;
    const txns = count(db, 'arcade_txns');
    const rows = count(db, 'arcade_ledger');
    // a is credited first, then b cannot pay.
    const r = wallet.transfer('admin', 'admin', 'system', 'x', [
      { account: walletAccount('a'), delta: 100 },
      { account: escrowAccount('lamplight:t1', 'a'), delta: 50 },
      { account: walletAccount('b'), delta: -20_001 },
      { account: 'house', delta: 19_851 },
    ]);
    expect(r).toEqual({ ok: false, code: 'funds' });
    expect(wallet.view('a')).toMatchObject({ bal: 20_000, esc: 0 });
    expect(wallet.view('b').bal).toBe(20_000);
    expect(count(db, 'arcade_txns')).toBe(txns);
    expect(count(db, 'arcade_ledger')).toBe(rows);
    expect(count(db, 'arcade_escrow')).toBe(0);
    expect(changes).toEqual([]);
    // Escrow and pots can never go negative either.
    expect(wallet.transfer('cashout', 'lamplight:t1', 'a', 'y', [{ account: escrowAccount('lamplight:t1', 'a'), delta: -1 }, { account: walletAccount('a'), delta: 1 }])).toEqual({
      ok: false,
      code: 'funds',
    });
    expect(wallet.transfer('prize', 'glimmer', 'a', 'z', [{ account: potAccount('glimmer'), delta: -1 }, { account: walletAccount('a'), delta: 1 }])).toEqual({ ok: false, code: 'funds' });
    // A refusal inside a larger transaction undoes only itself.
    wallet.tx(() => {
      ok(wallet.transfer('admin', 'admin', 'system', 'keep', [{ account: 'house', delta: -1 }, { account: walletAccount('a'), delta: 1 }]));
      expect(wallet.transfer('admin', 'admin', 'system', 'drop', [{ account: walletAccount('b'), delta: -99_999 }, { account: 'house', delta: 99_999 }]).ok).toBe(false);
    });
    expect(wallet.view('a').bal).toBe(20_001);
    expect(wallet.view('b').bal).toBe(20_000);
    expect(checkInvariant(db)).toEqual([]);
  });

  it('refuses unbalanced legs and merges a repeated account into one leg', () => {
    const { db, wallet, addAccount } = setup();
    addAccount('a');
    wallet.view('a');
    const w = walletAccount('a');
    expect(wallet.transfer('admin', 'admin', 'system', 'u', [{ account: w, delta: 1 }])).toEqual({ ok: false, code: 'unbalanced' });
    expect(wallet.transfer('admin', 'admin', 'system', 'u', [])).toEqual({ ok: false, code: 'unbalanced' });
    const r = ok(
      wallet.transfer('admin', 'admin', 'system', 'm', [
        { account: w, delta: -5 },
        { account: w, delta: -5 },
        { account: 'house', delta: 10 },
      ]),
    );
    expect(r.balances.get(w)).toBe(19_990);
    expect(db.prepare('SELECT account, delta FROM arcade_ledger WHERE txn_id = ? ORDER BY account').all(r.txnId)).toEqual([
      { account: 'house', delta: 10 },
      { account: w, delta: -10 },
    ]);
    expect(() => wallet.transfer('admin', 'admin', 'system', 'bad', [{ account: 'x:1' as LedgerAccount, delta: 0 }])).toThrow(/malformed/);
    expect(() => wallet.transfer('admin', 'admin', 'system', 'bad', [{ account: w, delta: 0.5 }, { account: 'house', delta: -0.5 }])).toThrow(/integer/);
  });

  it('a retry returns the stored receipt; system txns dedupe by idem', () => {
    const { db, wallet, addAccount } = setup();
    addAccount('a');
    wallet.view('a');
    const legs: Leg[] = [{ account: walletAccount('a'), delta: -10 }, { account: 'house', delta: 10 }];
    ok(wallet.transfer('spin', 'glimmer:orchard', 'a', 'g:1', legs, { receipt: '{"w":0}' }));
    expect(wallet.transfer('spin', 'glimmer:orchard', 'a', 'g:1', legs, { receipt: '{"w":9}' })).toEqual({ ok: true, dup: true, receipt: '{"w":0}' });
    expect(wallet.receipt('a', 'g:1')).toBe('{"w":0}');
    expect(wallet.receipt('a', 'g:2')).toBeNull();
    expect(wallet.view('a').bal).toBe(19_990);
    // Another actor with the same key is a different txn; a null key never dedupes.
    expect(wallet.transfer('spin', 'glimmer:orchard', 'system', 'g:1', legs).ok && true).toBe(true);
    ok(wallet.transfer('admin', 'admin', 'system', null, legs));
    ok(wallet.transfer('admin', 'admin', 'system', null, legs));
    ok(wallet.transfer('admin', 'admin', 'system', 'once', legs));
    expect(wallet.transfer('admin', 'admin', 'system', 'once', legs)).toEqual({ ok: true, dup: true, receipt: null });
    expect(wallet.view('a').bal).toBe(19_950);
    expect(checkInvariant(db)).toEqual([]);
  });

  it('clears receipts after 24 h', () => {
    const { db, clock, wallet, addAccount } = setup();
    addAccount('a');
    wallet.view('a');
    const legs: Leg[] = [{ account: walletAccount('a'), delta: -1 }, { account: 'house', delta: 1 }];
    ok(wallet.transfer('spin', 'glimmer:orchard', 'a', 'g:1', legs, { receipt: '{"ok":1}' }));
    clock.advance(DAY - 1);
    expect(clearReceipts(db, clock.now())).toBe(0);
    expect(wallet.receipt('a', 'g:1')).toBe('{"ok":1}');
    clock.advance(2);
    expect(clearReceipts(db, clock.now())).toBe(1);
    expect(wallet.receipt('a', 'g:1')).toBeNull();
    expect(wallet.transfer('spin', 'glimmer:orchard', 'a', 'g:1', legs)).toEqual({ ok: true, dup: true, receipt: null });
    expect(wallet.view('a').bal).toBe(19_999);
  });

  it('folds spin and feature rows after 7 days and the rest after 90, keeping conservation', () => {
    const { db, clock, wallet, addAccount } = setup();
    addAccount('a');
    clock.set(Date.UTC(2026, 0, 31, 12));
    wallet.view('a');
    const w = walletAccount('a');
    const spin = ok(wallet.transfer('spin', 'glimmer:orchard', 'a', 'g:1', [{ account: w, delta: -10 }, { account: 'house', delta: 10 }]));
    const held = ok(wallet.transfer('spin', 'glimmer:embervault', 'a', 'g:2', [{ account: w, delta: -10 }, { account: 'house', delta: 10 }]));
    db.prepare("INSERT INTO arcade_pending (account_id, game, kind, txn_id, data, created_at) VALUES ('a', 'glimmer', 'vault', ?, '{}', 0)").run(held.txnId);
    ok(wallet.transfer('buyin', 'lamplight:t1', 'a', 'sit', [{ account: w, delta: -500 }, { account: escrowAccount('lamplight:t1', 'a'), delta: 500 }]));
    expect(wallet.claim('a').got).toBe(2000);
    const totals = () => Object.fromEntries([w, 'house', escrowAccount('lamplight:t1', 'a')].map((acc) => [acc, ledgerTotal(db, acc)]));
    const before = totals();
    expect(before[w]).toBe(21_480);

    clock.advance(8 * DAY);
    expect(foldLedger(db, clock.now()).folded).toBe(4);
    expect(totals()).toEqual(before);
    expect(count(db, 'arcade_txns', 'id = ' + spin.txnId)).toBe(0);
    expect(count(db, 'arcade_txns', 'id = ' + held.txnId)).toBe(1); // an open vault still points at it
    expect(count(db, 'arcade_ledger', "kind = 'buyin'")).toBe(2);
    expect(db.prepare("SELECT month, delta, \"rows\" FROM arcade_ledger_months WHERE account = ? AND kind = 'spin'").get(w)).toEqual({ month: '2026-01', delta: -20, rows: 2 });
    expect(checkInvariant(db)).toEqual([]);

    // A later spin still writes a correct house running total over the folded months.
    const next = ok(wallet.transfer('spin', 'glimmer:orchard', 'a', 'g:3', [{ account: w, delta: -1 }, { account: 'house', delta: 1 }]));
    expect(next.balances.get('house')).toBe(ledgerTotal(db, 'house'));

    clock.advance(91 * DAY);
    foldLedger(db, clock.now());
    // Everything folds except the txn holding the newest house row (g:3), which carries the running total.
    expect(db.prepare('SELECT DISTINCT txn_id FROM arcade_ledger').pluck().all()).toEqual([next.txnId]);
    expect(count(db, 'arcade_txns', `kind = 'spin'`)).toBe(2); // g:2 (pending vault) and g:3
    expect(totals()).toEqual({ ...before, [w]: before[w] - 1, house: before.house + 1 });
    expect(checkInvariant(db)).toEqual([]);
    // Txn rows of other kinds are kept, so their keys still dedupe.
    expect(wallet.transfer('buyin', 'lamplight:t1', 'a', 'sit', [{ account: w, delta: -500 }, { account: escrowAccount('lamplight:t1', 'a'), delta: 500 }])).toMatchObject({ dup: true });
    expect(wallet.view('a').bal).toBe(21_479);
    const after = ok(wallet.transfer('feature', 'glimmer:embervault', 'a', 'gp:1', [{ account: 'house', delta: -3 }, { account: w, delta: 3 }]));
    expect(after.balances.get('house')).toBe(ledgerTotal(db, 'house'));
    expect(checkInvariant(db)).toEqual([]);
  });

  it('parses escrow holders, keeps escrow kinds and refunds bots to the house', () => {
    const { db, wallet, addAccount } = setup();
    addAccount('acct1', 'acct2');
    expect(parseLedgerAccount('e:cup:abc:acct1')).toEqual({ type: 'escrow', ref: 'cup:abc', holder: 'acct1' });
    expect(parseLedgerAccount('e:cup:abc:bot:2')).toEqual({ type: 'escrow', ref: 'cup:abc', holder: 'bot:2' });
    expect(parseLedgerAccount('e:lamplight:t1:bot:3')).toEqual({ type: 'escrow', ref: 'lamplight:t1', holder: 'bot:3' });
    expect(parseLedgerAccount('e:dash:d1:acct1')).toEqual({ type: 'escrow', ref: 'dash:d1', holder: 'acct1' });
    expect(parseLedgerAccount('e:nohold')).toBeNull();
    expect(parseLedgerAccount('w:')).toBeNull();
    expect(escrowAccount('cup:abc', 'bot:2')).toBe('e:cup:abc:bot:2');

    wallet.view('acct1');
    wallet.view('acct2');
    ok(wallet.transfer('buyin', 'cup:abc', 'acct1', 'r1', [{ account: walletAccount('acct1'), delta: -300 }, { account: escrowAccount('cup:abc', 'acct1'), delta: 300 }]));
    ok(wallet.transfer('buyin', 'cup:abc', 'system', 'r2', [{ account: 'house', delta: -300 }, { account: escrowAccount('cup:abc', 'bot:2'), delta: 300 }]));
    ok(wallet.transfer('buyin', 'cup:abcd', 'acct2', 'r3', [{ account: walletAccount('acct2'), delta: -40 }, { account: escrowAccount('cup:abcd', 'acct2'), delta: 40 }]));
    // A hand moves chips to a holder with no row yet: that row is a 'stack'.
    ok(wallet.transfer('hand', 'cup:abc', 'system', 'h1', [{ account: escrowAccount('cup:abc', 'bot:2'), delta: -100 }, { account: escrowAccount('cup:abc', 'acct2'), delta: 100 }]));
    expect(db.prepare('SELECT ref, account_id AS id, amount, kind FROM arcade_escrow ORDER BY ref, account_id').all()).toEqual([
      { ref: 'cup:abc', id: 'acct1', amount: 300, kind: 'buyin' },
      { ref: 'cup:abc', id: 'acct2', amount: 100, kind: 'stack' },
      { ref: 'cup:abc', id: 'bot:2', amount: 200, kind: 'buyin' },
      { ref: 'cup:abcd', id: 'acct2', amount: 40, kind: 'buyin' },
    ]);
    expect(wallet.view('acct2').esc).toBe(140);
    expect(wallet.escrowRows('cup:abc').map((r) => r.account)).toEqual(['acct1', 'acct2', 'bot:2']);
    expect(wallet.escrowRows('cup:').length).toBe(4);

    const house = ledgerTotal(db, 'house');
    expect(wallet.refund('cup:abc', 'refund')).toBe(600);
    expect(wallet.view('acct1')).toMatchObject({ bal: 20_000, esc: 0 });
    expect(wallet.view('acct2')).toMatchObject({ bal: 20_060, esc: 40 });
    expect(ledgerTotal(db, 'house')).toBe(house + 200);
    expect(wallet.escrowRows('')).toEqual([{ ref: 'cup:abcd', account: 'acct2', amount: 40, kind: 'buyin' }]);
    expect(db.prepare("SELECT actor, idem FROM arcade_txns WHERE kind = 'refund'").get()).toMatchObject({ actor: 'system', idem: expect.stringMatching(/^refund:cup:abc:\d+$/) });
    expect(wallet.refund('', 'restart-refund')).toBe(40);
    expect(count(db, 'arcade_escrow')).toBe(0);
    expect(checkInvariant(db)).toEqual([]);
  });

  it('accumulates sub-chip carry and records pot winners', () => {
    const { db, clock, wallet } = setup();
    expect(wallet.pot('glimmer')).toEqual({ pool: 0, carryE4: 0, last: null });
    expect(wallet.addCarry('glimmer', 9_999)).toBe(0);
    expect(wallet.addCarry('glimmer', 1)).toBe(1);
    expect(wallet.pot('glimmer').carryE4).toBe(0);
    expect(wallet.addCarry('glimmer', 2000 * 75)).toBe(15);
    expect(wallet.pot('glimmer').carryE4).toBe(0);
    expect(wallet.addCarry('glimmer', 25 * 75)).toBe(0);
    expect(wallet.pot('glimmer').carryE4).toBe(1875);
    expect(() => wallet.addCarry('glimmer', -1)).toThrow();
    ok(wallet.transfer('pot_seed', 'glimmer', 'system', 'seed:1', [{ account: 'house', delta: -7500 }, { account: potAccount('glimmer'), delta: 7500 }]));
    wallet.potWon('glimmer', 'a', 7500, clock.now());
    expect(wallet.pot('glimmer')).toEqual({ pool: 7500, carryE4: 1875, last: { accountId: 'a', amount: 7500, at: clock.now() } });
    expect(checkInvariant(db)).toEqual([]);
  });

  it('reports changed wallets after the outermost transaction commits', async () => {
    const { wallet, addAccount, changes } = setup();
    addAccount('a', 'b');
    wallet.view('a');
    wallet.view('b');
    expect(changes).toEqual([['a'], ['b']]);
    changes.length = 0;
    wallet.tx(() => {
      ok(wallet.transfer('buyin', 'lamplight:t1', 'a', 's', [{ account: walletAccount('a'), delta: -5 }, { account: escrowAccount('lamplight:t1', 'a'), delta: 5 }]));
      ok(wallet.transfer('admin', 'admin', 'system', 'x', [{ account: walletAccount('b'), delta: -5 }, { account: walletAccount('a'), delta: 5 }]));
      expect(changes).toEqual([]);
    });
    expect(changes).toEqual([['a', 'b']]);
    changes.length = 0;
    // Escrow-only and refused transfers report nothing; neither does a rolled-back transaction.
    ok(wallet.transfer('hand', 'lamplight:t1', 'system', 'h', [{ account: escrowAccount('lamplight:t1', 'a'), delta: -5 }, { account: escrowAccount('lamplight:t1', 'b'), delta: 5 }]));
    wallet.transfer('admin', 'admin', 'system', 'y', [{ account: walletAccount('a'), delta: -1e9 }, { account: 'house', delta: 1e9 }]);
    expect(() =>
      wallet.tx(() => {
        ok(wallet.transfer('admin', 'admin', 'system', 'z', [{ account: 'house', delta: -1 }, { account: walletAccount('a'), delta: 1 }]));
        throw new Error('game bug');
      }),
    ).toThrow('game bug');
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(changes).toEqual([]);
    expect(wallet.view('a').bal).toBe(20_000);
  });

  it('prunes poker hands after 30 days and beyond 2,000 per table', () => {
    const { db, clock } = setup();
    const now = clock.now();
    const insert = db.prepare(
      "INSERT INTO arcade_poker_hands (table_ref, hand_no, format, seats, commit_root, hand_secret, deck, record, created_at) VALUES (?, ?, 'cash', '[]', x'00', x'00', x'00', '{}', ?)",
    );
    db.transaction(() => {
      for (let i = 0; i < 2005; i++) insert.run('lamplight:t1', i, now - 1000 + i);
      for (let i = 0; i < 3; i++) insert.run('lamplight:t2', i, now - 31 * DAY);
      insert.run('lamplight:t2', 3, now - 29 * DAY);
    })();
    expect(pruneHands(db, now)).toBe(8);
    expect(count(db, 'arcade_poker_hands', "table_ref = 'lamplight:t1'")).toBe(2000);
    expect(db.prepare("SELECT MIN(hand_no) FROM arcade_poker_hands WHERE table_ref = 'lamplight:t1'").pluck().get()).toBe(5);
    expect(count(db, 'arcade_poker_hands', "table_ref = 'lamplight:t2'")).toBe(1);
  });

  it('checkInvariant reports a tampered ledger', () => {
    const { db, wallet, addAccount } = setup();
    addAccount('a');
    wallet.view('a');
    expect(checkInvariant(db)).toEqual([]);
    db.prepare("UPDATE arcade_wallets SET balance = balance + 1 WHERE account_id = 'a'").run();
    expect(checkInvariant(db).join('\n')).toMatch(/w:a: ledger sums to 20000, balance is 20001/);
    db.prepare("UPDATE arcade_wallets SET balance = balance - 1 WHERE account_id = 'a'").run();
    db.prepare("UPDATE arcade_ledger SET delta = delta + 1 WHERE account = 'house'").run();
    expect(checkInvariant(db).join('\n')).toMatch(/legs sum to 1/);
  });
});
