import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installTitleBar } from './TitleBar';

const root = document.documentElement;

afterEach(() => {
  const host = document.querySelector('[data-titlebar-root]');
  if (host) {
    render(null, host);
    host.remove();
  }
  delete window.desktopAPI;
  root.removeAttribute('data-titlebar');
  root.style.removeProperty('--titlebar-fallback-height');
});

describe('installTitleBar', () => {
  it('draws nothing in the browser, on mobile or in a shell with a native frame', () => {
    installTitleBar();
    window.desktopAPI = { titleBar: null } as unknown as Window['desktopAPI'];
    installTitleBar();
    expect(document.querySelector('[data-titlebar-root]')).toBeNull();
    expect(document.querySelector('.titlebar')).toBeNull();
    expect(root.hasAttribute('data-titlebar')).toBe(false);
    expect(root.style.getPropertyValue('--titlebar-fallback-height')).toBe('');
  });

  it('draws the bar once in the desktop shell and hands its colours to the caption buttons', () => {
    const setTitleBarColors = vi.fn();
    window.desktopAPI = { titleBar: { height: 32, platform: 'win32' }, setTitleBarColors } as unknown as Window['desktopAPI'];
    act(() => installTitleBar());
    act(() => installTitleBar());

    expect(document.querySelectorAll('[data-titlebar-root]')).toHaveLength(1);
    expect(document.body.firstElementChild?.hasAttribute('data-titlebar-root')).toBe(true);
    const bar = document.querySelector('.titlebar') as HTMLElement;
    expect(bar.textContent).toBe('Datasetto');
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    expect(bar.dataset.platform).toBe('win32');
    expect(bar.querySelector('img')?.getAttribute('src')).toMatch(/favicon\.svg$/);
    expect(root.dataset.titlebar).toBe('overlay');
    expect(root.style.getPropertyValue('--titlebar-fallback-height')).toBe('32px');

    // jsdom has no stylesheet here, so the bar is see-through and nothing goes out yet.
    expect(setTitleBarColors).not.toHaveBeenCalled();
    bar.style.backgroundColor = '#1e1f22';
    bar.style.color = '#949ba4';
    window.dispatchEvent(new Event('load'));
    expect(setTitleBarColors).toHaveBeenCalledExactlyOnceWith({ color: '#1e1f22', symbolColor: '#949ba4' });
  });

  it('marks macOS so the text clears the traffic lights', () => {
    window.desktopAPI = { titleBar: { height: 32, platform: 'darwin' } } as unknown as Window['desktopAPI'];
    act(() => installTitleBar());
    expect(root.dataset.titlebar).toBe('mac');
    expect(document.querySelector('.titlebar')).not.toBeNull();
  });
});
