import { describe, expect, it } from 'vitest';
import { VIDEO_GRID_GAP, VIDEO_TILE_MIN_HEIGHT, bestColumns, videoGridLayout } from './videoGrid';

describe('bestColumns', () => {
  it('uses one column for a single tile and for phones', () => {
    expect(bestColumns(1, 1000, 600)).toBe(1);
    expect(bestColumns(3, 351, 560)).toBe(1);
    expect(bestColumns(5, 351, 560)).toBe(1);
  });

  it('puts two tiles side by side only when the box is wide enough to make them bigger', () => {
    expect(bestColumns(2, 1600, 600)).toBe(2);
    // 780x600: stacked tiles are 526x296, side by side only 386x217.
    expect(bestColumns(2, 780, 600)).toBe(1);
    expect(bestColumns(2, 351, 560)).toBe(1);
  });

  it('keeps five tiles in two columns on a laptop and three on a wide screen', () => {
    expect(bestColumns(5, 780, 600)).toBe(2);
    expect(bestColumns(5, 1600, 700)).toBe(3);
    expect(bestColumns(9, 1600, 900)).toBe(3);
  });

  it('never exceeds four columns and copes with nonsense sizes', () => {
    expect(bestColumns(20, 4000, 400)).toBe(4);
    expect(bestColumns(4, 0, 0)).toBe(1);
    expect(bestColumns(0, 800, 600)).toBe(1);
  });
});

describe('videoGridLayout', () => {
  it('stacks five tiles on a portrait tablet as 16:9 cells centred in the width', () => {
    // 504x850: one column of 290x163 pictures beats two columns of 248x139.
    const tablet = videoGridLayout(5, 504, 850);
    expect(tablet.columns).toBe(1);
    expect(tablet.rows).toBe(5);
    expect(tablet.cellHeight).toBe(Math.floor((850 - 4 * VIDEO_GRID_GAP) / 5));
    expect(tablet.cellWidth).toBe(Math.floor((tablet.cellHeight * 16) / 9));
    expect(tablet.cellWidth).toBeLessThan(504);
  });

  it('fills the width and shares the height when the box is short', () => {
    const laptop = videoGridLayout(5, 780, 600);
    expect(laptop.columns).toBe(2);
    expect(laptop.rows).toBe(3);
    expect(laptop.cellHeight).toBe(Math.floor((600 - 2 * VIDEO_GRID_GAP) / 3));
    expect(laptop.cellWidth).toBe(Math.floor((laptop.cellHeight * 16) / 9));
  });

  it('sizes rows to the picture when the box is tall', () => {
    const tall = videoGridLayout(2, 700, 1200);
    expect(tall.columns).toBe(1);
    expect(tall.cellWidth).toBe(700);
    expect(tall.cellHeight).toBe(Math.floor((700 * 9) / 16));
  });

  it('never goes below the minimum tile height (the grid scrolls instead)', () => {
    const crowded = videoGridLayout(12, 351, 400);
    expect(crowded.cellHeight).toBe(VIDEO_TILE_MIN_HEIGHT);
    expect(crowded.rows * crowded.cellHeight + (crowded.rows - 1) * VIDEO_GRID_GAP).toBeGreaterThan(400);
  });

  it('handles a single tile and an unmeasured box', () => {
    expect(videoGridLayout(1, 780, 600)).toEqual({ columns: 1, rows: 1, cellWidth: 780, cellHeight: Math.floor((780 * 9) / 16) });
    const unmeasured = videoGridLayout(3, 0, 0);
    expect(unmeasured.cellHeight).toBe(VIDEO_TILE_MIN_HEIGHT);
    expect(unmeasured.cellWidth).toBeGreaterThan(0);
  });
});
