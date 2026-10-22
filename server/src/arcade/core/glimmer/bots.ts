/**
 * The offline hall's four bot neighbours (glimmerhall.md §14): Juniper, Wex, Saffi and Gus. They
 * spin the real engine with the device's RNG, so their wins are genuine draws; this module only
 * holds their habits. Time is passed in; nothing here reads a clock.
 *
 * | Bot | Machine | Bet | Cadence | Habit |
 * |---|---|---|---|---|
 * | Juniper | Orchard | minimum | 2.5–4 s | after losing 40 % of a session's bankroll, a 60–120 s break |
 * | Wex | Tidepool | 2nd step | 1.6–2.5 s | steady; sparkles at wins of 25× or more |
 * | Saffi | Ember Vault | 3rd–4th step | 1.2–2 s | one step up after a feature, one down after 20 dead spins |
 * | Gus | any | 1st–2nd step | 2–3.5 s | changes machine every 30–60 spins |
 *
 * Each bot has a hidden 10,000-chip bankroll that refills after a 30 s break when broke. In a Dash
 * every bot spins each 1.4–2.2 s.
 */
import type { Rng } from './feature.js';
import { DEFS_BY_IDX, type MachineIdx } from './machines.js';

export interface BotDef {
  name: string;
  /** -1: wanders between machines. */
  machine: MachineIdx | -1;
  /** Bet ladder steps, lowest and highest. */
  steps: readonly [number, number];
  gapMs: readonly [number, number];
  habit: 'breaks' | 'steady' | 'raises' | 'wanders';
}

export const BOTS: readonly BotDef[] = [
  { name: 'Juniper', machine: 0, steps: [0, 0], gapMs: [2500, 4000], habit: 'breaks' },
  { name: 'Wex', machine: 1, steps: [1, 1], gapMs: [1600, 2500], habit: 'steady' },
  { name: 'Saffi', machine: 2, steps: [2, 3], gapMs: [1200, 2000], habit: 'raises' },
  { name: 'Gus', machine: -1, steps: [0, 1], gapMs: [2000, 3500], habit: 'wanders' },
];

export const BOT_BANKROLL = 10_000;
export const BOT_BROKE_REST_MS = 30_000;
export const DASH_GAP_MS: readonly [number, number] = [1400, 2200];

export interface BotState {
  readonly def: BotDef;
  machine: MachineIdx;
  step: number;
  bankroll: number;
  /** Bankroll at the start of the current session (Juniper's 40 % rule). */
  sessionStart: number;
  /** Spins left on this machine before Gus moves on. */
  machineLeft: number;
  deadSpins: number;
  /** No spins before this time. */
  restUntil: number;
}

const between = (rng: Rng, lo: number, hi: number): number => lo + rng(hi - lo + 1);

export const createBot = (index: number, rng: Rng): BotState => {
  const def = BOTS[index] as BotDef;
  const machine = def.machine === -1 ? (rng(3) as MachineIdx) : def.machine;
  return {
    def,
    machine,
    step: between(rng, def.steps[0], def.steps[1]),
    bankroll: BOT_BANKROLL,
    sessionStart: BOT_BANKROLL,
    machineLeft: between(rng, 30, 60),
    deadSpins: 0,
    restUntil: 0,
  };
};

/** Milliseconds until the bot's next spin after one at `nowMs` (rests included). */
export const botDelay = (b: BotState, rng: Rng, nowMs: number, dash: boolean): number => {
  const gap = dash ? DASH_GAP_MS : b.def.gapMs;
  const jitter = between(rng, gap[0], gap[1]);
  return Math.max(jitter, b.restUntil - nowMs);
};

export const botBet = (b: BotState, machine: MachineIdx = b.machine): number => {
  const bets = (DEFS_BY_IDX[machine] as { bets: readonly number[] }).bets;
  return bets[Math.min(b.step, bets.length - 1)] as number;
};

export interface BotSpinOutcome {
  win: number;
  bet: number;
  feature: boolean;
}

/** After a bot's spin settled: update the bankroll and habits. Returns a machine change, if any. */
export const botAfterSpin = (b: BotState, o: BotSpinOutcome, rng: Rng, nowMs: number): { moved: boolean } => {
  b.bankroll += o.win - o.bet;
  let moved = false;
  if (o.win > 0) b.deadSpins = 0;
  else b.deadSpins += 1;
  const def = b.def;
  if (def.habit === 'breaks' && b.sessionStart - b.bankroll >= (b.sessionStart * 4) / 10) {
    b.restUntil = nowMs + between(rng, 60_000, 120_000);
    b.sessionStart = b.bankroll;
  } else if (def.habit === 'raises') {
    if (o.feature) b.step = Math.min(def.steps[1], b.step + 1);
    else if (b.deadSpins >= 20) {
      b.step = Math.max(def.steps[0], b.step - 1);
      b.deadSpins = 0;
    }
  } else if (def.habit === 'wanders') {
    b.machineLeft -= 1;
    if (b.machineLeft <= 0) {
      b.machine = ((b.machine + 1 + rng(2)) % 3) as MachineIdx;
      b.machineLeft = between(rng, 30, 60);
      b.step = between(rng, def.steps[0], def.steps[1]);
      moved = true;
    }
  }
  if (b.bankroll < botBet(b)) {
    b.restUntil = Math.max(b.restUntil, nowMs + BOT_BROKE_REST_MS);
    b.bankroll = BOT_BANKROLL;
    b.sessionStart = BOT_BANKROLL;
  }
  return { moved };
};

/** Wex sparkles at big wins in the hall. */
export const botReacts = (b: BotState, winX100: number): boolean => b.def.habit === 'steady' && winX100 >= 2500;
