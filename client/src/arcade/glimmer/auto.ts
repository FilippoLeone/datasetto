/**
 * Auto-spin limits and the reality check (glimmerhall.md §12.6, §15).
 *
 * Auto-spin runs 10, 25 or 50 spins, never more, with a required loss limit of 10, 25 or 50 % of
 * the balance it started from, at least 1.6 s between spins and never in turbo. It stops on a
 * feature, a win of 50 × or more (on by default), a pot win, the hall hiding or going away, a
 * disconnect, a balance below the bet, the reality check, the seat moving elsewhere, or the limit.
 *
 * The reality check counts active time per spin (the time since the previous spin, capped at
 * 120 s) and asks at the next settle after 30 minutes: time played, spins and net change, with
 * Keep playing or Leave. It needs no timer.
 */
import { AUTO_STOP_X } from '@arcade/core/glimmer/wire';

export const AUTO_SPINS = [10, 25, 50] as const;
export const AUTO_LOSS = [10, 25, 50] as const;
export const AUTO_GAP_MS = 1600;

export interface AutoCfg {
  spins: (typeof AUTO_SPINS)[number];
  lossPct: (typeof AUTO_LOSS)[number];
  stopBig: boolean;
}

export interface AutoRun {
  cfg: AutoCfg;
  left: number;
  startBal: number;
  /** Chips the run may lose before it stops. */
  limit: number;
}

export type AutoStop = 'done' | 'feature' | 'big' | 'pot' | 'hidden' | 'offline' | 'funds' | 'limit' | 'check' | 'moved' | 'user' | 'refused';

export const startAuto = (cfg: AutoCfg, bal: number): AutoRun => ({ cfg, left: cfg.spins, startBal: bal, limit: Math.floor((bal * cfg.lossPct) / 100) });

/** Before a spin: may the run take another one at `bet`? */
export const autoMayContinue = (run: AutoRun, bal: number, bet: number): AutoStop | null => {
  if (run.left <= 0) return 'done';
  if (bal < bet) return 'funds';
  // The next spin could take the run past its loss limit.
  if (run.startBal - (bal - bet) > run.limit) return 'limit';
  return null;
};

/** After a spin settled. */
export const autoAfterSpin = (run: AutoRun, o: { win: number; bet: number; feature: boolean; pot: boolean }): AutoStop | null => {
  run.left -= 1;
  if (o.pot) return 'pot';
  if (o.feature) return 'feature';
  if (run.cfg.stopBig && o.win >= o.bet * AUTO_STOP_X) return 'big';
  return run.left <= 0 ? 'done' : null;
};

export const AUTO_STOP_TEXT: Record<AutoStop, string> = {
  done: 'Auto-spin finished',
  feature: 'Auto-spin stopped for the feature',
  big: 'Auto-spin stopped on a big win',
  pot: 'Auto-spin stopped: Glimmer Pot!',
  hidden: 'Auto-spin stopped while away',
  offline: 'Auto-spin stopped: connection lost',
  funds: 'Auto-spin stopped: not enough chips',
  limit: 'Auto-spin stopped at your loss limit',
  check: 'Auto-spin stopped for a break',
  moved: 'Auto-spin stopped',
  user: 'Auto-spin stopped',
  refused: 'Auto-spin stopped',
};

export const CHECK_EVERY_MS = 30 * 60_000;
const CAP_MS = 120_000;

export interface RealityCheck {
  /** A spin settled at `now` with this net change. */
  onSpin(now: number, net: number): void;
  /** The summary when a check is due (once), else null. */
  take(): { minutes: number; spins: number; net: number } | null;
  readonly activeMs: number;
}

export const createRealityCheck = (periodMs: number = CHECK_EVERY_MS): RealityCheck => {
  let active = 0;
  let last = -1;
  let spins = 0;
  let net = 0;
  let next = periodMs;
  let due = false;
  return {
    onSpin(now, delta) {
      if (last >= 0) active += Math.min(CAP_MS, Math.max(0, now - last));
      last = now;
      spins += 1;
      net += delta;
      if (active >= next) due = true;
    },
    take() {
      if (!due) return null;
      due = false;
      next = active + periodMs;
      return { minutes: Math.round(active / 60_000), spins, net };
    },
    get activeMs() {
      return active;
    },
  };
};
