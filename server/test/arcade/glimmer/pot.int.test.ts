/**
 * The Glimmer Pot's carry over 10k online spins (glimmerhall.md §4.1, §18.1 test 9), in its own
 * file so it runs beside the other suites: whole chips moved = floor(Σ bet × 75 / 10,000), the
 * sub-chip carry kept by the house, and exactly one pot draw per base spin (never for free spins).
 */
import { describe, expect, it } from 'vitest';
import { DEFS } from '../../../src/arcade/core/version.js';
import type { EnterOk, SpinOk } from '../../../src/arcade/core/glimmer/wire.js';
import { checkInvariant } from '../../../src/arcade/wallet.js';
import { createHarness, scripted, sid } from './harness.js';

describe('the Glimmer Pot', () => {
  it('moves floor(Σ bet × 75 / 10,000) chips into the pot over 10k bets, drawing the pot once per base spin only', () => {
    const r = scripted(11);
    let potDraws = 0;
    const h = createHarness({
      rng: r.rng,
      potRng: (n) => {
        potDraws += 1;
        return n - 1;
      },
    });
    h.addAccount('a');
    h.voice.set('a', 'ch');
    expect(h.call<EnterOk>(h.ctx('a'), 'glimmer:enter', { ch: 'ch', v: DEFS.glimmer }).ok).toBe(true);
    h.wallet.transfer('admin', 'test', 'system', 'fill', [
      { account: 'house', delta: -5_000_000 },
      { account: 'w:a', delta: 5_000_000 },
    ]);
    const bets = [20, 40, 100, 200, 500];
    let sum = 0;
    let freeSpins = 0;
    for (let i = 0; i < 10_000; i += 1) {
      const bet = bets[r.rng(5)] as number;
      sum += bet;
      const ack = h.call<SpinOk>(h.ctx('a'), 'glimmer:spin', { m: 1, b: bet, id: sid() });
      expect(ack.ok).toBe(true);
      if (ack.f?.k === 't') freeSpins += ack.f.r.length / 5;
    }
    expect(freeSpins).toBeGreaterThan(0);
    expect(potDraws).toBe(10_000);
    const pot = h.wallet.pot('glimmer');
    expect(pot.pool).toBe(Math.floor((sum * 75) / 10_000));
    expect(pot.carryE4).toBe((sum * 75) % 10_000);
    expect(checkInvariant(h.db)).toEqual([]);
  }, 20_000);

});
