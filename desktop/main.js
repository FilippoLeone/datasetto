const { app, BrowserWindow, ipcMain, nativeTheme, Notification } = require('electron');
const path = require('node:path');

const isDev = Boolean(process.env.ELECTRON_START_URL);
let mainWindow;

// Notification queue to avoid spam
const notificationQueue = [];
let isProcessingNotifications = false;

function resolveRendererFile() {
  const indexHtml = path.join(__dirname, 'renderer', 'index.html');
  return indexHtml;
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
    icon: path.join(__dirname, 'resources', 'icon.png'),
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
}

app.whenReady().then(() => {
  // Set app user model ID for Windows notifications
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.datasetto.desktop');
    console.log('[Desktop] App User Model ID set for Windows notifications');
  }

  createWindow();

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
    app.quit();
  }
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
      icon: path.join(__dirname, 'resources', 'icon.png'),
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
