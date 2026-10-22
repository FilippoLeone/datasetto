/**
 * The shared core's purity rules (docs/arcade/platform.md §3.1, §13.4; plan.md §3.2 "Purity";
 * fuseyard.md §2.4). The core runs on the server and on the device, so it may not touch time,
 * randomness, platform APIs or anything outside `server/src/arcade/core`; sims and bots may only
 * loop with bounded `for` loops. `npm run typecheck` also compiles the core with its own tsconfig
 * (no DOM, no Node, erasable syntax only).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/arcade/core');

/** Source with comments removed and string/template contents blanked, so prose never trips a rule. */
export const codeOnly = (source: string): string => {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i] as string;
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      out += c;
      i += 1;
      while (i < n && source[i] !== c) {
        if (source[i] === '\\') i += 1;
        else if (source[i] === '\n') out += '\n';
        i += 1;
      }
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
};

/** Import specifiers, read from the raw source (they live inside strings). */
export const importSpecifiers = (source: string): string[] => {
  const specs: string[] = [];
  const re = /(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(re)) specs.push((match[1] ?? match[2] ?? match[3]) as string);
  return specs;
};

const BANNED_EVERYWHERE: readonly [string, RegExp][] = [
  ['Math.random', /\bMath\s*\.\s*random\b/],
  ['Date', /\bDate\b/],
  ['performance', /\bperformance\b/],
  ['setTimeout', /\bsetTimeout\b/],
  ['setInterval', /\bsetInterval\b/],
  ['setImmediate', /\bsetImmediate\b/],
  ['queueMicrotask', /\bqueueMicrotask\b/],
  ['requestAnimationFrame', /\brequestAnimationFrame\b/],
  ['crypto', /\bcrypto\b/],
  ['for…in', /\bfor\s*\(\s*(?:const|let|var)?\s*[\w$]+\s+in\b/],
  ['enum', /\benum\b/],
  ['process', /\bprocess\b/],
  ['globalThis', /\bglobalThis\b/],
];

const BANNED_IN_LOOPS: readonly [string, RegExp][] = [
  ['while', /\bwhile\s*\(/],
  ['do', /\bdo\s*\{/],
];

const FUSEYARD_STRUCTURES: readonly [string, RegExp][] = [
  ['new Map', /\bnew\s+Map\b/],
  ['new Set', /\bnew\s+Set\b/],
  ['Object.keys/values/entries', /\bObject\s*\.\s*(?:keys|values|entries)\b/],
];

const HIDDEN: readonly [string, RegExp][] = [['hidden', /\bhidden\b/]];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : name.endsWith('.ts') ? [path] : [];
  });

/** Every rule that applies to a core file (path relative to core, with forward slashes). */
export const rulesFor = (rel: string): readonly [string, RegExp][] => {
  const parts = rel.split('/');
  const file = parts[parts.length - 1] as string;
  const rules = [...BANNED_EVERYWHERE];
  const inLoopDir = parts.slice(0, -1).some((dir) => dir === 'sim' || dir === 'bots');
  if (inLoopDir || file === 'sim.ts' || file === 'danger.ts' || file === 'bots.ts') rules.push(...BANNED_IN_LOOPS);
  if (parts[0] === 'fuseyard') {
    if (file === 'sim.ts' || file === 'danger.ts' || file === 'bots.ts') rules.push(...FUSEYARD_STRUCTURES);
    if (file === 'codec.ts' || file === 'view.ts' || file === 'danger.ts' || file === 'bots.ts') rules.push(...HIDDEN);
  }
  return rules;
};

export const violations = (rel: string, source: string, absPath: string): string[] => {
  const found: string[] = [];
  const code = codeOnly(source);
  for (const [name, re] of rulesFor(rel)) {
    const lines = code.split('\n');
    lines.forEach((line, index) => {
      if (re.test(line)) found.push(rel + ':' + (index + 1) + ' uses ' + name);
    });
  }
  for (const spec of importSpecifiers(source)) {
    if (!spec.startsWith('.')) {
      found.push(rel + ' imports ' + spec + ' (only relative imports inside core are allowed)');
      continue;
    }
    if (!spec.endsWith('.js')) found.push(rel + ' imports ' + spec + ' without the .js suffix');
    const target = resolve(dirname(absPath), spec);
    if (target !== CORE && !target.startsWith(CORE + sep)) found.push(rel + ' imports ' + spec + ', outside core');
  }
  return found;
};

describe('the purity scanner', () => {
  it('ignores comments and strings but sees code', () => {
    const src = "// Math.random in a comment\nconst a = 'Date and crypto';\n/* setTimeout */ let x = Math.random();\n";
    expect(violations('net/x.ts', src, join(CORE, 'net/x.ts'))).toEqual(['net/x.ts:3 uses Math.random']);
  });

  it('flags enum, for…in, timers and loops where they are banned', () => {
    expect(violations('a.ts', 'enum E { A }', join(CORE, 'a.ts'))).toContain('a.ts:1 uses enum');
    expect(violations('a.ts', 'for (const k in o) {}', join(CORE, 'a.ts'))).toContain('a.ts:1 uses for…in');
    expect(violations('a.ts', 'for (const k of o) {}', join(CORE, 'a.ts'))).toEqual([]);
    expect(violations('bellwick/sim/room.ts', 'while (x) {}', join(CORE, 'bellwick/sim/room.ts'))).toContain('bellwick/sim/room.ts:1 uses while');
    expect(violations('fuseyard/sim.ts', 'do { } while (x);', join(CORE, 'fuseyard/sim.ts')).length).toBe(2);
    expect(violations('fuseyard/codec.ts', 'while (x) {}', join(CORE, 'fuseyard/codec.ts'))).toEqual([]);
  });

  it("applies Fuseyard's extra tokens to its own files only", () => {
    expect(violations('fuseyard/bots.ts', 'const m = new Map();', join(CORE, 'fuseyard/bots.ts'))).toContain('fuseyard/bots.ts:1 uses new Map');
    expect(violations('fuseyard/view.ts', 'r.hidden', join(CORE, 'fuseyard/view.ts'))).toContain('fuseyard/view.ts:1 uses hidden');
    expect(violations('fuseyard/sim.ts', 'r.hidden', join(CORE, 'fuseyard/sim.ts'))).toEqual([]);
    expect(violations('bellwick/bots.ts', 'const m = new Map();', join(CORE, 'bellwick/bots.ts'))).toEqual([]);
  });

  it('rejects imports that leave core or lack the .js suffix', () => {
    expect(violations('net/a.ts', "import x from 'node:fs';", join(CORE, 'net/a.ts'))[0]).toMatch(/only relative imports/);
    expect(violations('net/a.ts', "import { y } from '../../wallet.js';", join(CORE, 'net/a.ts'))[0]).toMatch(/outside core/);
    expect(violations('net/a.ts', "import type { y } from '../bytes';", join(CORE, 'net/a.ts'))[0]).toMatch(/without the .js suffix/);
    expect(violations('net/a.ts', "import { y } from '../bytes.js';", join(CORE, 'net/a.ts'))).toEqual([]);
  });
});

describe('server/src/arcade/core', () => {
  const files = walk(CORE);

  it('contains the platform core files', () => {
    const rels = files.map((path) => relative(CORE, path).split(sep).join('/'));
    for (const expected of ['version.ts', 'bytes.ts', 'rng.ts', 'hash.ts', 'net/lane.ts', 'net/events.ts', 'net/match.ts', 'net/pacer.ts', 'net/clock.ts', 'net/interp.ts', 'net/budget.ts']) {
      expect(rels).toContain(expected);
    }
  });

  it('keeps every purity rule', () => {
    const found = files.flatMap((path) => violations(relative(CORE, path).split(sep).join('/'), readFileSync(path, 'utf8'), path));
    expect(found).toEqual([]);
  });
});
