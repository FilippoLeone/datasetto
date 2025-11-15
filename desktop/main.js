const { app, BrowserWindow, ipcMain, nativeTheme, Notification, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');

const isDev = Boolean(process.env.ELECTRON_START_URL);
let mainWindow;
let tray;
let isQuitting = false;
let trayHintShown = false;
const supportsTrayMinimize = process.platform === 'win32';
const trayIconImages = {
  idle: null,
  speaking: null,
};
const trayVoiceState = {
  connected: false,
  speaking: false,
  muted: false,
};

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
    backgroundColor: '#0f1016',
    title: 'Datasetto',
    autoHideMenuBar: true,
    icon: resolveResourcePath('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
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
  mainWindow.show();
  mainWindow.focus();
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
