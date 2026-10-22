import http from 'node:http';
import { loadConfigFromEnvFile } from './config.js';
import { createContext } from './context.js';
import { openDatabase } from './db/index.js';
import { createHttpApp } from './http/app.js';
import { logger } from './logger.js';
import { createShutdown } from './shutdown.js';
import { createSocketServer } from './socket/index.js';
import { StreamWatchdog } from './services/streamWatchdog.js';

const main = async (): Promise<void> => {
  const config = loadConfigFromEnvFile();
  const db = openDatabase(config.database.path);
  const ctx = createContext(config, db);

  const app = createHttpApp(ctx);
  const server = http.createServer(app);
  const { io, arcade } = createSocketServer(server, ctx);
  const watchdog = new StreamWatchdog(ctx, {
    statUrl: config.streaming.statUrl,
    maxBitrateKbps: config.streaming.maxBitrateKbps,
    monthlyEgressBytes: config.streaming.monthlyEgressBytes,
  });
  ctx.runtime.watchdog = watchdog;
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
      restartWaitMs: config.shutdown.expectedWaitMs,
    },
    'datasetto server ready',
  );

  const shutdown = createShutdown({ ctx, io, server, stoppables: [watchdog, arcade], arcade, timers });

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
};

main().catch((error) => {
  logger.fatal({ err: error }, 'failed to start');
  process.exit(1);
});
