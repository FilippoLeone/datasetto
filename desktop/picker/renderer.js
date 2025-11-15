const filters = document.querySelectorAll('.filter');
const grid = document.getElementById('sourcesGrid');
const shareBtn = document.getElementById('shareBtn');
const cancelBtn = document.getElementById('cancelBtn');
const closeBtn = document.getElementById('closeBtn');
const audioToggle = document.getElementById('audioToggle');

let sources = [];
let activeFilter = 'all';
let selectedId = null;
let allowAudio = false;
let shareAudio = true;

function getSelectedSource() {
  return sources.find((source) => source.id === selectedId) ?? null;
}

function renderSources() {
  grid.innerHTML = '';

  const filtered = sources.filter((source) => {
    if (activeFilter === 'all') {
      return true;
    }
    return source.type === activeFilter;
  });

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No sources available';
    grid.appendChild(empty);
    return;
  }

  for (const source of filtered) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `source-card${source.id === selectedId ? ' selected' : ''}`;
    card.dataset.id = source.id;
    card.dataset.type = source.type;

    const thumb = document.createElement('div');
    thumb.className = 'source-card__thumb';
    if (source.thumbnail) {
      const img = document.createElement('img');
      img.src = source.thumbnail;
      img.alt = source.name;
      thumb.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'placeholder';
      placeholder.textContent = source.type === 'screen' ? '🖥️' : '🪟';
      thumb.appendChild(placeholder);
    }
    card.appendChild(thumb);

    const meta = document.createElement('div');
    meta.className = 'source-card__meta';

    if (source.appIcon) {
      const icon = document.createElement('img');
      icon.src = source.appIcon;
      icon.alt = '';
      meta.appendChild(icon);
    }

    const textBlock = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = source.name || (source.type === 'screen' ? 'Screen' : 'Window');
    const subtitle = document.createElement('span');
    subtitle.textContent = source.type === 'screen' ? 'Display' : 'Application';

    textBlock.appendChild(title);
    textBlock.appendChild(subtitle);
    meta.appendChild(textBlock);

    card.appendChild(meta);

    card.addEventListener('click', () => selectSource(source.id));
    card.addEventListener('dblclick', () => {
      selectSource(source.id);
      confirmSelection();
    });

    grid.appendChild(card);
  }
}

function selectSource(id) {
  if (selectedId === id) {
    return;
  }
  selectedId = id;
  const selectedSource = getSelectedSource();
  if (selectedSource?.type === 'window') {
    shareAudio = false;
  }
  updateControls();
  renderSources();
}

function updateControls() {
  const selectedSource = getSelectedSource();
  shareBtn.disabled = !selectedSource;

  const audioAllowed = allowAudio && selectedSource?.type === 'screen';
  audioToggle.disabled = !audioAllowed;
  if (!audioAllowed) {
    audioToggle.checked = false;
  } else {
    audioToggle.checked = shareAudio;
  }
}

function confirmSelection() {
  const source = getSelectedSource();
  if (!source) {
    return;
  }

  window.pickerAPI.selectSource({
    source: {
      id: source.id,
      name: source.name,
      type: source.type,
      isScreen: source.type === 'screen',
    },
    shareAudio: Boolean(audioToggle.checked && allowAudio && source.type === 'screen'),
  });
}

filters.forEach((button) => {
  button.addEventListener('click', () => {
    activeFilter = button.dataset.filter || 'all';
    filters.forEach((btn) => btn.classList.toggle('active', btn === button));
    renderSources();
  });
});

shareBtn.addEventListener('click', confirmSelection);
cancelBtn.addEventListener('click', () => window.pickerAPI.cancel());
closeBtn.addEventListener('click', () => window.pickerAPI.cancel());
audioToggle.addEventListener('change', (event) => {
  shareAudio = event.target.checked;
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    window.pickerAPI.cancel();
  }
  if (event.key === 'Enter' && !shareBtn.disabled) {
    confirmSelection();
  }
});

window.pickerAPI.onSources((payload) => {
  sources = payload.sources ?? [];
  allowAudio = Boolean(payload.allowAudio);
  selectedId = null;
  shareAudio = allowAudio;
  renderSources();
  updateControls();
});
