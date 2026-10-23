/**
 * The cfg the client's setup screens send, parsed by the real server schemas: lamplight `parseCfg`,
 * fuseyard's strict `cfgSchema` (and `configOf`), bellwick's `bellwickCfgSchema`. The objects are
 * literals copied from client/src/features/arcade/setup.test.ts ("the cfg sent"), which pins what
 * the client's `cfgFor` produces; change one side and change the other with it.
 */
import { describe, expect, it } from 'vitest';
import { BotLevel } from '../../src/arcade/core/fuseyard/rules.js';
import { bellwickCfgSchema } from '../../src/arcade/rooms/bellwick.js';
import { cfgSchema as fuseyardCfg, configOf } from '../../src/arcade/rooms/fuseyard.js';
import { parseCfg } from '../../src/arcade/tables/lamplight.js';

describe('Lamplight lobby cfg', () => {
  it('seats no bots unless the switch asks for them', () => {
    expect(parseCfg('open', { tier: 'pebble', players: 6, onlineBots: false, bots: 'regular' })).toEqual({ tier: 'pebble', seats: 6, bots: null, buyIn: 0 });
    expect(parseCfg('cup', { buyIn: 2000, players: 6, onlineBots: false, bots: 'regular' })).toEqual({ tier: 'pebble', seats: 6, bots: null, buyIn: 2000 });
    expect(parseCfg('trio', { buyIn: 1000 })).toEqual({ tier: 'pebble', seats: 3, bots: null, buyIn: 1000 });
    expect(parseCfg('open', { tier: 'boulder', players: 6, onlineBots: false, bots: 'regular' })).toEqual({ tier: 'boulder', seats: 6, bots: null, buyIn: 0 });
  });

  it('seats bots at the chosen level when the switch is on', () => {
    expect(parseCfg('open', { tier: 'pebble', players: 6, onlineBots: true, bots: 'sharp' })).toEqual({ tier: 'pebble', seats: 6, bots: 'sharp', buyIn: 0 });
    expect(parseCfg('cup', { buyIn: 2000, players: 6, onlineBots: true, bots: 'regular' })).toEqual({ tier: 'pebble', seats: 6, bots: 'regular', buyIn: 2000 });
  });
});

describe('Fuseyard lobby cfg', () => {
  it('passes the strict schema with exactly the keys sent', () => {
    for (const cfg of [
      { bots: 'scrapper', wins: 3, arena: 'rotation', fighters: 4 },
      { bots: 'scrapper', arena: 'rotation', fighters: 4 },
      { bots: 'menace', arena: 'pond', fighters: 3 },
    ]) {
      const parsed = fuseyardCfg.safeParse(cfg);
      expect(parsed.success, JSON.stringify(cfg)).toBe(true);
      expect(parsed.data).toMatchObject(cfg);
    }
  });

  it('builds the match the setup screen showed', () => {
    expect(configOf({ bots: 'scrapper', wins: 3, arena: 'rotation', fighters: 4 }, 7, 'brawl')).toEqual({
      mode: 'brawl',
      arena: 'rotation',
      fighters: 4,
      winsNeeded: 3,
      botLevel: BotLevel.Scrapper,
      seed: 7,
    });
    expect(configOf({ bots: 'menace', arena: 'pond', fighters: 3 }, 7, 'quickfire')).toEqual({
      mode: 'quickfire',
      arena: 'pond',
      fighters: 3,
      winsNeeded: 3,
      botLevel: BotLevel.Menace,
      seed: 7,
    });
  });
});

describe('Bellwick lobby cfg', () => {
  it('continues {slot: n} and starts a new tale in slot k for {slot: "new", into: k}', () => {
    expect(bellwickCfgSchema.parse({ slot: 1, into: 0 })).toEqual({ tale: 'slot', slot: 1 });
    expect(bellwickCfgSchema.parse({ slot: 'new', into: 2 })).toEqual({ tale: 'new', slot: 2 });
    expect(bellwickCfgSchema.parse({ slot: 'new', into: 0 })).toEqual({ tale: 'new', slot: 0 });
  });
});
