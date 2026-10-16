import { Router, type Response } from 'express';
import type { AppContext } from '../../context.js';
import { migrations } from '../../db/migrations.js';
import type { StreamWatchdogStatus } from '../../services/streamWatchdog.js';

export interface DatabaseHealth {
  ok: boolean;
  /** `PRAGMA user_version`; equals `schemaExpected` after migrations ran. */
  schemaVersion: number | null;
  schemaExpected: number;
  journalMode: string | null;
  error: string | null;
}

export interface HealthReport {
  /** `ok` while serving; `restarting` during a graceful shutdown; `degraded` when the database does not answer. */
  status: 'ok' | 'degraded' | 'restarting';
  version: string;
  uptime: number;
  timestamp: number;
  shuttingDown: boolean;
  database: DatabaseHealth;
  /** Null until index.ts has created the watchdog (tests, scripts). */
  watchdog: StreamWatchdogStatus | null;
  sockets: { connected: number; signedIn: number };
}

export const LATEST_SCHEMA_VERSION = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);

/** A round trip through SQLite plus the two pragmas that say the file is the one we expect. */
export const databaseHealth = (ctx: AppContext): DatabaseHealth => {
  try {
    if (!ctx.db.open) throw new Error('database handle is closed');
    ctx.db.prepare('SELECT 1').get();
    const schemaVersion = Number(ctx.db.pragma('user_version', { simple: true }) ?? 0);
    const journalMode = String(ctx.db.pragma('journal_mode', { simple: true }) ?? '');
    return { ok: schemaVersion === LATEST_SCHEMA_VERSION, schemaVersion, schemaExpected: LATEST_SCHEMA_VERSION, journalMode, error: null };
  } catch (error) {
    return {
      ok: false,
      schemaVersion: null,
      schemaExpected: LATEST_SCHEMA_VERSION,
      journalMode: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export const healthReport = (ctx: AppContext): HealthReport => {
  const database = databaseHealth(ctx);
  const shuttingDown = ctx.runtime.shuttingDown;
  return {
    status: shuttingDown ? 'restarting' : database.ok ? 'ok' : 'degraded',
    version: ctx.config.version,
    uptime: Math.round((Date.now() - ctx.startedAt) / 1000),
    timestamp: Date.now(),
    shuttingDown,
    database,
    watchdog: ctx.runtime.watchdog?.status() ?? null,
    sockets: { connected: ctx.runtime.connectedSockets(), signedIn: ctx.presence.onlineCount() },
  };
};

export const healthRouter = (ctx: AppContext): Router => {
  const router = Router();

  /**
   * Liveness for Docker, Caddy and people. 503 while restarting (so a load balancer
   * or the compose health check stops routing here) and when the database is gone.
   */
  const health = (_req: unknown, res: Response) => {
    const report = healthReport(ctx);
    res.setHeader('Cache-Control', 'no-store');
    res.status(report.status === 'ok' ? 200 : 503).json(report);
  };

  router.get('/health', health);
  router.get('/api/health', health);

  router.get('/api/stats', (_req, res) => {
    res.json({
      channels: ctx.channels.count(),
      users: ctx.presence.onlineCount(),
      messages: ctx.messages.count(),
      uptime: Math.round((Date.now() - ctx.startedAt) / 1000),
      timestamp: Date.now(),
    });
  });

  return router;
};
