import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

type StateListener = (state: { isActive: boolean }) => void;

const plugin = vi.hoisted(() => ({
  listeners: [] as Array<(state: { isActive: boolean }) => void>,
  initial: true,
  addListener: null as Mock | null,
}));

vi.mock('@capacitor/app', () => {
  plugin.addListener = vi.fn(async (event: string, listener: StateListener) => {
    if (event === 'appStateChange') plugin.listeners.push(listener);
    return { remove: async () => undefined };
  });
  return {
    App: {
      addListener: plugin.addListener,
      getState: vi.fn(async () => ({ isActive: plugin.initial })),
    },
  };
});

const fire = (isActive: boolean) => plugin.listeners.forEach((listener) => listener({ isActive }));

describe('app state', () => {
  beforeEach(() => {
    vi.resetModules();
    plugin.listeners.length = 0;
    plugin.initial = true;
    plugin.addListener?.mockClear();
  });
  afterEach(() => {
    delete window.Capacitor;
  });

  it('shares one Capacitor listener between every subscriber', async () => {
    window.Capacitor = { isNativePlatform: () => true };
    const { onAppStateChange, isAppActive } = await import('./appState');
    const first: boolean[] = [];
    const second: boolean[] = [];
    const stopFirst = onAppStateChange((active) => first.push(active));
    onAppStateChange((active) => second.push(active));
    await vi.waitFor(() => expect(plugin.listeners).toHaveLength(1));
    expect(plugin.addListener).toHaveBeenCalledTimes(1);

    fire(false);
    expect(isAppActive()).toBe(false);
    fire(true);
    stopFirst();
    fire(false);
    expect(first).toEqual([false, true]);
    expect(second).toEqual([false, true, false]);
    expect(plugin.addListener).toHaveBeenCalledTimes(1);
  });

  it('knows an app that started in the background', async () => {
    window.Capacitor = { isNativePlatform: () => true };
    plugin.initial = false;
    const { startAppStateTracking, onAppStateChange, isAppActive } = await import('./appState');
    const seen: boolean[] = [];
    onAppStateChange((active) => seen.push(active));
    startAppStateTracking();
    await vi.waitFor(() => expect(isAppActive()).toBe(false));
    expect(seen).toEqual([false]);
    expect(plugin.addListener).toHaveBeenCalledTimes(1);
  });

  it('installs nothing on the web or in Electron', async () => {
    const { onAppStateChange, startAppStateTracking, isAppActive } = await import('./appState');
    const cb = vi.fn();
    const stop = onAppStateChange(cb);
    startAppStateTracking();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(plugin.addListener).not.toHaveBeenCalled();
    expect(isAppActive()).toBe(true);
    expect(cb).not.toHaveBeenCalled();
    stop();
  });
});
