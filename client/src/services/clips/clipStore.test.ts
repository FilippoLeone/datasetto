import { describe, expect, it } from 'vitest';
import { CLIP_STORAGE_CAP_BYTES, clipFileName, planEviction, slugify, totalClipBytes } from './clipStore';

const MB = 1024 * 1024;
const clip = (id: string, bytes: number, createdAt: number) => ({ id, bytes, createdAt });

describe('planEviction', () => {
  it('removes nothing while the new clip fits', () => {
    const plan = planEviction([clip('a', 100 * MB, 1), clip('b', 100 * MB, 2)], 40 * MB);
    expect(plan).toEqual({ remove: [], totalAfter: 240 * MB, tooBig: false });
  });

  it('removes the oldest clips first until the new one fits under the cap', () => {
    const existing = [clip('newest', 150 * MB, 300), clip('oldest', 120 * MB, 100), clip('middle', 200 * MB, 200)];
    const plan = planEviction(existing, 45 * MB); // 470 + 45 = 515 MB: one has to go
    expect(plan.remove).toEqual(['oldest']);
    expect(plan.totalAfter).toBe(395 * MB);
    const bigger = planEviction(existing, 200 * MB); // 670 MB: two have to go
    expect(bigger.remove).toEqual(['oldest', 'middle']);
    expect(bigger.totalAfter).toBe(350 * MB);
  });

  it('breaks ties on the same timestamp deterministically and honours a custom cap', () => {
    const plan = planEviction([clip('b', 10, 5), clip('a', 10, 5), clip('c', 10, 6)], 10, 20);
    expect(plan.remove).toEqual(['a', 'b']);
    expect(plan.totalAfter).toBe(20);
  });

  it('refuses a clip larger than the whole cap instead of emptying the library', () => {
    const plan = planEviction([clip('a', 10 * MB, 1)], CLIP_STORAGE_CAP_BYTES + 1);
    expect(plan.tooBig).toBe(true);
    expect(plan.remove).toEqual([]);
  });

  it('sums the bytes of a library', () => {
    expect(totalClipBytes([clip('a', 3, 1), clip('b', 4, 2)])).toBe(7);
    expect(totalClipBytes([])).toBe(0);
  });
});

describe('clip file names', () => {
  it('slugifies source names', () => {
    expect(slugify("Bob's screen")).toBe('bobs-screen');
    expect(slugify('#main-stream')).toBe('main-stream');
    expect(slugify('  Ünïcödé  Name!! ')).toBe('unicode-name');
    expect(slugify('***')).toBe('clip');
    expect(slugify('x'.repeat(80)).length).toBeLessThanOrEqual(40);
  });

  it('builds datasetto-clip-<source>-<date>.webm in local time', () => {
    const when = new Date(2026, 9, 21, 18, 7, 9).getTime();
    expect(clipFileName('#main-stream', when)).toBe('datasetto-clip-main-stream-2026-10-21_18-07-09.webm');
    expect(clipFileName("Alice's screen", when)).toBe('datasetto-clip-alices-screen-2026-10-21_18-07-09.webm');
  });
});
