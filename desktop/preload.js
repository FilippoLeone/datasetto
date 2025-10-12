const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  serverUrl: 'https://datasetto.com',
  apiBaseUrl: 'https://datasetto.com',
  hlsBaseUrl: 'https://datasetto.com/hls',
  rtmpServerUrl: 'rtmp://datasetto.com/hls'
});

const runtimeConfig = Object.freeze(resolveRuntimeConfig());

defineGlobals();

function defineGlobals() {
  contextBridge.exposeInMainWorld('desktopAPI', {
    getInfo: () => ipcRenderer.invoke('app:get-info'),
    getRuntimeConfig: () => runtimeConfig,
    showNotification: (options) => ipcRenderer.invoke('notification:show', options),
    checkNotificationPermission: () => ipcRenderer.invoke('notification:check-permission')
  });

  contextBridge.exposeInMainWorld('datasettoDesktopConfig', runtimeConfig);
}

function resolveRuntimeConfig() {
  const candidates = [];

  if (process.env.DATASETTO_RUNTIME_CONFIG_PATH) {
    candidates.push(process.env.DATASETTO_RUNTIME_CONFIG_PATH);
  }

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'runtime-config.json'));
  }

  candidates.push(path.join(__dirname, 'runtime-config.json'));

  let fileConfig = {};

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          fileConfig = parsed;
          break;
        }
      }
    } catch (error) {
      console.warn('[desktop][preload] Failed to load runtime config from', candidate, error);
    }
  }

  const envConfig = {
    serverUrl: process.env.DATASETTO_SERVER_URL || process.env.VITE_SERVER_URL || '',
    apiBaseUrl: process.env.DATASETTO_API_BASE_URL || process.env.VITE_API_BASE_URL || '',
    hlsBaseUrl: process.env.DATASETTO_HLS_BASE_URL || process.env.VITE_HLS_BASE_URL || '',
    rtmpServerUrl: process.env.DATASETTO_RTMP_SERVER_URL || process.env.VITE_RTMP_SERVER_URL || ''
  };

  return {
    serverUrl: stringOrDefault(fileConfig.serverUrl, envConfig.serverUrl, DEFAULT_RUNTIME_CONFIG.serverUrl),
    apiBaseUrl: stringOrDefault(fileConfig.apiBaseUrl, envConfig.apiBaseUrl, DEFAULT_RUNTIME_CONFIG.apiBaseUrl),
    hlsBaseUrl: stringOrDefault(fileConfig.hlsBaseUrl, envConfig.hlsBaseUrl, DEFAULT_RUNTIME_CONFIG.hlsBaseUrl),
    rtmpServerUrl: stringOrDefault(fileConfig.rtmpServerUrl, envConfig.rtmpServerUrl, DEFAULT_RUNTIME_CONFIG.rtmpServerUrl)
  };
}

function stringOrDefault(...values) {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return '';
}
