/**
 * Touch gesture maths, kept free of DOM so it can be unit tested: swipe
 * classification (drawers), long-press tracking (message menu) and pinch
 * zoom (avatar cropper). The components only feed pointer coordinates in.
 */

export interface GesturePoint {
  x: number;
  y: number;
  /** Timestamp in ms (performance.now() or event.timeStamp). */
  t: number;
}

export type SwipeDirection = 'left' | 'right' | 'up' | 'down';

export interface SwipeOptions {
  /** Travel along the main axis that always counts as a swipe. */
  minDistance: number;
  /** A shorter, quicker flick counts too: at least this far at this speed. */
  flickDistance: number;
  /** px per ms. */
  flickVelocity: number;
  /** Gestures slower than this are scrolls or drags, not swipes. */
  maxDuration: number;
  /** The main axis must dominate the other by this factor, or it is a diagonal drag. */
  axisRatio: number;
}

export const SWIPE_DEFAULTS: SwipeOptions = {
  minDistance: 56,
  flickDistance: 24,
  flickVelocity: 0.35,
  maxDuration: 700,
  axisRatio: 1.6,
};

/**
 * The direction of a finger movement from `start` to `end`, or null when it was
 * too short, too slow, too diagonal or took too long (a scroll or a drag).
 */
export const classifySwipe = (start: GesturePoint, end: GesturePoint, options: Partial<SwipeOptions> = {}): SwipeDirection | null => {
  const config = { ...SWIPE_DEFAULTS, ...options };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dt = Math.max(1, end.t - start.t);
  if (dt > config.maxDuration) return null;
  const horizontal = Math.abs(dx) >= Math.abs(dy) * config.axisRatio;
  const vertical = Math.abs(dy) >= Math.abs(dx) * config.axisRatio;
  if (!horizontal && !vertical) return null;
  const travel = horizontal ? Math.abs(dx) : Math.abs(dy);
  const fast = travel >= config.flickDistance && travel / dt >= config.flickVelocity;
  if (travel < config.minDistance && !fast) return null;
  if (horizontal) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
};

export interface LongPressOptions {
  /** How long the finger has to stay down. */
  delay: number;
  /** Movement beyond this many px cancels the press (the user is scrolling). */
  tolerance: number;
}

export const LONG_PRESS_DEFAULTS: LongPressOptions = { delay: 450, tolerance: 10 };

/**
 * Tracks one finger: `down` starts the timer, `move` beyond the tolerance or
 * `up` / `cancel` before the delay drops it, otherwise `onLongPress` fires once.
 * `fired` tells the caller to swallow the click that follows a long press.
 */
export class LongPressTracker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private origin: { x: number; y: number; id: number } | null = null;
  /** True from the moment the press fired until the next `down`. */
  fired = false;

  constructor(
    private readonly onLongPress: () => void,
    private readonly options: LongPressOptions = LONG_PRESS_DEFAULTS,
  ) {}

  down(x: number, y: number, pointerId = 0): void {
    this.clear();
    this.fired = false;
    this.origin = { x, y, id: pointerId };
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.origin) return;
      this.origin = null;
      this.fired = true;
      this.onLongPress();
    }, this.options.delay);
  }

  move(x: number, y: number, pointerId = 0): void {
    if (!this.origin || this.origin.id !== pointerId) return;
    if (Math.hypot(x - this.origin.x, y - this.origin.y) > this.options.tolerance) this.cancel();
  }

  up(pointerId = 0): void {
    if (this.origin && this.origin.id !== pointerId) return;
    this.cancel();
  }

  cancel(): void {
    this.clear();
    this.origin = null;
  }

  /** True while a press is in progress and has not fired. */
  get pending(): boolean {
    return this.origin !== null;
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

export interface DrawerState {
  /** Phone layout: the channel list is a drawer. */
  phone: boolean;
  /** Mobile layout (phones and tablets): the member list is a drawer. */
  mobile: boolean;
  sidebarOpen: boolean;
  membersOpen: boolean;
  /** A dialog, sheet or the search page is up: swipes belong to it. */
  locked: boolean;
}

export type DrawerAction = 'open-sidebar' | 'close-sidebar' | 'open-members' | 'close-members' | null;

/**
 * What a horizontal swipe does to the drawers: right opens the channel drawer
 * (phones) or closes the member drawer, left opens the member drawer or closes
 * the channel drawer. Nothing while the layout has no drawers or a panel is up.
 */
export const drawerSwipeAction = (direction: SwipeDirection | null, state: DrawerState): DrawerAction => {
  if (!direction || state.locked || !state.mobile) return null;
  if (direction === 'left') {
    if (state.sidebarOpen) return 'close-sidebar';
    if (state.membersOpen) return null;
    return 'open-members';
  }
  if (direction === 'right') {
    if (state.membersOpen) return 'close-members';
    if (state.sidebarOpen) return null;
    return state.phone ? 'open-sidebar' : null;
  }
  return null;
};

/** Distance between two fingers. */
export const pointerDistance = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * The zoom after a pinch: the finger distance grew from `previousDistance` to
 * `distance`, so the picture grows by the same factor, clamped to [min, max].
 */
export const pinchZoom = (zoom: number, previousDistance: number, distance: number, min = 1, max = 4): number => {
  if (previousDistance <= 0 || distance <= 0 || !Number.isFinite(distance)) return zoom;
  return Math.min(max, Math.max(min, zoom * (distance / previousDistance)));
};
