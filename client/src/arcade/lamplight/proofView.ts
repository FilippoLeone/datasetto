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
