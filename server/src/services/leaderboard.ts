import type { DB } from '../db/index.js';

export interface LeaderboardEntry {
  name: string;
  score: number;
}

/** Minigame high scores, keyed by game type and display name. Keeps the best score. */
export class LeaderboardService {
  private readonly stmts;

  constructor(db: DB) {
    this.stmts = {
      upsert: db.prepare(`
        INSERT INTO leaderboard (game_type, player_name, score, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(game_type, player_name) DO UPDATE SET
          score = MAX(leaderboard.score, excluded.score),
          updated_at = CASE WHEN excluded.score > leaderboard.score THEN excluded.updated_at ELSE leaderboard.updated_at END
      `),
      top: db.prepare(
        'SELECT player_name AS name, score FROM leaderboard WHERE game_type = ? ORDER BY score DESC, updated_at ASC LIMIT ?',
      ),
    };
  }

  async saveScore(type: string, name: string, score: number): Promise<void> {
    if (!type || !name || !Number.isFinite(score) || score <= 0) return;
    this.stmts.upsert.run(type.slice(0, 32), name.slice(0, 64), Math.round(score), Date.now());
  }

  async getLeaderboard(type: string, limit = 10): Promise<LeaderboardEntry[]> {
    if (!type) return [];
    const rows = this.stmts.top.all(type.slice(0, 32), Math.min(Math.max(limit, 1), 100)) as LeaderboardEntry[];
    return rows.map((row) => ({ name: row.name, score: Number(row.score) }));
  }
}
