/**
 * The hall's DOM chrome (glimmerhall.md §12.1–§12.2), built once at mount: the top bar (balance
 * and session net, Glimmer Dash, "How it works"), the machine tabs, the reels box, the win meter,
 * the Glimmer Pot, the friends strip, the thumb-zone controls and the play-money footer. Updates
 * are direct `textContent` and class writes; nothing here renders per frame.
 */
import { DEFS_BY_IDX, type MachineIdx } from '@arcade/core/glimmer/machines';
import { uiSpriteUrl } from './art';
import { CSS } from './css';
import { button, fmt, h, setText, signed } from './ui';

export const PLAY_MONEY = "Chips are play money. They can't be bought, sold, cashed out or traded, and they're worth nothing.";
export const SHORT_NAMES = ['Orchard', 'Tidepool', 'Ember Vault'] as const;

export interface Hall {
  root: HTMLDivElement;
  reelHost: HTMLDivElement;
  hits: HTMLDivElement;
  doorButtons: HTMLButtonElement[];
  tabs: HTMLButtonElement[];
  bal: HTMLButtonElement;
  dashBtn: HTMLButtonElement;
  helpBtn: HTMLButtonElement;
  betMinus: HTMLButtonElement;
  betPlus: HTMLButtonElement;
  spin: HTMLButtonElement;
  auto: HTMLButtonElement;
  fold: HTMLButtonElement;
  friends: HTMLDivElement;
  play: HTMLDivElement;
  setMachine(m: MachineIdx): void;
  setBalance(n: number, label?: string): void;
  setNet(n: number): void;
  setBet(text: string, caption: string): void;
  setMeter(text: string, kind: 'win' | 'small' | 'idle'): void;
  setSub(text: string): void;
  setPot(n: number | null): void;
  banner(text: string): void;
  say(text: string): void;
  /** Shows a sheet (one at a time); returns its close function. */
  sheet(card: HTMLElement, onClose?: () => void): () => void;
  closeSheet(): void;
  readonly sheetOpen: boolean;
  /** "Paused · tap to return" and similar full-hall notices. */
  cover(text: string | null): void;
  dispose(): void;
}

export const createHall = (stage: HTMLElement, o: { mode: 'local' | 'remote' }): Hall => {
  const style = h('style');
  style.textContent = CSS;
  const root = h('div', 'gh');
  root.tabIndex = 0;
  root.setAttribute('role', 'application');
  root.setAttribute('aria-label', 'Glimmerhall');
  root.dataset.mode = o.mode;

  // Top bar.
  const top = h('div', 'gh-top');
  const bal = button('gh-bal', '', 'Balance and this session');
  const coin = h('img');
  coin.alt = '';
  coin.width = coin.height = 18;
  coin.src = uiSpriteUrl(o.mode === 'local' ? 'leaf' : 'coin', 2);
  const balN = h('span', '', '0');
  const net = h('span', 'gh-net', '');
  bal.append(coin, balN, net);
  if (o.mode === 'local') bal.append(h('span', 'gh-badge', 'PRACTICE'));
  const dashBtn = button('gh-pill', 'Dash', 'Glimmer Dash');
  const helpBtn = button('gh-round', '?', 'How it works');
  top.append(bal, h('div', 'gh-sp'), dashBtn, helpBtn);

  // Machine tabs.
  const tabsRow = h('div', 'gh-tabs');
  tabsRow.setAttribute('role', 'tablist');
  tabsRow.setAttribute('aria-label', 'Machines');
  const tabs = DEFS_BY_IDX.map((def, i) => {
    const t = button('gh-tab', SHORT_NAMES[i] as string);
    t.setAttribute('role', 'tab');
    t.title = def.name;
    tabsRow.append(t);
    return t;
  });

  // Body: the play column and the hall side (friends, pot).
  const body = h('div', 'gh-body');
  const play = h('div', 'gh-play');
  const reelBox = h('div', 'gh-reelbox');
  const reelHost = h('div', 'gh-reels');
  const hits = h('div', 'gh-hits');
  hits.hidden = true;
  const doorButtons = [0, 1, 2].map((d) => {
    const b = button('', '', 'Open door ' + (d + 1));
    hits.append(b);
    return b;
  });
  reelBox.append(reelHost, hits);
  const meter = h('div', 'gh-meter');
  const meterWin = h('div', 'gh-win idle', 'Good luck');
  const meterSub = h('div', 'gh-sub', '');
  meter.append(meterWin, meterSub);
  const ctrl = h('div', 'gh-ctrl');
  const betMinus = button('gh-sq', '−', 'Lower bet');
  const bet = h('div', 'gh-bet');
  const betN = h('b', '', '');
  const betCap = h('span', '', 'Bet');
  bet.append(betN, betCap);
  const betPlus = button('gh-sq', '+', 'Raise bet');
  const spin = button('gh-spin', 'SPIN', 'Spin');
  const auto = button('gh-auto', 'Auto', 'Auto-spin');
  ctrl.append(betMinus, bet, betPlus, spin, auto);
  play.append(reelBox, meter, ctrl);

  const side = h('div', 'gh-side');
  const pot = h('div', 'gh-pot');
  const potN = h('b', '', '');
  pot.append(h('span', '', 'Glimmer Pot'), potN);
  const friends = h('div', 'gh-friends');
  friends.setAttribute('aria-label', 'In the hall');
  const fold = button('gh-fold', '‹', 'Hide the hall');
  side.append(pot, friends);
  body.append(play, side);

  const foot = h('div', 'gh-foot', PLAY_MONEY);
  const live = h('div', 'gh-sr');
  live.setAttribute('aria-live', 'polite');
  root.append(style, top, tabsRow, body, foot, live);
  stage.append(root);

  let sheetEl: HTMLDivElement | null = null;
  let sheetClose: (() => void) | null = null;
  let coverEl: HTMLDivElement | null = null;

  const closeSheet = (): void => {
    if (!sheetEl) return;
    sheetEl.remove();
    sheetEl = null;
    const cb = sheetClose;
    sheetClose = null;
    cb?.();
  };

  return {
    root,
    reelHost,
    hits,
    doorButtons,
    tabs,
    bal,
    dashBtn,
    helpBtn,
    betMinus,
    betPlus,
    spin,
    auto,
    fold,
    friends,
    play,
    setMachine(m) {
      root.dataset.m = String(m);
      tabs.forEach((t, i) => t.setAttribute('aria-selected', String(i === m)));
    },
    setBalance(n, label) {
      setText(balN, label ?? fmt(n));
    },
    setNet(n) {
      setText(net, n === 0 ? '' : signed(n));
      net.classList.toggle('up', n > 0);
    },
    setBet(text, caption) {
      setText(betN, text);
      setText(betCap, caption);
    },
    setMeter(text, kind) {
      setText(meterWin, text);
      meterWin.className = 'gh-win' + (kind === 'win' ? '' : ' ' + kind);
    },
    setSub(text) {
      setText(meterSub, text);
    },
    setPot(n) {
      pot.classList.toggle('on', n !== null);
      if (n !== null) setText(potN, fmt(n));
    },
    banner(text) {
      const b = h('div', 'gh-banner', text);
      b.addEventListener('animationend', () => b.remove(), { once: true });
      play.append(b);
      // At most two banners at once.
      const all = play.querySelectorAll('.gh-banner');
      if (all.length > 2) all[0]?.remove();
    },
    say(text) {
      setText(live, text);
    },
    sheet(card, onClose) {
      closeSheet();
      const wrap = h('div', 'gh-sheet');
      wrap.append(card);
      wrap.addEventListener('pointerdown', (e) => {
        if (e.target === wrap) closeSheet();
      });
      root.append(wrap);
      sheetEl = wrap;
      sheetClose = onClose ?? null;
      return closeSheet;
    },
    closeSheet,
    get sheetOpen() {
      return sheetEl !== null;
    },
    cover(text) {
      if (text === null) {
        coverEl?.remove();
        coverEl = null;
        return;
      }
      if (!coverEl) {
        coverEl = h('div', 'gh-paused');
        root.append(coverEl);
      }
      setText(coverEl, text);
    },
    dispose() {
      closeSheet();
      root.remove();
    },
  };
};

/** A card with a title and a close button. */
export const card = (title: string, onClose: () => void, offs: (() => void)[]): { el: HTMLDivElement; body: HTMLDivElement } => {
  const el = h('div', 'gh-card');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', title);
  const x = button('gh-x', '×', 'Close');
  const fn = (): void => onClose();
  x.addEventListener('click', fn);
  offs.push(() => x.removeEventListener('click', fn));
  const body = h('div');
  el.append(x, h('h3', '', title), body);
  return { el, body };
};
