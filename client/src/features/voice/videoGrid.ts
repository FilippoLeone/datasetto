/** Layout maths for the voice channel's video grid. */

export const VIDEO_GRID_GAP = 8;
/** A tile never gets shorter than this; past that point the grid scrolls instead. */
export const VIDEO_TILE_MIN_HEIGHT = 96;
const MAX_COLUMNS = 4;

export interface VideoGridLayout {
  columns: number;
  rows: number;
  /** Column width in px: the full share of the width, or 16:9 of the row height when the box is short. */
  cellWidth: number;
  /** Row height in px: 16:9 of the column width when the box is tall enough, never below the minimum. */
  cellHeight: number;
}

/**
 * The column count that gives `count` 16:9 tiles the most picture inside a
 * `width` x `height` box: cells share the box equally, and the picture is the
 * largest 16:9 rectangle that fits a cell. Phones end up with one column, a
 * laptop with five tiles gets two, a wide screen with nine gets three.
 */
export const bestColumns = (count: number, width: number, height: number, gap: number = VIDEO_GRID_GAP): number => {
  if (count <= 1 || width <= 0 || height <= 0) return 1;
  let best = 1;
  let bestArea = -1;
  for (let columns = 1; columns <= Math.min(count, MAX_COLUMNS); columns++) {
    const rows = Math.ceil(count / columns);
    const cellWidth = (width - gap * (columns - 1)) / columns;
    const cellHeight = (height - gap * (rows - 1)) / rows;
    if (cellWidth <= 0 || cellHeight <= 0) continue;
    const pictureWidth = Math.min(cellWidth, (cellHeight * 16) / 9);
    const area = pictureWidth * ((pictureWidth * 9) / 16);
    if (area > bestArea) {
      bestArea = area;
      best = columns;
    }
  }
  return best;
};

/**
 * Columns, rows and the cell size for `count` tiles in a box. Cells are 16:9
 * whichever side limits them (so a picture is never stuck in a tall or wide
 * black cell) and the grid centres them; below the minimum tile height the
 * grid scrolls instead of shrinking further.
 */
export const videoGridLayout = (count: number, width: number, height: number, gap: number = VIDEO_GRID_GAP): VideoGridLayout => {
  const columns = bestColumns(count, width, height, gap);
  const rows = Math.max(1, Math.ceil(Math.max(count, 1) / columns));
  const sharedWidth = Math.max(0, (width - gap * (columns - 1)) / columns);
  const sharedHeight = Math.max(0, (height - gap * (rows - 1)) / rows);
  // Whichever side limits the 16:9 cell decides; the other side follows from it.
  const widthLimited = (sharedWidth * 9) / 16 <= sharedHeight;
  let cellWidth = widthLimited ? Math.floor(sharedWidth) : 0;
  let cellHeight = widthLimited ? Math.floor((cellWidth * 9) / 16) : Math.floor(sharedHeight);
  if (!widthLimited) cellWidth = Math.floor((cellHeight * 16) / 9);
  if (cellHeight < VIDEO_TILE_MIN_HEIGHT) {
    cellHeight = VIDEO_TILE_MIN_HEIGHT;
    cellWidth = Math.floor(Math.min(sharedWidth > 0 ? sharedWidth : Infinity, (VIDEO_TILE_MIN_HEIGHT * 16) / 9));
  }
  return { columns, rows, cellWidth, cellHeight };
};
