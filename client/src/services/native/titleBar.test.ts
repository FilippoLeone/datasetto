import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopTitleBar, followTitleBarColors, readTitleBarColors, toHexColor } from './titleBar';

const flushObservers = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  delete window.desktopAPI;
  document.documentElement.removeAttribute('class');
  document.documentElement.removeAttribute('data-theme');
  document.body.innerHTML = '';
});

describe('toHexColor', () => {
  it('turns computed colours into #rrggbb', () => {
    expect(toHexColor('rgb(30, 31, 34)')).toBe('#1e1f22');
    expect(toHexColor('rgba(148, 155, 164, 1)')).toBe('#949ba4');
    expect(toHexColor('rgb(255 255 255)')).toBe('#ffffff');
    expect(toHexColor('rgb(0 0 0 / 100%)')).toBe('#000000');
    expect(toHexColor(' #1E1F22 ')).toBe('#1e1f22');
    expect(toHexColor('#abc')).toBe('#aabbcc');
    expect(toHexColor('rgb(300, -1, 12.6)')).toBeNull();
    expect(toHexColor('rgb(254.6, 0.4, 12.6)')).toBe('#ff000d');
  });

  it('refuses see-through and unknown colours', () => {
    expect(toHexColor('rgba(0, 0, 0, 0)')).toBeNull();
    expect(toHexColor('rgba(30, 31, 34, 0.5)')).toBeNull();
    expect(toHexColor('rgb(30 31 34 / 50%)')).toBeNull();
    expect(toHexColor('transparent')).toBeNull();
    expect(toHexColor('oklch(0.2 0.01 260)')).toBeNull();
    expect(toHexColor('')).toBeNull();
  });
});

describe('desktopTitleBar', () => {
  it('is null in the browser and with a native frame', () => {
    expect(desktopTitleBar()).toBeNull();
    window.desktopAPI = { titleBar: null } as unknown as Window['desktopAPI'];
    expect(desktopTitleBar()).toBeNull();
    window.desktopAPI = { titleBar: { height: 0, platform: 'win32' } } as unknown as Window['desktopAPI'];
    expect(desktopTitleBar()).toBeNull();
  });

  it('returns what the shell says', () => {
    window.desktopAPI = { titleBar: { height: 32, platform: 'win32' } } as unknown as Window['desktopAPI'];
    expect(desktopTitleBar()).toEqual({ height: 32, platform: 'win32' });
  });
});

describe('followTitleBarColors', () => {
  const makeBar = (background: string, text: string): HTMLElement => {
    const bar = document.createElement('div');
    bar.style.backgroundColor = background;
    bar.style.color = text;
    document.body.appendChild(bar);
    return bar;
  };

  it('reads the background and text colour of the bar', () => {
    expect(readTitleBarColors(makeBar('#1e1f22', '#949ba4'))).toEqual({ color: '#1e1f22', symbolColor: '#949ba4' });
    expect(readTitleBarColors(makeBar('transparent', '#949ba4'))).toBeNull();
  });

  it('sends the colours at once and again when a theme change alters them, never the same twice', async () => {
    const bar = makeBar('#1e1f22', '#949ba4');
    const send = vi.fn();
    const stop = followTitleBarColors(bar, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith({ color: '#1e1f22', symbolColor: '#949ba4' });

    // A class change that leaves the colours as they are sends nothing.
    document.documentElement.classList.add('compact');
    await flushObservers();
    expect(send).toHaveBeenCalledTimes(1);

    // A light theme: the bar's tokens change with the attribute.
    bar.style.backgroundColor = '#f2f3f5';
    bar.style.color = '#4e5058';
    document.documentElement.setAttribute('data-theme', 'light');
    await flushObservers();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ color: '#f2f3f5', symbolColor: '#4e5058' });

    // Back to dark through a class on <body>.
    bar.style.backgroundColor = '#1e1f22';
    bar.style.color = '#949ba4';
    document.body.className = 'theme-dark';
    await flushObservers();
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith({ color: '#1e1f22', symbolColor: '#949ba4' });

    stop();
    bar.style.backgroundColor = '#ffffff';
    document.documentElement.setAttribute('data-theme', 'light-2');
    await flushObservers();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('waits for usable colours instead of sending a see-through background', async () => {
    const bar = makeBar('transparent', '#949ba4');
    const send = vi.fn();
    const stop = followTitleBarColors(bar, send);
    expect(send).not.toHaveBeenCalled();
    bar.style.backgroundColor = '#1e1f22';
    window.dispatchEvent(new Event('load'));
    expect(send).toHaveBeenCalledWith({ color: '#1e1f22', symbolColor: '#949ba4' });
    stop();
  });
});
