#!/usr/bin/env node
/**
 * Bundle checks, run by `npm run build` after Vite (docs/arcade/platform.md §3.1 and §20 note 49,
 * plan.md §3.2 "Bundle"). Fails the build when:
 *
 * - the Arcade's own code in the main bundle (modules under src/arcade, src/features/arcade and the
 *   shared core that the entry chunk and the chunks it loads at startup hold) is over 4 KB gzip. It
 *   is measured as those modules' share of each chunk's rendered code, applied to the chunk's gzip
 *   size, from the stats that scripts/bundle-stats.mjs records during the build;
 * - the main bundle loads `arcade-runtime`, the shell or a game chunk at startup (a static import);
 * - an Arcade chunk is over its budget: `arcade-runtime` ≤ 25 KB; Fuseyard ≤ 45 KB; Bellwick ≤ 60 KB;
 *   Lamplight ≤ 50 KB (its bot Worker ≤ 10 KB); Glimmerhall ≤ 40 KB;
 * - the main entry chunk passes MAIN_CEILING, a general guard with headroom for the app's own
 *   features. Growth against scripts/bundle-baseline.json (moved on purpose with
 *   `node scripts/check-bundle.mjs --update-baseline`) is printed, and only warned about.
 *
 * Sizes are gzip level 9 of the emitted files.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { STATS_FILE } from './bundle-stats.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = process.argv.slice(2);
const updateBaseline = args.includes('--update-baseline');
const dist = resolve(root, args.find((a) => !a.startsWith('--')) ?? 'dist');
const assets = join(dist, 'assets');
const BASELINE_FILE = join(here, 'bundle-baseline.json');

const KB = 1024;
/** The Arcade's code in the main bundle. */
const ARCADE_MAIN_BUDGET = 4 * KB;
/** The main entry chunk, gzip: a ceiling well above the app with every feature open on 2026-10-22 (151 KB). */
const MAIN_CEILING = 180_000;
/** Growth over the baseline file that earns a warning (never a failure). */
const BASELINE_WARN = 8 * KB;
const ARCADE_MODULE = /(^|\/)src\/(arcade|features\/arcade)\/|(^|\/)arcade\/core\//;
const LAZY_CHUNK = /^(arcade-runtime|fuseyard|bellwick|lamplight|glimmer|shell|session)-/;
const BUDGETS = [
  { label: 'arcade-runtime', match: /^arcade-runtime-[\w-]+\.js$/, max: 25 * KB },
  { label: 'fuseyard', match: /^fuseyard-[\w-]+\.js$/, max: 45 * KB },
  { label: 'bellwick', match: /^bellwick-[\w-]+\.js$/, max: 60 * KB },
  { label: 'lamplight', match: /^lamplight-[\w-]+\.js$/, max: 50 * KB },
  { label: 'lamplight-bots', match: /^bots\.worker-[\w-]+\.js$/, max: 10 * KB },
  { label: 'glimmer', match: /^glimmer-[\w-]+\.js$/, max: 40 * KB },
];

const fail = (message) => {
  console.error('check-bundle: ' + message);
  process.exit(1);
};

if (!existsSync(assets)) fail(assets + ' does not exist; run vite build first');
if (!existsSync(STATS_FILE)) fail('no build stats at ' + STATS_FILE + '; run vite build (the bundle-stats plugin writes them)');

const gzCache = new Map();
const gz = (file) => {
  if (!gzCache.has(file)) gzCache.set(file, gzipSync(readFileSync(join(assets, file)), { level: 9 }).length);
  return gzCache.get(file);
};
const files = readdirSync(assets).filter((f) => f.endsWith('.js'));
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const entry = /assets\/(index-[\w-]+\.js)/.exec(html)?.[1];
if (!entry) fail('no entry chunk in index.html');

const stats = JSON.parse(readFileSync(STATS_FILE, 'utf8'));
const byFile = new Map(stats.chunks.map((c) => [c.fileName.replace(/^assets\//, ''), c]));
if (!byFile.has(entry)) fail('the build stats are from another build (no ' + entry + '); run vite build again');

const problems = [];
const rows = [];
const row = (label, size, max, note = '') => rows.push([label, size, max, note]);

// The main bundle: the entry chunk and every chunk it imports statically, transitively.
const startup = [];
const queue = [entry];
while (queue.length > 0) {
  const file = queue.shift();
  if (startup.includes(file)) continue;
  startup.push(file);
  for (const imported of byFile.get(file)?.imports ?? []) queue.push(imported.replace(/^assets\//, ''));
}
for (const file of startup) {
  if (LAZY_CHUNK.test(file)) problems.push('the main bundle loads ' + file + ' at startup; Arcade code must stay lazy');
}
// The same rule read from the emitted code, in case the stats and the files ever disagree.
const entrySource = readFileSync(join(assets, entry), 'utf8');
for (const m of entrySource.matchAll(/(?:from|import)\s*"\.\/([\w.-]+\.js)"/g)) {
  if (LAZY_CHUNK.test(m[1])) problems.push('the main bundle imports ' + m[1] + ' at startup; Arcade code must stay lazy');
}

// The Arcade's share of each startup chunk.
let arcadeMain = 0;
const arcadeModules = [];
for (const file of startup) {
  const chunk = byFile.get(file);
  const total = chunk.modules.reduce((sum, m) => sum + m.length, 0);
  const mine = chunk.modules.filter((m) => ARCADE_MODULE.test(m.id));
  const length = mine.reduce((sum, m) => sum + m.length, 0);
  if (total > 0 && length > 0) arcadeMain += Math.round((gz(file) * length) / total);
  arcadeModules.push(...mine.map((m) => m.id.replace(/^src\//, '')));
}
row('Arcade code in the main bundle (' + arcadeModules.length + ' modules)', arcadeMain, ARCADE_MAIN_BUDGET);
if (arcadeMain > ARCADE_MAIN_BUDGET) problems.push('the Arcade adds ' + arcadeMain + ' B gzip to the main bundle (budget ' + ARCADE_MAIN_BUDGET + ' B): ' + arcadeModules.join(', '));

// The main entry chunk as a whole: a ceiling, and the growth since the baseline was last moved.
const mainSize = gz(entry);
const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8')).mainGzip : null;
const delta = baseline === null ? null : mainSize - baseline;
row('main entry (' + entry + ')', mainSize, MAIN_CEILING, delta === null ? 'no baseline' : (delta >= 0 ? '+' : '') + delta + ' vs scripts/bundle-baseline.json');
if (mainSize > MAIN_CEILING) problems.push('the main entry is ' + mainSize + ' B gzip, over the ' + MAIN_CEILING + ' B ceiling');

for (const budget of BUDGETS) {
  for (const file of files.filter((f) => budget.match.test(f))) {
    row(budget.label + ' (' + file + ')', gz(file), budget.max);
    if (gz(file) > budget.max) problems.push(budget.label + ' is ' + gz(file) + ' B gzip (budget ' + budget.max + ' B)');
  }
}

for (const [label, size, max, note] of rows) {
  console.log('check-bundle: ' + label.padEnd(52) + String(size).padStart(8) + ' B gzip  (limit ' + max + ')  ' + note);
}
if (delta !== null && delta > BASELINE_WARN) {
  console.warn('check-bundle: WARNING the main entry grew ' + delta + ' B gzip since scripts/bundle-baseline.json; if that is expected, move the baseline with node scripts/check-bundle.mjs --update-baseline');
}
if (updateBaseline) {
  writeFileSync(BASELINE_FILE, JSON.stringify({ mainGzip: mainSize, updated: new Date().toISOString().slice(0, 10) }, null, 2) + '\n');
  console.log('check-bundle: baseline set to ' + mainSize + ' B gzip');
}
if (problems.length > 0) {
  for (const problem of problems) console.error('check-bundle: FAIL ' + problem);
  process.exit(1);
}
console.log('check-bundle: all bundle checks hold');
