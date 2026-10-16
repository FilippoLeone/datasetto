import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifySwipe, drawerSwipeAction, LongPressTracker, pinchZoom, pointerDistance, type DrawerState } from './gestures';

const at = (x: number, y: number, t: number) => ({ x, y, t });

describe('drawerSwipeAction', () => {
  const phone: DrawerState = { phone: true, mobile: true, sidebarOpen: false, membersOpen: false, locked: false };
  const tablet: DrawerState = { ...phone, phone: false };

  it('opens the drawers from the main area on a phone', () => {
    expect(drawerSwipeAction('right', phone)).toBe('open-sidebar');
    expect(drawerSwipeAction('left', phone)).toBe('open-members');
  });

  it('closes an open drawer with the opposite swipe and ignores the other direction', () => {
    expect(drawerSwipeAction('left', { ...phone, sidebarOpen: true })).toBe('close-sidebar');
    expect(drawerSwipeAction('right', { ...phone, sidebarOpen: true })).toBeNull();
    expect(drawerSwipeAction('right', { ...phone, membersOpen: true })).toBe('close-members');
    expect(drawerSwipeAction('left', { ...phone, membersOpen: true })).toBeNull();
  });

  it('only knows the member drawer on a tablet', () => {
    expect(drawerSwipeAction('right', tablet)).toBeNull();
    expect(drawerSwipeAction('left', tablet)).toBe('open-members');
    expect(drawerSwipeAction('right', { ...tablet, membersOpen: true })).toBe('close-members');
  });

  it('does nothing on desktop, while a panel is up, or for vertical swipes', () => {
    expect(drawerSwipeAction('right', { ...phone, mobile: false, phone: false })).toBeNull();
    expect(drawerSwipeAction('right', { ...phone, locked: true })).toBeNull();
    expect(drawerSwipeAction('down', phone)).toBeNull();
    expect(drawerSwipeAction(null, phone)).toBeNull();
  });
});

describe('classifySwipe', () => {
  it('reads a clear horizontal movement', () => {
    expect(classifySwipe(at(20, 300, 0), at(120, 310, 200))).toBe('right');
    expect(classifySwipe(at(300, 300, 0), at(180, 290, 200))).toBe('left');
  });

  it('reads vertical movements too', () => {
    expect(classifySwipe(at(100, 100, 0), at(104, 200, 200))).toBe('down');
    expect(classifySwipe(at(100, 300, 0), at(96, 180, 200))).toBe('up');
  });

  it('ignores short movements unless they are quick flicks', () => {
    expect(classifySwipe(at(0, 0, 0), at(40, 0, 400))).toBeNull();
    // 40 px in 60 ms is a flick.
    expect(classifySwipe(at(0, 0, 0), at(40, 0, 60))).toBe('right');
    // ...but not when it is shorter than the flick distance.
    expect(classifySwipe(at(0, 0, 0), at(20, 0, 20))).toBeNull();
  });

  it('ignores diagonal drags and slow movements', () => {
    expect(classifySwipe(at(0, 0, 0), at(80, 70, 200))).toBeNull();
    expect(classifySwipe(at(0, 0, 0), at(200, 0, 900))).toBeNull();
  });

  it('takes custom thresholds', () => {
    expect(classifySwipe(at(0, 0, 0), at(30, 0, 300), { minDistance: 30 })).toBe('right');
  });
});

describe('LongPressTracker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once after the delay while the finger stays put', () => {
    const fire = vi.fn();
    const tracker = new LongPressTracker(fire, { delay: 400, tolerance: 10 });
    tracker.down(10, 10, 1);
    expect(tracker.pending).toBe(true);
    vi.advanceTimersByTime(399);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(tracker.fired).toBe(true);
    expect(tracker.pending).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('drops the press when the finger lifts early or moves too far', () => {
    const fire = vi.fn();
    const tracker = new LongPressTracker(fire, { delay: 400, tolerance: 10 });
    tracker.down(10, 10, 1);
    tracker.up(1);
    vi.advanceTimersByTime(500);
    expect(fire).not.toHaveBeenCalled();

    tracker.down(10, 10, 1);
    tracker.move(14, 12, 1); // within tolerance
    vi.advanceTimersByTime(100);
    tracker.move(10, 30, 1); // scrolling
    vi.advanceTimersByTime(500);
    expect(fire).not.toHaveBeenCalled();
    expect(tracker.pending).toBe(false);
  });

  it('ignores moves and lifts of another pointer', () => {
    const fire = vi.fn();
    const tracker = new LongPressTracker(fire, { delay: 400, tolerance: 10 });
    tracker.down(10, 10, 1);
    tracker.move(100, 100, 2);
    tracker.up(2);
    vi.advanceTimersByTime(400);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('resets the fired flag on the next press', () => {
    const tracker = new LongPressTracker(() => undefined, { delay: 100, tolerance: 10 });
    tracker.down(0, 0);
    vi.advanceTimersByTime(100);
    expect(tracker.fired).toBe(true);
    tracker.down(0, 0);
    expect(tracker.fired).toBe(false);
    tracker.cancel();
  });
});

describe('pinch zoom', () => {
  it('measures the finger distance', () => {
    expect(pointerDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('scales the zoom by the change in finger distance, within bounds', () => {
    expect(pinchZoom(1, 100, 150)).toBeCloseTo(1.5);
    expect(pinchZoom(2, 200, 100)).toBeCloseTo(1);
    expect(pinchZoom(3, 100, 300)).toBe(4);
    expect(pinchZoom(1.2, 100, 50)).toBe(1);
  });

  it('keeps the zoom when the distances are unusable', () => {
    expect(pinchZoom(2, 0, 100)).toBe(2);
    expect(pinchZoom(2, 100, 0)).toBe(2);
    expect(pinchZoom(2, 100, Number.NaN)).toBe(2);
  });
});
