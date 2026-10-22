/**
 * The deck check in the history drawer (lamplight.md §8.2, §18.4) with a stubbed host: a valid proof
 * verifies, a tampered one is a mismatch, a refused one says why, and without crypto.subtle (plain
 * http) it says a secure connection is needed. Also the model's gap handling: a skipped `q` asks
 * for a sync and is not applied.
 */
import { describe, expect, it } from 'vitest';
import { b64url } from '@arcade/core/bytes';
import { buildProof, commit, revealPositions } from '@arcade/core/lamplight/proof';
import type { TableHost } from '../runtime/types';
import { NEEDS_HTTPS, verifyHand } from './proofView';
import { createTableModel, type HandRecord } from './table';

/** A small stand-in hash (not SHA-256, but deterministic and collision-free enough for the test). */
const fakeSha = async (data: Uint8Array): Promise<Uint8Array> => {
  const out = new Uint8Array(32);
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h = Math.imul(h ^ data[i], 0x01000193);
    out[i % 32] ^= h & 0xff;
    out[(i + 7) % 32] ^= (h >>> 8) & 0xff;
  }
  for (let i = 0; i < 32; i++) {
    h = Math.imul(h ^ i, 0x01000193);
    out[i] ^= h >>> 24;
  }
  return out;
};

const hostWith = (answer: unknown): TableHost => ({
  mode: 'remote',
  request: async <T,>() => answer as T,
  on: () => () => undefined,
  connected: () => true,
  onConnection: () => () => undefined,
  ackRttMs: () => 0,
  setVisible: () => undefined,
  close: () => undefined,
});

const deal = async () => {
  const deck = Array.from({ length: 52 }, (_, i) => (i * 7) % 52);
  const salts = deck.map((_, i) => Uint8Array.from({ length: 16 }, (_, k) => (i * 31 + k * 17) & 0xff));
  const { leaves, root } = await commit(deck, salts, fakeSha);
  const positions = revealPositions({ dealt: [1, 2, 0], board: 5, shown: [], viewer: 0 });
  const proof = buildProof(leaves, root, positions.map((i) => ({ i, c: deck[i], salt: salts[i] })));
  const rec: HandRecord = {
    no: 7,
    at: 0,
    label: 'Pebble 5/10',
    lines: [],
    net: 0,
    pot: 0,
    cr: b64url(root),
    seen: positions.map((i) => ({ i, c: deck[i] })),
    seed: null,
    done: true,
  };
  return { proof, rec, deck };
};

describe('verify deck', () => {
  it('verifies a matching proof and reports a mismatch', async () => {
    const { proof, rec } = await deal();
    expect(await verifyHand(hostWith({ ok: true, ...proof }), 't', rec, fakeSha)).toMatch(/^Deck verified/);
    const tampered = { ...proof, rv: proof.rv.map((r, k) => (k === 0 ? { ...r, c: (r.c + 1) % 52 } : r)) };
    expect(await verifyHand(hostWith({ ok: true, ...tampered }), 't', rec, fakeSha)).toMatch(/^Mismatch/);
    const otherHand = { ...rec, cr: b64url(new Uint8Array(32)) };
    expect(await verifyHand(hostWith({ ok: true, ...proof }), 't', otherHand, fakeSha)).toMatch(/commitment/);
  });

  it('explains refusals and missing crypto.subtle', async () => {
    const { rec } = await deal();
    expect(await verifyHand(hostWith({ ok: false, code: 'forbidden' }), 't', rec, fakeSha)).toMatch(/Only players dealt in/);
    expect(await verifyHand(hostWith({ ok: true }), 't', rec, null)).toBe(NEEDS_HTTPS);
    expect(await verifyHand(hostWith({ ok: true }), 't', { ...rec, cr: null }, fakeSha)).toMatch(/Practice hands/);
  });
});

describe('event order', () => {
  it('asks for a sync on a gap in q and ignores duplicates', () => {
    const syncs: number[] = [];
    const m = createTableModel({
      me: 'me',
      names: (ids) => ids.map(() => 'x'),
      now: () => 0,
      linkMs: () => 0,
      sync: (since) => syncs.push(since),
      onEffect: () => undefined,
      onChange: () => undefined,
      act: () => undefined,
      announce: () => undefined,
    });
    m.handle('lamplight:snap', {
      t: 'tbl',
      q: 5,
      cfg: { f: 'open', tier: 'pebble', seats: 2, act: 15000, tb: 30000, tba: 5000, tbm: 60000, bi: [400, 1000], bots: null },
      lv: { i: 0, sb: 5, bb: 10, an: 0, ends: null },
      me: 0,
      hp: 0,
      lbb: null,
      seats: [
        { n: 0, a: 'me', st: 'a', stk: 1000, sb: 0, tot: 0, ac: -1, tb: 30000, fl: 1 },
        { n: 1, a: 'x', st: 'a', stk: 1000, sb: 0, tot: 0, ac: -1, tb: 30000, fl: 1 },
      ],
      h: null,
    });
    expect(m.lastQ).toBe(5);
    m.handle('lamplight:seat', { t: 'tbl', q: 5, s: 1, a: 'x', st: 'o', stk: 1000, tb: 30000, fl: 1 });
    expect(m.view?.seats[1].status).toBe('active');
    m.handle('lamplight:seat', { t: 'tbl', q: 7, s: 1, a: 'x', st: 'o', stk: 1000, tb: 30000, fl: 1 });
    expect(syncs).toEqual([5]);
    expect(m.view?.seats[1].status).toBe('active');
    m.handle('lamplight:seat', { t: 'tbl', q: 6, s: 1, a: 'x', st: 'o', stk: 1000, tb: 30000, fl: 1 });
    expect(m.view?.seats[1].status).toBe('sittingOut');
    expect(m.lastQ).toBe(6);
  });
});
