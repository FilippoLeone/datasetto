import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createContext, type AppContext } from '../src/context.js';
import { openDatabase } from '../src/db/index.js';
import { createHttpApp } from '../src/http/app.js';
import { createSocketServer, type SocketServer } from '../src/socket/index.js';

/** Uploads (avatars) go to a throwaway directory per test process. */
export const testDataDir = mkdtempSync(join(tmpdir(), 'datasetto-test-'));

export const testEnv = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  DATABASE_PATH: ':memory:',
  DATA_DIR: testDataDir,
  LOG_LEVEL: 'silent',
  CORS_ORIGINS: 'http://localhost',
  ...overrides,
});

export const makeConfig = (overrides: Record<string, string> = {}): AppConfig => loadConfig(testEnv(overrides));

export const makeContext = (overrides: Record<string, string> = {}): AppContext => {
  const config = makeConfig(overrides);
  return createContext(config, openDatabase(':memory:', { memory: true }));
};

export interface TestServer {
  ctx: AppContext;
  url: string;
  sockets: SocketServer;
  close: () => Promise<void>;
}

export const startTestServer = async (overrides: Record<string, string> = {}): Promise<TestServer> => {
  const ctx = makeContext(overrides);
  const app = createHttpApp(ctx);
  const server = http.createServer(app);
  const sockets = createSocketServer(server, ctx);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    ctx,
    sockets,
    url: 'http://127.0.0.1:' + port,
    close: () =>
      new Promise<void>((resolve) => {
        sockets.io.close(() => {
          server.close(() => {
            ctx.db.close();
            resolve();
          });
        });
      }),
  };
};

export const waitFor = <T>(fn: () => T | undefined | null | false, timeoutMs = 3000): Promise<T> =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = fn();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(tick, 10);
    };
    tick();
  });
