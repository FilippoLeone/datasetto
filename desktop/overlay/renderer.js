// Voice overlay page. Draws the state the client sends through main.js
// (client/src/features/voice/voiceOverlayState.ts): the channel, one row per
// participant with a speaking ring and mute/deafen icons, and your own state in the
// header. Rows are reused by participant id so a change of speaker only touches the
// attributes that changed.
(() => {
  const api = window.overlayAPI;
  const card = document.getElementById('card');
  const channelEl = document.getElementById('channel');
  const statusEl = document.getElementById('status');
  const rowsEl = document.getElementById('rows');
  const moreEl = document.getElementById('more');
  const rowTemplate = document.getElementById('rowTemplate');

  const rows = new Map();
  let lastHeight = 0;

  const reportSize = () => {
    if (card.classList.contains('is-hidden')) {
      return;
    }
    // Layout height (offsetHeight ignores the enter animation's scale transform) plus the
    // 8 px body padding on each side (style.css).
    const height = Math.ceil(card.offsetHeight) + 16;
    if (height !== lastHeight && height > 0) {
      lastHeight = height;
      api.reportSize(height);
    }
  };

  const setStatus = (state) => {
    let text = '';
    let tone = '';
    if (state.deafened) {
      text = 'Deafened';
      tone = 'muted';
    } else if (state.muted) {
      text = 'Muted';
      tone = 'muted';
    } else if (state.pushToTalk) {
      text = state.transmitting ? 'Live' : 'Hold to talk';
      tone = state.transmitting ? 'live' : 'ptt';
    }
    if (!text) {
      statusEl.hidden = true;
      return;
    }
    if (statusEl.textContent !== text) {
      statusEl.textContent = text;
    }
    statusEl.dataset.tone = tone;
    statusEl.hidden = false;
  };

  const renderRow = (row, participant) => {
    const nameEl = row.querySelector('.row__name');
    const label = participant.name + (participant.self ? ' <small>(you)</small>' : '');
    if (nameEl.dataset.label !== label) {
      nameEl.dataset.label = label;
      nameEl.textContent = participant.name;
      if (participant.self) {
        const you = document.createElement('small');
        you.textContent = '(you)';
        nameEl.appendChild(you);
      }
    }
    const image = row.querySelector('.row__image');
    const src = participant.avatarUrl || '';
    if (image.dataset.src !== src) {
      image.dataset.src = src;
      if (src) {
        image.src = src;
        image.hidden = false;
      } else {
        image.removeAttribute('src');
        image.hidden = true;
      }
    }
    row.dataset.speaking = String(participant.speaking);
    row.dataset.muted = String(participant.muted);
    row.dataset.deafened = String(participant.deafened);
    row.title = participant.name + (participant.self ? ' (you)' : '');
  };

  const render = (state) => {
    if (!state) {
      card.classList.add('is-hidden');
      rowsEl.replaceChildren();
      rows.clear();
      lastHeight = 0;
      return;
    }
    if (channelEl.textContent !== state.channelName) {
      channelEl.textContent = state.channelName;
    }
    setStatus(state);

    const seen = new Set();
    const ordered = [];
    for (const participant of state.participants) {
      let row = rows.get(participant.id);
      if (!row) {
        row = rowTemplate.content.firstElementChild.cloneNode(true);
        rows.set(participant.id, row);
      }
      renderRow(row, participant);
      seen.add(participant.id);
      ordered.push(row);
    }
    for (const [id, row] of rows) {
      if (!seen.has(id)) {
        rows.delete(id);
        row.remove();
      }
    }
    // Reorder only when the order changed, so untouched rows keep their animation state.
    const current = [...rowsEl.children];
    if (current.length !== ordered.length || current.some((row, index) => row !== ordered[index])) {
      rowsEl.replaceChildren(...ordered);
    }

    if (state.more > 0) {
      moreEl.textContent = '+' + state.more + ' more';
      moreEl.hidden = false;
    } else {
      moreEl.hidden = true;
    }

    card.classList.remove('is-hidden');
    reportSize();
  };

  api.onState(render);
  new ResizeObserver(() => reportSize()).observe(card);
  card.addEventListener('animationend', () => reportSize());
  // Avatars that load late change nothing in height (fixed size), but fonts may.
  document.fonts?.ready.then(() => reportSize()).catch(() => undefined);
})();
