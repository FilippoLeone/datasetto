/**
 * Away fighters (docs/arcade/fuseyard.md §1.7, §12 "fuseyard.ghosts"): the danger lock, immunity,
 * being moved by steel, passed by sliding bombs, no pickups, the return shield, and every row of the
 * round-end table including the 150-tick hold and the 30-tick resume.
 */
import { describe, expect, it } from 'vitest';
import { EV, GHOST_LOCK_MAX, HOLD_WIN, Item, QUICK_CLOSE_AT, CLOSE_EVERY, RESUME_COUNT, SHIELD, SeatCmd } from '../../../src/arcade/core/fuseyard/rules.js';
import { Cell, Control, Dir, Phase, addBomb, allEvents, cellAt, events, fighter, inputByte, place, run, scenario, seatStep, xy } from './helpers.js';

describe('the danger lock', () => {
  it('waits while the fighter stands in the footprint of a bomb with fuse ≤ 30, then ghosts after the blast', () => {
    const m = scenario({ fighters: 3 });
    place(m, 0, xy(3, 5));
    place(m, 1, xy(13, 11));
    place(m, 2, xy(13, 1));
    addBomb(m, 1, xy(5, 5), { fuse: 20, range: 2 });
    const f = fighter(m, 0);
    seatStep(m, { 0: SeatCmd.Ghost }, { 0: inputByte(Dir.W, 0, false, false) });
    expect(f.control).toBe(Control.Human);
    expect(f.ghostLock).toBe(1);
    // Inputs are ignored while locked: it stands still.
    const x0 = f.x;
    run(m, 5, { 0: inputByte(Dir.W, 0, false, false) });
    expect(f.x).toBe(x0);
    // The bomb goes off with the fighter still in it: hiding never dodges a blast already on its way.
    run(m, 20);
    expect(f.alive).toBe(false);
  });

  it('applies at once outside any danger, and at the latest after 45 ticks', () => {
    const m = scenario({ fighters: 3 });
    place(m, 0, xy(1, 1));
    place(m, 1, xy(13, 11));
    place(m, 2, xy(13, 1));
    seatStep(m, { 0: SeatCmd.Ghost });
    expect(fighter(m, 0).control).toBe(Control.Ghost);
    expect(Array.from(m.seatOut.subarray(0, 2))).toEqual([0, 1]);

    const m2 = scenario({ fighters: 3 });
    place(m2, 0, xy(3, 5));
    place(m2, 1, xy(13, 11));
    place(m2, 2, xy(13, 1));
    // A Clicker bomb never counts (it has no fuse), a long fuse does not either: use a flame that is
    // refreshed every tick so the cell stays dangerous.
    seatStep(m2, { 0: SeatCmd.Ghost });
    const f = fighter(m2, 0);
    f.shield = 9999;
    for (let t = 0; t < GHOST_LOCK_MAX + 2 && f.control !== Control.Ghost; t += 1) {
      m2.current.flame[xy(3, 5)] = 10;
      run(m2, 1);
    }
    expect(f.control).toBe(Control.Ghost);
  });
});

describe('a ghost', () => {
  const ghostAt = (cell: number) => {
    const m = scenario({ fighters: 3 });
    place(m, 0, cell);
    place(m, 1, xy(13, 11));
    place(m, 2, xy(13, 1));
    seatStep(m, { 0: SeatCmd.Ghost });
    expect(fighter(m, 0).control).toBe(Control.Ghost);
    return m;
  };

  it('is immune to flame and does not move', () => {
    const m = ghostAt(xy(5, 5));
    addBomb(m, 1, xy(4, 5), { fuse: 1, range: 2 });
    run(m, 20, { 0: inputByte(Dir.E, 0, true, false) });
    const f = fighter(m, 0);
    expect(f.alive).toBe(true);
    expect(f.x).toBe(((5 << 6) + 32));
    expect(m.current.bombCount).toBe(0);
  });

  it('is moved by steel to the nearest free floor', () => {
    const m = ghostAt(xy(1, 1));
    m.current.tick = QUICK_CLOSE_AT;
    m.current.nextDropTick = QUICK_CLOSE_AT + CLOSE_EVERY;
    m.config.mode = 'quickfire';
    const all = allEvents(run(m, 40));
    const tele = all.find((e) => e.kind === EV.Teleport)!;
    expect(tele.p[0]).toBe(2);
    expect(fighter(m, 0).alive).toBe(true);
    expect(m.current.cells[cellAt(fighter(m, 0).x, fighter(m, 0).y)]).toBe(Cell.Floor);
  });

  it('lets sliding bombs pass and picks nothing up', () => {
    const m = ghostAt(xy(6, 3));
    m.current.items[xy(6, 3)] = Item.SpareFuse;
    place(m, 1, xy(1, 3));
    fighter(m, 1).glove = true;
    addBomb(m, 2, xy(2, 3), { fuse: 70 });
    run(m, 60, { 1: inputByte(Dir.E, 0, false, false) });
    expect(m.current.items[xy(6, 3)]).toBe(Item.SpareFuse);
    // The item stops the bomb before (6,3); without the item the bomb would pass the ghost.
    const m2 = ghostAt(xy(6, 3));
    place(m2, 1, xy(1, 3));
    fighter(m2, 1).glove = true;
    addBomb(m2, 2, xy(2, 3), { fuse: 70 });
    const all = allEvents(run(m2, 60, { 1: inputByte(Dir.E, 0, false, false) }));
    expect(all.find((e) => e.kind === EV.BombStopped)!.p[2]).toBe(xy(13, 3));
  });

  it('comes back live with a 45-tick shield and passer bits', () => {
    const m = ghostAt(xy(5, 5));
    addBomb(m, 1, xy(5, 5), { fuse: 70, range: 2 });
    seatStep(m, { 0: SeatCmd.Return });
    const f = fighter(m, 0);
    expect(f.control).toBe(Control.Human);
    expect(f.shield).toBe(SHIELD);
    expect(m.current.bombs[0]!.passers & 1).toBe(1);
    m.current.bombs[0]!.fuse = 1;
    run(m, 1);
    expect(f.alive).toBe(true);
  });

  it('is replaced by a Scrapper bot with a shield when the grace runs out', () => {
    const m = ghostAt(xy(5, 5));
    seatStep(m, { 0: SeatCmd.BotTakeover });
    const f = fighter(m, 0);
    expect(f.control).toBe(Control.Bot);
    expect(f.botLevel).toBe(1);
    expect(f.shield).toBe(SHIELD);
  });
});

describe('round end with ghosts', () => {
  /** Three humans; slot 0 turns ghost, then slot 2 dies, leaving the given state. */
  const setup = (slot1Bot: boolean) => {
    const m = scenario({ fighters: 3, humans: slot1Bot ? [0, 2] : [0, 1, 2] });
    place(m, 0, xy(1, 1));
    place(m, 1, xy(13, 11));
    place(m, 2, xy(5, 5));
    if (slot1Bot) {
      // A bot that cannot go anywhere, so the test controls the board.
      m.current.cells[xy(12, 11)] = Cell.Steel;
      m.current.cells[xy(13, 10)] = Cell.Steel;
    }
    seatStep(m, { 0: SeatCmd.Ghost });
    addBomb(m, 2, xy(4, 5), { fuse: 1, range: 2 });
    run(m, 1);
    expect(fighter(m, 2).alive).toBe(false);
    return m;
  };

  it('G > 0, H = 1, B = 0: freezes and the human wins after 150 ticks', () => {
    const m = setup(false);
    expect(m.current.phase).toBe(Phase.Frozen);
    expect(m.current.holdWinner).toBe(1);
    // Nothing runs while frozen.
    const x = fighter(m, 1).x;
    run(m, HOLD_WIN - 1, { 1: inputByte(Dir.N, 0, false, false) });
    expect(fighter(m, 1).x).toBe(x);
    expect(m.current.phase).toBe(Phase.Frozen);
    run(m, 1);
    expect(m.current.phase).toBe(Phase.RoundEnd);
    expect(m.current.winner).toBe(1);
    expect(m.scores[1]).toBe(1);
  });

  it('a ghost returning ends the hold; the round resumes after a 30-tick countdown', () => {
    const m = setup(false);
    run(m, 40);
    seatStep(m, { 0: SeatCmd.Return });
    expect(m.current.phase).toBe(Phase.Resuming);
    run(m, RESUME_COUNT - 1);
    expect(m.current.phase).toBe(Phase.Resuming);
    run(m, 1);
    expect(m.current.phase).toBe(Phase.Playing);
  });

  it('G > 0 and H = 0: freezes with no hold, even with a bot alive, until the ghost returns or its grace ends', () => {
    const m = setup(true);
    expect(m.current.phase).toBe(Phase.Frozen);
    expect(m.current.holdWinner).toBe(-1);
    run(m, HOLD_WIN + 10);
    expect(m.current.phase).toBe(Phase.Frozen);
    seatStep(m, { 0: SeatCmd.BotTakeover });
    expect(m.current.phase).toBe(Phase.Resuming);
  });

  it('any other state plays on with the ghost as a statue', () => {
    const m = scenario({ fighters: 3 });
    place(m, 0, xy(1, 1));
    place(m, 1, xy(13, 11));
    place(m, 2, xy(13, 1));
    seatStep(m, { 0: SeatCmd.Ghost });
    run(m, 30);
    expect(m.current.phase).toBe(Phase.Playing);
    const ev = events(seatStep(m, {}));
    expect(ev.some((e) => e.kind === EV.Round)).toBe(false);
  });

  it('the hold restarts when the lone human turns ghost too', () => {
    const m = setup(false);
    run(m, 50);
    seatStep(m, { 1: SeatCmd.Ghost });
    expect(m.current.phase).toBe(Phase.Frozen);
    expect(m.current.holdWinner).toBe(-1);
  });
});
