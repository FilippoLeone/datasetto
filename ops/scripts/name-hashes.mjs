#!/usr/bin/env node
/**
 * The naming scan's helper (docs/arcade/platform.md §18). The repository holds only SHA-256 hashes of
 * the deny list (server/test/naming.test.ts); the maintainer keeps the plain list outside the repo.
 *
 *   node ops/scripts/name-hashes.mjs <list-file>     print the hashes of every line (lower-cased words,
 *                                                   one- or two-word entries) for the test's DENY set
 *   node ops/scripts/name-hashes.mjs --git [range]   scan commit messages (default: main..HEAD) for any
 *                                                   word or word pair whose hash is in the DENY set
 *   node ops/scripts/name-hashes.mjs --scan <path…>  scan files the same way the test does
 *
 * Words are runs of letters and digits (apostrophes and hyphens join a word, then are dropped), lower
 * cased; a pair is two neighbouring words joined by one space.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const sha = (text) => createHash('sha256').update(text).digest('hex');

/** Lower-cased words of a text; apostrophes and hyphens inside a word are dropped (pac-man → pacman). */
export const words = (text) => (text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).map((w) => w.replace(/['’-]/g, ''));

/** Every word and neighbouring word pair of a text. */
export const terms = (text) => {
  const w = words(text);
  const out = new Set(w);
  for (let i = 0; i + 1 < w.length; i += 1) out.add(w[i] + ' ' + w[i + 1]);
  return out;
};

/** The deny hashes, read from the test file so there is one list. */
export const denyHashes = () => {
  const source = readFileSync(join(root, 'server/test/naming.test.ts'), 'utf8');
  const block = /const DENY = new Set\(\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? '';
  return new Set([...block.matchAll(/'([0-9a-f]{64})'/g)].map((m) => m[1]));
};

export const findHits = (text, deny) => {
  const hits = [];
  for (const term of terms(text)) if (deny.has(sha(term))) hits.push(sha(term).slice(0, 12));
  return hits;
};

const walk = (path) => {
  const stat = statSync(path);
  if (!stat.isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => (name === 'node_modules' || name === 'dist' || name.startsWith('.') ? [] : walk(join(path, name))));
};

const main = () => {
  const [mode, ...rest] = process.argv.slice(2);
  if (!mode) {
    console.error('usage: name-hashes.mjs <list-file> | --git [range] | --scan <path…>');
    process.exit(2);
  }
  if (mode === '--git') {
    const range = rest[0] ?? 'main..HEAD';
    const log = execFileSync('git', ['log', '--format=%H%x00%B%x00', range], { cwd: root, encoding: 'utf8' });
    const deny = denyHashes();
    const parts = log.split('\0');
    let bad = 0;
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const hits = findHits(parts[i + 1], deny);
      if (hits.length) {
        bad += 1;
        console.log(parts[i].trim().slice(0, 10) + ' matches ' + hits.join(', '));
      }
    }
    console.log(bad ? bad + ' commit message(s) match the deny list' : 'commit messages in ' + range + ': clean');
    process.exit(bad ? 1 : 0);
  }
  if (mode === '--scan') {
    const deny = denyHashes();
    let bad = 0;
    for (const file of rest.flatMap((p) => walk(resolve(p)))) {
      const hits = findHits(readFileSync(file, 'utf8'), deny);
      if (hits.length) {
        bad += 1;
        console.log(file + ' matches ' + hits.join(', '));
      }
    }
    console.log(bad ? bad + ' file(s) match' : 'clean');
    process.exit(bad ? 1 : 0);
  }
  // A list file: one entry per line, # comments allowed. Prints the hash of each entry's normal form.
  for (const line of readFileSync(mode, 'utf8').split(/\r?\n/)) {
    const entry = line.replace(/#.*/, '').trim();
    if (!entry) continue;
    const normal = words(entry).join(' ');
    if (normal.split(' ').length > 2) {
      console.error('skipped (more than two words): ' + entry);
      continue;
    }
    console.log("  '" + sha(normal) + "',");
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
