'use strict';

/**
 * Automatic updates for the packaged desktop app.
 *
 * Windows (installed) and Linux (AppImage, deb) update themselves through
 * electron-updater: the installer of the newest GitHub release is downloaded in
 * the background and installed on the next restart or quit. Builds that cannot
 * replace themselves (macOS without code signing, the portable Windows
 * executable, a deb without a sudo helper) only read the release metadata and
 * announce the newer version with a link to the download page. The client shows
 * both as a small banner (never a dialog) and offers the switch in Settings.
 *
 * Release metadata (latest.yml, latest-mac.yml, latest-linux.yml and the
 * .blockmap files) is produced by electron-builder next to the installers and
 * uploaded with them by .github/workflows/release.yml.
 */

const { app, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REPO = 'FilippoLeone/datasetto';
const FIRST_CHECK_DELAY_MS = 20 * 1000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15 * 1000;
const SETTINGS_FILE = 'desktop-settings.json';

/** `owner/repo` of the GitHub repository whose releases carry the installers. */
function updateRepo() {
  const configured = (process.env.DATASETTO_UPDATE_REPO || '').trim();
  return /^[\w.-]+\/[\w.-]+$/.test(configured) ? configured : DEFAULT_REPO;
}

function channelFileName() {
  if (process.platform === 'darwin') return 'latest-mac.yml';
  if (process.platform === 'linux') return 'latest-linux.yml';
  return 'latest.yml';
}

/** Numeric comparison of `1.2.3`-style versions; a suffix (`-beta.1`) sorts below the plain release. */
function compareVersions(a, b) {
  const parse = (value) => {
    const match = /^v?(\d+(?:\.\d+)*)(?:[-+](.*))?$/i.exec(String(value ?? '').trim());
    return match ? { numbers: match[1].split('.').map(Number), suffix: match[2] || '' } : null;
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return !left && !right ? 0 : !left ? -1 : 1;
  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (left.suffix === right.suffix) return 0;
  if (!left.suffix) return 1;
  if (!right.suffix) return -1;
  return left.suffix < right.suffix ? -1 : 1;
}

function readSettings(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeSettings(file, settings) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  } catch (error) {
    console.warn('[Updater] Could not save settings:', error?.message ?? error);
  }
}

/**
 * @param {{ onState: (state: object) => void, beforeInstall?: () => void }} options
 *   `onState` receives every state change (forwarded to the renderer);
 *   `beforeInstall` runs right before quitAndInstall (the tray "close to hide" guard).
 */
function createUpdater({ onState, beforeInstall }) {
  const settingsFile = path.join(app.getPath('userData'), SETTINGS_FILE);
  const settings = readSettings(settingsFile);
  const repo = updateRepo();
  const [owner, name] = repo.split('/');
  const portable = process.platform === 'win32' && Boolean(process.env.PORTABLE_EXECUTABLE_DIR);

  const state = {
    autoUpdate: settings.autoUpdate !== false,
    mode: 'off',
    status: 'idle',
    currentVersion: app.getVersion(),
    version: null,
    percent: null,
    url: null,
    error: null,
    checkedAt: null,
  };

  let autoUpdater = null;
  let timer = null;
  let started = false;
  /** Resolves when the running check (and download, when there is one) has settled. */
  let inflight = null;
  let settle = null;

  const publish = () => {
    try {
      onState({ ...state });
    } catch (error) {
      console.warn('[Updater] Could not publish state:', error?.message ?? error);
    }
  };

  const set = (patch) => {
    Object.assign(state, patch);
    publish();
  };

  const finish = () => {
    if (settle) {
      const done = settle;
      settle = null;
      inflight = null;
      done();
    }
  };

  const releasePageUrl = () => `https://github.com/${repo}/releases/latest`;

  if (app.isPackaged) {
    try {
      const updater = require('electron-updater').autoUpdater;
      updater.logger = {
        info: (message) => console.log('[Updater]', message),
        warn: (message) => console.warn('[Updater]', message),
        error: (message) => console.error('[Updater]', message),
        debug: () => {},
      };
      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = true;
      updater.allowPrerelease = false;
      updater.allowDowngrade = false;
      // The releases carry full installers, never NSIS web installers.
      updater.disableWebInstaller = true;
      updater.setFeedURL({ provider: 'github', owner, repo: name });
      const selfUpdating = process.platform !== 'darwin' && !portable && updater.isUpdaterActive();
      state.mode = selfUpdating ? 'self' : 'notice';
      if (selfUpdating) {
        autoUpdater = updater;
        updater.on('checking-for-update', () => {
          if (state.status !== 'ready') set({ status: 'checking', error: null });
        });
        updater.on('update-available', (info) => {
          console.log('[Updater] Update available:', info?.version);
          if (state.status !== 'ready') set({ status: 'downloading', version: info?.version ?? null, percent: 0, error: null });
        });
        updater.on('update-not-available', (info) => {
          console.log('[Updater] Up to date (latest:', info?.version, ')');
          if (state.status !== 'ready') set({ status: 'none', version: null, percent: null, checkedAt: Date.now() });
          finish();
        });
        updater.on('download-progress', (progress) => {
          if (state.status === 'downloading') set({ percent: Number(progress?.percent) || 0 });
        });
        updater.on('update-downloaded', (info) => {
          console.log('[Updater] Update downloaded:', info?.version, '- it installs on the next restart');
          set({ status: 'ready', version: info?.version ?? state.version, percent: 100, checkedAt: Date.now(), error: null });
          finish();
        });
        updater.on('error', (error) => {
          const message = error?.message ?? String(error);
          console.warn('[Updater] Error:', message);
          if (state.status !== 'ready') set({ status: 'error', error: message.slice(0, 200), checkedAt: Date.now(), percent: null });
          finish();
        });
      }
    } catch (error) {
      console.warn('[Updater] electron-updater unavailable, falling back to notices:', error?.message ?? error);
      state.mode = 'notice';
    }
  }

  console.log(`[Updater] Mode: ${state.mode} (version ${state.currentVersion}, repo ${repo}, automatic updates ${state.autoUpdate ? 'on' : 'off'})`);

  /** Notice mode: read the version from the newest release's metadata file. */
  async function checkMetadata() {
    const file = channelFileName();
    const url = `https://github.com/${repo}/releases/latest/download/${file}`;
    set({ status: 'checking', error: null });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await net.fetch(url, { signal: controller.signal, headers: { 'Cache-Control': 'no-cache' } });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${file}`);
      const text = await response.text();
      const match = /^version:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(text);
      if (!match) throw new Error(`no version in ${file}`);
      const latest = match[1].trim();
      if (compareVersions(latest, state.currentVersion) > 0) {
        console.log(`[Updater] Version ${latest} is available (running ${state.currentVersion})`);
        set({ status: 'available', version: latest, url: releasePageUrl(), checkedAt: Date.now() });
      } else {
        console.log(`[Updater] Up to date (latest: ${latest})`);
        set({ status: 'none', version: null, url: null, checkedAt: Date.now() });
      }
    } catch (error) {
      const message = error?.message ?? String(error);
      console.warn('[Updater] Could not read release metadata:', message);
      set({ status: 'error', error: message.slice(0, 200), checkedAt: Date.now() });
    } finally {
      clearTimeout(timeout);
    }
  }

  /** One check; resolves once the check (and any download) has settled. */
  function check() {
    if (state.mode === 'off') return Promise.resolve();
    if (inflight) return inflight;
    if (state.mode === 'notice' || !autoUpdater) {
      inflight = checkMetadata().finally(() => {
        inflight = null;
      });
      return inflight;
    }
    if (state.status === 'ready') return Promise.resolve();
    inflight = new Promise((resolve) => {
      settle = resolve;
    });
    autoUpdater.checkForUpdates().then(
      (result) => {
        // null: the updater is inactive for this build; nothing more will be emitted.
        if (result === null) finish();
      },
      () => finish(),
    );
    return inflight;
  }

  function schedule(delay) {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!state.autoUpdate || state.mode === 'off') return;
    timer = setTimeout(() => {
      timer = null;
      check().finally(() => schedule(CHECK_INTERVAL_MS));
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    /** Start the periodic checks (a first one shortly after launch). */
    start() {
      if (started) return;
      started = true;
      schedule(FIRST_CHECK_DELAY_MS);
    },
    getState() {
      return { ...state };
    },
    setAutoUpdate(enabled) {
      const next = enabled !== false;
      if (next !== state.autoUpdate) {
        settings.autoUpdate = next;
        writeSettings(settingsFile, settings);
        set({ autoUpdate: next });
        console.log('[Updater] Automatic updates', next ? 'enabled' : 'disabled');
        if (next) schedule(1000);
        else schedule(0);
      }
      return { ...state };
    },
    /** A manual check from Settings; works with automatic updates off too. */
    async checkNow() {
      await check();
      return { ...state };
    },
    /** Quit and install the downloaded update. Returns false when there is none. */
    install() {
      if (!autoUpdater || state.status !== 'ready') return false;
      console.log('[Updater] Restarting to install version', state.version);
      try {
        if (beforeInstall) beforeInstall();
        setImmediate(() => autoUpdater.quitAndInstall(true, true));
        return true;
      } catch (error) {
        console.error('[Updater] quitAndInstall failed:', error?.message ?? error);
        return false;
      }
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

module.exports = { createUpdater, compareVersions, updateRepo, channelFileName };
