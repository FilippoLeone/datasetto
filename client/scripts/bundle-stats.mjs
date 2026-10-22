/**
 * A Vite (Rolldown) plugin that records, for every emitted JS chunk, its static imports and the
 * modules it holds with their rendered (pre-minify) length. `scripts/check-bundle.mjs` reads it to
 * measure the Arcade's share of the main bundle, whatever else the main bundle grows by.
 *
 * Written to node_modules/.cache/datasetto/bundle-stats.json, outside dist/ so it never ships.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

export const STATS_FILE = resolve(import.meta.dirname, '..', 'node_modules', '.cache', 'datasetto', 'bundle-stats.json');

export const bundleStatsPlugin = () => ({
  name: 'datasetto-bundle-stats',
  apply: 'build',
  generateBundle(_options, bundle) {
    const root = resolve(import.meta.dirname, '..');
    const chunks = [];
    for (const item of Object.values(bundle)) {
      if (item.type !== 'chunk') continue;
      chunks.push({
        fileName: item.fileName,
        isEntry: item.isEntry,
        imports: item.imports,
        modules: Object.entries(item.modules ?? {}).map(([id, m]) => ({
          id: relative(root, id.replace(/^\0/, '')).split('\\').join('/'),
          length: m.renderedLength ?? 0,
        })),
      });
    }
    mkdirSync(dirname(STATS_FILE), { recursive: true });
    writeFileSync(STATS_FILE, JSON.stringify({ builtAt: new Date().toISOString(), chunks }));
  },
});
