import { describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../../src/db/index.js';
import { BOARD_CACHE_MS, createBoards, createResults, createStats, statBoard, type BoardDef } from '../../src/arcade/stats.js';

const makeClock = (start = Date.UTC(2026, 5, 1, 12)) => {
  let t = start;
  return {
    now: () => t,
    hr: () => BigInt(t) * 1_000_000n,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    advance(ms: number) {
      t += ms;
    },
  };
};

const setup = () => ({ db: openDatabase(':memory:', { memory: true }), clock: makeClock() });

describe('stats', () => {
  it('adds, keeps maxima and reads 0 for a missing counter', () => {
    const { db, clock } = setup();
    const stats = createStats(db, clock);
    expect(stats.get('a', 'fuseyard', 'wins')).toBe(0);
    stats.add('a', 'fuseyard', 'wins', 5);
    stats.add('a', 'fuseyard', 'wins', -2);
    expect(stats.get('a', 'fuseyard', 'wins')).toBe(3);
    expect(stats.get('a', 'bellwick', 'wins')).toBe(0);
    stats.max('a', 'glimmer', 'orchard.bestx', 1200);
    stats.max('a', 'glimmer', 'orchard.bestx', 700);
    expect(stats.get('a', 'glimmer', 'orchard.bestx')).toBe(1200);
    stats.max('a', 'glimmer', 'orchard.bestx', 1500);
    expect(stats.get('a', 'glimmer', 'orchard.bestx')).toBe(1500);
    expect(() => stats.add('a', 'fuseyard', 'wins', 0.5)).toThrow(TypeError);
    expect(() => stats.max('a', 'fuseyard', 'wins', Number.NaN)).toThrow(TypeError);
  });

  it('moves updated_at only when a maximum improves, so the first to reach a value ranks first', () => {
    const { db, clock } = setup();
    const stats = createStats(db, clock);
    stats.max('late', 'bellwick', 'clear', 50);
    clock.advance(1000);
    stats.max('early', 'bellwick', 'clear', 90);
    clock.advance(1000);
    stats.max('late', 'bellwick', 'clear', 90);
    clock.advance(1000);
    stats.max('early', 'bellwick', 'clear', 90); // equal: no change
    stats.max('early', 'bellwick', 'clear', 10); // lower: no change
    const board = statBoard('bellwick', 'clear', 'clear', 'Best clear');
    expect(board.query(db, 10)).toEqual([
      { accountId: 'early', value: 90 },
      { accountId: 'late', value: 90 },
    ]);
  });
});

describe('results', () => {
  it('records a result and its players in one transaction', () => {
    const { db, clock } = setup();
    const results = createResults(db, clock);
    const id = results.record(
      { game: 'lamplight', mode: 'trio', channelId: 'ch1', humans: 3, startedAt: 1000, endedAt: 2000, summary: { buyIn: 100, mult: 3, pool: 900 } },
      [
        { accountId: 'a', place: 1, score: null, chipsDelta: 800 },
        { accountId: 'b', place: 2, score: null, chipsDelta: -100 },
        { accountId: 'c', place: 3, score: 12, chipsDelta: -100 },
      ],
    );
    expect(db.prepare('SELECT game, mode, channel_id AS ch, humans, started_at AS s, ended_at AS e, summary FROM arcade_results WHERE id = ?').get(id)).toEqual({
      game: 'lamplight',
      mode: 'trio',
      ch: 'ch1',
      humans: 3,
      s: 1000,
      e: 2000,
      summary: '{"buyIn":100,"mult":3,"pool":900}',
    });
    expect(db.prepare('SELECT account_id AS a, place, score, chips_delta AS d FROM arcade_result_players WHERE result_id = ? ORDER BY place').all(id)).toEqual([
      { a: 'a', place: 1, score: null, d: 800 },
      { a: 'b', place: 2, score: null, d: -100 },
      { a: 'c', place: 3, score: 12, d: -100 },
    ]);

    // A failing player row rolls the whole result back.
    const before = db.prepare('SELECT COUNT(*) FROM arcade_results').pluck().get();
    expect(() =>
      results.record({ game: 'fuseyard', mode: 'match', channelId: null, humans: 2, startedAt: 0, endedAt: 1, summary: undefined }, [
        { accountId: 'a', place: 1, score: 3, chipsDelta: 0 },
        { accountId: 'a', place: 2, score: 1, chipsDelta: 0 },
      ]),
    ).toThrow();
    expect(db.prepare('SELECT COUNT(*) FROM arcade_results').pluck().get()).toBe(before);
    const second = results.record({ game: 'fuseyard', mode: 'match', channelId: null, humans: 2, startedAt: 0, endedAt: 1, summary: undefined }, []);
    expect(db.prepare('SELECT summary FROM arcade_results WHERE id = ?').pluck().get(second)).toBe('null');
  });
});

describe('boards', () => {
  it('lists boards, answers null for unknown ones and caches rows for 60 s', () => {
    const { db, clock } = setup();
    const stats = createStats(db, clock);
    let queries = 0;
    const custom: BoardDef = {
      id: 'best-win',
      label: 'Best win',
      query: (database: DB, limit: number) => {
        queries++;
        return (database.prepare("SELECT account_id AS accountId, value FROM arcade_stats WHERE game = 'glimmer' AND stat = 'best' ORDER BY value DESC LIMIT ?").all(limit) as {
          accountId: string;
          value: number;
        }[]).map((row) => ({ ...row, label: 'x' + row.value }));
      },
    };
    const boards = createBoards(db, clock, [
      { game: 'fuseyard', boards: [statBoard('fuseyard', 'wins', 'wins', 'Wins')] },
      { game: 'glimmer', boards: [custom] },
      { game: 'lamplight' },
    ]);
    expect(boards.list('fuseyard')).toEqual([{ id: 'wins', label: 'Wins' }]);
    expect(boards.list('lamplight')).toEqual([]);
    expect(boards.list('bellwick')).toEqual([]);
    expect(boards.rows('fuseyard', 'nope')).toBeNull();
    expect(boards.rows('bellwick', 'wins')).toBeNull();

    stats.add('a', 'glimmer', 'best', 10);
    stats.add('b', 'glimmer', 'best', 30);
    expect(boards.rows('glimmer', 'best-win')).toEqual([
      { accountId: 'b', value: 30, label: 'x30' },
      { accountId: 'a', value: 10, label: 'x10' },
    ]);
    expect(boards.rows('glimmer', 'best-win', 1)).toEqual([{ accountId: 'b', value: 30, label: 'x30' }]);
    expect(queries).toBe(1);

    stats.add('a', 'glimmer', 'best', 100);
    clock.advance(BOARD_CACHE_MS - 1);
    expect(boards.rows('glimmer', 'best-win')?.[0]).toEqual({ accountId: 'b', value: 30, label: 'x30' });
    expect(queries).toBe(1);
    clock.advance(1);
    expect(boards.rows('glimmer', 'best-win')?.[0]).toEqual({ accountId: 'a', value: 110, label: 'x110' });
    expect(queries).toBe(2);

    // Each board has its own cache.
    stats.add('c', 'fuseyard', 'wins', 2);
    expect(boards.rows('fuseyard', 'wins')).toEqual([{ accountId: 'c', value: 2 }]);
    stats.add('d', 'fuseyard', 'wins', 5);
    expect(boards.rows('fuseyard', 'wins')).toEqual([{ accountId: 'c', value: 2 }]);
    clock.advance(BOARD_CACHE_MS);
    expect(boards.rows('fuseyard', 'wins')).toEqual([
      { accountId: 'd', value: 5 },
      { accountId: 'c', value: 2 },
    ]);
  });
});
