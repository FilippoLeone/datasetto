/**
 * Fuseyard's module-owned DOM (fuseyard.md §8.1): the pause menu (Resume, Controls, a few device
 * settings, Leave) and the match-end panel (standings, Rematch, Leave). Both are built once at mount
 * and shown or hidden; nothing here re-renders per frame.
 */

export interface Standing {
  slot: number;
  wick: string;
  name: string;
  roundWins: number;
  kills: number;
  blocks: number;
  /** 1-based; ties share a place. */
  place: number;
}

export interface MenuSettings {
  lanes: boolean;
  music: boolean;
}

export interface MenuHandlers {
  resume(): void;
  leave(): void;
  rematch(): void;
  settings(s: MenuSettings): void;
}

export interface Menus {
  showPause(on: boolean): void;
  readonly pauseOpen: boolean;
  /** The match-end panel; `title` and `again` (the primary button's label) default to a match end. */
  showEnd(rows: readonly Standing[], o: { canRematch: boolean; note: string; title?: string; again?: string }): void;
  hideEnd(): void;
  readonly endOpen: boolean;
  setSettings(s: MenuSettings): void;
  /** Moves keyboard focus into an open panel (for Esc and gamepad users). */
  focus(): void;
  dispose(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
};

const BTN = 'min-h-11 rounded-md px-4 text-sm font-semibold transition-colors';
const PRIMARY = BTN + ' bg-brand text-white hover:brightness-110';
const SECONDARY = BTN + ' bg-input text-text hover:bg-hover';
const PANEL = 'pointer-events-auto flex w-full max-w-xs flex-col gap-3 rounded-lg bg-elevated p-4 text-text shadow-pop';
const LAYER = 'absolute inset-0 z-20 hidden items-center justify-center bg-black/55 p-4';

export const createMenus = (root: HTMLElement, h: MenuHandlers, o: { coarse: boolean }): Menus => {
  const cleanups: (() => void)[] = [];
  const on = (t: EventTarget, type: string, fn: (e: Event) => void): void => {
    t.addEventListener(type, fn);
    cleanups.push(() => t.removeEventListener(type, fn));
  };
  let settings: MenuSettings = { lanes: o.coarse, music: false };

  // ------------------------------------------------------------------ pause
  const pause = el('div', LAYER);
  pause.dataset.fuseyardPause = '';
  pause.setAttribute('role', 'dialog');
  pause.setAttribute('aria-label', 'Paused');
  const pp = el('div', PANEL);
  pp.append(el('h3', 'text-base font-semibold text-text-bright', 'Paused'));
  const resume = el('button', PRIMARY, 'Resume');
  resume.type = 'button';
  const controls = el('button', SECONDARY, 'Controls');
  controls.type = 'button';
  const help = el('div', 'hidden rounded-md bg-input p-3 text-xs leading-relaxed text-text-muted');
  help.innerHTML = '';
  const helpRows = o.coarse
    ? ['Stick: move (drag past the ring to steer)', 'Pop: drop a bomb', 'Click: set off your oldest held bomb (with the Clicker)', 'II: pause']
    : ['WASD or arrows: move', 'Space or J: drop a bomb', 'K or Shift: set off a held bomb (Clicker)', 'Esc or P: pause', 'A gamepad works too: stick, A, B, Start'];
  for (const line of helpRows) help.append(el('div', '', line));
  const toggles = el('div', 'flex flex-col gap-2 text-sm');
  const toggle = (label: string, get: () => boolean, set: (v: boolean) => void): HTMLButtonElement => {
    const b = el('button', 'flex min-h-11 items-center justify-between rounded-md bg-input px-3 text-left text-text hover:bg-hover');
    b.type = 'button';
    b.setAttribute('role', 'switch');
    const name = el('span', '', label);
    const state = el('span', 'text-xs font-semibold text-text-muted');
    b.append(name, state);
    const sync = (): void => {
      b.setAttribute('aria-checked', String(get()));
      state.textContent = get() ? 'On' : 'Off';
    };
    sync();
    on(b, 'click', () => {
      set(!get());
      sync();
      h.settings(settings);
    });
    (b as HTMLButtonElement & { sync?: () => void }).sync = sync;
    return b;
  };
  const lanes = toggle('Blast lanes', () => settings.lanes, (v) => (settings = { ...settings, lanes: v }));
  const music = toggle('Music', () => settings.music, (v) => (settings = { ...settings, music: v }));
  toggles.append(lanes, music);
  const leave = el('button', SECONDARY, 'Leave');
  leave.type = 'button';
  pp.append(resume, controls, help, toggles, leave);
  pause.append(pp);
  on(resume, 'click', () => h.resume());
  on(leave, 'click', () => h.leave());
  on(controls, 'click', () => help.classList.toggle('hidden'));

  // ------------------------------------------------------------------ match end
  const end = el('div', LAYER);
  end.dataset.fuseyardEnd = '';
  end.setAttribute('role', 'dialog');
  end.setAttribute('aria-label', 'Match over');
  const ep = el('div', PANEL);
  const title = el('h3', 'text-base font-semibold text-text-bright', 'Match over');
  const list = el('ol', 'flex flex-col gap-1 text-sm');
  const note = el('p', 'text-xs text-text-muted');
  const again = el('button', PRIMARY, 'Rematch');
  again.type = 'button';
  const quit = el('button', SECONDARY, 'Leave');
  quit.type = 'button';
  ep.append(title, list, note, again, quit);
  end.append(ep);
  on(again, 'click', () => h.rematch());
  on(quit, 'click', () => h.leave());

  root.append(pause, end);
  const show = (layer: HTMLElement, v: boolean): void => {
    layer.classList.toggle('hidden', !v);
    layer.classList.toggle('flex', v);
  };

  return {
    showPause(v) {
      show(pause, v);
      if (!v) help.classList.add('hidden');
    },
    get pauseOpen() {
      return !pause.classList.contains('hidden');
    },
    showEnd(rows, opts) {
      list.textContent = '';
      for (const r of rows) {
        const li = el('li', 'flex items-center gap-2 rounded-md bg-input px-2 py-1.5');
        li.append(
          el('span', 'w-5 text-right font-semibold text-text-bright', String(r.place)),
          el('span', 'min-w-0 flex-1 truncate', r.wick + (r.name ? ' · ' + r.name : '')),
          el('span', 'text-xs text-text-muted', r.roundWins + ' won · ' + r.kills + ' KOs · ' + r.blocks + ' blocks'),
        );
        list.append(li);
      }
      note.textContent = opts.note;
      title.textContent = opts.title ?? 'Match over';
      end.setAttribute('aria-label', opts.title ?? 'Match over');
      again.textContent = opts.again ?? 'Rematch';
      again.classList.toggle('hidden', !opts.canRematch);
      show(end, true);
    },
    hideEnd() {
      show(end, false);
    },
    get endOpen() {
      return !end.classList.contains('hidden');
    },
    setSettings(s) {
      settings = s;
      for (const b of [lanes, music] as (HTMLButtonElement & { sync?: () => void })[]) b.sync?.();
    },
    focus() {
      const target = !end.classList.contains('hidden') ? (again.classList.contains('hidden') ? quit : again) : resume;
      target.focus({ preventScroll: true });
    },
    dispose() {
      for (const c of cleanups.splice(0)) c();
      pause.remove();
      end.remove();
    },
  };
};
