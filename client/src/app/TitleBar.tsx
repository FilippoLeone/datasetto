import { render } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { desktopTitleBar, followTitleBarColors } from '@/services/native/titleBar';

const LOGO_URL = `${import.meta.env.BASE_URL}favicon.svg`;

/**
 * The bar across the top of the desktop app's window: logo and name on the left, the system's
 * caption buttons drawn over its right end (Windows, Linux) or its left end (macOS) by the
 * shell. The whole bar drags the window; a double click maximizes it, a right click opens
 * the system menu. It has no controls of its own: anything clickable added here needs
 * `app-region: no-drag`, or the window swallows the click.
 */
export const TitleBar = ({ platform }: { platform: string }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = ref.current;
    if (!bar || !window.desktopAPI?.setTitleBarColors) return;
    return followTitleBarColors(bar, (colors) => window.desktopAPI?.setTitleBarColors?.(colors));
  }, []);
  return (
    <div ref={ref} className="titlebar" data-platform={platform} aria-hidden="true">
      <div className="titlebar-area">
        <img src={LOGO_URL} alt="" width={16} height={16} draggable={false} />
        <span className="truncate">Datasetto</span>
      </div>
    </div>
  );
};

/**
 * Draw the bar when the desktop shell hid its native one; a no-op in the browser and on mobile.
 * It gets its own root ahead of the app, so it stays on every screen (sign-in included), and
 * `data-titlebar` on <html> makes the safe-area paddings (.safe-top, .p-safe) clear it.
 */
export const installTitleBar = (): void => {
  const bar = desktopTitleBar();
  if (!bar || document.querySelector('[data-titlebar-root]')) return;
  const root = document.documentElement;
  root.dataset.titlebar = bar.platform === 'darwin' ? 'mac' : 'overlay';
  root.style.setProperty('--titlebar-fallback-height', `${bar.height}px`);
  const host = document.createElement('div');
  host.setAttribute('data-titlebar-root', '');
  document.body.prepend(host);
  render(<TitleBar platform={bar.platform} />, host);
};
