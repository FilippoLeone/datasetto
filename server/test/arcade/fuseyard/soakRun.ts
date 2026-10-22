/**
 * The bot soak (docs/arcade/fuseyard.md §12 "fuseyard.soak"): one-on-one Quickfire rounds of Menace
 * against Sprout plus four-bot Brawl rounds at the lobby's default level (Scrapper), with a hard
 * wall cap. Shared by the CI test (soak.test.ts) and the on-demand runner (soak.mts, 10×).
 */
import { performance } from 'node:perf_hooks';
import { BotLevel, EV, Phase, cellAt, newStepIn, type MatchConfig } from '../../../src/arcade/core/fuseyard/rules.js';
import { BotRule } from '../../../src/arcade/core/fuseyard/bots.js';
import { createMatch, step } from '../../../src/arcade/core/fuseyard/sim.js';

export interface SoakStats {
  duelRounds: number;
  menaceWins: number;
  duelDraws: number;
  brawlRounds: number;
  /** Deaths and self-kills by bot level (Sprout, Scrapper, Menace), over every round. */
  deaths: number[];
  selfKills: number[];
  brawlLengths: number[];
  /** Longest run of ticks a living bot stood still outside Wait. */
  maxStuck: number;
  ticks: number;
  /** p99 of the time one playing step took, divided by the bots in it (ms per bot decision). */
  thinkP99Ms: number;
  roundsPastLimit: number;
  wallMs: number;
  stoppedEarly: string | null;
  /** Where the longest stand-still happened. */
  stuckAt: string;
}

const SIZES = [0, 7, 4, 4, 8, 3, 4, 2, 2, 2, 3, 4, 4, 5, 8];

interface Lineup {
  config: MatchConfig;
  levels: number[];
}

const playRound = (lineup: Lineup, stats: SoakStats, times: number[], onRound: (winner: number, lengthTicks: number) => void, roundsWanted: number, deadline: number): number => {
  const m = createMatch(lineup.config, lineup.levels.map((botLevel, slot) => ({ slot, human: false, botLevel })));
  const input = newStepIn();
  const n = lineup.levels.length;
  const lastPos = new Int32Array(4).fill(-1);
  const still = new Int32Array(4);
  let rounds = 0;
  let lastRound = -1;
  const limit = lineup.config.mode === 'quickfire' ? 2700 : 4500;
  for (let t = 0; t < 200_000 && rounds < roundsWanted; t += 1) {
    if ((t & 1023) === 0 && performance.now() > deadline) {
      stats.stoppedEarly = 'wall cap after ' + stats.ticks + ' ticks';
      return rounds;
    }
    const playing = m.current.phase === Phase.Playing;
    const a = performance.now();
    step(m, input);
    const dt = performance.now() - a;
    stats.ticks += 1;
    if (playing) times.push(dt / n);
    const r = m.current;
    for (let i = 0; i < m.eventsLen; ) {
      const k = m.events[i] as number;
      if (k === EV.Died) {
        const slot = m.events[i + 1] as number;
        const killer = m.events[i + 2] as number;
        const lvl = lineup.levels[slot] as number;
        stats.deaths[lvl] = (stats.deaths[lvl] as number) + 1;
        if (killer === slot) stats.selfKills[lvl] = (stats.selfKills[lvl] as number) + 1;
      }
      i += SIZES[k] as number;
    }
    if (r.phase === Phase.Playing) {
      for (let s = 0; s < n; s += 1) {
        const f = r.fighters[s]!;
        if (!f.alive) continue;
        const pos = f.y * 1024 + f.x;
        const waiting = m.brains[s]!.rule === BotRule.Wait;
        if (pos === lastPos[s] && !waiting) {
          still[s] = (still[s] as number) + 1;
          if ((still[s] as number) > stats.maxStuck) {
            stats.maxStuck = still[s] as number;
            const b = m.brains[s]!;
            stats.stuckAt = `seed ${lineup.config.seed} round ${m.round} tick ${r.tick} slot ${s} lvl ${lineup.levels[s]} rule ${b.rule} cell ${cellAt(f.x, f.y)} target ${b.target} path ${b.pathPos}/${b.pathLen} input ${f.lastInput}`;
          }
        } else still[s] = 0;
        lastPos[s] = pos;
      }
    } else still.fill(0);
    if (r.phase === Phase.RoundEnd && m.round !== lastRound) {
      lastRound = m.round;
      rounds += 1;
      if (r.tick > limit) stats.roundsPastLimit += 1;
      onRound(r.winner, r.tick);
    }
    if (r.phase === Phase.MatchEnd) break;
    void cellAt;
  }
  return rounds;
};

/** Runs the soak at `scale` (1 for CI, 10 on demand) within `capMs`. */
export const runSoak = (scale: number, capMs: number): SoakStats => {
  const start = performance.now();
  const deadline = start + capMs;
  const stats: SoakStats = {
    duelRounds: 0,
    menaceWins: 0,
    duelDraws: 0,
    brawlRounds: 0,
    deaths: [0, 0, 0],
    selfKills: [0, 0, 0],
    brawlLengths: [],
    maxStuck: 0,
    ticks: 0,
    thinkP99Ms: 0,
    roundsPastLimit: 0,
    wallMs: 0,
    stoppedEarly: null,
    stuckAt: '',
  };
  const times: number[] = [];
  const duels = 60 * scale;
  for (let i = 0; i < duels && !stats.stoppedEarly; i += 1) {
    const config: MatchConfig = { mode: 'quickfire', arena: 'rotation', fighters: 2, winsNeeded: 3, botLevel: BotLevel.Scrapper, seed: (i + 1) * 7919 };
    // Alternate the sides so neither corner favours Menace.
    const menaceSlot = i % 2;
    const levels = menaceSlot === 0 ? [BotLevel.Menace, BotLevel.Sprout] : [BotLevel.Sprout, BotLevel.Menace];
    playRound({ config, levels }, stats, times, (winner) => {
      stats.duelRounds += 1;
      if (winner === menaceSlot) stats.menaceWins += 1;
      if (winner < 0) stats.duelDraws += 1;
    }, 1, deadline);
  }
  const brawls = 12 * scale;
  for (let seed = 1; stats.brawlRounds < brawls && !stats.stoppedEarly && seed < 1000; seed += 1) {
    const config: MatchConfig = { mode: 'brawl', arena: 'rotation', fighters: 4, winsNeeded: 3, botLevel: BotLevel.Scrapper, seed: seed * 104729 };
    playRound({ config, levels: [1, 1, 1, 1] }, stats, times, (_w, len) => {
      stats.brawlRounds += 1;
      stats.brawlLengths.push(len);
    }, brawls - stats.brawlRounds, deadline);
  }
  times.sort((a, b) => a - b);
  stats.thinkP99Ms = times[Math.floor(times.length * 0.99)] ?? 0;
  stats.wallMs = performance.now() - start;
  return stats;
};

export const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[s.length >> 1] as number) : 0;
};

export const summary = (s: SoakStats): string =>
  [
    `duels ${s.duelRounds}: Menace won ${s.menaceWins} (${((100 * s.menaceWins) / Math.max(1, s.duelRounds)).toFixed(0)} %), draws ${s.duelDraws}`,
    `brawl rounds ${s.brawlRounds}, median ${(median(s.brawlLengths) / 30).toFixed(0)} s`,
    `deaths Sprout/Scrapper/Menace ${s.deaths.join('/')}, self-kills ${s.selfKills.join('/')}`,
    `max stuck ${s.maxStuck} ticks (${s.stuckAt}), think p99 ${(s.thinkP99Ms * 1000).toFixed(1)} µs, ${s.ticks} ticks in ${s.wallMs.toFixed(0)} ms`,
  ].join('; ');
