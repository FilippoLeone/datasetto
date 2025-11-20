const { app, BrowserWindow, ipcMain, nativeTheme, Notification, Tray, Menu, nativeImage, desktopCapturer } = require('electron');
const path = require('node:path');

// Allow screen capture APIs (getDisplayMedia) inside our file:// based renderer
app.commandLine.appendSwitch('allow-http-screen-capture');

const isDev = Boolean(process.env.ELECTRON_START_URL);
let mainWindow;
let tray;
let isQuitting = false;
let trayHintShown = false;
const supportsTrayMinimize = process.platform === 'win32';
const SINGLE_INSTANCE_WARNING_COOLDOWN_MS = 8000;
const trayIconImages = {
  idle: null,
  speaking: null,
};
const trayVoiceState = {
  connected: false,
  speaking: false,
  muted: false,
};
let lastSingleInstanceWarningAt = 0;
let activePickerWindow = null;
function buildPickerPayload(sources) {
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    type: source.id?.startsWith('screen:') ? 'screen' : 'window',
    thumbnail: source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : null,
    appIcon:
      source.appIcon && typeof source.appIcon.toDataURL === 'function' && !source.appIcon.isEmpty()
        ? source.appIcon.toDataURL()
        : null,
  }));
}

async function promptScreenshareSource(options = {}) {
  const pickerOptions = {
    types: ['screen', 'window'],
    thumbnailSize: { width: 420, height: 240 },
    fetchWindowIcons: true,
  };
  const sources = await desktopCapturer.getSources(pickerOptions);

  if (!sources || sources.length === 0) {
    throw new Error('No capture sources available');
  }

  if (activePickerWindow) {
    activePickerWindow.close();
  }

  return new Promise((resolve) => {
    const pickerWindow = new BrowserWindow({
      width: 720,
      height: 560,
      resizable: false,
      maximizable: false,
      minimizable: false,
      title: 'Share Your Screen',
      modal: true,
      parent: mainWindow ?? undefined,
      autoHideMenuBar: true,
      backgroundColor: '#11131a',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'picker', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    activePickerWindow = pickerWindow;

    const cleanup = (result) => {
      if (activePickerWindow === pickerWindow) {
        activePickerWindow = null;
      }
      resolve(result ?? null);
      pickerWindow.destroy();
    };

    const handleSelection = (_event, payload) => {
      ipcMain.removeListener('screenshare-picker:cancel', handleCancel);
      cleanup(payload);
    };

    const handleCancel = () => {
      ipcMain.removeListener('screenshare-picker:selected', handleSelection);
      cleanup(null);
    };

    ipcMain.once('screenshare-picker:selected', handleSelection);
    ipcMain.once('screenshare-picker:cancel', handleCancel);

    pickerWindow.on('closed', () => {
      ipcMain.removeListener('screenshare-picker:selected', handleSelection);
      ipcMain.removeListener('screenshare-picker:cancel', handleCancel);
      if (activePickerWindow === pickerWindow) {
        activePickerWindow = null;
        resolve(null);
      }
    });

    pickerWindow.once('ready-to-show', () => {
      pickerWindow.show();
      pickerWindow.focus();
      pickerWindow.webContents.send('screenshare-picker:sources', {
        allowAudio: Boolean(options?.requestAudio),
        sources: buildPickerPayload(sources),
      });
    });

    pickerWindow.loadFile(path.join(__dirname, 'picker', 'index.html')).catch((error) => {
      console.error('[Desktop] Failed to load screenshare picker UI:', error);
      cleanup(null);
    });
  });
}


const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (event) => {
    event.preventDefault();
    showAlreadyRunningWarning();
    restoreFromTray();
  });
}

// Notification queue to avoid spam
const notificationQueue = [];
let isProcessingNotifications = false;

function resolveRendererFile() {
  const indexHtml = path.join(__dirname, 'renderer', 'index.html');
  return indexHtml;
}

function resolveResourcePath(...segments) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'resources', ...segments);
  }
  return path.join(__dirname, 'resources', ...segments);
}

function loadTrayImages() {
  if (!supportsTrayMinimize) {
    return;
  }

  const winIcon = resolveResourcePath('icon.ico');
  const winSpeakingIcon = resolveResourcePath('icon-speaking.ico');
  const pngIcon = resolveResourcePath('icon.png');
  const pngSpeakingIcon = resolveResourcePath('icon-speaking.png');

  const idleImage = nativeImage.createFromPath(process.platform === 'win32' ? winIcon : pngIcon);
  const speakingImage = nativeImage.createFromPath(process.platform === 'win32' ? winSpeakingIcon : pngSpeakingIcon);

  trayIconImages.idle = idleImage && typeof idleImage.isEmpty === 'function' && !idleImage.isEmpty() ? idleImage : null;
  trayIconImages.speaking = speakingImage && typeof speakingImage.isEmpty === 'function' && !speakingImage.isEmpty()
    ? speakingImage
    : trayIconImages.idle;
}

function updateTrayVoiceIndicator(partialState = {}) {
  if (!supportsTrayMinimize || !tray) {
    return;
  }

  trayVoiceState.connected = typeof partialState.connected === 'boolean' ? partialState.connected : trayVoiceState.connected;
  trayVoiceState.speaking = typeof partialState.speaking === 'boolean' ? partialState.speaking : trayVoiceState.speaking;
  trayVoiceState.muted = typeof partialState.muted === 'boolean' ? partialState.muted : trayVoiceState.muted;

  const shouldHighlight = trayVoiceState.connected && trayVoiceState.speaking && !trayVoiceState.muted;
  const nextImage = shouldHighlight && trayIconImages.speaking ? trayIconImages.speaking : trayIconImages.idle;
  if (nextImage) {
    tray.setImage(nextImage);
  }

  const tooltipBase = 'Datasetto';
  const tooltipDetail = !trayVoiceState.connected
    ? 'Click to reopen'
    : shouldHighlight
      ? 'Speaking in voice channel'
      : 'Connected to voice channel';
  tray.setToolTip(`${tooltipBase}${tooltipDetail ? ` — ${tooltipDetail}` : ''}`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#09090b',
    title: 'Datasetto',
    autoHideMenuBar: true,
    titleBarOverlay: {
      color: '#09090b',
      symbolColor: '#ffffff',
      height: 30
    },
    icon: resolveResourcePath('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false // keep mic level updates running while the window is hidden
    }
  });

  if (typeof mainWindow.setMenuBarVisibility === 'function') {
    mainWindow.setMenuBarVisibility(false);
  }

  const startUrl = process.env.ELECTRON_START_URL;
  if (isDev && startUrl) {
    mainWindow.loadURL(startUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(resolveRendererFile());
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (supportsTrayMinimize) {
    mainWindow.on('close', (event) => {
      if (isQuitting) {
        return;
      }

      event.preventDefault();

      // Hide window instead of quitting, mimicking "minimize to tray"
      mainWindow.hide();
      if (typeof mainWindow.setSkipTaskbar === 'function') {
        mainWindow.setSkipTaskbar(true);
      }

      if (!trayHintShown) {
        trayHintShown = true;
        if (Notification.isSupported()) {
          const hint = new Notification({
            title: 'Datasetto is still running',
            body: 'Find the Datasetto icon in the system tray to reopen the app.',
            icon: resolveResourcePath('icon.png'),
          });
          hint.show();
        }
      }
    });
  }
}

function createTray() {
  if (!supportsTrayMinimize || tray) {
    return;
  }

  const fallbackPath = process.platform === 'win32'
    ? resolveResourcePath('icon.ico')
    : resolveResourcePath('icon.png');
  const trayBaseImage = trayIconImages.idle ?? nativeImage.createFromPath(fallbackPath);

  try {
    tray = new Tray(trayBaseImage);
  } catch (error) {
    console.error('[Desktop] Failed to create tray icon:', error);
    tray = null;
    return;
  }
  tray.setToolTip('Datasetto');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Datasetto',
      click: () => {
        restoreFromTray();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible()) {
      mainWindow.hide();
      if (typeof mainWindow.setSkipTaskbar === 'function') {
        mainWindow.setSkipTaskbar(true);
      }
      return;
    }

    restoreFromTray();
  });

  updateTrayVoiceIndicator();
}

function restoreFromTray() {
  if (!mainWindow) {
    createWindow();
    return;
  }

  if (typeof mainWindow.setSkipTaskbar === 'function') {
    mainWindow.setSkipTaskbar(false);
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function showAlreadyRunningWarning() {
  const now = Date.now();
  if (now - lastSingleInstanceWarningAt < SINGLE_INSTANCE_WARNING_COOLDOWN_MS) {
    return;
  }
  lastSingleInstanceWarningAt = now;

  if (Notification.isSupported()) {
    const warning = new Notification({
      title: 'Datasetto is already running',
      body: 'Use the existing window or the tray icon instead of opening another copy.',
      icon: resolveResourcePath('icon.png'),
    });
    warning.show();
  }

  if (mainWindow && typeof mainWindow.flashFrame === 'function') {
    mainWindow.flashFrame(true);
    setTimeout(() => {
      if (mainWindow && typeof mainWindow.flashFrame === 'function') {
        mainWindow.flashFrame(false);
      }
    }, 2000);
  }
}

app.whenReady().then(() => {
  // Set app user model ID for Windows notifications
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.datasetto.desktop');
    console.log('[Desktop] App User Model ID set for Windows notifications');
  }

  createWindow();
  loadTrayImages();
  createTray();

  // Test notification support on startup
  console.log('[Desktop] Notification supported:', Notification.isSupported());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (supportsTrayMinimize && !isQuitting) {
      return;
    }
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

ipcMain.handle('app:get-info', () => ({
  name: app.getName(),
  version: app.getVersion(),
  platform: process.platform,
  isDarkMode: nativeTheme.shouldUseDarkColors
}));

// Native notification handler
ipcMain.handle('notification:show', async (event, { title, body, type, silent }) => {
  console.log('[Desktop] Notification request received:', { title, body, type, silent });
  
  if (!Notification.isSupported()) {
    console.error('[Desktop] Notifications not supported on this platform');
    return { success: false, error: 'Notifications not supported' };
  }

  try {
    // Add to queue to avoid spam
    notificationQueue.push({ title, body, type, silent });
    console.log('[Desktop] Notification added to queue. Queue length:', notificationQueue.length);
    processNotificationQueue();
    return { success: true };
  } catch (error) {
    console.error('[Desktop] Error showing notification:', error);
    return { success: false, error: error.message };
  }
});

// Process notification queue with rate limiting
async function processNotificationQueue() {
  if (isProcessingNotifications || notificationQueue.length === 0) {
    return;
  }

  isProcessingNotifications = true;
  console.log('[Desktop] Processing notification queue...');

  while (notificationQueue.length > 0) {
    const { title, body, type, silent } = notificationQueue.shift();

    // Don't show notification if window is focused (unless it's critical)
    const isFocused = mainWindow && mainWindow.isFocused();
    console.log('[Desktop] Window focused:', isFocused, '| Type:', type);
    
    if (isFocused && type !== 'error') {
      console.log('[Desktop] Skipping notification (window focused, non-error)');
      continue;
    }

    console.log('[Desktop] Showing notification:', { title, body, type });
    
    const notification = new Notification({
      title: title || 'Datasetto',
      body: body || '',
      icon: resolveResourcePath('icon.png'),
      silent: silent || false,
      urgency: type === 'error' ? 'critical' : type === 'warning' ? 'normal' : 'low',
    });

    notification.on('click', () => {
      console.log('[Desktop] Notification clicked');
      if (mainWindow) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.focus();
      }
    });

    notification.show();
    console.log('[Desktop] Notification shown successfully');

    // Wait a bit between notifications to avoid spam
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  isProcessingNotifications = false;
}

// Check notification permission on startup
ipcMain.handle('notification:check-permission', async () => {
  return Notification.isSupported();
});

ipcMain.handle('screenshare:pick-source', async (_event, payload) => {
  try {
    const selection = await promptScreenshareSource({ requestAudio: Boolean(payload?.audio) });
    if (!selection || !selection.source) {
      return { success: false, error: 'cancelled' };
    }

    return {
      success: true,
      source: selection.source,
      shareAudio: Boolean(selection.shareAudio),
    };
  } catch (error) {
    console.error('[Desktop] Failed to select screenshare source:', error);
    return { success: false, error: error?.message || 'selection-failed' };
  }
});

ipcMain.on('voice:activity', (_event, payload) => {
  if (!supportsTrayMinimize) {
    return;
  }

  const nextState = {
    connected: Boolean(payload?.connected),
    speaking: Boolean(payload?.speaking),
    muted: Boolean(payload?.muted),
  };
  updateTrayVoiceIndicator(nextState);
});
