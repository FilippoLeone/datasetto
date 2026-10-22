/**
 * A game's frame loop on the shared frame scheduler (platform.md §10.2). It subscribes to `frames`
 * only while the game is visible AND something needs a frame: an animation is running, something
 * is dirty, or there is a sim to step. A still poker table or slot hall therefore schedules nothing.
 *
 * With `step` (an offline sim), a fixed 30 Hz accumulator runs at most `maxSteps` (4) steps per frame
 * and drops the backlog after a stall, so hidden means paused. `draw(now, alpha)` gets the fraction
 * of a tick since the last step for interpolation (0 without `step`).
 */
import { TICK_MS } from '@arcade/core/net/lane';
import { frames } from './p0';

export interface Loop {
  markDirty(): void;
  animate(on: boolean): void;
  setVisible(v: boolean): void;
  dispose(): void;
  readonly running: boolean;
}

export const createLoop = (o: { draw(nowMs: number, alpha: number): void; step?: { fn(): void; maxSteps?: number }; maxFps?: 30 | 60 }): Loop => {
  let visible = true;
  let animating = false;
  let dirty = true;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let acc = 0;
  const maxSteps = o.step?.maxSteps ?? 4;

  const wanted = (): boolean => !disposed && visible && (animating || dirty || o.step !== undefined);

  const onFrame = (now: number, dt: number): void => {
    let alpha = 0;
    if (o.step) {
      acc += Math.min(dt, 250);
      let steps = 0;
      while (acc >= TICK_MS && steps < maxSteps) {
        o.step.fn();
        acc -= TICK_MS;
        steps += 1;
      }
      if (acc >= TICK_MS) acc = 0;
      alpha = acc / TICK_MS;
    }
    dirty = false;
    o.draw(now, alpha);
    sync();
  };

  const sync = (): void => {
    if (wanted()) {
      if (!unsubscribe) unsubscribe = frames.add(onFrame, { maxFps: o.maxFps ?? 60, label: 'arcade-loop' });
    } else if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
      acc = 0;
    }
  };

  sync();

  return {
    markDirty() {
      dirty = true;
      sync();
    },
    animate(on) {
      animating = on;
      sync();
    },
    setVisible(v) {
      if (v === visible) return;
      visible = v;
      // Coming back: one fresh frame, and no catch-up of the time spent hidden.
      if (v) {
        dirty = true;
        acc = 0;
      }
      sync();
    },
    dispose() {
      disposed = true;
      sync();
    },
    get running() {
      return unsubscribe !== null;
    },
  };
};
