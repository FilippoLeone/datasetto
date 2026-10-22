/**
 * Game setups from the catalogue (setup.ts): which fields show where, the cfg each setup sends (in
 * the shape the servers parse, so no server change is needed), the summary lines, the remembered
 * setup, and the Bellwick save-slot default. The server parsers are mirrored below by hand:
 * lamplight `parseCfg` (bots), fuseyard's strict `cfgSchema` keys, bellwick's `bellwickCfgSchema`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATALOG, defaultOptions, type GameMeta, type Where } from '@/arcade/catalog';
import { meta as bellwick } from '@/arcade/bellwick/meta';
import { meta as fuseyard } from '@/arcade/fuseyard/meta';
import { meta as glimmer } from '@/arcade/glimmer/meta';
import { meta as lamplight } from '@/arcade/lamplight/meta';
import {
  cfgFields,
  cfgFor,
  fieldsFor,
  fillNewTale,
  hasOptions,
  modesFor,
  pickSaveSlot,
  resolveSetup,
  saveSetup,
  SETUP_KEY,
  summaryOf,
  summaryOfFields,
  withSaveSlot,
  type SlotInfo,
} from './setup';

const PLACES: readonly Where[] = ['offline', 'online'];

/** server/src/arcade/tables/lamplight.ts parseCfg: who sits as bots at an online table. */
const lamplightBots = (cfg: Record<string, unknown>): string | null => {
  const level = typeof cfg.bots === 'string' && cfg.bots !== 'off' ? cfg.bots : null;
  return cfg.onlineBots === undefined ? level : cfg.onlineBots ? (level ?? 'regular') : null;
};
/** server/src/arcade/rooms/fuseyard.ts cfgSchema (`.strict()`). */
const FUSEYARD_KEYS = ['mode', 'arena', 'fighters', 'wins', 'bots'];
const FUSEYARD_VALUES: Record<string, readonly unknown[]> = {
  arena: ['rotation', 'yard', 'mill', 'pond', 'garden', 'depot'],
  fighters: [2, 3, 4],
  wins: [2, 3, 5],
  bots: ['sprout', 'scrapper', 'menace'],
};
/** server/src/arcade/rooms/bellwick.ts bellwickCfgSchema's preprocess. */
const bellwickTale = (o: Record<string, unknown>): { tale: 'new' | 'slot'; slot: number } => {
  const slotOf = (v: unknown) => (v === 0 || v === 1 || v === 2 ? v : null);
  const existing = slotOf(o.slot);
  return existing !== null ? { tale: 'slot', slot: existing } : { tale: 'new', slot: slotOf(o.into) ?? 0 };
};

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('the catalogue', () => {
  it('gives every mode a one-line blurb and keeps keys unique per mode and place', () => {
    for (const meta of CATALOG) {
      for (const mode of meta.modes) {
        expect(mode.blurb, meta.id + '/' + mode.id).toBeTruthy();
        expect(mode.blurb!.length, meta.id + '/' + mode.id).toBeLessThanOrEqual(80);
      }
      for (const where of PLACES) {
        for (const mode of modesFor(meta, where)) {
          const keys = cfgFields(meta, where, mode.id).map((f) => f.key);
          expect(new Set(keys).size, meta.id + '/' + mode.id + '/' + where).toBe(keys.length);
        }
      }
    }
  });

  it('puts at most 2 fields on any setup screen (main fields, whatever the values)', () => {
    for (const meta of CATALOG) {
      for (const where of PLACES) {
        for (const mode of modesFor(meta, where)) {
          const main = cfgFields(meta, where, mode.id).filter((f) => f.more !== true && f.more !== where);
          expect(main.length, meta.id + '/' + mode.id + '/' + where).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('keeps solo fields out of a call and call fields out of solo play', () => {
    const keys = (where: Where, mode: string) => fieldsFor(lamplight, where, mode, resolveSetup(lamplight, where).values).all.map((f) => f.key);
    expect(keys('offline', 'open')).toEqual(['bots', 'tier', 'players']);
    expect(keys('online', 'open')).toEqual(['tier', 'players', 'onlineBots']);
    expect(keys('online', 'trio')).toEqual(['buyIn']);
    expect(fieldsFor(lamplight, 'offline', 'open', {}).main.map((f) => f.key)).toEqual(['bots']);
    expect(fieldsFor(lamplight, 'online', 'open', {}).main.map((f) => f.key)).toEqual(['tier']);
    expect(fieldsFor(fuseyard, 'offline', 'brawl', {}).main.map((f) => f.key)).toEqual(['bots']);
    expect(fieldsFor(fuseyard, 'online', 'brawl', {}).main).toEqual([]);
    expect(fieldsFor(fuseyard, 'online', 'quickfire', {}).all.map((f) => f.key)).toEqual(['bots', 'arena', 'fighters']);
  });

  it('shows the bot level online only once bots are asked for, and the switch only at Pebble and Cobble', () => {
    const shown = (values: Record<string, unknown>) => fieldsFor(lamplight, 'online', 'open', values).all.map((f) => f.key);
    expect(shown({ onlineBots: true })).toEqual(['tier', 'players', 'onlineBots', 'bots']);
    expect(shown({ tier: 'cobble', onlineBots: true })).toContain('bots');
    expect(shown({ tier: 'boulder', onlineBots: true })).toEqual(['tier', 'players']);
    expect(shown({ tier: 'summit' })).toEqual(['tier', 'players']);
    expect(fieldsFor(lamplight, 'online', 'cup', { onlineBots: true }).all.map((f) => f.key)).toEqual(['buyIn', 'players', 'onlineBots', 'bots']);
  });

  it('offers Options only where there is something to choose', () => {
    const offers = (meta: GameMeta, where: Where) => hasOptions(meta, where, resolveSetup(meta, where));
    expect(offers(lamplight, 'offline')).toBe(true);
    expect(offers(lamplight, 'online')).toBe(true);
    expect(offers(fuseyard, 'online')).toBe(true);
    expect(offers(glimmer, 'offline')).toBe(false);
    expect(offers(glimmer, 'online')).toBe(false);
    expect(offers(bellwick, 'offline')).toBe(false);
    expect(offers(bellwick, 'online')).toBe(true);
  });

  it('keeps defaultOptions without a place as before (every field of the mode)', () => {
    expect(defaultOptions(fuseyard, 'brawl')).toEqual({ bots: 'scrapper', wins: 3, arena: 'rotation', fighters: 4 });
    expect(defaultOptions(lamplight, 'trio')).toEqual({ bots: 'regular', buyIn: 1000 });
    expect(defaultOptions(lamplight, 'trio', 'online')).toEqual({ buyIn: 1000 });
  });
});

describe('the cfg sent', () => {
  it('Lamplight: always sends the bots switch online, off by default, so no bots sit down unasked', () => {
    const open = cfgFor(lamplight, 'online', 'open', resolveSetup(lamplight, 'online').values);
    expect(open).toEqual({ tier: 'pebble', players: 6, onlineBots: false, bots: 'regular' });
    expect(lamplightBots(open)).toBeNull();
    expect(cfgFor(lamplight, 'online', 'cup', {})).toEqual({ buyIn: 2000, players: 6, onlineBots: false, bots: 'regular' });
    expect(cfgFor(lamplight, 'online', 'trio', { bots: 'sharp', onlineBots: true, players: 9 })).toEqual({ buyIn: 1000 });
    expect(lamplightBots(cfgFor(lamplight, 'online', 'trio', {}))).toBeNull();
  });

  it('Lamplight: a hidden switch sends its default (off at Boulder and Summit, whatever was remembered)', () => {
    const boulder = cfgFor(lamplight, 'online', 'open', { tier: 'boulder', onlineBots: true, bots: 'sharp' });
    expect(boulder).toEqual({ tier: 'boulder', players: 6, onlineBots: false, bots: 'regular' });
    expect(lamplightBots(boulder)).toBeNull();
    const pebble = cfgFor(lamplight, 'online', 'open', { tier: 'pebble', onlineBots: true, bots: 'sharp' });
    expect(pebble).toEqual({ tier: 'pebble', players: 6, onlineBots: true, bots: 'sharp' });
    expect(lamplightBots(pebble)).toBe('sharp');
    expect(lamplightBots(cfgFor(lamplight, 'online', 'cup', { onlineBots: true }))).toBe('regular');
  });

  it('Lamplight solo: bot level, stakes and seats; no online switch', () => {
    expect(cfgFor(lamplight, 'offline', 'open', {})).toEqual({ bots: 'regular', tier: 'pebble', players: 6 });
    expect(cfgFor(lamplight, 'offline', 'cup', { buyIn: 500, bots: 'greenhorn' })).toEqual({ bots: 'greenhorn', buyIn: 500, players: 6 });
    expect(cfgFor(lamplight, 'offline', 'trio', { buyIn: 2000 })).toEqual({ bots: 'regular', buyIn: 1000 });
  });

  it('Fuseyard: only the strict schema keys, with values it accepts', () => {
    for (const where of PLACES) {
      for (const mode of ['brawl', 'quickfire']) {
        const cfg = cfgFor(fuseyard, where, mode, { arena: 'nowhere', fighters: 7, wins: 4, bots: 'boss', extra: 1 });
        for (const [key, value] of Object.entries(cfg)) {
          expect(FUSEYARD_KEYS, key).toContain(key);
          expect(FUSEYARD_VALUES[key], key).toContain(value);
        }
      }
    }
    expect(cfgFor(fuseyard, 'online', 'brawl', {})).toEqual({ bots: 'scrapper', wins: 3, arena: 'rotation', fighters: 4 });
    expect(cfgFor(fuseyard, 'online', 'quickfire', { wins: 5, arena: 'pond', fighters: 3, bots: 'menace' })).toEqual({ bots: 'menace', arena: 'pond', fighters: 3 });
  });

  it('Bellwick: {slot: n} continues, {slot: "new", into: k} starts a new tale in slot k', () => {
    const cont = cfgFor(bellwick, 'online', 'party', { slot: 1, into: 2 });
    expect(cont).toEqual({ slot: 1, into: 0 });
    expect(bellwickTale(cont)).toEqual({ tale: 'slot', slot: 1 });
    const fresh = cfgFor(bellwick, 'online', 'party', { slot: 'new', into: 2 });
    expect(fresh).toEqual({ slot: 'new', into: 2 });
    expect(bellwickTale(fresh)).toEqual({ tale: 'new', slot: 2 });
    expect(cfgFor(bellwick, 'offline', 'solo', { slot: 1 })).toEqual({});
    expect(cfgFor(glimmer, 'online', 'hall', {})).toEqual({});
  });
});

describe('summaries', () => {
  it('read like the card lines', () => {
    expect(summaryOf(lamplight, 'offline', 'open', {})).toBe('Cash table · Regular bots');
    expect(summaryOf(lamplight, 'online', 'open', {})).toBe('Cash table · Pebble 5/10');
    expect(summaryOf(lamplight, 'online', 'cup', {})).toBe('Tournament · 2,000');
    expect(summaryOf(fuseyard, 'offline', 'brawl', {})).toBe('Brawl · Scrapper bots');
    expect(summaryOf(fuseyard, 'online', 'brawl', {})).toBe('Brawl');
    expect(summaryOf(glimmer, 'online', 'hall', {})).toBe('Open hall');
    expect(summaryOf(bellwick, 'online', 'party', {})).toBe('Party Tale');
    expect(summaryOf(bellwick, 'online', 'party', { slot: 1 })).toBe('Party Tale · Continue Slot 2');
    expect(summaryOf(bellwick, 'online', 'party', { slot: 'new' })).toBe('Party Tale · New tale');
  });

  it('list the More options and the lobby options line', () => {
    expect(summaryOfFields(fieldsFor(lamplight, 'offline', 'open', {}).more, {})).toBe('Pebble 5/10 · 6 seats');
    expect(summaryOfFields(fieldsFor(lamplight, 'online', 'open', {}).more, {})).toBe('6 seats');
    expect(summaryOfFields(fieldsFor(lamplight, 'online', 'open', { onlineBots: true }).more, { onlineBots: true })).toBe('6 seats · Fill empty seats with bots · Regular bots');
    expect(fieldsFor(lamplight, 'online', 'trio', {}).more).toEqual([]);
    expect(summaryOfFields(fieldsFor(fuseyard, 'offline', 'brawl', {}).more, {})).toBe('first to 3 · Rotation · 4 fighters');
    expect(summaryOfFields(fieldsFor(fuseyard, 'online', 'brawl', {}).more, {})).toBe('Scrapper bots · first to 3 · Rotation · 4 fighters');
    // The lobby never offers what was fixed at create (seats, the tale).
    expect(summaryOf(fuseyard, 'online', 'brawl', { wins: 5, arena: 'pond', fighters: 3 }, { all: true, editable: 'lobby' })).toBe('Brawl · Scrapper bots · first to 5 · Frostbite Pond');
    expect(fieldsFor(fuseyard, 'online', 'brawl', {}, 'lobby').all.map((f) => f.key)).toEqual(['bots', 'wins', 'arena']);
    expect(fieldsFor(bellwick, 'online', 'party', { slot: 'new' }, 'lobby').all).toEqual([]);
  });
});

describe('the remembered setup', () => {
  it('starts from the first mode offered here and the defaults', () => {
    expect(resolveSetup(lamplight, 'offline')).toEqual({ mode: 'open', values: { bots: 'regular', tier: 'pebble', players: 6 } });
    expect(resolveSetup(bellwick, 'offline')).toEqual({ mode: 'solo', values: {} });
    // A save slot has no default: one tap reads the save list first.
    expect(resolveSetup(bellwick, 'online')).toEqual({ mode: 'party', values: { into: 0 } });
  });

  it('remembers solo and call setups apart', () => {
    saveSetup(lamplight, 'offline', { mode: 'cup', values: { bots: 'sharp', buyIn: 10000, players: 4 } });
    saveSetup(lamplight, 'online', { mode: 'open', values: { tier: 'cobble', onlineBots: true, bots: 'greenhorn' } });
    expect(resolveSetup(lamplight, 'offline')).toEqual({ mode: 'cup', values: { bots: 'sharp', buyIn: 10000, players: 4 } });
    expect(resolveSetup(lamplight, 'online')).toEqual({ mode: 'open', values: { tier: 'cobble', players: 6, onlineBots: true, bots: 'greenhorn' } });
    expect(summaryOf(lamplight, 'offline', 'cup', resolveSetup(lamplight, 'offline').values)).toBe('Tournament · Sharp bots');
    expect(JSON.parse(localStorage.getItem(SETUP_KEY) ?? '{}')).toMatchObject({ v: 1, offline: { lamplight: { mode: 'cup' } }, online: { lamplight: { mode: 'open' } } });
  });

  it('falls back from bad stored values, unknown keys and modes not offered here', () => {
    localStorage.setItem(
      SETUP_KEY,
      JSON.stringify({
        v: 1,
        offline: { lamplight: { mode: 'gone', values: { bots: 'godlike', tier: 'cobble', players: 12, junk: 1 } }, bellwick: { mode: 'party', values: { slot: 2 } } },
        online: { fuseyard: { mode: 'quickfire', values: { arena: 'moon', fighters: 3, wins: 5 } }, bellwick: { mode: 'party', values: { slot: 7, into: 9 } } },
      }),
    );
    expect(resolveSetup(lamplight, 'offline')).toEqual({ mode: 'open', values: { bots: 'regular', tier: 'cobble', players: 6 } });
    expect(resolveSetup(bellwick, 'offline')).toEqual({ mode: 'solo', values: {} });
    // Wins belong to Brawl: kept for when Brawl comes back, never sent in Quickfire.
    const quick = resolveSetup(fuseyard, 'online');
    expect(quick).toEqual({ mode: 'quickfire', values: { bots: 'scrapper', arena: 'rotation', fighters: 3, wins: 5 } });
    expect(cfgFor(fuseyard, 'online', quick.mode, quick.values)).toEqual({ bots: 'scrapper', arena: 'rotation', fighters: 3 });
    expect(resolveSetup(bellwick, 'online')).toEqual({ mode: 'party', values: { into: 0 } });

    localStorage.setItem(SETUP_KEY, '{not json');
    expect(resolveSetup(fuseyard, 'online')).toEqual({ mode: 'brawl', values: { bots: 'scrapper', wins: 3, arena: 'rotation', fighters: 4 } });
    localStorage.setItem(SETUP_KEY, JSON.stringify({ v: 2, offline: { fuseyard: { mode: 'quickfire', values: {} } } }));
    expect(resolveSetup(fuseyard, 'offline').mode).toBe('brawl');
  });
});

describe('the Bellwick save slot', () => {
  const slot = (n: number, updatedAt: number, inUse = false): SlotInfo => ({ slot: n, updatedAt, inUse });

  it('continues the latest tale that is free, else starts a new one in the first empty slot', () => {
    expect(pickSaveSlot([], undefined)).toEqual({ slot: 'new', into: 0 });
    expect(pickSaveSlot([slot(0, 10), slot(2, 30)], undefined)).toEqual({ slot: 2, into: null });
    expect(pickSaveSlot([slot(0, 10), slot(2, 30, true)], undefined)).toEqual({ slot: 0, into: null });
    expect(pickSaveSlot([slot(0, 10, true)], 1)).toEqual({ slot: 'new', into: 1 });
    expect(pickSaveSlot([slot(0, 10), slot(1, 20)], 'new')).toEqual({ slot: 'new', into: 2 });
  });

  it('never overwrites by default: all slots used and New remembered asks first', () => {
    const full = [slot(0, 10), slot(1, 20), slot(2, 30)];
    expect(pickSaveSlot(full, 'new')).toBeNull();
    expect(pickSaveSlot([slot(0, 10, true), slot(1, 20, true), slot(2, 30, true)], undefined)).toBeNull();
    expect(withSaveSlot(bellwick, 'online', { mode: 'party', values: { slot: 'new', into: 0 } }, full)).toBeNull();
  });

  it('fills the cfg from the save list', () => {
    const setup = resolveSetup(bellwick, 'online');
    const picked = withSaveSlot(bellwick, 'online', setup, [slot(1, 5)]);
    expect(cfgFor(bellwick, 'online', 'party', picked!)).toEqual({ slot: 1, into: 0 });
    const fresh = withSaveSlot(bellwick, 'online', setup, []);
    expect(cfgFor(bellwick, 'online', 'party', fresh!)).toEqual({ slot: 'new', into: 0 });
    // New tale picked by hand: the first empty slot, unless every slot is used (then the host's "Replaces").
    expect(fillNewTale(bellwick, 'online', { mode: 'party', values: { slot: 'new', into: 0 } }, [slot(0, 1), slot(1, 2)])).toEqual({ slot: 'new', into: 2 });
    expect(fillNewTale(bellwick, 'online', { mode: 'party', values: { slot: 'new', into: 1 } }, [slot(0, 1), slot(1, 2), slot(2, 3)])).toEqual({ slot: 'new', into: 1 });
    expect(fillNewTale(bellwick, 'online', { mode: 'party', values: { slot: 0 } }, [])).toEqual({ slot: 0 });
    // "Replaces" shows only when no slot is empty (the form hides it otherwise).
    expect(fieldsFor(bellwick, 'online', 'party', { slot: 'new' }).more.map((f) => f.key)).toEqual(['into']);
    expect(fieldsFor(bellwick, 'online', 'party', { slot: 2 }).more).toEqual([]);
  });
});
