/**
 * On-demand Fuseyard soak (docs/arcade/fuseyard.md §12): ten times the CI soak, capped at 60 s.
 *   npx tsx test/arcade/fuseyard/soak.mts [scale]
 * Exits 1 when a criterion fails.
 */
import { median, runSoak, summary } from './soakRun.js';

const scale = Number(process.argv[2] ?? 10);
const s = runSoak(scale, 60_000);
console.log('fuseyard soak ×' + scale + ': ' + summary(s));
const failures: string[] = [];
if (s.stoppedEarly) failures.push(s.stoppedEarly);
if (s.menaceWins / Math.max(1, s.duelRounds) < 0.8) failures.push('Menace won under 80 %');
if (s.selfKills[2]! / Math.max(1, s.deaths[2]!) >= 0.1) failures.push('Menace self-kills ≥ 10 %');
if (s.selfKills[0]! / Math.max(1, s.deaths[0]!) >= 0.4) failures.push('Sprout self-kills ≥ 40 %');
const med = median(s.brawlLengths) / 30;
if (med < 30 || med > 110) failures.push('median Brawl round ' + med.toFixed(0) + ' s');
if (s.maxStuck >= 300) failures.push('a bot stood still for ' + s.maxStuck + ' ticks');
if (s.roundsPastLimit > 0) failures.push(s.roundsPastLimit + ' rounds ran past their limit');
for (const f of failures) console.error('FAIL ' + f);
process.exit(failures.length ? 1 : 0);
