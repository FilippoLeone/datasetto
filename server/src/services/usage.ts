import type { DB } from '../db/index.js';

export interface MonthlyUsage {
  month: string;
  hlsEgressBytes: number;
  streamSeconds: number;
  /** Arcade action-lane and table-lane bytes sent ("Arcade egress"). */
  arcadeEgressBytes: number;
  updatedAt: number;
}

/** `YYYY-MM` in UTC; the billing month everything is counted against. */
export const monthKey = (now = Date.now()): string => new Date(now).toISOString().slice(0, 7);

/**
 * Rough, persistent accounting of the traffic that costs money: HLS bytes
 * served to viewers (estimated from the publisher's bitrate times the number
 * of viewers) and stream time. Survives restarts so a monthly budget means
 * something.
 */
export class UsageService {
  private readonly stmts;

  constructor(db: DB) {
    this.stmts = {
      get: db.prepare('SELECT month, hls_egress_bytes, stream_seconds, arcade_egress_bytes, updated_at FROM usage_months WHERE month = ?'),
      upsert: db.prepare(`
        INSERT INTO usage_months (month, hls_egress_bytes, stream_seconds, updated_at)
        VALUES (@month, @bytes, @seconds, @now)
        ON CONFLICT(month) DO UPDATE SET
          hls_egress_bytes = hls_egress_bytes + excluded.hls_egress_bytes,
          stream_seconds = stream_seconds + excluded.stream_seconds,
          updated_at = excluded.updated_at
      `),
      recent: db.prepare('SELECT month, hls_egress_bytes, stream_seconds, arcade_egress_bytes, updated_at FROM usage_months ORDER BY month DESC LIMIT ?'),
      arcade: db.prepare(`
        INSERT INTO usage_months (month, hls_egress_bytes, stream_seconds, arcade_egress_bytes, updated_at)
        VALUES (@month, 0, 0, @bytes, @now)
        ON CONFLICT(month) DO UPDATE SET arcade_egress_bytes = arcade_egress_bytes + excluded.arcade_egress_bytes, updated_at = excluded.updated_at
      `),
    };
  }

  addEgress(bytes: number, seconds: number, now = Date.now()): void {
    if (!(bytes > 0) && !(seconds > 0)) return;
    this.stmts.upsert.run({ month: monthKey(now), bytes: Math.round(Math.max(0, bytes)), seconds: Math.round(Math.max(0, seconds)), now });
  }

  /** Add Arcade lane bytes to the month's counter. */
  addArcadeEgress(bytes: number, now = Date.now()): void {
    if (!(bytes > 0)) return;
    this.stmts.arcade.run({ month: monthKey(now), bytes: Math.round(bytes), now });
  }

  get(month = monthKey()): MonthlyUsage {
    const row = this.stmts.get.get(month) as { month: string; hls_egress_bytes: number; stream_seconds: number; arcade_egress_bytes: number; updated_at: number } | undefined;
    return row
      ? { month: row.month, hlsEgressBytes: row.hls_egress_bytes, streamSeconds: row.stream_seconds, arcadeEgressBytes: row.arcade_egress_bytes, updatedAt: row.updated_at }
      : { month, hlsEgressBytes: 0, streamSeconds: 0, arcadeEgressBytes: 0, updatedAt: 0 };
  }

  monthEgressBytes(now = Date.now()): number {
    return this.get(monthKey(now)).hlsEgressBytes;
  }

  recent(limit = 6): MonthlyUsage[] {
    return (this.stmts.recent.all(limit) as Array<{ month: string; hls_egress_bytes: number; stream_seconds: number; arcade_egress_bytes: number; updated_at: number }>).map((row) => ({
      month: row.month,
      hlsEgressBytes: row.hls_egress_bytes,
      streamSeconds: row.stream_seconds,
      arcadeEgressBytes: row.arcade_egress_bytes,
      updatedAt: row.updated_at,
    }));
  }
}
