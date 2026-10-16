import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTopPanel, installBackStack, openPanelCount, pushBackHandler, resetBackStack } from './backStack';

describe('back stack without history (Capacitor)', () => {
  beforeEach(() => {
    resetBackStack();
    installBackStack({ history: false });
  });
  afterEach(() => resetBackStack());

  it('closes the newest panel first and reports when nothing is open', () => {
    const drawer = vi.fn();
    const dialog = vi.fn();
    const closeDrawer = pushBackHandler(drawer);
    pushBackHandler(dialog);
    expect(openPanelCount()).toBe(2);
    expect(closeTopPanel()).toBe(true);
    expect(dialog).toHaveBeenCalledTimes(1);
    expect(drawer).not.toHaveBeenCalled();
    expect(closeTopPanel()).toBe(true);
    expect(drawer).toHaveBeenCalledTimes(1);
    expect(closeTopPanel()).toBe(false);
    // Unregistering a panel that back already closed is a no-op.
    closeDrawer();
    expect(openPanelCount()).toBe(0);
  });

  it('forgets a panel that closed on its own', () => {
    const close = vi.fn();
    const release = pushBackHandler(close);
    release();
    expect(closeTopPanel()).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });
});

describe('back stack with history (touch browsers)', () => {
  beforeEach(() => {
    resetBackStack();
    window.history.replaceState(null, '');
    installBackStack({ history: true });
  });
  afterEach(() => resetBackStack());

  it('adds a history entry per panel and closes it on popstate', () => {
    const close = vi.fn();
    pushBackHandler(close);
    expect(window.history.state).toEqual({ datasettoPanel: expect.any(Number) });
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(openPanelCount()).toBe(0);
  });

  it('removes its own entry when the panel closes by a tap, and ignores that popstate', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const close = vi.fn();
    const release = pushBackHandler(close);
    release();
    expect(back).toHaveBeenCalledTimes(1);
    // The browser answers history.back() with a popstate: it must not close anything else.
    const other = vi.fn();
    pushBackHandler(other);
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    expect(other).not.toHaveBeenCalled();
    expect(openPanelCount()).toBe(1);
    back.mockRestore();
  });

  it('leaves history alone when the panel is not the current entry', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const releaseFirst = pushBackHandler(vi.fn());
    pushBackHandler(vi.fn());
    releaseFirst();
    expect(back).not.toHaveBeenCalled();
    expect(openPanelCount()).toBe(1);
    back.mockRestore();
  });

  it('drops a stale panel marker left by a reload', () => {
    resetBackStack();
    window.history.replaceState({ datasettoPanel: 7 }, '');
    installBackStack({ history: true });
    expect(window.history.state).toBeNull();
  });
});
