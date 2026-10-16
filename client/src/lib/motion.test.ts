import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { MOTION, useListPresence, usePresence } from './motion';

/** Tiny renderHook on top of preact/test-utils (no extra dependency). */
const renderHook = <P, R>(hook: (props: P) => R, initialProps: P) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const result = { current: undefined as unknown as R };
  const Harness = ({ hookProps }: { hookProps: P }) => {
    result.current = hook(hookProps);
    return null;
  };
  act(() => {
    render(h(Harness, { hookProps: initialProps }), container);
  });
  return {
    result,
    rerender: (props: P) =>
      act(() => {
        render(h(Harness, { hookProps: props }), container);
      }),
    unmount: () =>
      act(() => {
        render(null, container);
        container.remove();
      }),
  };
};

const states = (entries: { key: string; state: string }[]) => entries.map((entry) => entry.key + ':' + entry.state);

describe('usePresence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stays mounted for the leave duration and reports the direction', () => {
    const hook = renderHook(({ open }: { open: boolean }) => usePresence(open, 200), { open: true });
    expect(hook.result.current).toEqual({ mounted: true, state: 'open' });
    hook.rerender({ open: false });
    expect(hook.result.current).toEqual({ mounted: true, state: 'closed' });
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(hook.result.current.mounted).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(hook.result.current.mounted).toBe(false);
    hook.unmount();
  });

  it('reopens without waiting for the timer', () => {
    const hook = renderHook(({ open }: { open: boolean }) => usePresence(open, MOTION.base), { open: true });
    hook.rerender({ open: false });
    hook.rerender({ open: true });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(hook.result.current).toEqual({ mounted: true, state: 'open' });
    hook.unmount();
  });
});

describe('useListPresence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps removed items in place as closed until the leave duration passes', () => {
    const hook = renderHook(({ items }: { items: string[] }) => useListPresence(items, (item) => item, 200), { items: ['a', 'b', 'c'] });
    expect(states(hook.result.current)).toEqual(['a:open', 'b:open', 'c:open']);
    hook.rerender({ items: ['a', 'c'] });
    expect(states(hook.result.current)).toEqual(['a:open', 'b:closed', 'c:open']);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(hook.result.current.map((entry) => entry.key)).toEqual(['a', 'c']);
    hook.unmount();
  });

  it('cancels the departure of an item that comes back', () => {
    const hook = renderHook(({ items }: { items: string[] }) => useListPresence(items, (item) => item, 200), { items: ['a', 'b'] });
    hook.rerender({ items: ['a'] });
    hook.rerender({ items: ['a', 'b'] });
    expect(states(hook.result.current)).toEqual(['a:open', 'b:open']);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(hook.result.current.map((entry) => entry.key)).toEqual(['a', 'b']);
    hook.unmount();
  });
});
