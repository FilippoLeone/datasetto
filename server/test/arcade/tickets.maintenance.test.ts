/**
 * Lane tickets and resume tokens (platform.md §4.1), and the daily job (platform.md §11.2).
 */
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { openDatabase } from '../../src/db/index.js';
import { b64url } from '../../src/arcade/core/bytes.js';
import { createMaintenance } from '../../src/arcade/maintenance.js';
import type { TableGame } from '../../src/arcade/tables/types.js';
import { createTickets, TICKET_TTL_MS } from '../../src/arcade/tickets.js';
import { createFakeClock } from './harness/clock.js';

describe('tickets', () => {
  it('are single-use, signed, and expire after 30 s', () => {
    const clock = createFakeClock();
    const tickets = createTickets(clock);
    const { ticket, exp } = tickets.issue({ accountId: 'a', matchId: 'm', role: 'p' });
    expect(exp - clock.now()).toBe(TICKET_TTL_MS);
    expect(tickets.redeem(ticket)).toEqual({ accountId: 'a', matchId: 'm', role: 'p' });
    expect(tickets.redeem(ticket)).toBeNull();
    const second = tickets.issue({ accountId: 'a', matchId: 'm', role: 's' }).ticket;
    clock.advance(TICKET_TTL_MS + 1);
    expect(tickets.redeem(second)).toBeNull();
    // Tampering with the body or the signature fails.
    const third = tickets.issue({ accountId: 'a', matchId: 'm', role: 'p' }).ticket;
    const [body, mac] = third.split('.') as [string, string];
    expect(tickets.redeem(body + 'x.' + mac)).toBeNull();
    expect(tickets.redeem(body + '.' + mac.slice(0, -2) + 'AA')).toBeNull();
    expect(tickets.redeem('junk')).toBeNull();
    // Another process's tickets (another secret) are refused.
    const other = createTickets(clock).issue({ accountId: 'a', matchId: 'm', role: 'p' }).ticket;
    expect(tickets.redeem(other)).toBeNull();
    expect(tickets.size.nonces).toBeLessThanOrEqual(2);
  });

  it('rotates resume tokens, honours the grace window and revokes per seat or match', () => {
    const clock = createFakeClock();
    const tickets = createTickets(clock);
    const t1 = b64url(tickets.resumeToken({ accountId: 'a', matchId: 'm', slot: 0 }, clock.now() + 60_000));
    expect(tickets.resume(t1)).toEqual({ accountId: 'a', matchId: 'm', slot: 0 });
    expect(tickets.resume(t1)).toBeNull();
    const t2 = b64url(tickets.resumeToken({ accountId: 'a', matchId: 'm', slot: 0 }, clock.now() + 60_000));
    tickets.setValidUntil('m', 0, clock.now() + 1000);
    clock.advance(1001);
    expect(tickets.resume(t2)).toBeNull();
    const t3 = b64url(tickets.resumeToken({ accountId: 'b', matchId: 'm', slot: 1 }, clock.now() + 60_000));
    const t4 = b64url(tickets.resumeToken({ accountId: 'c', matchId: 'n', slot: 0 }, clock.now() + 60_000));
    tickets.revoke('m');
    expect(tickets.resume(t3)).toBeNull();
    expect(tickets.resume(t4)).not.toBeNull();
  });
});

describe('the daily job', () => {
  it('runs at boot and again after midnight UTC, calling every table game', () => {
    const clock = createFakeClock(Date.UTC(2026, 9, 22, 23, 0, 0));
    const db = openDatabase(':memory:', { memory: true });
    const days: number[] = [];
    const game = { daily: (now: number) => days.push(now) } as unknown as TableGame;
    const job = createMaintenance({ db, clock, log: pino({ level: 'silent' }), tableGames: () => [game] });
    expect(days).toHaveLength(1);
    clock.advance(30 * 60_000);
    expect(days).toHaveLength(1);
    clock.advance(32 * 60_000);
    expect(days).toHaveLength(2);
    clock.advance(24 * 60 * 60_000);
    expect(days).toHaveLength(3);
    job.stop();
    expect(clock.pending).toBe(0);
    db.close();
  });
});
