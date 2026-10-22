/**
 * The Arcade's heavier UI (the overlay, the sheet, the online stage), loaded on first use as one
 * lazy chunk so the main bundle carries only the button, the chips and the state (≤ 4 KB gzip).
 */
export { ArcadeOverlay } from './ArcadeOverlay';
export { ArcadeSheet } from './ArcadeSheet';
