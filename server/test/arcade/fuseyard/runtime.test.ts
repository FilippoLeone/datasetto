/**
 * Fuseyard's CoreMatch runtime (docs/arcade/fuseyard.md §3.5, §5): the per-slot input queue, ackUp,
 * seat commands and the host events, results, the offline rematch, and the canonical dump with
 * restore and the replay ring.
 */
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PHASE } from '../../../src/arcade/core/net/lane.js';
import type { HostEvent } from '../../../src/arcade/core/net/match.js';
import { encodeUp } from '../../../src/arcade/core/fuseyard/codec.js';
import { createReplayRing, dumpMatch, hashMatch, replayRun, restoreMatch } from '../../../src/arcade/core/fuseyard/replay.js';
import { CORE_EVENT, createFuseyardCore, type FuseyardCore } from '../../../src/arcade/core/fuseyard/runtime.js';
import { BotLevel, Control, Dir, IN_BOMB, Phase, inputByte, newStepIn, type MatchConfig } from '../../../src/arcade/core/fuseyard/rules.js';
import { createMatch, step, takeOverOffline } from '../../../src/arcade/core/fuseyard/sim.js';

const cfg = (o: Partial<MatchConfig> = {}): MatchConfig => ({ mode: 'brawl', arena: 'yard', fighters: 2, winsNeeded: 2, botLevel: BotLevel.Scrapper, seed: 77, ...o });

const core2 = (offline = false, o: Partial<MatchConfig> = {}): FuseyardCore =>
  createFuseyardCore({ config: cfg(o), seats: [{ slot: 0, human: true, botLevel: 1 }, { slot: 1, human: true, botLevel: 1 }], offline });

/** Steps until the countdown is over. */
const toPlay = (c: FuseyardCore): void => {
  for (let i = 0; i < 100 && c.match.current.phase !== Phase.Playing; i += 1) c.step();
};

const up = (c: FuseyardCore, slot: number, seq: number, inputs: number[]): void => c.onUp(slot, encodeUp(new Uint8Array(inputs), inputs.length), seq);

describe('the input queue', () => {
  it('pops one input per tick and acks the newest applied seq; duplicates are dropped', () => {
    const c = core2();
    toPlay(c);
    const f = c.match.current.fighters[0]!;
    const x0 = f.x;
    const E = inputByte(Dir.E, 0, false, false);
    up(c, 0, 2, [E, E]);
    up(c, 0, 2, [E, E]); // duplicate
    c.step();
    expect(c.ackUp(0)).toBe(1);
    c.step();
    expect(c.ackUp(0)).toBe(2);
    expect(f.x - x0).toBe(16);
    // Empty: the last direction repeats for 6 ticks (no press), ackUp unchanged, then it stops.
    for (let i = 0; i < 10; i += 1) c.step();
    expect(c.ackUp(0)).toBe(2);
    expect(f.x - x0).toBe(16 + 6 * 8);
  });

  it('trims a backlog above 4 to 2, keeping the dropped presses', () => {
    const c = core2();
    toPlay(c);
    const f = c.match.current.fighters[0]!;
    const BOMB = inputByte(0, 0, true, false);
    up(c, 0, 6, [BOMB, 0, 0, 0, 0, 0]);
    c.step();
    // The press survived the trim and the next two inputs are the newest.
    expect(c.match.current.bombCount).toBe(1);
    expect(c.ackUp(0)).toBe(5);
    c.step();
    expect(c.ackUp(0)).toBe(6);
    expect(f.bombsOut).toBe(1);
  });

  it('drops malformed UPs, UPs for bots, and UPs from a ghost (the ring is cleared)', () => {
    const c = core2();
    toPlay(c);
    c.onUp(0, new Uint8Array([3, 1]), 5);
    c.onUp(0, new Uint8Array([0]), 5);
    up(c, 1, 9, [inputByte(0, 0, true, false)]);
    c.setSeat(1, 'ghost');
    c.step();
    expect(c.match.current.fighters[1]!.control).toBe(Control.Ghost);
    up(c, 1, 10, [inputByte(0, 0, true, false)]);
    c.step();
    expect(c.match.current.bombCount).toBe(0);
    expect(c.ackUp(0)).toBe(0);
  });
});

describe('host events', () => {
  it('PHASE 2 first, seat changes as they apply, keyframe requests at a round start', () => {
    const c = core2();
    c.step();
    const first = c.takeHostEvents();
    expect(first[0]).toEqual({ t: 'phase', phase: PHASE.running, reason: 0, body: new Uint8Array(0) });
    toPlay(c);
    c.takeHostEvents();
    c.setSeat(0, 'ghost');
    c.step();
    expect(c.takeHostEvents()).toEqual([{ t: 'seat', slot: 0, state: 'ghost' }]);
    c.setSeat(0, 'live');
    c.step();
    expect(c.takeHostEvents()).toEqual([{ t: 'seat', slot: 0, state: 'live' }]);
    expect(c.takeHostEvents()).toEqual([]);
  });

  it('ends a match with PHASE 4 (16 B results) and `end`, offline waits for a rematch instead', () => {
    for (const offline of [false, true]) {
      const c = core2(offline, { mode: 'quickfire' });
      toPlay(c);
      c.takeHostEvents();
      const r = c.match.current;
      // Slot 1 dies: slot 0 wins the only round.
      r.fighters[1]!.alive = false;
      const events: HostEvent[] = [];
      for (let i = 0; i < 200; i += 1) {
        c.step();
        events.push(...c.takeHostEvents());
      }
      const phase = events.find((e) => e.t === 'phase');
      expect(phase && phase.t === 'phase' && phase.phase).toBe(PHASE.ending);
      expect(phase && phase.t === 'phase' && phase.body.length).toBe(16);
      const end = events.find((e) => e.t === 'end');
      expect(Boolean(end)).toBe(!offline);
      expect(c.idle).toBe(true);
      expect(c.result()?.players.map((p) => [p.slot, p.place])).toEqual([[0, 1], [1, 2]]);
      if (offline) {
        c.onEvent(0, new Uint8Array([CORE_EVENT.rematch, 9, 9, 9, 9]));
        const again = c.takeHostEvents();
        expect(again.some((e) => e.t === 'rekey' && e.slot === 0)).toBe(true);
        expect(c.idle).toBe(false);
        expect(c.match.config.seed).toBe(0x09090909);
        expect(c.match.current.phase).toBe(Phase.Countdown);
      }
    }
  });

  it('ends after 120 s without human input while a live human plays', () => {
    const c = core2();
    toPlay(c);
    let end: HostEvent | undefined;
    // Closing Time ends the first round on the way; the clock only runs during play.
    for (let i = 0; i < 4600 && !end; i += 1) {
      c.step();
      end = c.takeHostEvents().find((e) => e.t === 'end');
    }
    expect(end).toEqual({ t: 'end', reason: 'idle', result: null });
  });

  it('sets dodge grace from the RTT at round start (bots get none)', () => {
    const c = core2();
    c.setRtt(0, 200);
    c.setRtt(1, 10);
    const r = c.match.current;
    r.fighters[1]!.alive = false;
    for (let i = 0; i < 400 && c.match.round === 0; i += 1) c.step();
    expect(c.match.round).toBe(1);
    expect(r.fighters[0]!.dodgeGrace).toBe(3);
    expect(r.fighters[1]!.dodgeGrace).toBe(0);
  });
});

describe('dump, restore and replay', () => {
  it('restores a match that steps on identically, and the HANDOVER deflates to about 1 KB', () => {
    const m = createMatch(cfg({ fighters: 4 }), []);
    const input = newStepIn();
    for (let i = 0; i < 900; i += 1) step(m, input);
    const dump = dumpMatch(m);
    expect(dump.length).toBeGreaterThan(1800);
    expect(dump.length).toBeLessThan(3000);
    expect(deflateRawSync(dump).length).toBeLessThan(1400);
    const copy = restoreMatch(dump)!;
    expect(hashMatch(copy)).toBe(hashMatch(m));
    for (let i = 0; i < 600; i += 1) {
      step(m, input);
      step(copy, input);
    }
    expect(hashMatch(copy)).toBe(hashMatch(m));
    expect(restoreMatch(dump.subarray(0, 100))).toBeNull();
  });

  it('the replay ring reproduces the match from its older dump, under 8 KB deflated', () => {
    const m = createMatch(cfg({ fighters: 4, mode: 'brawl', arena: 'rotation' }), [{ slot: 0, human: true, botLevel: 1 }]);
    const ring = createReplayRing();
    const input = newStepIn();
    const hashes = new Map<number, number>();
    for (let t = 0; t < 2500; t += 1) {
      input.inputs[0] = t % 40 < 20 ? inputByte(Dir.E, 0, t % 50 === 0, false) : inputByte(Dir.S, 0, false, false);
      input.grace[0] = t > 1200 ? 2 : 1;
      input.seats.fill(0xff);
      if (t === 1500) input.seats[0] = 1;
      if (t === 1700) input.seats[0] = 0;
      ring.record(m, input);
      step(m, input);
      hashes.set(m.tick, hashMatch(m));
    }
    const bytes = ring.bytes();
    expect(deflateRawSync(bytes).length).toBeLessThan(8192);
    const replayed = replayRun(bytes, step, (rm) => expect(hashMatch(rm)).toBe(hashes.get(rm.tick)))!;
    expect(replayed.tick).toBe(m.tick);
    expect(hashMatch(replayed)).toBe(hashMatch(m));
    expect(IN_BOMB).toBe(0x40);
  });
});

describe('continuing a HANDOVER offline', () => {
  it('keeps the player, turns the other humans and ghosts into bots at the match level, and plays on', () => {
    // Online: slots 0–2 human, 3 a bot; slot 0 is a ghost when the server restarts.
    const online = createFuseyardCore({
      config: cfg({ fighters: 4, botLevel: BotLevel.Menace }),
      seats: [0, 1, 2].map((slot) => ({ slot, human: true, botLevel: 1 })).concat([{ slot: 3, human: false, botLevel: BotLevel.Sprout }]),
      offline: false,
    });
    toPlay(online);
    online.setSeat(0, 'ghost');
    online.setSeat(2, 'ghost');
    for (let i = 0; i < 60; i += 1) online.step();
    expect(online.match.current.fighters[0]!.control).toBe(Control.Ghost);
    const m = restoreMatch(online.dump())!;
    expect(m.current.phase).toBe(Phase.Playing);

    takeOverOffline(m, 0);
    const f = m.current.fighters;
    expect(f[0]!.control).toBe(Control.Human);
    expect(f[0]!.shield).toBeGreaterThan(0);
    expect([f[1]!.control, f[2]!.control, f[3]!.control]).toEqual([Control.Bot, Control.Bot, Control.Bot]);
    expect([f[1]!.botLevel, f[2]!.botLevel, f[3]!.botLevel]).toEqual([BotLevel.Menace, BotLevel.Menace, BotLevel.Sprout]);

    // The offline runtime plays it on, with no ghosts and no results.
    const local = createFuseyardCore({ config: m.config, seats: [], offline: true, match: m });
    const from = m.tick;
    const hosts: HostEvent[] = [];
    for (let i = 0; i < 900; i += 1) {
      up(local, 0, i + 1, [inputByte(i % 60 < 30 ? Dir.E : Dir.W, 0, false, false)]);
      local.step();
      hosts.push(...local.takeHostEvents());
    }
    expect(local.match.tick).toBe(from + 900);
    expect(local.match.current.fighters.some((x) => x.control === Control.Ghost)).toBe(false);
    expect(hosts.some((e) => e.t === 'end')).toBe(false);
  });
});
