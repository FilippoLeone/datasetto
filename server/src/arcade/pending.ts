/**
 * Server-held outcomes waiting for a player's next move (`arcade_pending`, one row per account and
 * game): Glimmerhall's vault doors until the pick, kept across restarts. Every call works inside
 * `wallet.tx(...)`, so a pick's transfer and the row's removal commit together. The txn id keeps
 * the wallet's receipt cleanup from dropping the transfer the row points at.
 */
import type { DB } from '../db/index.js';
import type { Clock } from './clock.js';

export type PendingGame = 'glimmer' | 'lamplight';

export interface PendingRow {
  accountId: string;
  kind: string;
  txnId: number;
  data: string;
  createdAt: number;
}

export interface PendingStore {
  get(accountId: string, game: PendingGame): Omit<PendingRow, 'accountId'> | null;
  /** Insert or replace the account's row for this game. */
  put(accountId: string, game: PendingGame, kind: string, txnId: number, data: string): void;
  remove(accountId: string, game: PendingGame): void;
  /** Rows created more than `ms` ago (oldest first), e.g. to settle abandoned vaults. */
  olderThan(game: PendingGame, ms: number): readonly PendingRow[];
}

interface Row {
  account_id: string;
  kind: string;
  txn_id: number;
  data: string;
  created_at: number;
}

export const createPending = (db: DB, clock: Clock): PendingStore => {
  const getStmt = db.prepare<[string, string], Row>('SELECT account_id, kind, txn_id, data, created_at FROM arcade_pending WHERE account_id = ? AND game = ?');
  const putStmt = db.prepare('INSERT OR REPLACE INTO arcade_pending (account_id, game, kind, txn_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const removeStmt = db.prepare('DELETE FROM arcade_pending WHERE account_id = ? AND game = ?');
  const olderStmt = db.prepare<[string, number], Row>(
    'SELECT account_id, kind, txn_id, data, created_at FROM arcade_pending WHERE game = ? AND created_at < ? ORDER BY created_at, account_id',
  );
  const toRow = (r: Row): PendingRow => ({ accountId: r.account_id, kind: r.kind, txnId: r.txn_id, data: r.data, createdAt: r.created_at });
  return {
    get(accountId, game) {
      const r = getStmt.get(accountId, game);
      return r ? { kind: r.kind, txnId: r.txn_id, data: r.data, createdAt: r.created_at } : null;
    },
    put(accountId, game, kind, txnId, data) {
      putStmt.run(accountId, game, kind, txnId, data, clock.now());
    },
    remove(accountId, game) {
      removeStmt.run(accountId, game);
    },
    olderThan(game, ms) {
      return olderStmt.all(game, clock.now() - ms).map(toRow);
    },
  };
};
