import type { Server as HttpServer } from 'node:http';
import type { Server as SocketServer } from 'socket.io';
import type { AppContext } from './context.js';

/** The whole sequence, from the signal to `process.exit`, fits in this. */
export const SHUTDOWN_DEADLINE_MS = 10_000;
/** Time given to the transports to deliver `server:restarting` before the sockets are closed. */
export const RESTART_NOTICE_MS = 300;
/** Keep-alive HTTP connections still open after the socket layer closed are cut after this. */
export const LINGER_MS = 1_000;

export interface RestartNotice {
  /** How long clients should wait before their first reconnect attempt. */
  expectedWaitMs: number;
  /** Why: a deploy or stop (`SIGTERM`), an operator at the console (`SIGINT`), a crash. */
  reason: string;
  at: number;
}

export interface ShutdownDeps {
  ctx: AppContext;
  io: SocketServer;
  server: HttpServer;
  stoppables?: Array<{ stop?: () => void; shutdown?: () => void } | null | undefined>;
  timers?: NodeJS.Timeout[];
  exit?: (code: number) => void;
  deadlineMs?: number;
  noticeMs?: number;
  lingerMs?: number;
}

export interface Shutdown {
  /** Run (or join) the sequence; resolves with the exit code once everything is closed. */
  (signal: string): Promise<number>;
  readonly started: boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/**
 * Graceful stop on SIGTERM (a deploy recreating the container) or SIGINT:
 *
 * 1. mark the process as shutting down: new sockets are refused and `/health` answers 503;
 * 2. stop timers and the stream watchdog;
 * 3. tell every connected client `server:restarting {expectedWaitMs}` so it waits
 *    that long before reconnecting instead of hammering the next container;
 * 4. close the sockets and the HTTP server;
 * 5. checkpoint the WAL into the database file and close it;
 * 6. exit 0. A deadline forces exit 1 if any step hangs.
 */
export const createShutdown = ({
  ctx,
  io,
  server,
  stoppables = [],
  timers = [],
  exit = (code) => process.exit(code),
  deadlineMs = SHUTDOWN_DEADLINE_MS,
  noticeMs = RESTART_NOTICE_MS,
  lingerMs = LINGER_MS,
}: ShutdownDeps): Shutdown => {
  let running: Promise<number> | null = null;

  const closeDatabase = () => {
    if (!ctx.db.open) return;
    try {
      ctx.db.pragma('wal_checkpoint(TRUNCATE)');
      ctx.db.close();
    } catch (error) {
      ctx.log.error({ err: error }, 'failed to close database cleanly');
    }
  };

  const run = async (signal: string): Promise<number> => {
    const startedAt = Date.now();
    ctx.runtime.shuttingDown = true;
    const connected = ctx.runtime.connectedSockets();
    ctx.log.info({ signal, connected, expectedWaitMs: ctx.config.shutdown.expectedWaitMs }, 'shutting down');

    const deadline = setTimeout(() => {
      ctx.log.warn({ signal, afterMs: Date.now() - startedAt }, 'shutdown deadline reached, forcing exit');
      ctx.runtime.bursts.flush();
      closeDatabase();
      exit(1);
    }, deadlineMs);
    deadline.unref?.();

    for (const timer of timers) clearInterval(timer);
    for (const item of stoppables) {
      try {
        item?.stop?.();
        item?.shutdown?.();
      } catch (error) {
        ctx.log.warn({ err: error }, 'component failed to stop');
      }
    }

    const notice: RestartNotice = { expectedWaitMs: ctx.config.shutdown.expectedWaitMs, reason: signal, at: Date.now() };
    io.emit('server:restarting', notice);
    if (connected > 0) await sleep(noticeMs);

    // io.close() drops every socket, stops engine.io and closes the HTTP server it is attached to.
    const linger = setTimeout(() => server.closeAllConnections?.(), lingerMs);
    linger.unref?.();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    clearTimeout(linger);

    ctx.runtime.bursts.flush();
    closeDatabase();
    clearTimeout(deadline);
    ctx.log.info({ signal, ms: Date.now() - startedAt }, 'server stopped');
    exit(0);
    return 0;
  };

  const shutdown = ((signal: string) => {
    if (!running) running = run(signal);
    return running;
  }) as Shutdown;
  Object.defineProperty(shutdown, 'started', { get: () => running !== null });
  return shutdown;
};
