import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/index.js';
import { createPrefs, REENABLE_DELAY_MS } from '../../src/arcade/prefs.js';
import { createSaves, SAVE_MAX_BYTES, type SaveSlot } from '../../src/arcade/saves.js';
import type { GameId } from '../../src/arcade/core/version.js';

const HOUR = 3_600_000;

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

const setup = () => {
  const db = openDatabase(':memory:', { memory: true });
  const clock = makeClock();
  const insert = db.prepare("INSERT INTO accounts (id, username, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, 'x', 0, 0)");
  for (const id of ['owner', 'other']) insert.run(id, id, id);
  return { db, clock };
};

describe('saves', () => {
  it('puts, lists, gets, overwrites and removes slots', () => {
    const { db, clock } = setup();
    const busy = new Set<string>();
    const saves = createSaves(db, clock, (owner, game, slot) => busy.has(`${owner}/${game}/${slot}`));
    expect(saves.list('owner', 'bellwick')).toEqual([]);
    expect(saves.get('owner', 'bellwick', 0)).toBeNull();

    saves.put('owner', 'bellwick', 2, 1, new Uint8Array([9, 8, 7]), ['owner', 'other']);
    saves.put('owner', 'bellwick', 0, 1, new Uint8Array([1]), ['owner']);
    saves.put('other', 'bellwick', 0, 1, new Uint8Array([5]), []);
    saves.put('owner', 'fuseyard', 1, 1, new Uint8Array([6]), []);
    expect(saves.list('owner', 'bellwick').map((s) => s.slot)).toEqual([0, 2]);
    expect(saves.get('owner', 'bellwick', 2)).toEqual({ slot: 2, version: 1, data: new Uint8Array([9, 8, 7]), members: ['owner', 'other'], updatedAt: clock.now() });

    clock.advance(1000);
    const sub = new Uint8Array([0, 4, 4, 4, 0]).subarray(1, 4);
    saves.put('owner', 'bellwick', 2, 3, sub, ['other', 'owner', 'other']);
    expect(saves.get('owner', 'bellwick', 2)).toEqual({ slot: 2, version: 3, data: new Uint8Array([4, 4, 4]), members: ['owner', 'other'], updatedAt: clock.now() });

    busy.add('owner/bellwick/2');
    expect(saves.inUse('owner', 'bellwick', 2)).toBe(true);
    expect(saves.remove('owner', 'bellwick', 2)).toBe('in-use');
    expect(saves.get('owner', 'bellwick', 2)).not.toBeNull();
    busy.clear();
    expect(saves.remove('owner', 'bellwick', 2)).toBe('ok');
    expect(saves.get('owner', 'bellwick', 2)).toBeNull();
    expect(saves.remove('owner', 'bellwick', 2)).toBe('ok');
    expect(saves.list('other', 'bellwick')).toHaveLength(1);
    expect(saves.list('owner', 'fuseyard')).toHaveLength(1);
  });

  it('caps data at 4,096 bytes and members at 16', () => {
    const { db, clock } = setup();
    const saves = createSaves(db, clock, () => false);
    saves.put('owner', 'bellwick', 0, 1, new Uint8Array(SAVE_MAX_BYTES), []);
    expect(saves.get('owner', 'bellwick', 0)?.data.byteLength).toBe(SAVE_MAX_BYTES);
    expect(() => saves.put('owner', 'bellwick', 1, 1, new Uint8Array(SAVE_MAX_BYTES + 1), [])).toThrow(RangeError);
    expect(saves.get('owner', 'bellwick', 1)).toBeNull();
    expect(() => saves.put('owner', 'bellwick', 3 as SaveSlot, 1, new Uint8Array(1), [])).toThrow(RangeError);
    expect(() => saves.put('owner', 'bellwick', 0, 1.5, new Uint8Array(1), [])).toThrow(RangeError);

    const members = Array.from({ length: 20 }, (_, i) => 'm' + i);
    saves.put('owner', 'bellwick', 2, 1, new Uint8Array(1), members);
    expect(saves.get('owner', 'bellwick', 2)?.members).toEqual(members.slice(4));
  });
});

describe('prefs (self-exclusion)', () => {
  it('starts visible and writes no row until something changes', () => {
    const { db, clock } = setup();
    const prefs = createPrefs(db, clock);
    expect(prefs.get('owner')).toEqual({ hidden: false, games: {}, reenableAt: null });
    expect(prefs.hidden('owner', 'glimmer')).toBe(false);
    expect(db.prepare('SELECT COUNT(*) FROM arcade_prefs').pluck().get()).toBe(0);
  });

  it('hides at once and re-enables only after 24 h', () => {
    const { db, clock } = setup();
    const prefs = createPrefs(db, clock);
    expect(prefs.set('owner', { hidden: true })).toEqual({ hidden: true, games: {}, reenableAt: null });
    for (const game of ['lamplight', 'glimmer', 'fuseyard', 'bellwick'] as GameId[]) expect(prefs.hidden('owner', game)).toBe(true);
    expect(prefs.hidden('other', 'glimmer')).toBe(false);

    const asked = clock.now();
    expect(prefs.set('owner', { hidden: false })).toEqual({ hidden: true, games: {}, reenableAt: asked + REENABLE_DELAY_MS });
    clock.advance(24 * HOUR - 1);
    expect(prefs.hidden('owner', 'lamplight')).toBe(true);
    // Asking again does not restart the wait.
    expect(prefs.set('owner', { hidden: false }).reenableAt).toBe(asked + REENABLE_DELAY_MS);
    clock.advance(1);
    expect(prefs.hidden('owner', 'lamplight')).toBe(false);
    expect(prefs.get('owner')).toEqual({ hidden: false, games: {}, reenableAt: null });
    // The applied change was saved.
    expect(db.prepare("SELECT hidden, games, reenable_at AS r FROM arcade_prefs WHERE account_id = 'owner'").get()).toEqual({ hidden: 0, games: '{}', r: null });
  });

  it('per-game toggles: hiding again cancels the wait, a new un-hide restarts it', () => {
    const { db, clock } = setup();
    const prefs = createPrefs(db, clock);
    expect(prefs.set('owner', { games: { glimmer: false, fuseyard: false } }).games).toEqual({ glimmer: false, fuseyard: false });
    expect(prefs.hidden('owner', 'glimmer')).toBe(true);
    expect(prefs.hidden('owner', 'lamplight')).toBe(false);

    const t0 = clock.now();
    expect(prefs.set('owner', { games: { glimmer: true } })).toEqual({ hidden: false, games: { glimmer: false, fuseyard: false }, reenableAt: t0 + REENABLE_DELAY_MS });
    expect(JSON.parse(db.prepare("SELECT games FROM arcade_prefs WHERE account_id = 'owner'").pluck().get() as string)).toEqual({
      glimmer: false,
      fuseyard: false,
      pending: { games: { glimmer: true } },
    });

    // Hiding glimmer again cancels its waiting un-hide.
    clock.advance(HOUR);
    expect(prefs.set('owner', { games: { glimmer: false } }).reenableAt).toBeNull();
    clock.advance(25 * HOUR);
    expect(prefs.hidden('owner', 'glimmer')).toBe(true);

    // Two un-hides: the second restarts the wait for both.
    prefs.set('owner', { games: { glimmer: true } });
    clock.advance(10 * HOUR);
    const t1 = clock.now();
    expect(prefs.set('owner', { games: { fuseyard: true } }).reenableAt).toBe(t1 + REENABLE_DELAY_MS);
    clock.advance(20 * HOUR);
    expect(prefs.hidden('owner', 'glimmer')).toBe(true);
    clock.advance(4 * HOUR);
    expect(prefs.get('owner')).toEqual({ hidden: false, games: {}, reenableAt: null });
  });

  it('a mixed request hides at once and delays only the un-hide', () => {
    const { clock, db } = setup();
    const prefs = createPrefs(db, clock);
    prefs.set('owner', { games: { glimmer: false } });
    const row = prefs.set('owner', { hidden: true, games: { glimmer: true, bellwick: false } });
    expect(row).toEqual({ hidden: true, games: { glimmer: false, bellwick: false }, reenableAt: clock.now() + REENABLE_DELAY_MS });
    clock.advance(REENABLE_DELAY_MS);
    expect(prefs.get('owner')).toEqual({ hidden: true, games: { bellwick: false }, reenableAt: null });
    expect(prefs.hidden('owner', 'glimmer')).toBe(true); // the whole Arcade is still hidden
  });
});
