/**
 * The Arcade's heavier UI (the overlay, the sheet, the online stage) and the online actions, loaded
 * on first use as one lazy chunk so the main bundle carries only the button, the chips, the
 * bindings and the state (≤ 4 KB gzip in all).
 */
export { ArcadeOverlay } from './ArcadeOverlay';
export { ArcadeSheet } from './ArcadeSheet';
export { GameStage } from './GameStage';
export { acceptInvite, joinFromChip, leaveCurrent, lobbyEnded, lobbyLive, reopenStage, stopStage } from './remote';
