/**
 * Action-lane tickets and resume tokens (platform.md §4.1).
 *
 * - A ticket is `base64url(json).base64url(hmac)`, signed with HMAC-SHA-256 under a per-process random
 *   secret (matches do not survive restarts, so tickets need not either). Body `{a, m, r, e, n}`:
 *   account, match, role (`p` player, `s` spectator), expiry, nonce. TTL 30 s, single use: the nonce
 *   is remembered until the ticket would have expired.
 * - A resume token is 32 random bytes bound to one seat, valid while that seat's grace lasts; every use
 *   rotates it, so a reconnect needs no main socket.
 *
 * No timers: expired entries are swept on use.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { b64url, fromB64url } from './core/bytes.js';
import type { Clock } from './clock.js';

export const TICKET_TTL_MS = 30_000;

export interface TicketClaim {
  accountId: string;
  matchId: string;
  role: 'p' | 's';
}

export interface ResumeClaim {
  accountId: string;
  matchId: string;
  slot: number;
}

export interface Tickets {
  issue(claim: TicketClaim): { ticket: string; exp: number };
  /** The claim of a valid, unused ticket (and marks it used), else null. */
  redeem(ticket: string): TicketClaim | null;
  /** A fresh 32-byte resume token for a seat, valid until `validUntil` (the end of its grace) or revoked. */
  resumeToken(claim: ResumeClaim, validUntil: number): Uint8Array;
  /** Use a resume token: returns its claim and forgets the token (the WELCOME that follows carries a new one). */
  resume(token: string): ResumeClaim | null;
  /** Extend or shorten every token of a seat (the grace window moved). */
  setValidUntil(matchId: string, slot: number, validUntil: number): void;
  /** Forget the tokens of a seat or a whole match. */
  revoke(matchId: string, slot?: number): void;
  readonly size: { nonces: number; tokens: number };
}

export const createTickets = (clock: Clock, secret: Buffer = randomBytes(32)): Tickets => {
  const usedNonces = new Map<string, number>();
  const tokens = new Map<string, ResumeClaim & { until: number }>();

  const sign = (body: string): string => b64url(createHmac('sha256', secret).update(body).digest());

  const sweep = (now: number): void => {
    for (const [nonce, exp] of usedNonces) if (exp <= now) usedNonces.delete(nonce);
    for (const [token, claim] of tokens) if (claim.until <= now) tokens.delete(token);
  };

  return {
    issue(claim) {
      const now = clock.now();
      sweep(now);
      const exp = now + TICKET_TTL_MS;
      const body = b64url(Buffer.from(JSON.stringify({ a: claim.accountId, m: claim.matchId, r: claim.role, e: exp, n: b64url(randomBytes(12)) })));
      return { ticket: body + '.' + sign(body), exp };
    },

    redeem(ticket) {
      if (typeof ticket !== 'string' || ticket.length > 400) return null;
      const dot = ticket.indexOf('.');
      if (dot <= 0) return null;
      const body = ticket.slice(0, dot);
      const mac = fromB64url(ticket.slice(dot + 1));
      const expected = fromB64url(sign(body));
      if (!mac || !expected || mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
      const raw = fromB64url(body);
      if (!raw) return null;
      let parsed: { a?: unknown; m?: unknown; r?: unknown; e?: unknown; n?: unknown };
      try {
        parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
      } catch {
        return null;
      }
      const now = clock.now();
      sweep(now);
      if (typeof parsed.a !== 'string' || typeof parsed.m !== 'string' || (parsed.r !== 'p' && parsed.r !== 's')) return null;
      if (typeof parsed.e !== 'number' || parsed.e <= now || typeof parsed.n !== 'string') return null;
      if (usedNonces.has(parsed.n)) return null;
      usedNonces.set(parsed.n, parsed.e);
      return { accountId: parsed.a, matchId: parsed.m, role: parsed.r };
    },

    resumeToken(claim, validUntil) {
      const token = randomBytes(32);
      tokens.set(b64url(token), { ...claim, until: validUntil });
      return new Uint8Array(token);
    },

    resume(token) {
      if (typeof token !== 'string' || token.length > 64) return null;
      const now = clock.now();
      sweep(now);
      const claim = tokens.get(token);
      if (!claim) return null;
      tokens.delete(token);
      return { accountId: claim.accountId, matchId: claim.matchId, slot: claim.slot };
    },

    setValidUntil(matchId, slot, validUntil) {
      for (const claim of tokens.values()) if (claim.matchId === matchId && claim.slot === slot) claim.until = validUntil;
    },

    revoke(matchId, slot) {
      for (const [token, claim] of tokens) if (claim.matchId === matchId && (slot === undefined || claim.slot === slot)) tokens.delete(token);
    },

    get size() {
      return { nonces: usedNonces.size, tokens: tokens.size };
    },
  };
};
