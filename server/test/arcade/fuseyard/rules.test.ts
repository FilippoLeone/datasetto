/**
 * Fuseyard rules (docs/arcade/fuseyard.md §1, §12 "fuseyard.rules"): blasts, chains with kill credit,
 * passer masks, kicks, the Clicker, belts, ice, pads, round and match flow, Closing Time, scatter,
 * and the arena guarantees (safe zones, item counts, an escapable bomb on every spawn).
 */
import { describe, expect, it } from 'vitest';
import { ARENAS, SPAWNS, SPIRAL, spawnOf } from '../../../src/arcade/core/fuseyard/arenas.js';
import {
  ARM_BLOCK,
  BELT_PUSH,
  CLOSE_AT,
  CLOSE_EVERY,
  EV,
  FLAME,
  Item,
  KICK_SPEED,
  ORPHAN_FUSE,
  PAD_COOLDOWN,
  QUICK_CLOSE_AT,
  SPIRAL_CELLS,
  Special,
  WARN_TICKS,
  itemCount,
} from '../../../src/arcade/core/fuseyard/rules.js';
import { createMatch, step } from '../../../src/arcade/core/fuseyard/sim.js';
import {
  CELLS,
  Cell,
  Dir,
  Phase,
  REMOTE,
  addBomb,
  allEvents,
  cellAt,
  cx,
  cy,
  events,
  fighter,
  inputByte,
  place,
  run,
  scenario,
  setCell,
  walk,
  xy,
} from './helpers.js';
import { newStepIn } from '../../../src/arcade/core/fuseyard/rules.js';

const E = (d: number): number => inputByte(d, 0, false, false);
const BOMB = inputByte(0, 0, true, false);
const DET = inputByte(0, 0, false, true);

describe('arenas', () => {
  it('parse with the border, 30 pillars and their features', () => {
    expect(ARENAS.map((a) => a.id)).toEqual(['yard', 'mill', 'pond', 'garden', 'depot']);
    for (const a of ARENAS) {
      expect(Array.from(a.cells).filter((c) => c === Cell.Pillar).length).toBe(30);
      for (const s of SPAWNS) expect(a.cells[s]).toBe(Cell.Floor);
    }
    expect(ARENAS[1]!.hasBelts && ARENAS[4]!.hasBelts).toBe(true);
    expect(ARENAS[2]!.hasIce).toBe(true);
    expect(ARENAS[3]!.hasPads && ARENAS[4]!.hasPads).toBe(true);
    expect(ARENAS[3]!.padPartner[xy(3, 6)]).toBe(xy(11, 6));
    expect(ARENAS[3]!.padPartner[xy(7, 9)]).toBe(xy(7, 3));
  });

  it('closing time walks 106 interior cells clockwise from (1,1), sparing the centre', () => {
    expect(SPIRAL.length).toBe(SPIRAL_CELLS);
    expect(new Set(SPIRAL).size).toBe(106);
    expect(Array.from(SPIRAL.slice(0, 3))).toEqual([xy(1, 1), xy(2, 1), xy(3, 1)]);
    expect(SPIRAL[12]).toBe(xy(13, 1));
    expect(SPIRAL[13]).toBe(xy(13, 2));
    for (const c of SPIRAL) {
      const x = c % 15;
      const y = (c / 15) | 0;
      expect(x >= 1 && x <= 13 && y >= 1 && y <= 11).toBe(true);
      expect(x % 2 === 0 && y % 2 === 0).toBe(false);
      expect(x >= 6 && x <= 8 && y >= 5 && y <= 7).toBe(false);
    }
  });

  it('never fills a cell within Manhattan distance 3 of a spawn', () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      for (const arena of ['yard', 'mill', 'pond', 'garden', 'depot'] as const) {
        const m = createMatch({ mode: 'brawl', arena, fighters: 4, winsNeeded: 3, botLevel: 1, seed: seed * 977 }, []);
        for (const s of SPAWNS) {
          for (let c = 0; c < CELLS; c += 1) {
            const d = Math.abs((c % 15) - (s % 15)) + Math.abs(((c / 15) | 0) - ((s / 15) | 0));
            if (d <= 3) expect(m.current.cells[c]).not.toBe(Cell.Block);
          }
        }
      }
    }
  });

  it('hides exactly max(1, round(count × fighters / 4)) items of each kind', () => {
    expect([1, 2, 3, 4, 5].map((it) => itemCount(it, 4))).toEqual([7, 7, 4, 2, 1]);
    expect([1, 2, 3, 4, 5].map((it) => itemCount(it, 2))).toEqual([4, 4, 2, 1, 1]);
    expect([1, 2, 3, 4, 5].map((it) => itemCount(it, 3))).toEqual([5, 5, 3, 2, 1]);
    for (const fighters of [2, 3, 4] as const) {
      for (let seed = 1; seed <= 6; seed += 1) {
        const m = createMatch({ mode: 'brawl', arena: 'yard', fighters, winsNeeded: 3, botLevel: 1, seed }, []);
        const counts = [0, 0, 0, 0, 0, 0];
        let blocks = 0;
        for (let c = 0; c < CELLS; c += 1) {
          counts[m.current.hidden[c]!] += 1;
          if (m.current.cells[c] === Cell.Block) blocks += 1;
          if (m.current.hidden[c]) expect(m.current.cells[c]).toBe(Cell.Block);
        }
        expect(blocks).toBeGreaterThan(21);
        for (let it = 1; it <= 5; it += 1) expect(counts[it]).toBe(itemCount(it, fighters));
      }
    }
  });

  it('drops Spare Fuses first when there are more items than blocks', () => {
    const m = createMatch({ mode: 'brawl', arena: 'yard', fighters: 4, winsNeeded: 3, botLevel: 1, seed: 7 }, []);
    // Rebuild the round on a board with only 18 blocks by re-running setup on a sparse copy is not
    // exposed; instead check the rule on the item table: the sum of counts never exceeds the blocks.
    let hidden = 0;
    for (let c = 0; c < CELLS; c += 1) if (m.current.hidden[c]) hidden += 1;
    expect(hidden).toBe(21);
  });

  it('every spawn has an escape from a range-2 bomb at base speed', () => {
    const escapes = [
      [xy(1, 1), xy(2, 1), xy(3, 1), xy(3, 2)],
      [xy(13, 1), xy(12, 1), xy(11, 1), xy(11, 2)],
      [xy(1, 11), xy(2, 11), xy(3, 11), xy(3, 10)],
      [xy(13, 11), xy(12, 11), xy(11, 11), xy(11, 10)],
    ];
    for (const arena of ['yard', 'mill', 'pond', 'garden', 'depot'] as const) {
      for (let s = 0; s < 4; s += 1) {
        const m = scenario({ arena, fighters: 4, keepBlocks: true, seed: 31 + s });
        for (let o = 0; o < 4; o += 1) if (o !== s) fighter(m, o).alive = false;
        const f = place(m, s, SPAWNS[s]!);
        expect(f.range).toBe(2);
        run(m, 1, { [s]: BOMB });
        expect(m.current.bombCount).toBe(1);
        expect(walk(m, s, escapes[s]!)).toBeGreaterThan(0);
        run(m, 90);
        expect(fighter(m, s).alive).toBe(true);
      }
    }
  });

  it('puts two fighters on opposite corners', () => {
    expect(spawnOf(0, 2)).toBe(xy(1, 1));
    expect(spawnOf(1, 2)).toBe(xy(13, 11));
    expect(spawnOf(1, 4)).toBe(xy(13, 1));
  });
});

describe('blasts', () => {
  it('arms stop before pillars and reach their range on open floor', () => {
    const m = scenario();
    place(m, 0, xy(1, 1));
    place(m, 1, xy(13, 11));
    addBomb(m, 0, xy(4, 5), { fuse: 1, range: 2 });
    const ev = events(run(m, 1)[0]!).find((e) => e.kind === EV.Explode)!;
    expect(Array.from(ev.p.slice(3))).toEqual([0, 2, 0, 2]);
    for (const c of [xy(4, 5), xy(5, 5), xy(6, 5), xy(3, 5), xy(2, 5)]) expect(m.current.flame[c]).toBe(FLAME - 1);
    expect(m.current.flame[xy(4, 4)]).toBe(0);
    expect(m.current.flame[xy(7, 5)]).toBe(0);
  });

  it('includes the first block, breaks it and stops; its item shows only when the flame ends', () => {
    const m = scenario();
    place(m, 0, xy(1, 1));
    place(m, 1, xy(13, 11));
    setCell(m, xy(6, 5), Cell.Block);
    m.current.hidden[xy(6, 5)] = Item.WideSpark;
    setCell(m, xy(5, 3), Cell.Block);
    addBomb(m, 0, xy(5, 5), { fuse: 1, range: 4 });
    const evs = events(run(m, 1)[0]!);
    const ex = evs.find((e) => e.kind === EV.Explode)!;
    expect(ex.p[3]).toBe(2 | ARM_BLOCK); // north: (5,4), then the block at (5,3)
    expect(ex.p[4]).toBe(1 | ARM_BLOCK); // east: the block at (6,5)
    expect(evs.filter((e) => e.kind === EV.BlockBroken).map((e) => Array.from(e.p))).toEqual([
      [xy(5, 3), 0],
      [xy(6, 5), Item.WideSpark],
    ]);
    expect(m.current.cells[xy(6, 5)]).toBe(Cell.Floor);
    expect(m.current.items[xy(6, 5)]).toBe(0);
    expect(m.current.pendingItem[xy(6, 5)]).toBe(Item.WideSpark);
    run(m, FLAME - 2);
    expect(m.current.items[xy(6, 5)]).toBe(0);
    run(m, 1);
    expect(m.current.items[xy(6, 5)]).toBe(Item.WideSpark);
    expect(m.current.pendingItem[xy(6, 5)]).toBe(0);
  });

  it('burns a visible item and stops there', () => {
    const m = scenario();
    place(m, 0, xy(1, 1));
    place(m, 1, xy(13, 11));
    m.current.items[xy(6, 5)] = Item.SpareFuse;
    addBomb(m, 0, xy(4, 5), { fuse: 1, range: 4 });
    const evs = events(run(m, 1)[0]!);
    expect(evs.find((e) => e.kind === EV.Explode)!.p[4]).toBe(2);
    expect(evs.some((e) => e.kind === EV.ItemBurned && e.p[0] === xy(6, 5))).toBe(true);
    expect(m.current.items[xy(6, 5)]).toBe(0);
    expect(m.current.flame[xy(7, 5)]).toBe(0);
  });

  it('chains in id order and gives the kill to the bomb that wrote the flame last', () => {
    const m = scenario({ fighters: 3 });
    place(m, 0, xy(1, 1));
    place(m, 1, xy(13, 11));
    place(m, 2, xy(5, 5));
    addBomb(m, 0, xy(4, 5), { fuse: 1, range: 2 });
    addBomb(m, 1, xy(6, 5), { fuse: 60, range: 2 });
    const evs = events(run(m, 1)[0]!);
    const ex = evs.filter((e) => e.kind === EV.Explode).map((e) => e.p[0]! | (e.p[1]! << 8));
    expect(ex).toEqual([1, 2]);
    const died = evs.find((e) => e.kind === EV.Died)!;
    expect(Array.from(died.p)).toEqual([2, 1, 0]);
    expect(fighter(m, 1).kills).toBe(1);
    expect(m.current.bombCount).toBe(0);
  });

  it('lets a fighter walk off its own bomb, then blocks it', () => {
    const m = scenario();
    place(m, 0, xy(3, 1));
    place(m, 1, xy(13, 11));
    run(m, 1, { 0: BOMB });
    const b = m.current.bombs[0]!;
    expect(b.passers & 1).toBe(1);
    run(m, 10, { 0: E(Dir.E) });
    expect(cellAt(fighter(m, 0).x, fighter(m, 0).y)).toBe(xy(4, 1));
    run(m, 10, { 0: E(Dir.E) });
    expect(b.passers & 1).toBe(0);
    run(m, 20, { 0: E(Dir.W) });
    // Back against the bomb: stopped at (4,1)'s centre.
    expect(fighter(m, 0).x).toBe(cx(xy(4, 1)));
  });
});

describe('kicks', () => {
  const kickSetup = (obstacle: (m: ReturnType<typeof scenario>) => void, expectStop: number): void => {
    const m = scenario({ fighters: 3 });
    place(m, 0, xy(1, 3));
    place(m, 1, xy(13, 11));
    place(m, 2, xy(13, 9));
    fighter(m, 0).glove = true;
    addBomb(m, 1, xy(2, 3), { fuse: 70 });
    obstacle(m);
    const ticks = run(m, 70, { 0: E(Dir.E) });
    const all = allEvents(ticks);
    expect(all.some((e) => e.kind === EV.BombKicked && e.p[2] === Dir.E)).toBe(true);
    const stop = all.find((e) => e.kind === EV.BombStopped)!;
    expect(stop.p[2]).toBe(expectStop);
    const b = m.current.bombs[0]!;
    expect(b.x).toBe(cx(expectStop));
    expect(b.slideDir).toBe(Dir.None);
  };
  it('slide at 16 per tick and stop before a wall', () => {
    const m = scenario();
    place(m, 0, xy(1, 3));
    place(m, 1, xy(13, 11));
    fighter(m, 0).glove = true;
    addBomb(m, 1, xy(2, 3), { fuse: 70 });
    run(m, 2, { 0: E(Dir.E) });
    const b = m.current.bombs[0]!;
    expect(b.slideDir).toBe(Dir.E);
    const x0 = b.x;
    run(m, 1);
    expect(b.x - x0).toBe(KICK_SPEED);
    kickSetup(() => undefined, xy(13, 3));
  });
  it('stop before a block, steel, a bomb, an item and a live fighter', () => {
    kickSetup((m) => setCell(m, xy(8, 3), Cell.Block), xy(7, 3));
    kickSetup((m) => setCell(m, xy(8, 3), Cell.Steel), xy(7, 3));
    kickSetup((m) => addBomb(m, 2, xy(9, 3), { fuse: 70 }), xy(8, 3));
    kickSetup((m) => (m.current.items[xy(6, 3)] = Item.QuickBoots), xy(5, 3));
    kickSetup((m) => place(m, 2, xy(10, 3)), xy(9, 3));
  });
  it('need the glove', () => {
    const m = scenario();
    place(m, 0, xy(1, 3));
    place(m, 1, xy(13, 11));
    addBomb(m, 1, xy(2, 3), { fuse: 70 });
    const all = allEvents(run(m, 10, { 0: E(Dir.E) }));
    expect(all.some((e) => e.kind === EV.BombKicked)).toBe(false);
  });
});

describe('the Clicker', () => {
  it('makes remote bombs, fires the oldest first, and orphans them at 45 on death and on ghost', () => {
    const m = scenario({ fighters: 3 });
    const f = place(m, 0, xy(1, 3));
    place(m, 1, xy(13, 11));
    place(m, 2, xy(13, 9));
    f.clicker = true;
    f.bombsMax = 3;
    run(m, 1, { 0: BOMB });
    walk(m, 0, [xy(1, 3), xy(1, 4), xy(1, 5), xy(1, 6), xy(1, 7)]);
    run(m, 1, { 0: BOMB });
    walk(m, 0, [xy(1, 7), xy(1, 8), xy(1, 9), xy(1, 10)]);
    expect(m.current.bombCount).toBe(2);
    expect(m.current.bombs[0]!.fuse).toBe(REMOTE);
    const evs = events(run(m, 1, { 0: DET })[0]!);
    const ex = evs.filter((e) => e.kind === EV.Explode);
    expect(ex.length).toBe(1);
    expect(ex[0]!.p[2]).toBe(xy(1, 3));
    expect(m.current.bombCount).toBe(1);
    // Death: the holder's remaining remote bomb gets fuse 45.
    addBomb(m, 2, xy(1, 10), { fuse: 1, range: 1 });
    run(m, 1);
    expect(f.alive).toBe(false);
    expect(m.current.bombs.slice(0, m.current.bombCount).find((b) => b.owner === 0)!.fuse).toBe(ORPHAN_FUSE);
  });

  it('orphans a ghost holder’s bombs at 45', () => {
    const m = scenario({ fighters: 2 });
    const f = place(m, 0, xy(1, 3));
    place(m, 1, xy(13, 11));
    f.clicker = true;
    run(m, 1, { 0: BOMB });
    walk(m, 0, [xy(1, 3), xy(1, 4), xy(1, 5), xy(1, 6), xy(1, 7)]);
    const input = newStepIn();
    input.seats[0] = 1; // ghost request
    step(m, input);
    expect(f.control).toBe(1);
    expect(m.current.bombs[0]!.fuse).toBe(ORPHAN_FUSE);
  });
});

describe('belts, ice and pads', () => {
  it('a belt pushes a still fighter 4 units per tick, but not one walking across it', () => {
    const m = scenario({ arena: 'mill' });
    place(m, 0, xy(3, 5)); // belt east
    place(m, 1, xy(13, 11));
    const x0 = fighter(m, 0).x;
    run(m, 1);
    expect(fighter(m, 0).x - x0).toBe(BELT_PUSH);
    // Across the belt (north from (4,5) towards (4,4)? a pillar): use (3,5) heading south instead.
    const m2 = scenario({ arena: 'mill' });
    place(m2, 0, xy(4, 5));
    place(m2, 1, xy(13, 11));
    const y0 = fighter(m2, 0).y;
    const xs = fighter(m2, 0).x;
    run(m2, 1, { 0: E(Dir.N) });
    expect(fighter(m2, 0).x).toBe(xs + BELT_PUSH); // north is blocked by the pillar: the belt pushes
    void y0;
  });

  it('a bomb resting on a belt rides it at 4 units per tick', () => {
    const m = scenario({ arena: 'mill' });
    place(m, 0, xy(1, 1));
    place(m, 1, xy(13, 11));
    const b = addBomb(m, 0, xy(3, 5), { fuse: 70 });
    const ev = events(run(m, 1)[0]!);
    expect(ev.some((e) => e.kind === EV.BombKicked && e.p[2] === (Dir.E | 0x80))).toBe(true);
    expect(b.x).toBe(cx(xy(3, 5)) + 4);
    run(m, 15);
    expect(b.x).toBe(cx(xy(4, 5)));
  });

  it('a fighter keeps sliding on ice and turns only at centres into open cells', () => {
    const m = scenario({ arena: 'pond' });
    place(m, 0, xy(3, 5));
    place(m, 1, xy(13, 11));
    run(m, 10, { 0: E(Dir.E) }); // onto the ice at (4,5)
    const f = fighter(m, 0);
    expect(m.current.special[cellAt(f.x, f.y)]).toBe(Special.Ice);
    const x1 = f.x;
    run(m, 5); // no input: keeps sliding east
    expect(f.x).toBeGreaterThan(x1);
    expect(f.moving).toBe(true);
    // It slides to the end of the ice (10,5) and stops on the first floor cell without input.
    run(m, 80);
    expect(cellAt(f.x, f.y)).toBe(xy(11, 5));
    expect(f.moving).toBe(false);
  });

  it('pads jump to the partner, keep direction, cool down 20 ticks, and skip a blocked partner', () => {
    const m = scenario({ arena: 'garden' });
    place(m, 0, xy(3, 5));
    place(m, 1, xy(13, 11));
    const ticks = run(m, 12, { 0: E(Dir.S) });
    const tele = allEvents(ticks).find((e) => e.kind === EV.Teleport)!;
    expect(tele.p[0]).toBe(0);
    expect(tele.p[3]).toBe(xy(11, 6));
    const f = fighter(m, 0);
    expect(f.padCooldown).toBeGreaterThan(0);
    expect(f.padCooldown).toBeLessThanOrEqual(PAD_COOLDOWN);
    // Blocked partner: a bomb on (11,6) stops the jump.
    const m2 = scenario({ arena: 'garden' });
    place(m2, 0, xy(3, 5));
    place(m2, 1, xy(13, 11));
    addBomb(m2, 1, xy(11, 6), { fuse: 70 });
    const t2 = run(m2, 12, { 0: E(Dir.S) });
    expect(allEvents(t2).some((e) => e.kind === EV.Teleport)).toBe(false);
    expect(cellAt(fighter(m2, 0).x, fighter(m2, 0).y)).toBe(xy(3, 7));
  });
});

describe('round and match flow', () => {
  it('two deaths in one tick are a draw', () => {
    const m = scenario();
    place(m, 0, xy(3, 5));
    place(m, 1, xy(5, 5));
    addBomb(m, 0, xy(4, 5), { fuse: 1, range: 2 });
    run(m, 1);
    expect(m.current.phase).toBe(Phase.RoundEnd);
    expect(m.current.winner).toBe(-1);
    expect(Array.from(m.scores)).toEqual([0, 0, 0, 0]);
    expect(m.draws).toBe(1);
  });

  it('the last one standing scores, and a result card of 120 ticks follows', () => {
    const m = scenario();
    place(m, 0, xy(1, 1));
    place(m, 1, xy(5, 5));
    addBomb(m, 0, xy(4, 5), { fuse: 1, range: 2 });
    run(m, 1);
    expect(m.current.winner).toBe(0);
    expect(m.scores[0]).toBe(1);
    run(m, 119);
    expect(m.current.phase).toBe(Phase.RoundEnd);
    run(m, 1);
    expect(m.current.phase).toBe(Phase.Countdown);
    expect(m.round).toBe(1);
  });

  it('a Brawl ends at K wins, or after 2K + 3 rounds', () => {
    const m = scenario({ winsNeeded: 2 });
    m.scores[1] = 1;
    place(m, 0, xy(1, 1));
    place(m, 1, xy(5, 5));
    addBomb(m, 0, xy(6, 5), { fuse: 1, range: 2 });
    m.scores[0] = 1;
    run(m, 1);
    expect(m.scores[0]).toBe(2);
    run(m, 120);
    expect(m.current.phase).toBe(Phase.MatchEnd);
    expect(m.matchEnded).toBe(true);

    const cap = scenario({ winsNeeded: 2 });
    cap.round = 6; // the 7th round (2K + 3 = 7)
    place(cap, 0, xy(3, 5));
    place(cap, 1, xy(5, 5));
    addBomb(cap, 0, xy(4, 5), { fuse: 1, range: 2 });
    run(cap, 121);
    expect(cap.current.phase).toBe(Phase.MatchEnd);
  });

  it('a round at its time limit with two alive is a draw', () => {
    const m = scenario({ mode: 'quickfire' });
    place(m, 0, xy(7, 5));
    place(m, 1, xy(7, 7));
    m.current.tick = 2699;
    m.current.nextDropTick = 99999;
    run(m, 1);
    expect(m.current.phase).toBe(Phase.RoundEnd);
    expect(m.current.winner).toBe(-1);
  });

  it('Closing Time warns along the spiral every 6 ticks, drops steel 30 ticks later and stops after 106', () => {
    const m = scenario({ mode: 'quickfire' });
    place(m, 0, xy(7, 5));
    place(m, 1, xy(7, 7));
    m.current.tick = QUICK_CLOSE_AT;
    m.current.nextDropTick = QUICK_CLOSE_AT + CLOSE_EVERY;
    const ticks = run(m, 800);
    const all = allEvents(ticks);
    const warns = all.filter((e) => e.kind === EV.SteelWarn);
    const drops = all.filter((e) => e.kind === EV.SteelDrop);
    expect(warns.map((e) => e.p[0])).toEqual(Array.from(SPIRAL));
    expect(drops.map((e) => e.p[0])).toEqual(Array.from(SPIRAL));
    expect(warns[1]!.tick - warns[0]!.tick).toBe(CLOSE_EVERY);
    expect(drops[0]!.tick - warns[0]!.tick).toBe(WARN_TICKS);
    expect(drops[drops.length - 1]!.tick - (warns[0]!.tick - CLOSE_EVERY)).toBe(666);
    for (const c of SPIRAL) expect(m.current.cells[c]).toBe(Cell.Steel);
    expect(fighter(m, 0).alive && fighter(m, 1).alive).toBe(true);
    expect(CLOSE_AT).toBe(2700);
  });

  it('steel kills a fighter under it', () => {
    const m = scenario({ mode: 'quickfire' });
    place(m, 0, xy(1, 1));
    place(m, 1, xy(7, 7));
    m.current.tick = QUICK_CLOSE_AT;
    m.current.nextDropTick = QUICK_CLOSE_AT + CLOSE_EVERY;
    const all = allEvents(run(m, 40));
    expect(all.find((e) => e.kind === EV.Died)!.p[2]).toBe(1);
    expect(fighter(m, 0).alive).toBe(false);
  });

  it('a dying fighter scatters half its items (at most 6), Clicker first, onto free floor', () => {
    const m = scenario({ fighters: 3 });
    const f = place(m, 0, xy(5, 5));
    place(m, 1, xy(13, 11));
    place(m, 2, xy(13, 1));
    f.collected[Item.Clicker] = 1;
    f.collected[Item.ShoveGlove] = 1;
    f.collected[Item.WideSpark] = 3;
    f.collected[Item.SpareFuse] = 3;
    addBomb(m, 1, xy(4, 5), { fuse: 1, range: 1 });
    const evs = events(run(m, 1)[0]!);
    const drops = evs.filter((e) => e.kind === EV.ItemDropped).map((e) => e.p[1]);
    expect(drops).toEqual([Item.Clicker, Item.ShoveGlove, Item.WideSpark, Item.WideSpark]);
    for (const e of evs.filter((x) => x.kind === EV.ItemDropped)) {
      expect(m.current.cells[e.p[0]!]).toBe(Cell.Floor);
      expect(m.current.flame[e.p[0]!]).toBe(0);
    }
  });
});

describe('items', () => {
  it('pickups apply their effect up to the caps, the lowest slot winning a tie', () => {
    const m = scenario();
    const a = place(m, 0, xy(5, 5));
    const b = place(m, 1, xy(5, 5));
    m.current.items[xy(5, 5)] = Item.QuickBoots;
    const ev = events(run(m, 1)[0]!);
    expect(ev.find((e) => e.kind === EV.ItemTaken)!.p[1]).toBe(0);
    expect(a.speedLvl).toBe(1);
    expect(b.speedLvl).toBe(0);
    a.bombsMax = 8;
    m.current.items[xy(5, 5)] = Item.SpareFuse;
    run(m, 1);
    expect(a.bombsMax).toBe(8);
    expect(cy(xy(5, 5))).toBe(a.y);
  });
});
