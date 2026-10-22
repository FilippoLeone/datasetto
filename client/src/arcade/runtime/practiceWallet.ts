/**
 * Practice chips for offline poker and slots (platform.md §12). They live on this device only
 * (`datasetto.arcade.practice.v1`), never sync and never convert to or from real chips; the UI
 * badges them "PRACTICE". A free refill to 10,000 is always there when the balance is below the
 * minimum bet. Chips escrowed at a table are restored on the first read after the page closed.
 */
import type { PracticeWallet } from './types';
import { readLocal, writeLocal } from './store';

export const PRACTICE_KEY = 'datasetto.arcade.practice.v1';
export const PRACTICE_REFILL = 10_000;

interface Stored {
  v: 1;
  bal: number;
  esc: Record<string, number>;
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

const parse = (raw: unknown): Stored | null => {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || !isCount(o.bal)) return null;
  const esc: Record<string, number> = {};
  if (o.esc && typeof o.esc === 'object') {
    for (const [ref, amount] of Object.entries(o.esc as Record<string, unknown>)) if (isCount(amount) && amount > 0) esc[ref] = Math.floor(amount);
  }
  return { v: 1, bal: Math.floor(o.bal), esc };
};

export const createPracticeWallet = (key: string = PRACTICE_KEY): PracticeWallet & { escrowed(ref: string): number } => {
  let state: Stored | null = null;
  const listeners = new Set<(bal: number) => void>();

  const load = (): Stored => {
    if (state) return state;
    const stored = readLocal(key, parse);
    if (stored) {
      // Escrow still open means the page closed mid-hand: those chips go back to the balance.
      let restored = stored.bal;
      for (const amount of Object.values(stored.esc)) restored += amount;
      state = { v: 1, bal: restored, esc: {} };
      if (Object.keys(stored.esc).length > 0) writeLocal(key, state);
    } else {
      state = { v: 1, bal: PRACTICE_REFILL, esc: {} };
    }
    return state;
  };

  const commit = (): void => {
    const s = load();
    writeLocal(key, s);
    for (const listener of Array.from(listeners)) listener(s.bal);
  };

  return {
    balance: () => load().bal,
    debit(n, _ref) {
      const s = load();
      const amount = Math.floor(n);
      if (!(amount >= 0) || s.bal < amount) return false;
      s.bal -= amount;
      commit();
      return true;
    },
    credit(n, _ref) {
      const amount = Math.floor(n);
      if (!(amount > 0)) return;
      load().bal += amount;
      commit();
    },
    escrow(ref, amount) {
      const s = load();
      const take = Math.max(0, Math.min(s.bal, Math.floor(amount)));
      if (take === 0) return;
      s.bal -= take;
      s.esc[ref] = (s.esc[ref] ?? 0) + take;
      commit();
    },
    release(ref) {
      const s = load();
      const amount = s.esc[ref] ?? 0;
      if (amount === 0) return 0;
      delete s.esc[ref];
      s.bal += amount;
      commit();
      return amount;
    },
    escrowed: (ref) => load().esc[ref] ?? 0,
    refill(minBet) {
      const s = load();
      if (s.bal >= Math.max(1, minBet)) return false;
      s.bal = PRACTICE_REFILL;
      commit();
      return true;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
};

export const practiceWallet: PracticeWallet = createPracticeWallet();
