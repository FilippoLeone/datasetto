/**
 * What Glimmerhall keeps on the device (glimmerhall.md §13), every access through the runtime's
 * try/catch store with its in-memory fallback:
 * - `datasetto.arcade.glimmer.v1`: an offline pending vault (its base spin already took the Practice
 *   chips) and offline stats;
 * - Glimmerhall's record in `datasetto.arcade.prefs.v1`: turbo, last machine, haptics, the first-open
 *   notice, auto-spin's stop-on-big-win switch.
 */
import type { MachineIdx } from '@arcade/core/glimmer/machines';
import { readGamePref, writeGamePref } from '@/arcade/runtime/prefs';
import { readLocal, writeLocal } from '@/arcade/runtime/store';

export const GLIMMER_KEY = 'datasetto.arcade.glimmer.v1';

export interface MachineStats {
  spins: number;
  wagered: number;
  won: number;
  /** Best single result in chips and its multiple × 100. */
  best: number;
  bestx: number;
}

export interface DeviceState {
  v: 1;
  pend: { m: MachineIdx; bet: number; doors: number[] } | null;
  stats: MachineStats[];
  dash: { played: number; wins: number };
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const isMachine = (v: unknown): v is MachineIdx => v === 0 || v === 1 || v === 2;

const blankStats = (): MachineStats => ({ spins: 0, wagered: 0, won: 0, best: 0, bestx: 0 });

const parse = (raw: unknown): DeviceState | null => {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return null;
  let pend: DeviceState['pend'] = null;
  const p = o.pend as Record<string, unknown> | null | undefined;
  if (p && isMachine(p.m) && count(p.bet) > 0 && Array.isArray(p.doors) && p.doors.length === 3 && [...p.doors].sort().join() === '0,1,2') {
    pend = { m: p.m, bet: count(p.bet), doors: (p.doors as number[]).slice() };
  }
  const stats: MachineStats[] = [0, 1, 2].map((i) => {
    const s = (Array.isArray(o.stats) ? (o.stats[i] as Record<string, unknown> | undefined) : undefined) ?? {};
    return { spins: count(s.spins), wagered: count(s.wagered), won: count(s.won), best: count(s.best), bestx: count(s.bestx) };
  });
  const d = (o.dash as Record<string, unknown> | undefined) ?? {};
  return { v: 1, pend, stats, dash: { played: count(d.played), wins: count(d.wins) } };
};

export const loadDevice = (key: string = GLIMMER_KEY): DeviceState =>
  readLocal(key, parse) ?? { v: 1, pend: null, stats: [blankStats(), blankStats(), blankStats()], dash: { played: 0, wins: 0 } };

export const saveDevice = (state: DeviceState, key: string = GLIMMER_KEY): void => {
  writeLocal(key, state);
};

export interface GlimmerPrefs {
  turbo: boolean;
  machine: MachineIdx;
  haptics: boolean;
  /** The first-open "play money" card was acknowledged. */
  notice: boolean;
  /** Auto-spin stops on a win of 50 × or more. */
  stopBig: boolean;
  /** Last bet step per machine. */
  steps: [number, number, number];
}

export const DEFAULT_GLIMMER_PREFS: GlimmerPrefs = { turbo: false, machine: 1, haptics: false, notice: false, stopBig: true, steps: [0, 0, 0] };

const parsePrefs = (raw: unknown): GlimmerPrefs | null => {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const steps = Array.isArray(o.steps) ? o.steps : [];
  const step = (i: number): number => Math.min(4, count(steps[i]));
  return {
    turbo: o.turbo === true,
    machine: isMachine(o.machine) ? o.machine : DEFAULT_GLIMMER_PREFS.machine,
    haptics: o.haptics === true,
    notice: o.notice === true,
    stopBig: o.stopBig !== false,
    steps: [step(0), step(1), step(2)],
  };
};

export const loadGlimmerPrefs = (): GlimmerPrefs => readGamePref('glimmer', parsePrefs) ?? { ...DEFAULT_GLIMMER_PREFS, steps: [0, 0, 0] };

export const saveGlimmerPrefs = (p: GlimmerPrefs): void => {
  writeGamePref('glimmer', p);
};
