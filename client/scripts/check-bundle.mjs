#!/usr/bin/env node
/**
 * Bundle budgets for the Arcade (docs/arcade/platform.md §3.1, plan.md §3.2 "Bundle"), run by
 * `npm run build` after Vite. Fails the build when a budget is exceeded or when the main bundle
 * would load Arcade code at startup:
 *
 * - main entry chunk: at most 4 KB gzip more than before the Arcade (MAIN_BASELINE);
 * - the main entry never imports `arcade-runtime` or a game chunk statically;
 * - `arcade-runtime` ≤ 25 KB; Fuseyard ≤ 45 KB; Bellwick ≤ 60 KB; Lamplight ≤ 50 KB (its bot Worker
 *   ≤ 10 KB); Glimmerhall ≤ 40 KB.
 *
 * Sizes are gzip level 9 of the emitted files.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, process.argv[2] ?? 'dist');
const assets = join(dist, 'assets');

/** The main entry chunk on main before the Arcade (1ef6567), gzip level 9. */
const MAIN_BASELINE = 136_727;
const KB = 1024;
const BUDGETS = [
  { label: 'main bundle growth', match: null, max: 4 * KB },
  { label: 'arcade-runtime', match: /^arcade-runtime-[\w-]+\.js$/, max: 25 * KB },
  { label: 'fuseyard', match: /^fuseyard-[\w-]+\.js$/, max: 45 * KB },
  { label: 'bellwick', match: /^bellwick-[\w-]+\.js$/, max: 60 * KB },
  { label: 'lamplight', match: /^lamplight-[\w-]+\.js$/, max: 50 * KB },
  { label: 'lamplight-bots', match: /^bots\.worker-[\w-]+\.js$/, max: 10 * KB },
  { label: 'glimmer', match: /^glimmer-[\w-]+\.js$/, max: 40 * KB },
];

if (!existsSync(assets)) {
  console.error('check-bundle: ' + assets + ' does not exist; run vite build first');
  process.exit(1);
}

const gz = (file) => gzipSync(readFileSync(join(assets, file)), { level: 9 }).length;
const files = readdirSync(assets).filter((f) => f.endsWith('.js'));
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const entry = /assets\/(index-[\w-]+\.js)/.exec(html)?.[1];
if (!entry) {
  console.error('check-bundle: no entry chunk in index.html');
  process.exit(1);
}

const problems = [];
const rows = [];
const mainSize = gz(entry);
const growth = mainSize - MAIN_BASELINE;
rows.push(['main (' + entry + ')', mainSize, (growth >= 0 ? '+' : '') + growth + ' vs before the Arcade', 4 * KB]);
if (growth > 4 * KB) problems.push('main bundle grew by ' + growth + ' B gzip (budget 4096 B)');

// Static imports of the entry chunk (minified: `from"./x.js"`, or a bare `import"./x.js"`).
const entrySource = readFileSync(join(assets, entry), 'utf8');
const staticImports = [...entrySource.matchAll(/(?:from|import)\s*"\.\/([\w.-]+\.js)"/g)].map((m) => m[1]);
for (const imported of staticImports) {
  if (/^(arcade-runtime|fuseyard|bellwick|lamplight|glimmer|shell|session)-/.test(imported)) {
    problems.push('the main bundle imports ' + imported + ' at startup; Arcade code must stay lazy');
  }
}

for (const budget of BUDGETS.slice(1)) {
  for (const file of files.filter((f) => budget.match.test(f))) {
    const size = gz(file);
    rows.push([budget.label + ' (' + file + ')', size, '', budget.max]);
    if (size > budget.max) problems.push(budget.label + ' is ' + size + ' B gzip (budget ' + budget.max + ' B)');
  }
}

for (const [label, size, note, max] of rows) {
  console.log('check-bundle: ' + label.padEnd(44) + String(size).padStart(8) + ' B gzip  (budget ' + max + ')  ' + note);
}
if (problems.length > 0) {
  for (const problem of problems) console.error('check-bundle: FAIL ' + problem);
  process.exit(1);
}
console.log('check-bundle: all Arcade budgets hold');
