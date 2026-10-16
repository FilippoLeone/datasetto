import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createContext, type AppContext, type ContextOptions } from '../src/context.js';
import { openDatabase, type DB } from '../src/db/index.js';
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

export const makeContext = (overrides: Record<string, string> = {}, options: ContextOptions = {}): AppContext => {
  const config = makeConfig(overrides);
  return createContext(config, openDatabase(':memory:', { memory: true }), options);
};

export interface TestServer {
  ctx: AppContext;
  url: string;
  port: number;
  server: http.Server;
  sockets: SocketServer;
  close: () => Promise<void>;
}

export interface TestServerExtras {
  /** Reuse a database (a file shared by two "processes" in a restart test) instead of a fresh in-memory one. */
  db?: DB;
  /** Listen on this port instead of a random one (a restarted server keeps its address). */
  port?: number;
}

export const startTestServer = async (overrides: Record<string, string> = {}, options: ContextOptions = {}, extras: TestServerExtras = {}): Promise<TestServer> => {
  const ctx = extras.db ? createContext(makeConfig(overrides), extras.db, options) : makeContext(overrides, options);
  const app = createHttpApp(ctx);
  const server = http.createServer(app);
  const sockets = createSocketServer(server, ctx);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(extras.port ?? 0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    ctx,
    server,
    sockets,
    url: 'http://127.0.0.1:' + port,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        // After a graceful shutdown everything below is already closed; closing twice is harmless.
        sockets.io.close(() => {
          server.close(() => {
            if (ctx.db.open) ctx.db.close();
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
