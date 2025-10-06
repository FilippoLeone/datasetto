import Hls from 'hls.js';
import { io } from 'socket.io-client';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:4000';
const HLS_BASE_URL = import.meta.env.VITE_HLS_BASE_URL || 'http://localhost/hls';

const els = {
  name: document.getElementById('name'),
  channel: document.getElementById('channel'),
  join: document.getElementById('join'),
  presence: document.getElementById('presence'),
  video: document.getElementById('video'),
  streamKey: document.getElementById('streamKey'),
  micSelect: document.getElementById('micSelect'),
  spkSelect: document.getElementById('spkSelect'),
  voiceJoin: document.getElementById('voiceJoin'),
  mute: document.getElementById('mute'),
  deafen: document.getElementById('deafen'),
  msgs: document.getElementById('msgs'),
  chatForm: document.getElementById('chatForm'),
  chatInput: document.getElementById('chatInput'),
  // Account
  accName: document.getElementById('accName'),
  changeName: document.getElementById('changeName'),
  logout: document.getElementById('logout'),
  // Modal
  regModal: document.getElementById('regModal'),
  regTitle: document.getElementById('regTitle'),
  regUsername: document.getElementById('regUsername'),
  regPassword: document.getElementById('regPassword'),
  regConfirm: document.getElementById('regConfirm'),
  registerBtn: document.getElementById('registerBtn'),
  regCancel: document.getElementById('regCancel'),
  regError: document.getElementById('regError'),
  // Settings
  echoCancel: document.getElementById('echoCancel'),
  noiseSuppression: document.getElementById('noiseSuppression'),
  autoGain: document.getElementById('autoGain'),
  micGain: document.getElementById('micGain'),
  outputVol: document.getElementById('outputVol'),
  pttEnable: document.getElementById('pttEnable'),
  pttKey: document.getElementById('pttKey'),
  pttSetKey: document.getElementById('pttSetKey'),
  micLevel: document.getElementById('micLevel'),
  micGainVal: document.getElementById('micGainVal'),
  outputVolVal: document.getElementById('outputVolVal'),
  startMic: document.getElementById('startMic'),
  presenceList: document.getElementById('presenceList'),
  playerOverlay: document.getElementById('playerOverlay'),
  toggleSidebar: document.getElementById('toggleSidebar'),
  channelsList: document.getElementById('channelsList'),
  newChannelName: document.getElementById('newChannelName'),
  createChannel: document.getElementById('createChannel'),
  drawerBackdrop: document.getElementById('drawerBackdrop'),
};
let socket;
let currentChannel = 'lobby';
let localStream = null;
let peers = new Map(); // id -> RTCPeerConnection
let muted = false;
let deafened = false;
let account = null; // { username, passwordHash? }
let settings = null; // persisted device/audio settings
let pttActive = false;
let pttKeyCode = '';
let micAnalyser = null;
let micGainNode = null;
let audioCtx = null;
let remoteAudios = new Map(); // id -> audio element
let remoteMonitors = new Map(); // id -> { rafId, analyser, src, stop }

function log(msg) { console.log(msg); }

function setupPlayer(channel) {
  // Default alfg/nginx-rtmp path: /hls/<stream>/index.m3u8
  const m3u8 = `${HLS_BASE_URL}/${encodeURIComponent(channel)}/index.m3u8`;
  if (Hls.isSupported()) {
    const hls = new Hls({ maxLiveSyncPlaybackRate: 1.5 });
    hls.loadSource(m3u8);
    hls.attachMedia(els.video);
  } else if (els.video.canPlayType('application/vnd.apple.mpegurl')) {
    els.video.src = m3u8;
  }
  // Overlay until we get data
  if (els.playerOverlay) els.playerOverlay.style.display = 'flex';
  els.video.onplaying = () => { if (els.playerOverlay) els.playerOverlay.style.display = 'none'; };
}

// Local account storage
const LS_KEY = 'rtmpdisc.account.v1';
function hash(str) {
  // very lightweight non-crypto hash to avoid storing plain text; not secure by design
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
function loadAccount() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    account = raw ? JSON.parse(raw) : null;
  } catch { account = null; }
}
function saveAccount() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(account)); } catch {}
}
function updateAccountUI() {
  const name = account?.username || 'guest';
  els.accName.textContent = name;
  if (els.name) els.name.value = name;
}
function showModal(show) { els.regModal.classList.toggle('active', !!show); }
function openRegisterModal(mode = 'create') {
  els.regTitle.textContent = mode === 'edit' ? 'Update your profile' : 'Create your guest account';
  els.regUsername.value = account?.username || '';
  els.regPassword.value = '';
  els.regConfirm.value = '';
  els.regError.textContent = '';
  showModal(true);
}
function handleRegisterSave() {
  const username = (els.regUsername.value || '').trim().slice(0, 32);
  const pwd = els.regPassword.value || '';
  const conf = els.regConfirm.value || '';
  if (!username) { els.regError.textContent = 'Display name is required.'; return; }
  if (pwd !== conf) { els.regError.textContent = 'Passwords do not match.'; return; }
  const payload = { username };
  if (pwd) payload.passwordHash = hash(pwd);
  account = payload;
  saveAccount();
  updateAccountUI();
  if (socket && socket.connected) socket.emit('setName', username);
  showModal(false);
}

function renderPresence(users) {
  els.presence.textContent = `Online: ${users.map(u => u.name).join(', ')}`;
  // Build detailed list with per-user mute (local only)
  if (!els.presenceList) return;
  els.presenceList.innerHTML = '';
  users.forEach(u => {
    const row = document.createElement('div');
    row.className = 'user';
  row.dataset.id = u.id;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = u.name;
    const actions = document.createElement('span');
    const btn = document.createElement('button');
  const aud = remoteAudios.get(u.id);
  btn.textContent = aud && aud.muted ? 'Unmute' : 'Mute';
    btn.onclick = () => {
      const el = remoteAudios.get(u.id);
      if (el) el.muted = !el.muted;
      btn.textContent = el && el.muted ? 'Unmute' : 'Mute';
    };
    actions.appendChild(btn);
    row.appendChild(name);
    row.appendChild(actions);
    els.presenceList.appendChild(row);
  });
}

function renderChannels(list) {
  if (!els.channelsList) return;
  els.channelsList.innerHTML = '';
  list.forEach(ch => {
    const row = document.createElement('div');
    row.className = 'user';
    const left = document.createElement('span');
    left.className = 'name';
    left.textContent = `${ch.name} (${ch.count})`;
    if (ch.name === currentChannel) left.style.color = '#3498db';
    const actions = document.createElement('span');
    const joinBtn = document.createElement('button');
    joinBtn.textContent = ch.name === currentChannel ? 'Joined' : 'Join';
    joinBtn.disabled = ch.name === currentChannel;
    joinBtn.onclick = () => {
      currentChannel = ch.name;
      els.channel.value = ch.name;
      els.streamKey.textContent = ch.name;
      socket.emit('join', ch.name);
      setupPlayer(ch.name);
    };
    actions.appendChild(joinBtn);
    if (ch.name !== 'lobby' && ch.count === 0) {
      const delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      delBtn.onclick = () => socket.emit('channels:delete', ch.name);
      actions.appendChild(delBtn);
    }
    row.appendChild(left);
    row.appendChild(actions);
    els.channelsList.appendChild(row);
  });
}

function appendMsg({ from, text, ts }) {
  const div = document.createElement('div');
  const date = new Date(ts).toLocaleTimeString();
  div.textContent = `[${date}] ${from}: ${text}`;
  els.msgs.appendChild(div);
  els.msgs.scrollTop = els.msgs.scrollHeight;
}

async function listDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter(d => d.kind === 'audioinput');
  const spks = devices.filter(d => d.kind === 'audiooutput');

  els.micSelect.innerHTML = mics.map(d => `<option value="${d.deviceId}">${d.label || 'Microphone'}</option>`).join('');
  els.spkSelect.innerHTML = spks.map(d => `<option value="${d.deviceId}">${d.label || 'Speaker'}</option>`).join('');
}

function getAudioConstraints() {
  const deviceId = els.micSelect.value || undefined;
  return {
    noiseSuppression: !!els.noiseSuppression?.checked,
    echoCancellation: !!els.echoCancel?.checked,
    autoGainControl: !!els.autoGain?.checked,
    deviceId: deviceId ? { exact: deviceId } : undefined
  };
}

async function getLocalStream() {
  const audio = getAudioConstraints();
  const stream = await navigator.mediaDevices.getUserMedia({ audio });
  // Setup Web Audio for mic gain and meter
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(stream);
  micGainNode = audioCtx.createGain();
  micGainNode.gain.value = Number(els.micGain?.value || 1) || 1;
  if (els.micGainVal) els.micGainVal.textContent = `${micGainNode.gain.value.toFixed(1)}x`;
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(micGainNode).connect(analyser);
  micAnalyser = analyser;
  // Meter loop
  const data = new Uint8Array(analyser.frequencyBinCount);
  const loop = () => {
    if (!micAnalyser) return;
    micAnalyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i] - 128) / 128;
      if (v > peak) peak = v;
    }
  if (els.micLevel) els.micLevel.style.width = `${Math.min(100, Math.round(peak * 100))}%`;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  // Create processed stream for WebRTC
  const dest = audioCtx.createMediaStreamDestination();
  micGainNode.connect(dest);
  localStream = dest.stream;
  // Apply mute state
  setMuted(muted);
  return localStream;
}

function createPeer(id) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('voice:signal', { to: id, data: { candidate: e.candidate } });
  };

  pc.ontrack = (e) => {
    // Remote audio element per peer
  let el = document.getElementById(`aud-${id}`);
    if (!el) {
      el = document.createElement('audio');
      el.id = `aud-${id}`;
      el.autoplay = true;
      if (deafened) el.muted = true;
      // Apply current output volume and sink device if supported
      try { el.volume = Number(els.outputVol?.value || 1); } catch {}
      const sink = els.spkSelect?.value;
      if (sink && typeof el.setSinkId === 'function') {
        el.setSinkId(sink).catch(() => {});
      }
      document.body.appendChild(el);
    }
    el.srcObject = e.streams[0];
  remoteAudios.set(id, el);

    // Speaking indicator using Web Audio analyser on remote stream
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(e.streams[0]);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        const speaking = peak > 0.07; // threshold
        const row = document.querySelector(`.presence-list .user[data-id="${id}"]`);
        if (row) row.classList.toggle('speaking', speaking);
        const h = requestAnimationFrame(tick);
        const m = remoteMonitors.get(id);
        if (m) m.rafId = h;
      };
      const rafId = requestAnimationFrame(tick);
      remoteMonitors.set(id, {
        analyser,
        src,
        rafId,
        stop: () => {
          const m = remoteMonitors.get(id);
          if (!m) return;
          try { cancelAnimationFrame(m.rafId); } catch {}
          try { src.disconnect(); } catch {}
          try { analyser.disconnect(); } catch {}
        }
      });
    } catch {}
  };

  // Add local audio track if available
  if (localStream) {
    for (const track of localStream.getAudioTracks()) pc.addTrack(track, localStream);
  }

  peers.set(id, pc);
  return pc;
}

function cleanupPeer(id) {
  const pc = peers.get(id);
  if (pc) {
    pc.getSenders().forEach(s => s.track && s.track.stop());
    pc.close();
  }
  peers.delete(id);
  const el = document.getElementById(`aud-${id}`);
  if (el) el.remove();
  const mon = remoteMonitors.get(id);
  if (mon) { try { mon.stop(); } catch {} remoteMonitors.delete(id); }
}

function voiceJoin() {
  socket.emit('voice:join');
}

function voiceLeave() {
  socket.emit('voice:leave');
  for (const id of peers.keys()) cleanupPeer(id);
}

function setMuted(m) {
  muted = m;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !muted);
}

function setDeafened(d) {
  deafened = d;
  document.querySelectorAll('audio').forEach(a => a.muted = d);
}

function connect() {
  socket = io(SERVER_URL, { transports: ['websocket'] });

  socket.on('connect', () => {
  const username = account?.username || els.name.value || 'guest';
  socket.emit('setName', username);
    socket.emit('join', currentChannel);
  });

  socket.on('presence', (users) => renderPresence(users));
  socket.on('chat', appendMsg);
  socket.on('channels:data', (list) => renderChannels(list));
  socket.on('channels:update', (list) => renderChannels(list));

  socket.on('voice:peer-join', ({ id, name }) => {
    // Initiator side
    createPeer(id);
    (async () => {
      const pc = peers.get(id);
      if (!localStream) await getLocalStream();
      for (const track of localStream.getAudioTracks()) pc.addTrack(track, localStream);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('voice:signal', { to: id, data: { sdp: pc.localDescription } });
    })();
  });

  socket.on('voice:peer-leave', ({ id }) => cleanupPeer(id));

  socket.on('voice:signal', async ({ from, data }) => {
    let pc = peers.get(from);
    if (!pc) pc = createPeer(from);

    if (data.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      if (data.sdp.type === 'offer') {
        if (!localStream) await getLocalStream();
        for (const track of localStream.getAudioTracks()) pc.addTrack(track, localStream);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('voice:signal', { to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) { console.warn(e); }
    }
  });
}

// UI bindings
els.join.addEventListener('click', () => {
  const ch = els.channel.value || 'lobby';
  currentChannel = ch;
  els.streamKey.textContent = ch;
  setupPlayer(ch);
  if (socket) socket.emit('join', ch); else connect();
});

els.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const msg = els.chatInput.value;
  if (!msg) return;
  socket.emit('chat', msg);
  els.chatInput.value = '';
});

els.voiceJoin.addEventListener('click', async () => {
  if (!localStream) await getLocalStream();
  voiceJoin();
});

els.mute.addEventListener('click', () => setMuted(!muted));
els.deafen.addEventListener('click', () => setDeafened(!deafened));

// Change input device
els.micSelect.addEventListener('change', async () => {
  if (localStream) {
    // Stop previous tracks
    localStream.getTracks().forEach(t => t.stop());
  }
  await getLocalStream();
  // Replace tracks on all peer connections
  for (const pc of peers.values()) {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
    if (sender) {
      const track = localStream.getAudioTracks()[0];
      try { await sender.replaceTrack(track); } catch {}
    }
  }
});

// Change output device (speakers) if supported
els.spkSelect.addEventListener('change', async () => {
  const deviceId = els.spkSelect.value;
  const audios = Array.from(document.querySelectorAll('audio'));
  for (const a of audios) {
    if (typeof a.setSinkId === 'function') {
      try { await a.setSinkId(deviceId); } catch (e) { console.warn('setSinkId failed', e); }
    }
  }
});

// Account UI events
els.changeName.addEventListener('click', () => openRegisterModal('edit'));
els.logout.addEventListener('click', () => {
  account = null;
  saveAccount();
  updateAccountUI();
  if (socket && socket.connected) socket.emit('setName', 'guest');
});
els.registerBtn.addEventListener('click', handleRegisterSave);
els.regCancel.addEventListener('click', () => showModal(false));

// Settings persistence
const LS_SETTINGS = 'rtmpdisc.settings.v1';
function loadSettings() {
  try { settings = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}'); } catch { settings = {}; }
  els.echoCancel.checked = settings.echoCancel ?? true;
  els.noiseSuppression.checked = settings.noiseSuppression ?? true;
  els.autoGain.checked = settings.autoGain ?? true;
  els.micGain.value = settings.micGain ?? 1;
  els.outputVol.value = settings.outputVol ?? 1;
  els.pttEnable.checked = settings.pttEnable ?? false;
  els.pttKey.value = settings.pttKey || '';
  pttKeyCode = els.pttKey.value || '';
}
function saveSettings() {
  settings = {
    echoCancel: els.echoCancel.checked,
    noiseSuppression: els.noiseSuppression.checked,
    autoGain: els.autoGain.checked,
    micGain: Number(els.micGain.value || 1),
    outputVol: Number(els.outputVol.value || 1),
    pttEnable: els.pttEnable.checked,
    pttKey: els.pttKey.value || ''
  };
  try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch {}
}

['echoCancel','noiseSuppression','autoGain','micGain','outputVol','pttEnable'].forEach(id => {
  els[id].addEventListener('change', async () => {
    saveSettings();
    if (id === 'micGain' && micGainNode) micGainNode.gain.value = Number(els.micGain.value || 1);
  if (id === 'micGain' && els.micGainVal) els.micGainVal.textContent = `${Number(els.micGain.value || 1).toFixed(1)}x`;
    if (id === 'outputVol') document.querySelectorAll('audio').forEach(a => a.volume = Number(els.outputVol.value || 1));
  if (id === 'outputVol' && els.outputVolVal) els.outputVolVal.textContent = `${Math.round(Number(els.outputVol.value || 1)*100)}%`;
    if (id === 'echoCancel' || id === 'noiseSuppression' || id === 'autoGain') {
      if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        await getLocalStream();
        for (const pc of peers.values()) {
          const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
          if (sender) { try { await sender.replaceTrack(localStream.getAudioTracks()[0]); } catch {} }
        }
      }
    }
  });
});

let captureNextKey = false;
els.pttSetKey.addEventListener('click', (e) => {
  e.preventDefault();
  captureNextKey = true;
  els.pttKey.value = 'Press a key…';
});
window.addEventListener('keydown', (e) => {
  if (captureNextKey) {
    e.preventDefault();
    pttKeyCode = e.code;
    els.pttKey.value = pttKeyCode;
    captureNextKey = false;
    saveSettings();
    return;
  }
  if (els.pttEnable.checked && e.code === pttKeyCode) {
    pttActive = true;
    setMuted(false);
  }
});
window.addEventListener('keyup', (e) => {
  if (els.pttEnable.checked && e.code === pttKeyCode) {
    pttActive = false;
    setMuted(true);
  }
});

// Default
loadAccount();
updateAccountUI();
loadSettings();
// Initialize value labels from settings
if (els.micGainVal) els.micGainVal.textContent = `${Number(els.micGain?.value || 1).toFixed(1)}x`;
if (els.outputVolVal) els.outputVolVal.textContent = `${Math.round(Number(els.outputVol?.value || 1)*100)}%`;
setupPlayer(currentChannel);
connect();
listDevices().catch(console.warn);
// First-time users: prompt for a name
if (!account) openRegisterModal('create');

// Sidebar toggle
els.toggleSidebar?.addEventListener('click', () => {
  const app = document.getElementById('app');
  // Desktop collapse, mobile drawer: toggle both and CSS will pick the right behavior
  if (window.matchMedia('(max-width: 1024px)').matches) {
    app.classList.toggle('drawer-open');
  } else {
    app.classList.toggle('collapsed');
  }
});
els.drawerBackdrop?.addEventListener('click', () => {
  const app = document.getElementById('app');
  app.classList.remove('drawer-open');
});

// Channel management
els.createChannel?.addEventListener('click', () => {
  const name = (els.newChannelName.value || '').trim().slice(0, 32);
  if (!name) return;
  socket.emit('channels:create', name);
  els.newChannelName.value = '';
});

// Start mic test without joining voice
els.startMic?.addEventListener('click', async (e) => {
  e.preventDefault();
  if (!localStream) await getLocalStream();
});
