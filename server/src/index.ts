import http from 'node:http';
import { loadConfigFromEnvFile } from './config.js';
import { createContext } from './context.js';
import { openDatabase } from './db/index.js';
import { createHttpApp } from './http/app.js';
import { logger } from './logger.js';
import { createSocketServer } from './socket/index.js';
import { StreamWatchdog } from './services/streamWatchdog.js';

const main = async (): Promise<void> => {
  const config = loadConfigFromEnvFile();
  const db = openDatabase(config.database.path);
  const ctx = createContext(config, db);

  const app = createHttpApp(ctx);
  const server = http.createServer(app);
  const { io, minigames } = createSocketServer(server, ctx);
  const watchdog = new StreamWatchdog(ctx, {
    statUrl: config.streaming.statUrl,
    maxBitrateKbps: config.streaming.maxBitrateKbps,
    monthlyEgressBytes: config.streaming.monthlyEgressBytes,
  });
  watchdog.start();

  // Uploads never sent and files whose message is gone (channel deleted, retention) are removed.
  const sweepUploads = () => {
    try {
      const swept = ctx.uploads.sweep();
      if (swept.pending > 0 || swept.orphans > 0) logger.debug(swept, 'upload files swept');
    } catch (error) {
      logger.warn({ err: error }, 'upload sweep failed');
    }
  };
  sweepUploads();

  const timers = [
    setInterval(() => {
      const purged = ctx.sessions.purgeExpired();
      if (purged > 0) logger.debug({ purged }, 'expired sessions purged');
      const orphans = ctx.push.purgeOrphans();
      if (orphans > 0) logger.debug({ orphans }, 'push subscriptions of ended logins purged');
      sweepUploads();
      const previews = ctx.linkPreviews.purgeStale();
      if (previews > 0) logger.debug({ previews }, 'unused link previews purged');
    }, 60 * 60 * 1000),
    setInterval(() => ctx.moderation.purgeExpired(), 60 * 1000),
  ];
  timers.forEach((timer) => timer.unref());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.server.port, config.server.host, () => resolve());
  });

  logger.info(
    {
      version: config.version,
      env: config.env,
      host: config.server.host,
      port: config.server.port,
      database: config.database.path,
      registration: config.registration.mode,
      turn: ctx.turn.isEnabled(),
      push: ctx.push.isEnabled(),
      corsOrigins: config.cors.origins,
    },
    'datasetto server ready',
  );

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    timers.forEach((timer) => clearInterval(timer));
    watchdog.stop();
    minigames.shutdown?.();

    const force = setTimeout(() => {
      logger.warn('forcing exit after timeout');
      process.exit(1);
    }, 10_000);
    force.unref();

    io.close(() => {
      server.close(() => {
        try {
          db.pragma('wal_checkpoint(TRUNCATE)');
          db.close();
        } catch (error) {
          logger.error({ err: error }, 'failed to close database cleanly');
        }
        logger.info('server stopped');
        process.exit(0);
      });
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    shutdown('uncaughtException');
  });
};

main().catch((error) => {
  logger.fatal({ err: error }, 'failed to start');
  process.exit(1);
});
