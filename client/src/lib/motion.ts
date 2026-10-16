/**
 * Enter/leave animation helpers. CSS does the animating (tokens and keyframes in
 * styles/app.css); these hooks only keep an element mounted while its leave
 * animation runs and tell it which way it is going through `data-state`.
 */
import { useEffect, useRef, useState } from 'preact/hooks';

/** Durations in ms; keep in sync with --motion-* in styles/app.css. */
export const MOTION = { fast: 150, base: 200, slow: 250 } as const;

const reducedMotionQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

/** True when the user asked the OS for less motion; leave animations are then skipped. */
export const prefersReducedMotion = (): boolean => reducedMotionQuery?.matches ?? false;

/** How long to keep a leaving element around: nothing when motion is reduced. */
export const leaveDuration = (duration: number): number => (prefersReducedMotion() ? 0 : duration);

export type PresenceState = 'open' | 'closed';

export interface Presence {
  /** Render the element while this is true. */
  mounted: boolean;
  /** Put this on the element as `data-state`; CSS animates `[data-state='closed']` out. */
  state: PresenceState;
}

/**
 * Keeps an element mounted for `duration` ms after `open` turns false so its
 * leave animation can play.
 *
 *   const modal = usePresence(isOpen);
 *   return modal.mounted ? <div data-state={modal.state} className="dialog-card">…</div> : null;
 */
export const usePresence = (open: boolean, duration: number = MOTION.base): Presence => {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const wait = leaveDuration(duration);
    if (wait === 0) {
      setMounted(false);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), wait);
    return () => window.clearTimeout(timer);
  }, [open, duration]);
  return { mounted: open || mounted, state: open ? 'open' : 'closed' };
};

export interface PresentItem<T> {
  key: string;
  item: T;
  /** 'closed' while the item has left the list and its leave animation runs. */
  state: PresenceState;
}

/**
 * List version of usePresence: items that disappear from `items` stay in the
 * result as `state: 'closed'` for `duration` ms. New items are 'open' at once;
 * their enter animation is plain CSS on mount.
 */
export const useListPresence = <T>(items: T[], keyOf: (item: T) => string, duration: number = MOTION.base): PresentItem<T>[] => {
  const leaving = useRef(new Map<string, { item: T; index: number; timer: number }>());
  const previous = useRef<PresentItem<T>[]>([]);
  const [, bump] = useState(0);

  const live = new Map<string, T>();
  for (const item of items) live.set(keyOf(item), item);

  // Anything that was shown last time and is gone now starts leaving.
  const wait = leaveDuration(duration);
  previous.current.forEach((entry, index) => {
    // Only items that were live last time can start leaving; a 'closed' one whose
    // timer just fired is simply dropped.
    if (entry.state === 'closed' || live.has(entry.key) || leaving.current.has(entry.key)) return;
    if (wait === 0) return;
    const timer = window.setTimeout(() => {
      leaving.current.delete(entry.key);
      bump((value) => value + 1);
    }, wait);
    leaving.current.set(entry.key, { item: entry.item, index, timer });
  });
  // An item that came back while leaving is simply live again.
  for (const key of Array.from(leaving.current.keys())) {
    if (!live.has(key)) continue;
    window.clearTimeout(leaving.current.get(key)!.timer);
    leaving.current.delete(key);
  }

  const result: PresentItem<T>[] = items.map((item) => ({ key: keyOf(item), item, state: 'open' as const }));
  // Leaving items keep roughly their old position so neighbours do not jump.
  const departures = Array.from(leaving.current.entries()).sort((a, b) => a[1].index - b[1].index);
  for (const [key, entry] of departures) {
    result.splice(Math.min(entry.index, result.length), 0, { key, item: entry.item, state: 'closed' });
  }
  previous.current = result;

  useEffect(() => {
    const pending = leaving.current;
    return () => {
      for (const entry of pending.values()) window.clearTimeout(entry.timer);
      pending.clear();
    };
  }, []);

  return result;
};
