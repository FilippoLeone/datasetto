/**
 * On-demand soaks (plan.md §3.0: never a PR gate). Each game may add `server/test/arcade/<id>/soak.mts`
 * exporting `default async function soak(o: { deadlineMs: number; log(line: string): void }): Promise<void>`
 * that throws on failure. This runner finds them by path, so adding one never edits a shared file.
 *
 *   npm run test:soak            every soak
 *   npm run test:soak -- fuseyard   one game
 *
 * Each soak gets a hard stop of 60 s; the runner exits non-zero if any fails or overruns.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HARD_STOP_MS = 60_000;
const here = dirname(fileURLToPath(import.meta.url));
const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));

const soaks = readdirSync(here)
  .filter((name) => statSync(join(here, name)).isDirectory() && existsSync(join(here, name, 'soak.mts')))
  .filter((name) => wanted.length === 0 || wanted.includes(name));

if (soaks.length === 0) {
  console.log(wanted.length ? 'No soak for ' + wanted.join(', ') : 'No game has a soak yet.');
  process.exit(0);
}

let failed = 0;
for (const name of soaks) {
  const started = Date.now();
  const deadlineMs = started + HARD_STOP_MS;
  const mod = (await import(pathToFileURL(join(here, name, 'soak.mts')).href)) as { default: (o: { deadlineMs: number; log(line: string): void }) => Promise<void> };
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      mod.default({ deadlineMs, log: (line) => console.log('[' + name + '] ' + line) }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('over the 60 s hard stop')), HARD_STOP_MS);
      }),
    ]);
    console.log('[' + name + '] passed in ' + ((Date.now() - started) / 1000).toFixed(1) + ' s');
  } catch (error) {
    failed += 1;
    console.error('[' + name + '] FAILED after ' + ((Date.now() - started) / 1000).toFixed(1) + ' s: ' + (error instanceof Error ? error.message : String(error)));
  } finally {
    clearTimeout(timer);
  }
}
process.exit(failed > 0 ? 1 : 0);
