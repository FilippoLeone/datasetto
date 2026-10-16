const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

/** Production server used when nothing else is configured. */
const DEFAULT_SERVER_URL = 'https://datasetto.com';

const runtimeConfig = Object.freeze(resolveRuntimeConfig());

defineGlobals();

/**
 * The typed contract lives in client/src/types/globals.d.ts (DesktopAPI and
 * DatasettoDesktopConfig); keep both sides in sync.
 */
function defineGlobals() {
  contextBridge.exposeInMainWorld('desktopAPI', {
    getInfo: () => ipcRenderer.invoke('app:get-info'),
    getRuntimeConfig: () => runtimeConfig,
    showNotification: (options) => ipcRenderer.invoke('notification:show', options),
    checkNotificationPermission: () => ipcRenderer.invoke('notification:check-permission'),
    updateVoiceActivity: (state) => ipcRenderer.send('voice:activity', state),
    pickScreenshareSource: (options) => ipcRenderer.invoke('screenshare:pick-source', options),
    openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
    getLogPath: () => ipcRenderer.invoke('app:get-log-path'),
    openLogFile: () => ipcRenderer.invoke('app:open-log-file'),
    log: (level, ...args) => ipcRenderer.send('renderer:log', { level, args })
  });

  contextBridge.exposeInMainWorld('datasettoDesktopConfig', runtimeConfig);
}

/**
 * Where the backend lives, from the highest-priority source that names a server:
 *
 *   1. DATASETTO_SERVER_URL / DATASETTO_API_BASE_URL / DATASETTO_HLS_BASE_URL /
 *      DATASETTO_RTMP_SERVER_URL environment variables (VITE_* accepted too)
 *   2. runtime-config.json: DATASETTO_RUNTIME_CONFIG_PATH, the packaged
 *      resources/runtime-config.json, or desktop/runtime-config.json in development
 *   3. the built-in production default
 *
 * The layer that supplies `serverUrl` owns the configuration: URLs it leaves out are
 * derived from that server instead of being mixed with a lower layer, so a single
 * DATASETTO_SERVER_URL is enough to point the app at another server. When the
 * renderer is loaded over http(s) (ELECTRON_START_URL) and nothing is configured,
 * every value is empty and the client talks to the page origin like the web build.
 */
function resolveRuntimeConfig() {
  const envLayer = pickUrls({
    serverUrl: process.env.DATASETTO_SERVER_URL || process.env.VITE_SERVER_URL,
    apiBaseUrl: process.env.DATASETTO_API_BASE_URL || process.env.VITE_API_BASE_URL,
    hlsBaseUrl: process.env.DATASETTO_HLS_BASE_URL || process.env.VITE_HLS_BASE_URL,
    rtmpServerUrl: process.env.DATASETTO_RTMP_SERVER_URL || process.env.VITE_RTMP_SERVER_URL
  });
  const fileLayer = readConfigFile();
  const layers = [envLayer, fileLayer, { serverUrl: DEFAULT_SERVER_URL }];

  const configured = [envLayer, fileLayer].some((layer) => Object.values(layer).some(Boolean));
  const loadedFromFile = typeof window !== 'undefined' && window.location.protocol === 'file:';
  if (!configured && !loadedFromFile) {
    return { serverUrl: '', apiBaseUrl: '', hlsBaseUrl: '', rtmpServerUrl: '' };
  }

  const ownerIndex = layers.findIndex((layer) => Boolean(layer.serverUrl));
  const serverUrl = layers[ownerIndex].serverUrl;
  const pick = (field, derive) => {
    for (let index = 0; index <= ownerIndex; index += 1) {
      if (layers[index][field]) {
        return layers[index][field];
      }
    }
    return derive(serverUrl);
  };

  return {
    serverUrl,
    apiBaseUrl: pick('apiBaseUrl', (base) => base),
    hlsBaseUrl: pick('hlsBaseUrl', (base) => `${base}/hls`),
    rtmpServerUrl: pick('rtmpServerUrl', (base) => `rtmp://${hostnameOf(base)}/live`)
  };
}

function readConfigFile() {
  const candidates = [];

  if (process.env.DATASETTO_RUNTIME_CONFIG_PATH) {
    candidates.push(process.env.DATASETTO_RUNTIME_CONFIG_PATH);
  }

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'runtime-config.json'));
  }

  candidates.push(path.join(__dirname, 'runtime-config.json'));

  for (const candidate of candidates) {
    try {
      if (!candidate || !fs.existsSync(candidate)) {
        continue;
      }
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        return pickUrls(parsed);
      }
    } catch (error) {
      console.warn('[desktop][preload] Failed to load runtime config from', candidate, error);
    }
  }

  return {};
}

function pickUrls(source) {
  return {
    serverUrl: cleanUrl(source.serverUrl),
    apiBaseUrl: cleanUrl(source.apiBaseUrl),
    hlsBaseUrl: cleanUrl(source.hlsBaseUrl),
    rtmpServerUrl: cleanUrl(source.rtmpServerUrl)
  };
}

function cleanUrl(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'localhost';
  }
}
