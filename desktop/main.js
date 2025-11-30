const { app, BrowserWindow, ipcMain, nativeTheme, Notification, Tray, Menu, nativeImage, desktopCapturer, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// Force GPU Acceleration for NVENC/Hardware Encoding
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-features', 'VaapiVideoEncoder,VaapiVideoDecoder,CanvasOopRasterization');

// ============================================
// Logging Setup
// ============================================
const LOG_MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB max log size
let logFilePath = null;
let logStream = null;

/**
 * Determine the best log directory:
 * 1. For portable/standalone: use the directory where the exe is located
 * 2. For installed apps: use userData (AppData)
 * 3. Fallback to Desktop if all else fails
 */
function getLogDirectory() {
  const tryWrite = (dir) => {
    try {
      const testFile = path.join(dir, '.datasetto-write-test');
      fs.writeFileSync(testFile, 'test', { flag: 'w' });
      fs.unlinkSync(testFile);
      return true;
    } catch (e) {
      return false;
    }
  };

  try {
    // For packaged app, try exe directory first (portable mode)
    if (app.isPackaged) {
      const exeDir = path.dirname(process.execPath);
      if (tryWrite(exeDir)) {
        return exeDir;
      }
    }
    
    // Try userData directory
    try {
      const userDataPath = app.getPath('userData');
      if (!fs.existsSync(userDataPath)) {
        fs.mkdirSync(userDataPath, { recursive: true });
      }
      if (tryWrite(userDataPath)) {
        return userDataPath;
      }
    } catch (e) {
      // Continue to next fallback
    }
    
    // Fallback to Desktop (should always be writable)
    try {
      const desktopPath = app.getPath('desktop');
      if (tryWrite(desktopPath)) {
        return desktopPath;
      }
    } catch (e) {
      // Continue to next fallback
    }
    
    // Last resort: temp directory
    return app.getPath('temp');
  } catch (err) {
    // Absolute fallback
    return app.getPath('temp');
  }
}

function initLogging() {
  // Store original console methods before overriding
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;
  const originalConsoleInfo = console.info;
  
  try {
    const logDir = getLogDirectory();
    logFilePath = path.join(logDir, 'datasetto.log');
    
    originalConsoleLog('[Desktop] Log directory:', logDir);
    originalConsoleLog('[Desktop] Log file path:', logFilePath);
    originalConsoleLog('[Desktop] App packaged:', app.isPackaged);
    originalConsoleLog('[Desktop] Exe path:', process.execPath);
    
    // Rotate log if too large
    try {
      const stats = fs.statSync(logFilePath);
      if (stats.size > LOG_MAX_SIZE_BYTES) {
        const oldLogPath = path.join(logDir, 'datasetto.old.log');
        if (fs.existsSync(oldLogPath)) {
          fs.unlinkSync(oldLogPath);
        }
        fs.renameSync(logFilePath, oldLogPath);
      }
    } catch (e) {
      // File doesn't exist yet, that's fine
    }
    
    logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
    
    // Handle stream errors
    logStream.on('error', (err) => {
      originalConsoleError('[Desktop] Log stream error:', err);
    });
    
    // Write startup header
    const startupMsg = `\n${'='.repeat(60)}\n[${new Date().toISOString()}] Datasetto Desktop starting...\nPlatform: ${process.platform}, Arch: ${process.arch}, Electron: ${process.versions.electron}, Node: ${process.versions.node}\nLog file: ${logFilePath}\nExe path: ${process.execPath}\nPackaged: ${app.isPackaged}\n${'='.repeat(60)}\n`;
    logStream.write(startupMsg);
    
    const writeToLog = (level, args) => {
      if (!logStream) return;
      const timestamp = new Date().toISOString();
      const message = args.map(arg => {
        if (typeof arg === 'object') {
          try {
            return JSON.stringify(arg, null, 2);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      }).join(' ');
      logStream.write(`[${timestamp}] [${level}] ${message}\n`);
    };
    
    console.log = (...args) => {
      originalConsoleLog.apply(console, args);
      writeToLog('LOG', args);
    };
    
    console.warn = (...args) => {
      originalConsoleWarn.apply(console, args);
      writeToLog('WARN', args);
    };
    
    console.error = (...args) => {
      originalConsoleError.apply(console, args);
      writeToLog('ERROR', args);
    };
    
    console.info = (...args) => {
      originalConsoleInfo.apply(console, args);
      writeToLog('INFO', args);
    };
    
    console.log('[Desktop] Logging initialized at:', logFilePath);
  } catch (error) {
    // Use original console.error since we haven't overridden it yet
    const origError = console.error;
    origError('[Desktop] Failed to initialize logging:', error);
  }
}

function closeLogging() {
  if (logStream) {
    logStream.write(`[${new Date().toISOString()}] [INFO] Datasetto Desktop shutting down...\n`);
    logStream.end();
    logStream = null;
  }
}

// Don't initialize logging here - do it after app is ready
// initLogging() is called in app.whenReady()

// ============================================
// App Setup
// ============================================

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
  idle: null,       // Gray microphone - not connected
  connected: null,  // White microphone - connected to voice
  speaking: null,   // White microphone with green glow - speaking
  muted: null,      // Gray microphone with red slash - muted
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
    display_id: source.display_id, // Pass display_id to renderer
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
  const allowAudio = options?.requestAudio !== false;

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
        allowAudio,
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

  // Load microphone-based tray icons (Discord-style)
  const states = ['idle', 'connected', 'speaking', 'muted'];
  
  for (const state of states) {
    const icoPath = resolveResourcePath(`tray-${state}.ico`);
    const pngPath = resolveResourcePath(`tray-${state}.png`);
    const imagePath = process.platform === 'win32' ? icoPath : pngPath;
    
    const image = nativeImage.createFromPath(imagePath);
    trayIconImages[state] = image && typeof image.isEmpty === 'function' && !image.isEmpty() ? image : null;
  }

  // Fallback to legacy icons if new ones don't exist
  if (!trayIconImages.idle) {
    const fallbackIco = resolveResourcePath('icon.ico');
    const fallbackPng = resolveResourcePath('icon.png');
    const fallbackPath = process.platform === 'win32' ? fallbackIco : fallbackPng;
    const fallbackImage = nativeImage.createFromPath(fallbackPath);
    trayIconImages.idle = fallbackImage && !fallbackImage.isEmpty() ? fallbackImage : null;
  }
  
  // Use idle as fallback for other states if they don't exist
  if (!trayIconImages.connected) trayIconImages.connected = trayIconImages.idle;
  if (!trayIconImages.speaking) trayIconImages.speaking = trayIconImages.idle;
  if (!trayIconImages.muted) trayIconImages.muted = trayIconImages.idle;
}

function updateTrayVoiceIndicator(partialState = {}) {
  if (!supportsTrayMinimize || !tray) {
    return;
  }

  trayVoiceState.connected = typeof partialState.connected === 'boolean' ? partialState.connected : trayVoiceState.connected;
  trayVoiceState.speaking = typeof partialState.speaking === 'boolean' ? partialState.speaking : trayVoiceState.speaking;
  trayVoiceState.muted = typeof partialState.muted === 'boolean' ? partialState.muted : trayVoiceState.muted;

  // Determine which icon state to show (Discord-style priority)
  let iconState = 'idle';
  let tooltipDetail = 'Click to reopen';

  if (trayVoiceState.connected) {
    if (trayVoiceState.muted) {
      iconState = 'muted';
      tooltipDetail = 'Muted in voice channel';
    } else if (trayVoiceState.speaking) {
      iconState = 'speaking';
      tooltipDetail = 'Speaking in voice channel';
    } else {
      iconState = 'connected';
      tooltipDetail = 'Connected to voice channel';
    }
  }

  const nextImage = trayIconImages[iconState] ?? trayIconImages.idle;
  if (nextImage) {
    tray.setImage(nextImage);
  }

  tray.setToolTip(`Datasetto — ${tooltipDetail}`);
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

  // Handle window.open() popouts (e.g., screenshare video popout)
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName, features }) => {
    // Allow the video popout window with native look (no menu bar)
    if (frameName === 'datasetto-video-popout' || features?.includes('menubar=no')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          menuBarVisible: false,
          backgroundColor: '#05060b',
          title: 'Datasetto - Video',
          icon: resolveResourcePath('icon.png'),
        }
      };
    }
    // Default: allow other windows but also hide menu bar
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        menuBarVisible: false,
      }
    };
  });

  const startUrl = process.env.ELECTRON_START_URL;
  if (isDev && startUrl) {
    mainWindow.loadURL(startUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(resolveRendererFile());
  }

  // Register keyboard shortcuts for debugging (works in production too)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // Ctrl+Shift+I or F12 to open DevTools
    if ((input.control && input.shift && input.key === 'I') || input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
    // Ctrl+Shift+L to open log file location
    if (input.control && input.shift && input.key === 'L') {
      if (logFilePath) {
        shell.showItemInFolder(logFilePath);
      }
      event.preventDefault();
    }
  });

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
  // Initialize logging first (needs app to be ready for getPath)
  initLogging();
  
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
  closeLogging();
});

ipcMain.handle('app:get-info', () => ({
  name: app.getName(),
  version: app.getVersion(),
  platform: process.platform,
  isDarkMode: nativeTheme.shouldUseDarkColors
}));

// Open external URL handler
ipcMain.handle('shell:open-external', async (_event, url) => {
  if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});

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

// Log file handlers
ipcMain.handle('app:get-log-path', () => {
  return logFilePath;
});

ipcMain.handle('app:open-log-file', async () => {
  if (logFilePath && fs.existsSync(logFilePath)) {
    await shell.openPath(logFilePath);
    return true;
  }
  return false;
});

ipcMain.handle('screenshare:pick-source', async (_event, payload) => {
  try {
    const selection = await promptScreenshareSource({ requestAudio: payload?.audio !== false });
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

// Receive logs from renderer process
ipcMain.on('renderer:log', (_event, payload) => {
  const { level, args } = payload || {};
  const prefix = '[Renderer]';
  
  switch (level) {
    case 'error':
      console.error(prefix, ...(args || []));
      break;
    case 'warn':
      console.warn(prefix, ...(args || []));
      break;
    case 'info':
      console.info(prefix, ...(args || []));
      break;
    default:
      console.log(prefix, ...(args || []));
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
