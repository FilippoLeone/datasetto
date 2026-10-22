/**
 * "Verify deck" in the history drawer (lamplight.md §8.2): fetch the proof for a finished hand and
 * check it with `crypto.subtle` against the commitment received live and the cards you saw.
 * `crypto.subtle` needs a secure context (https, the desktop app's file:// page, the Android app).
 */
import { verify, type Proof, type Sha256 } from '@arcade/core/lamplight/proof';
import type { TableHost } from '../runtime/types';
import type { HandRecord } from './table';

export const NEEDS_HTTPS = 'Checking the deck needs a secure connection (https).';

export const subtleSha256 = (): Sha256 | null => {
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
  if (!subtle) return null;
  return async (data) => new Uint8Array(await subtle.digest('SHA-256', data as BufferSource));
};

export const verifyHand = async (host: TableHost, t: string, rec: HandRecord, sha = subtleSha256()): Promise<string> => {
  if (!rec.cr) return 'Practice hands have no deck commitment; the seed is kept instead.';
  if (!sha) return NEEDS_HTTPS;
  let res: { ok: boolean; code?: string } & Partial<Proof>;
  try {
    res = await host.request<{ ok: boolean; code?: string } & Partial<Proof>>('lamplight:proof', { t, h: rec.no }, { timeoutMs: 8000 });
  } catch {
    return 'The server did not answer. Try again in a moment.';
  }
  if (!res.ok || !res.root || !res.L || !res.rv) return res.code === 'forbidden' ? 'Only players dealt into this hand can check it.' : 'This hand can no longer be checked.';
  const result = await verify({ root: res.root, L: res.L, rv: res.rv }, rec.cr, rec.seen, sha);
  if (result.ok) return 'Deck verified: the cards did not change during this hand.';
  return 'Mismatch: the proof does not match what you saw (' + result.why + ').';
};

/** A stored hand as the server serves it (`lamplight:record`), filtered for you. */
export interface ServedRecord {
  h: number;
  f: string;
  tier: string | null;
  lv: [number, number, number];
  btn: number;
  seats: [number, string | null, string | null, number][];
  dealt: number[];
  acts: [number, number, string, number][];
  board: number[];
  pots: { a: number; w: number[] }[];
  net: [number, number][];
  shown: [number, number, number][];
  cr: string;
  own: [number, number] | null;
}

const STREET_NAMES = ['Preflop', 'Flop', 'Turn', 'River'];
const ACT_WORDS: Record<string, string> = { f: 'folds', x: 'checks', c: 'calls', b: 'bets', r: 'raises to', a: 'is all-in' };

/** Deck positions and cards you saw in a stored hand (your own, the board, shown hands). */
export const seenOf = (rec: ServedRecord, me: string): { i: number; c: number }[] => {
  const n = rec.dealt.length;
  const out: { i: number; c: number }[] = [];
  const mine = rec.seats.find((s) => s[1] === me);
  if (mine && rec.own) {
    const k = rec.dealt.indexOf(mine[0]);
    if (k >= 0) out.push({ i: k, c: rec.own[0] }, { i: n + k, c: rec.own[1] });
  }
  rec.board.forEach((c, b) => out.push({ i: 2 * n + b, c }));
  for (const [seat, a, b] of rec.shown) {
    const k = rec.dealt.indexOf(seat);
    if (k >= 0 && seat !== mine?.[0]) out.push({ i: k, c: a }, { i: n + k, c: b });
  }
  return out;
};

/** A stored hand as text lines ("Pip raises to 150"). */
export const recordLines = (rec: ServedRecord, name: (seat: number) => string, card: (c: number) => string): string[] => {
  const lines: string[] = [];
  if (rec.own) lines.push('Your cards: ' + rec.own.map(card).join(' '));
  let street = -1;
  for (const [st, seat, k, a] of rec.acts) {
    if (st !== street) {
      street = st;
      const shown = st === 0 ? [] : rec.board.slice(0, st === 1 ? 3 : st === 2 ? 4 : 5);
      lines.push(STREET_NAMES[st] + (shown.length ? ': ' + shown.map(card).join(' ') : ''));
    }
    lines.push(name(seat) + ' ' + (ACT_WORDS[k] ?? k) + (k === 'c' || k === 'b' || k === 'r' ? ' ' + a.toLocaleString('en-US') : ''));
  }
  for (const [seat, a, b] of rec.shown) lines.push(name(seat) + ' shows ' + card(a) + ' ' + card(b));
  for (const p of rec.pots) lines.push(p.w.map(name).join(' and ') + (p.w.length > 1 ? ' split ' : ' wins ') + p.a.toLocaleString('en-US'));
  return lines;
};
