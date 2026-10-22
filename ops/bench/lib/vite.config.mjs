/**
 * The client's own Vite config with three bench changes:
 * - its own dependency cache (outside client/), so a dev server another session runs from this
 *   checkout never sees its optimized deps change;
 * - `hmr: false`: a file written under client/ by someone else is never pushed to the measured page
 *   (no update, no reload, no second copy of a module). The WebSocket server stays on: with
 *   `ws: false` the page's Vite client hangs in CONNECTING, and Chrome lets only one WebSocket
 *   handshake per host:port be in CONNECTING, so the app's socket.io connection would wait forever;
 * - no screen clearing in the log file.
 * Loaded with `--configLoader native`, so the client config's `import.meta.dirname` stays correct.
 */
import { pathToFileURL } from 'node:url';

const base = (await import(pathToFileURL(process.env.NETBENCH_CLIENT_CONFIG).href)).default;

export default {
  ...base,
  cacheDir: process.env.NETBENCH_VITE_CACHE,
  clearScreen: false,
  server: { ...base.server, hmr: false },
};
