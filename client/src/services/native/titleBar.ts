/**
 * The desktop app's own title bar (Electron shell only).
 *
 * desktop/main.js hides the main window's native title bar and keeps the system's caption
 * buttons: minimize, maximize/restore and close over the right end of the bar on Windows
 * and Linux, the traffic lights at its left end on macOS. The page draws the bar under them
 * (app/TitleBar.tsx) and tells the shell its colours, so the buttons sit on the same
 * background. In the browser, on mobile and in a shell with a native frame there is no
 * `desktopAPI.titleBar`, and nothing here runs.
 */

export type DesktopTitleBarInfo = NonNullable<NonNullable<Window['desktopAPI']>['titleBar']>;

export interface TitleBarColors {
  /** Background of the bar, `#rrggbb`. */
  color: string;
  /** Colour of the caption button symbols, `#rrggbb`. */
  symbolColor: string;
}

/** What the shell says about the bar, or null where the window keeps its native frame. */
export const desktopTitleBar = (): DesktopTitleBarInfo | null => {
  const bar = typeof window === 'undefined' ? null : window.desktopAPI?.titleBar;
  return bar && Number.isFinite(bar.height) && bar.height > 0 ? bar : null;
};

const hex = (channel: number): string => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, '0');

/**
 * `#rrggbb` for a computed CSS colour: `rgb()`/`rgba()` (comma or space syntax) or hex.
 * Null for anything else and for a colour that is not fully opaque (the shell paints the
 * caption buttons' background with it, and a see-through one would not match the bar).
 */
export const toHexColor = (value: string): string | null => {
  const text = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(text);
  if (!rgb) return null;
  const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? Number.parseFloat(rgb[4]) / 100 : Number(rgb[4]);
  if (alpha < 1) return null;
  return `#${hex(Number(rgb[1]))}${hex(Number(rgb[2]))}${hex(Number(rgb[3]))}`;
};

/** The bar's background and text colour, as the shell takes them. */
export const readTitleBarColors = (bar: Element): TitleBarColors | null => {
  const style = getComputedStyle(bar);
  const color = toHexColor(style.backgroundColor);
  const symbolColor = toHexColor(style.color);
  return color && symbolColor ? { color, symbolColor } : null;
};

/**
 * Keep the caption buttons in the bar's colours: send them now, and again whenever they
 * change (a theme set on <html> or <body> through a class, `data-theme` or inline tokens,
 * the system's light or dark setting, the stylesheet finishing loading). Unchanged colours
 * are not sent twice. Returns a function that stops following.
 */
export const followTitleBarColors = (bar: Element, send: (colors: TitleBarColors) => void): (() => void) => {
  let last = '';
  const sync = (): void => {
    const colors = readTitleBarColors(bar);
    if (!colors) return;
    const key = `${colors.color} ${colors.symbolColor}`;
    if (key === last) return;
    last = key;
    send(colors);
  };
  sync();
  const observer = new MutationObserver(sync);
  const watched = { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] };
  observer.observe(document.documentElement, watched);
  if (document.body) observer.observe(document.body, watched);
  const scheme = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  scheme?.addEventListener?.('change', sync);
  window.addEventListener('load', sync);
  return () => {
    observer.disconnect();
    scheme?.removeEventListener?.('change', sync);
    window.removeEventListener('load', sync);
  };
};
