/**
 * Vite dev for the client, proxied to the shaper (`VITE_DEV_PROXY`), so the page's `/socket.io`,
 * `/arcade/ws` and `/api` go through the shaped link while the page's own modules come straight
 * from Vite. Output goes to a log file: a background process piped through `head` dies.
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killTree, sleep } from './chrome.mjs';
import { BENCH_DIR, CLIENT_DIR } from './paths.mjs';

export const startVite = async ({ port, proxy, logFile, timeoutMs = 45000 }) => {
  const fd = openSync(logFile, 'w');
  const child = spawn(
    process.execPath,
    [join(CLIENT_DIR, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', join(BENCH_DIR, 'lib', 'vite.config.mjs'), '--configLoader', 'native', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: CLIENT_DIR,
      env: {
        ...process.env,
        VITE_DEV_PROXY: proxy,
        NETBENCH_CLIENT_CONFIG: join(CLIENT_DIR, 'vite.config.js'),
        NETBENCH_VITE_CACHE: join(tmpdir(), 'ds-nb', 'vite-cache'),
        BROWSER: 'none',
      },
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    },
  );
  closeSync(fd);
  let exited = null;
  child.on('exit', (code) => {
    exited = code;
  });
  const url = 'http://127.0.0.1:' + port;
  const kill = () => {
    if (exited === null) killTree(child.pid);
  };
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (exited !== null) throw new Error('vite exited with ' + exited + ':\n' + readFileSync(logFile, 'utf8').slice(-2000));
    try {
      const res = await fetch(url + '/');
      if (res.ok) {
        await res.text();
        return { pid: child.pid, url, kill };
      }
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  kill();
  throw new Error('vite did not answer within ' + timeoutMs + ' ms');
};
