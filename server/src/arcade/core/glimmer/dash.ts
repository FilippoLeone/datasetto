/**
 * Glimmer Dash payouts (glimmerhall.md §5.3), shared by the server and the offline Dash.
 *
 * - The pool pays 100 % to the winner with 2 entrants, 70/30 with 3–4 and 50/30/20 with 5–8.
 * - Each share is floor(pool × pct / 100); the remainder goes to first place, so the payout sums to
 *   the pool exactly.
 * - Tied entrants split their places' combined shares; the odd chips go to whoever finished
 *   earlier (then to the earlier entrant).
 */

export interface DashEntrant {
  key: string;
  score: number;
  /** When the entrant used their last spin (or the end time if they did not finish). */
  finishedAt: number;
  /** Join order, the last tie-break. */
  order: number;
}

export interface DashPlace {
  key: string;
  /** 1-based; tied entrants share the best place of their group. */
  place: number;
  prize: number;
  score: number;
}

export const dashPercents = (entrants: number): readonly number[] => (entrants <= 2 ? [100] : entrants <= 4 ? [70, 30] : [50, 30, 20]);

/** Prize per place index (0-based), summing exactly to the pool. */
export const dashShares = (pool: number, entrants: number): number[] => {
  const pct = dashPercents(entrants);
  const shares: number[] = [];
  let sum = 0;
  for (let i = 0; i < pct.length; i += 1) {
    const share = Math.floor((pool * (pct[i] as number)) / 100);
    shares.push(share);
    sum += share;
  }
  shares[0] = (shares[0] as number) + pool - sum;
  return shares;
};

const earlier = (a: DashEntrant, b: DashEntrant): number => a.finishedAt - b.finishedAt || a.order - b.order;

/** Places and prizes, best first. */
export const dashPayout = (pool: number, entrants: readonly DashEntrant[]): DashPlace[] => {
  const shares = dashShares(pool, entrants.length);
  const ranked = entrants.slice().sort((a, b) => b.score - a.score || earlier(a, b));
  const out: DashPlace[] = [];
  let i = 0;
  for (let guard = 0; guard < ranked.length && i < ranked.length; guard += 1) {
    let j = i + 1;
    for (; j < ranked.length; j += 1) if ((ranked[j] as DashEntrant).score !== (ranked[i] as DashEntrant).score) break;
    let combined = 0;
    for (let p = i; p < j; p += 1) combined += shares[p] ?? 0;
    const k = j - i;
    const each = Math.floor(combined / k);
    let odd = combined - each * k;
    const group = ranked.slice(i, j).sort(earlier);
    for (let g = 0; g < group.length; g += 1) {
      const e = group[g] as DashEntrant;
      const extra = odd > 0 ? 1 : 0;
      odd -= extra;
      out.push({ key: e.key, place: i + 1, prize: each + extra, score: e.score });
    }
    i = j;
  }
  return out;
};
