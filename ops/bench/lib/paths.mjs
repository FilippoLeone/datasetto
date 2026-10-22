/**
 * Where things are, and how the bench loads the server's TypeScript: through tsx's ESM API in one
 * namespace, so every server module is loaded once and shared (the probe game's control object, the
 * codec and the socket server see the same instances). Plain `node` and `npx tsx` both work.
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BENCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = resolve(BENCH_DIR, '..', '..');
export const SERVER_DIR = join(REPO, 'server');
export const CLIENT_DIR = join(REPO, 'client');

/** `require` resolving from server/node_modules (socket.io-client, ws). */
export const serverRequire = createRequire(join(SERVER_DIR, 'package.json'));

let api = null;

/** Import a server TypeScript module by its path relative to server/. */
export const loadServer = async (rel) => {
  if (!api) {
    const tsxApi = pathToFileURL(join(SERVER_DIR, 'node_modules', 'tsx', 'dist', 'esm', 'api', 'index.mjs')).href;
    const { register } = await import(tsxApi);
    api = register({ namespace: 'arcade-netbench', tsconfig: join(SERVER_DIR, 'tsconfig.json') });
  }
  return api.import(pathToFileURL(join(SERVER_DIR, rel)).href, import.meta.url);
};

export const unloadServer = async () => {
  if (!api) return;
  const done = api.unregister();
  api = null;
  await done;
};
