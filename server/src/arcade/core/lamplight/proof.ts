/**
 * The deck commitment and its proof (lamplight.md §8.2). The hash is injected (node:crypto on the
 * server, crypto.subtle on the device), so this file stays pure.
 *
 * - salt_i = HMAC-SHA-256(handSecret, u8 i)[0..16]   (server only)
 * - leaf_i = SHA-256(u8 i ‖ u8 card_i ‖ salt_i)
 * - root   = SHA-256(leaf_0 ‖ … ‖ leaf_51)
 *
 * The proof holds all 52 leaves plus the positions, cards and salts the caller may see: the board,
 * its own two cards and the hands shown at showdown. Mucked cards and the undealt deck appear only
 * as salted leaf hashes.
 */
import { b64url, fromB64url } from '../bytes.js';

export const SALT_BYTES = 16;
export const LEAF_BYTES = 32;
export const POSITIONS = 52;

export type Sha256 = (data: Uint8Array) => Promise<Uint8Array> | Uint8Array;

export interface Reveal {
  /** Deck position. */
  i: number;
  /** Card. */
  c: number;
  /** Salt, base64url (22 characters). */
  s: string;
}

export interface Proof {
  root: string;
  /** The 52 leaves, base64url. */
  L: string;
  rv: Reveal[];
}

/** The bytes hashed into leaf i. */
export const leafInput = (i: number, card: number, salt: Uint8Array): Uint8Array => {
  const out = new Uint8Array(2 + SALT_BYTES);
  out[0] = i;
  out[1] = card;
  out.set(salt.subarray(0, SALT_BYTES), 2);
  return out;
};

/** Leaves and root of a dealt deck (server side, with its salts). */
export const commit = async (deck: readonly number[], salts: readonly Uint8Array[], sha256: Sha256): Promise<{ leaves: Uint8Array; root: Uint8Array }> => {
  const leaves = new Uint8Array(POSITIONS * LEAF_BYTES);
  for (let i = 0; i < POSITIONS; i++) leaves.set(await sha256(leafInput(i, deck[i], salts[i])), i * LEAF_BYTES);
  return { leaves, root: await sha256(leaves) };
};

/** The same, synchronously, for a hash that returns bytes directly (node:crypto). */
export const commitSync = (deck: readonly number[], salts: readonly Uint8Array[], sha256: (d: Uint8Array) => Uint8Array): { leaves: Uint8Array; root: Uint8Array } => {
  const leaves = new Uint8Array(POSITIONS * LEAF_BYTES);
  for (let i = 0; i < POSITIONS; i++) leaves.set(sha256(leafInput(i, deck[i], salts[i])), i * LEAF_BYTES);
  return { leaves, root: sha256(leaves) };
};

/**
 * The deck positions a proof may reveal to `viewer`: the board, the viewer's own two cards and the
 * hands shown at showdown (or in an all-in runout). Mucked hands and the undealt deck never.
 * `dealt` lists the seats dealt in, in deal order (from the seat left of the button).
 */
export const revealPositions = (o: { dealt: readonly number[]; board: number; shown: readonly number[]; viewer: number | null }): number[] => {
  const n = o.dealt.length;
  const out: number[] = [];
  o.dealt.forEach((seat, i) => {
    if (seat === o.viewer || o.shown.includes(seat)) out.push(i, n + i);
  });
  for (let b = 0; b < o.board && b < 5; b++) out.push(2 * n + b);
  return out.sort((a, b) => a - b);
};

export const buildProof = (leaves: Uint8Array, root: Uint8Array, reveals: readonly { i: number; c: number; salt: Uint8Array }[]): Proof => ({
  root: b64url(root),
  L: b64url(leaves),
  rv: reveals.map((r) => ({ i: r.i, c: r.c, s: b64url(r.salt) })),
});

const equal = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
};

export type VerifyResult = { ok: true } | { ok: false; why: 'malformed' | 'leaf' | 'root' | 'commitment' | 'cards' };

/**
 * Check a proof: every revealed card hashes to its leaf, the leaves hash to the root, the root is
 * the commitment received live (`cr`), and every card the caller saw (`expected`: position and
 * card) is revealed at that position.
 */
export const verify = async (proof: Proof, cr: string, expected: readonly { i: number; c: number }[], sha256: Sha256): Promise<VerifyResult> => {
  const leaves = fromB64url(proof.L);
  const root = fromB64url(proof.root);
  if (!leaves || leaves.length !== POSITIONS * LEAF_BYTES || !root || root.length !== LEAF_BYTES || !Array.isArray(proof.rv)) return { ok: false, why: 'malformed' };
  for (const r of proof.rv) {
    const salt = fromB64url(r.s);
    if (!salt || salt.length !== SALT_BYTES || !Number.isInteger(r.i) || r.i < 0 || r.i >= POSITIONS || !Number.isInteger(r.c) || r.c < 0 || r.c > 51) return { ok: false, why: 'malformed' };
    const leaf = await sha256(leafInput(r.i, r.c, salt));
    if (!equal(leaf, leaves.subarray(r.i * LEAF_BYTES, (r.i + 1) * LEAF_BYTES))) return { ok: false, why: 'leaf' };
  }
  if (!equal(await sha256(leaves), root)) return { ok: false, why: 'root' };
  if (proof.root !== cr) return { ok: false, why: 'commitment' };
  for (const e of expected) if (!proof.rv.some((r) => r.i === e.i && r.c === e.c)) return { ok: false, why: 'cards' };
  return { ok: true };
};
