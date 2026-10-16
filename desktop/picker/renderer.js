// Screen share picker window. Talks to desktop/main.js through window.pickerAPI
// (picker/preload.js). The result handed back is unchanged:
//   { source: { id, name, type, display_id, isScreen }, shareAudio }
'use strict';

const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
const grid = document.getElementById('sourcesGrid');
const shareBtn = document.getElementById('shareBtn');
const cancelBtn = document.getElementById('cancelBtn');
const closeBtn = document.getElementById('closeBtn');
const audioRow = document.getElementById('audioRow');
const audioHint = document.getElementById('audioHint');
const qualityHint = document.getElementById('qualityHint');
const cardTemplate = document.getElementById('cardTemplate');

const AUDIO_HINT = 'Sends everything your computer plays (game sound, music), not just the picked window. Wear headphones so your friends are not echoed back.';
const AUDIO_UNAVAILABLE_HINT = 'System audio is not available for this share.';

const state = {
  sources: [],
  tab: 'screen',
  selectedId: null,
  allowAudio: false,
  shareAudio: true,
  /** Cards currently in the grid, by source id (kept across thumbnail refreshes). */
  cards: new Map(),
};

const sourcesIn = (tab) => state.sources.filter((source) => source.type === tab);
const selectedSource = () => state.sources.find((source) => source.id === state.selectedId) ?? null;
const visibleCards = () => Array.from(grid.querySelectorAll('.card'));

const formatSubtitle = (source) => {
  if (source.type === 'screen') {
    const parts = [];
    if (source.display && source.display.width && source.display.height) parts.push(source.display.width + ' × ' + source.display.height);
    if (source.display && source.display.primary) parts.push('Primary display');
    return parts.length > 0 ? parts.join(' · ') : 'Display';
  }
  return source.appName || 'Window';
};

// SVG elements have no `hidden` property, so visibility is a class on both kinds of node.
const setShown = (node, shown) => node.classList.toggle('is-hidden', !shown);

const applyImage = (img, src) => {
  if (src) {
    if (img.getAttribute('src') !== src) img.src = src;
    setShown(img, true);
    return true;
  }
  setShown(img, false);
  img.removeAttribute('src');
  return false;
};

const fillCard = (card, source) => {
  card.dataset.id = source.id;
  card.dataset.type = source.type;
  card.setAttribute('aria-label', source.name || (source.type === 'screen' ? 'Screen' : 'Window'));
  card.title = source.name || '';
  const hasThumb = applyImage(card.querySelector('.card__image'), source.thumbnail);
  setShown(card.querySelector('.card__placeholder'), !hasThumb);
  // Screens always get the monitor glyph; window cards show their app's icon when Electron has one.
  const hasIcon = applyImage(card.querySelector('.card__icon:not(.card__icon--fallback)'), source.type === 'window' ? source.appIcon : null);
  setShown(card.querySelector('.card__icon--fallback'), !hasIcon);
  card.querySelector('.card__title').textContent = source.name || (source.type === 'screen' ? 'Screen' : 'Window');
  card.querySelector('.card__subtitle').textContent = formatSubtitle(source);
};

const createCard = (source) => {
  const card = cardTemplate.content.firstElementChild.cloneNode(true);
  fillCard(card, source);
  card.addEventListener('click', () => select(source.id, { focus: false }));
  card.addEventListener('dblclick', () => {
    select(source.id, { focus: false });
    confirm();
  });
  return card;
};

const updateSelectionUi = () => {
  for (const card of state.cards.values()) {
    const selected = card.dataset.id === state.selectedId;
    card.setAttribute('aria-selected', selected ? 'true' : 'false');
    card.tabIndex = selected ? 0 : -1;
  }
  // Keep one card reachable with Tab even before anything is selected.
  if (!visibleCards().some((card) => card.tabIndex === 0)) {
    const first = visibleCards()[0];
    if (first) first.tabIndex = 0;
  }
  const source = selectedSource();
  shareBtn.disabled = !source;
  shareBtn.textContent = source ? (source.type === 'screen' ? 'Share screen' : 'Share window') : 'Share';
  audioRow.disabled = !state.allowAudio;
  audioRow.setAttribute('aria-checked', state.allowAudio && state.shareAudio ? 'true' : 'false');
  audioHint.textContent = state.allowAudio ? AUDIO_HINT : AUDIO_UNAVAILABLE_HINT;
};

const renderGrid = () => {
  const list = sourcesIn(state.tab);
  grid.dataset.tab = state.tab;
  for (const tab of tabs) {
    const active = tab.dataset.tab === state.tab;
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.tabIndex = active ? 0 : -1;
    const count = tab.querySelector('.tab__count');
    if (count) count.textContent = String(sourcesIn(tab.dataset.tab).length);
  }

  const wanted = new Set(list.map((source) => source.id));
  for (const [id, card] of state.cards) {
    if (!wanted.has(id)) {
      card.remove();
      state.cards.delete(id);
    }
  }
  grid.querySelector('.empty')?.remove();

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = state.tab === 'screen' ? 'No screens were found.' : 'No windows to share. Open the app you want to show and it appears here.';
    grid.appendChild(empty);
  }

  list.forEach((source, index) => {
    let card = state.cards.get(source.id);
    if (!card) {
      card = createCard(source);
      state.cards.set(source.id, card);
    } else {
      fillCard(card, source);
    }
    // Keep DOM order equal to list order without touching cards already in place.
    const current = grid.children[index];
    if (current !== card) grid.insertBefore(card, current ?? null);
  });

  updateSelectionUi();
};

function select(id, { focus = true } = {}) {
  state.selectedId = id;
  updateSelectionUi();
  if (focus) state.cards.get(id)?.focus({ preventScroll: false });
  else state.cards.get(id)?.scrollIntoView({ block: 'nearest' });
}

const switchTab = (tab, { focusTab = false } = {}) => {
  if (!['screen', 'window'].includes(tab)) return;
  state.tab = tab;
  const list = sourcesIn(tab);
  if (!list.some((source) => source.id === state.selectedId)) state.selectedId = list[0]?.id ?? null;
  renderGrid();
  if (focusTab) tabs.find((button) => button.dataset.tab === tab)?.focus();
  if (state.selectedId) state.cards.get(state.selectedId)?.scrollIntoView({ block: 'nearest' });
};

function confirm() {
  const source = selectedSource();
  if (!source) return;
  window.pickerAPI.selectSource({
    source: {
      id: source.id,
      name: source.name,
      type: source.type,
      display_id: source.display_id,
      isScreen: source.type === 'screen',
    },
    shareAudio: Boolean(state.allowAudio && state.shareAudio),
  });
}

const cancel = () => window.pickerAPI.cancel();

/** Columns currently laid out in the grid, for Up/Down arrow moves. */
const columnCount = () => {
  const cards = visibleCards();
  if (cards.length < 2) return 1;
  const top = cards[0].offsetTop;
  let columns = 1;
  while (columns < cards.length && cards[columns].offsetTop === top) columns += 1;
  return columns;
};

const moveSelection = (delta) => {
  const cards = visibleCards();
  if (cards.length === 0) return;
  const index = cards.findIndex((card) => card.dataset.id === state.selectedId);
  const next = index === -1 ? (delta > 0 ? 0 : cards.length - 1) : Math.min(cards.length - 1, Math.max(0, index + delta));
  select(cards[next].dataset.id);
};

grid.addEventListener('keydown', (event) => {
  const keys = {
    ArrowRight: () => moveSelection(1),
    ArrowLeft: () => moveSelection(-1),
    ArrowDown: () => moveSelection(columnCount()),
    ArrowUp: () => moveSelection(-columnCount()),
    Home: () => moveSelection(-Infinity),
    End: () => moveSelection(Infinity),
  };
  const handler = keys[event.key];
  if (handler) {
    event.preventDefault();
    handler();
  }
});

for (const tab of tabs) {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  tab.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const index = tabs.indexOf(tab);
      const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      switchTab(next.dataset.tab, { focusTab: true });
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (state.selectedId) state.cards.get(state.selectedId)?.focus();
      else visibleCards()[0]?.focus();
    }
  });
}

audioRow.addEventListener('click', () => {
  if (!state.allowAudio) return;
  state.shareAudio = !state.shareAudio;
  updateSelectionUi();
});

shareBtn.addEventListener('click', confirm);
cancelBtn.addEventListener('click', cancel);
closeBtn.addEventListener('click', cancel);

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancel();
    return;
  }
  if (event.key === 'Enter') {
    // Enter on a button presses that button; anywhere else (a card, the grid) it shares.
    const target = event.target;
    const onControl = target instanceof HTMLElement && target.matches('button:not(.card)');
    if (!onControl && !shareBtn.disabled) {
      event.preventDefault();
      confirm();
    }
  }
});

const describeQuality = (quality) => {
  if (!quality || !quality.width || !quality.height) return 'Quality follows the screen share preset in Voice & audio settings.';
  const fps = quality.fps ? ' · ' + quality.fps + ' fps' : '';
  return 'Shared at ' + quality.width + ' × ' + quality.height + fps + '. Change it under Voice & audio › Screen share quality.';
};

window.pickerAPI.onSources((payload) => {
  state.sources = Array.isArray(payload.sources) ? payload.sources : [];
  state.allowAudio = Boolean(payload.allowAudio);
  if (payload.update) {
    // Thumbnail refresh: keep the tab, the selection and the audio choice.
    if (state.selectedId && !state.sources.some((source) => source.id === state.selectedId)) state.selectedId = sourcesIn(state.tab)[0]?.id ?? null;
    renderGrid();
    return;
  }
  state.shareAudio = state.allowAudio;
  qualityHint.textContent = describeQuality(payload.quality);
  const tab = sourcesIn('screen').length > 0 ? 'screen' : 'window';
  state.selectedId = sourcesIn(tab)[0]?.id ?? null;
  switchTab(tab);
  // Focus the preselected card so arrows and Enter work right away.
  if (state.selectedId) state.cards.get(state.selectedId)?.focus({ preventScroll: true });
  else tabs.find((button) => button.dataset.tab === tab)?.focus();
});
