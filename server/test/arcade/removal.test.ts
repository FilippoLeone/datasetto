/**
 * The old voice-channel games are gone for good (docs/arcade/platform.md §14, plan.md §3.2
 * "Removal"): no engine, no handlers, no client panel, no assets. Only the old-shell stub
 * (server/src/arcade/legacy.ts) and its test still name the old events.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ALLOWED = new Set(['server/src/arcade/legacy.ts', 'server/test/arcade/legacy.int.test.ts', 'server/test/arcade/removal.test.ts']);
const SCANNED = ['server/src', 'server/test', 'client/src', 'desktop/main.js', 'desktop/preload.js'];
const PATTERNS: readonly RegExp[] = [/MinigameManager/, /minigame/i, /voice:game:/];

const walk = (path: string): string[] => {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => (name === 'node_modules' || name === 'dist' ? [] : walk(join(path, name))));
};

describe('removal of the old games', () => {
  it('leaves no trace in the code outside the old-shell stub', () => {
    const hits: string[] = [];
    for (const base of SCANNED) {
      for (const file of walk(join(ROOT, base))) {
        if (!/\.(ts|tsx|js|mjs|json|css)$/.test(file)) continue;
        const rel = relative(ROOT, file).split(sep).join('/');
        if (ALLOWED.has(rel)) continue;
        const text = readFileSync(file, 'utf8');
        for (const pattern of PATTERNS) if (pattern.test(text)) hits.push(rel + ' matches ' + pattern);
      }
    }
    expect(hits).toEqual([]);
  });

  it('deleted the engine, its assets and the client panel', () => {
    for (const gone of ['server/src/minigames', 'server/assets', 'server/src/socket/handlers/minigame.ts', 'server/src/services/leaderboard.ts', 'client/src/features/minigames']) {
      expect(existsSync(join(ROOT, gone)), gone).toBe(false);
    }
  });

  it('builds the server image without an assets folder', () => {
    const dockerfile = readFileSync(join(ROOT, 'server/Dockerfile'), 'utf8');
    expect(dockerfile).not.toMatch(/assets/);
    const tsconfig = readFileSync(join(ROOT, 'server/tsconfig.json'), 'utf8');
    expect(tsconfig).not.toMatch(/allowJs|checkJs|src\/\*\*\/\*\.js/);
  });
});
