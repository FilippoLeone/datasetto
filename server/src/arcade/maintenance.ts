/**
 * The Arcade's daily job (platform.md §11.2, plan.md §1.3 #17): fold old ledger rows into months
 * (spin and feature after 7 days, everything else after 90), clear stored receipts after 24 h, prune
 * poker hands (30 days, at most 2,000 per table), and give every table game its `daily()` hook
 * (Glimmerhall picks vaults left pending for 24 h). It runs at boot and then once a day just after
 * midnight UTC, on one unref'd timer.
 */
import type { DB } from '../db/index.js';
import type { Logger } from '../logger.js';
import type { Clock } from './clock.js';
import type { TableGame } from './tables/types.js';
import { clearReceipts, foldLedger, pruneHands } from './wallet.js';

export interface Maintenance {
  runNow(): { folded: number; receipts: number; hands: number };
  stop(): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const createMaintenance = (o: { db: DB; clock: Clock; log: Logger; tableGames(): Iterable<TableGame> }): Maintenance => {
  let timer: unknown = null;

  const runNow = (): { folded: number; receipts: number; hands: number } => {
    const now = o.clock.now();
    let folded = 0;
    let receipts = 0;
    let hands = 0;
    try {
      folded = foldLedger(o.db, now).folded;
      receipts = clearReceipts(o.db, now);
      hands = pruneHands(o.db, now);
    } catch (error) {
      o.log.error({ err: error }, 'arcade daily job failed');
    }
    for (const game of o.tableGames()) {
      try {
        game.daily(now);
      } catch (error) {
        o.log.warn({ err: error }, 'arcade table daily hook failed');
      }
    }
    if (folded + receipts + hands > 0) o.log.info({ folded, receipts, hands }, 'arcade daily job');
    return { folded, receipts, hands };
  };

  const arm = (): void => {
    const now = o.clock.now();
    const nextMidnight = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS + 60_000;
    timer = o.clock.setTimeout(() => {
      runNow();
      arm();
    }, nextMidnight - now);
  };

  runNow();
  arm();

  return {
    runNow,
    stop() {
      if (timer !== null) o.clock.clearTimeout(timer);
      timer = null;
    },
  };
};
