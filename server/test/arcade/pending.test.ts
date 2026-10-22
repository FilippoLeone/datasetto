/**
 * `arcade_pending` through `TableApi.pending`: one row per account and game, replaced on put, and
 * removed in the same transaction as the transfer that settles it.
 */
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/index.js';
import { createPending } from '../../src/arcade/pending.js';
import { DEFAULT_SETTINGS } from '../../src/arcade/settings.js';
import { createWallet, escrowAccount, walletAccount } from '../../src/arcade/wallet.js';
import { createFakeClock } from './harness/clock.js';

const setup = () => {
  const db = openDatabase(':memory:', { memory: true });
  const clock = createFakeClock();
  db.prepare("INSERT INTO accounts (id, username, display_name, password_hash, created_at, updated_at) VALUES ('p1', 'p1', 'p1', 'x', 0, 0)").run();
  const wallet = createWallet(db, { clock, settings: () => DEFAULT_SETTINGS });
  wallet.view('p1');
  const pending = createPending(db, clock);
  const stake = (): number => {
    const t = wallet.transfer('spin', 'vault', 'p1', null, [
      { account: walletAccount('p1'), delta: -10 },
      { account: escrowAccount('dash:vault', 'p1'), delta: 10 },
    ]);
    if (!t.ok || t.dup) throw new Error('stake refused');
    return t.txnId;
  };
  return { db, clock, wallet, pending, stake };
};

describe('the pending store', () => {
  it('keeps one row per account and game, replaces it, lists old rows and removes it', () => {
    const { db, clock, pending, stake } = setup();
    expect(pending.get('p1', 'glimmer')).toBeNull();
    const first = stake();
    pending.put('p1', 'glimmer', 'vault', first, '{"doors":[1,2,3]}');
    expect(pending.get('p1', 'glimmer')).toEqual({ kind: 'vault', txnId: first, data: '{"doors":[1,2,3]}', createdAt: clock.now() });
    expect(pending.get('p1', 'lamplight')).toBeNull();
    clock.advance(1000);
    const second = stake();
    pending.put('p1', 'glimmer', 'vault', second, '{"doors":[3,2,1]}');
    expect(pending.get('p1', 'glimmer')?.txnId).toBe(second);
    expect(pending.olderThan('glimmer', 500)).toEqual([]);
    clock.advance(1000);
    expect(pending.olderThan('glimmer', 500)).toEqual([{ accountId: 'p1', kind: 'vault', txnId: second, data: '{"doors":[3,2,1]}', createdAt: clock.now() - 1000 }]);
    pending.remove('p1', 'glimmer');
    expect(pending.get('p1', 'glimmer')).toBeNull();
    db.close();
  });

  it('settles with the transfer in one transaction: a throw rolls both back', () => {
    const { db, wallet, pending, stake } = setup();
    const txn = stake();
    pending.put('p1', 'glimmer', 'vault', txn, '{}');
    expect(() =>
      wallet.tx(() => {
        wallet.transfer('prize', 'vault', 'system', null, [
          { account: escrowAccount('dash:vault', 'p1'), delta: -10 },
          { account: walletAccount('p1'), delta: 10 },
        ]);
        pending.remove('p1', 'glimmer');
        throw new Error('crash before commit');
      }),
    ).toThrow('crash before commit');
    expect(pending.get('p1', 'glimmer')?.txnId).toBe(txn);
    expect(wallet.view('p1').esc).toBe(10);
    wallet.tx(() => {
      wallet.transfer('prize', 'vault', 'system', null, [
        { account: escrowAccount('dash:vault', 'p1'), delta: -10 },
        { account: walletAccount('p1'), delta: 10 },
      ]);
      pending.remove('p1', 'glimmer');
    });
    expect(pending.get('p1', 'glimmer')).toBeNull();
    expect(wallet.view('p1').esc).toBe(0);
    db.close();
  });
});
