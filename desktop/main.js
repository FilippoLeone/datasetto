const { app, BrowserWindow, ipcMain, nativeTheme, Notification, Tray, Menu, nativeImage, desktopCapturer, shell, screen, globalShortcut } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { createUpdater } = require('./updater');
const { execFile } = require('node:child_process');

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
// Automatic updates (desktop/updater.js): created once the app is ready, state pushed to the renderer.
let updater = null;
// Screen share picker (desktop/picker). Thumbnails are refreshed while it is open so
// the cards show what each screen and window is doing right now.
const PICKER_THUMBNAIL_SIZE = { width: 480, height: 270 };
const PICKER_REFRESH_MS = 2000;

/** Physical size and primary flag of the display a screen source belongs to. */
function describeDisplay(source) {
  if (!source.display_id) {
    return null;
  }
  try {
    const display = screen.getAllDisplays().find((candidate) => String(candidate.id) === String(source.display_id));
    if (!display) {
      return null;
    }
    return {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
      primary: display.id === screen.getPrimaryDisplay().id,
    };
  } catch {
    return null;
  }
}

function buildPickerPayload(sources) {
  return sources.map((source) => {
    const isScreen = Boolean(source.id?.startsWith('screen:'));
    return {
      id: source.id,
      name: source.name,
      type: isScreen ? 'screen' : 'window',
      display_id: source.display_id, // Pass display_id to renderer
      display: isScreen ? describeDisplay(source) : null,
      thumbnail: source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : null,
      appIcon:
        source.appIcon && typeof source.appIcon.toDataURL === 'function' && !source.appIcon.isEmpty()
          ? source.appIcon.toDataURL()
          : null,
    };
  });
}

// The picker and the voice overlay are never offered as windows to share (picker/own-windows.js).
const ownWindows = require('./picker/own-windows.js');

/** One of this app's helper windows, as picker/own-windows.js wants it (null once closed). */
function helperWindowRef(window) {
  if (!window || window.isDestroyed()) {
    return null;
  }
  const read = (getter) => {
    try {
      return getter();
    } catch {
      return null;
    }
  };
  return {
    mediaSourceId: read(() => window.getMediaSourceId()),
    // On Windows this is the HWND that desktopCapturer puts in its window ids.
    nativeHandle: process.platform === 'win32' ? read(() => window.getNativeWindowHandle()) : null,
  };
}

function fetchPickerSources() {
  return desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: PICKER_THUMBNAIL_SIZE,
    fetchWindowIcons: true,
  });
}

/** The quality hint the client sends along ({ width, height, fps, label }), sanitised. */
function pickerQualityHint(quality) {
  if (!quality || typeof quality !== 'object') {
    return null;
  }
  const asNumber = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : null);
  return {
    width: asNumber(quality.width),
    height: asNumber(quality.height),
    fps: asNumber(quality.fps),
    label: typeof quality.label === 'string' ? quality.label.slice(0, 80) : null,
  };
}

/** A window size that fits the display the app is on, with margins on small screens. */
function pickerWindowSize() {
  let workArea = { width: 1280, height: 800 };
  try {
    const display = mainWindow && !mainWindow.isDestroyed() ? screen.getDisplayMatching(mainWindow.getBounds()) : screen.getPrimaryDisplay();
    workArea = display.workAreaSize;
  } catch {
    // Fall back to the defaults above.
  }
  return {
    width: Math.max(520, Math.min(880, workArea.width - 80)),
    height: Math.max(440, Math.min(680, workArea.height - 80)),
  };
}

async function promptScreenshareSource(options = {}) {
  const sources = await fetchPickerSources();
  const allowAudio = options?.requestAudio !== false;
  const quality = pickerQualityHint(options?.quality);

  if (!sources || sources.length === 0) {
    throw new Error('No capture sources available');
  }

  if (activePickerWindow) {
    activePickerWindow.close();
  }

  return new Promise((resolve) => {
    const { width, height } = pickerWindowSize();
    const pickerWindow = new BrowserWindow({
      width,
      height,
      minWidth: 520,
      minHeight: 440,
      useContentSize: true,
      resizable: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      title: ownWindows.PICKER_TITLE,
      modal: true,
      parent: mainWindow ?? undefined,
      autoHideMenuBar: true,
      backgroundColor: '#1e1f22',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'picker', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    activePickerWindow = pickerWindow;
    // Neither the picker nor the voice overlay may be offered as a window to share, not even
    // another running copy's. Worked out again on every refresh: the overlay window is
    // created the first time it shows, which can happen while the picker is open.
    const withoutPicker = (list) =>
      ownWindows.withoutHelperWindows(list, [pickerWindow, activePickerWindow, overlayWindow].map(helperWindowRef));

    let refreshTimer = null;
    let refreshing = false;
    let settled = false;

    const sendSources = (list, update) => {
      if (pickerWindow.isDestroyed()) {
        return;
      }
      pickerWindow.webContents.send('screenshare-picker:sources', {
        allowAudio,
        quality,
        update,
        sources: buildPickerPayload(withoutPicker(list)),
      });
    };

    const stopRefresh = () => {
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
    };

    const refreshThumbnails = async () => {
      if (refreshing || settled || pickerWindow.isDestroyed()) {
        return;
      }
      refreshing = true;
      try {
        sendSources(await fetchPickerSources(), true);
      } catch (error) {
        console.warn('[Desktop] Screenshare picker refresh failed:', error?.message ?? error);
      } finally {
        refreshing = false;
      }
    };

    const cleanup = (result) => {
      settled = true;
      stopRefresh();
      if (activePickerWindow === pickerWindow) {
        activePickerWindow = null;
      }
      resolve(result ?? null);
      if (!pickerWindow.isDestroyed()) {
        pickerWindow.destroy();
      }
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
      settled = true;
      stopRefresh();
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
      sendSources(sources, false);
      refreshTimer = setInterval(() => {
        void refreshThumbnails();
      }, PICKER_REFRESH_MS);
    });

    pickerWindow.loadFile(path.join(__dirname, 'picker', 'index.html')).catch((error) => {
      console.error('[Desktop] Failed to load screenshare picker UI:', error);
      cleanup(null);
    });
  });
}


// ============================================
// System-wide push to talk
// ============================================
// The renderer asks for an Electron accelerator (client/src/lib/shortcut.ts builds it
// from the key the user recorded) while in a voice channel with push to talk on, and
// drops it again when leaving voice or switching modes. globalShortcut is an ordinary
// OS hotkey registration (RegisterHotKey on Windows): nothing is injected into other
// processes, so anti-cheat systems have nothing to object to. The OS only reports
// presses; while the key is held it repeats them at the keyboard's repeat rate and the
// renderer treats the key as released once the repeats stop (pushToTalkHold.ts).
const ACCELERATOR_PATTERN = /^[A-Za-z0-9+\-=[\];'",.\/\\`~!@#$%^&*()_{}|:<>?]{1,64}$/;
let pttAccelerator = null;

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function unregisterPushToTalk() {
  if (!pttAccelerator) {
    return;
  }
  try {
    globalShortcut.unregister(pttAccelerator);
  } catch (error) {
    console.warn('[Desktop] Could not unregister the push-to-talk key:', error?.message ?? error);
  }
  pttAccelerator = null;
}

/** Replace the registered push-to-talk key; `null` only unregisters. */
function setPushToTalkShortcut(accelerator) {
  unregisterPushToTalk();
  if (accelerator === null || accelerator === undefined || accelerator === '') {
    return { accelerator: null, registered: false };
  }
  if (typeof accelerator !== 'string' || !ACCELERATOR_PATTERN.test(accelerator)) {
    return { accelerator: String(accelerator).slice(0, 64), registered: false, error: 'invalid' };
  }
  let registered = false;
  try {
    registered = globalShortcut.register(accelerator, () => {
      sendToRenderer('ptt:pressed', { accelerator, at: Date.now() });
    });
  } catch (error) {
    console.warn('[Desktop] Push-to-talk key rejected:', accelerator, error?.message ?? error);
    return { accelerator, registered: false, error: 'invalid' };
  }
  if (registered) {
    pttAccelerator = accelerator;
    console.log('[Desktop] Push-to-talk key registered:', accelerator);
    return { accelerator, registered: true };
  }
  console.warn('[Desktop] Push-to-talk key is taken by the system or another app:', accelerator);
  return { accelerator, registered: false, error: 'taken' };
}

/** Whether `accelerator` could be registered, leaving the current registration as it is. */
function checkPushToTalkShortcut(accelerator) {
  if (typeof accelerator !== 'string' || !ACCELERATOR_PATTERN.test(accelerator)) {
    return { available: false };
  }
  if (accelerator === pttAccelerator) {
    return { available: true };
  }
  try {
    const ok = globalShortcut.register(accelerator, () => undefined);
    if (ok) {
      globalShortcut.unregister(accelerator);
    }
    return { available: ok };
  } catch {
    return { available: false };
  }
}

// ============================================
// Voice overlay
// ============================================
// A small frameless, transparent, always-on-top window in a corner of the primary
// display (desktop/overlay). It ignores the mouse, never takes focus and is fed by the
// renderer with the current voice state. It is an ordinary top-level window: games in
// exclusive fullscreen cover it, borderless and windowed games show it.
const OVERLAY_WIDTH = 288;
const OVERLAY_MIN_HEIGHT = 56;
const OVERLAY_MAX_HEIGHT = 640;
const OVERLAY_MARGIN = 16;
const OVERLAY_CORNERS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
let overlayWindow = null;
let overlayLoaded = false;
const overlayConfig = { enabled: false, corner: 'top-right' };
let overlayState = null;
let overlayHeight = 120;

function overlayBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const height = Math.max(OVERLAY_MIN_HEIGHT, Math.min(OVERLAY_MAX_HEIGHT, Math.round(overlayHeight)));
  const right = overlayConfig.corner.endsWith('right');
  const bottom = overlayConfig.corner.startsWith('bottom');
  return {
    x: right ? area.x + area.width - OVERLAY_WIDTH - OVERLAY_MARGIN : area.x + OVERLAY_MARGIN,
    y: bottom ? area.y + area.height - height - OVERLAY_MARGIN : area.y + OVERLAY_MARGIN,
    width: OVERLAY_WIDTH,
    height,
  };
}

function positionOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }
  overlayWindow.setBounds(overlayBounds());
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return overlayWindow;
  }
  const bounds = overlayBounds();
  overlayWindow = new BrowserWindow({
    ...bounds,
    title: ownWindows.OVERLAY_TITLE,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'overlay', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  overlayLoaded = false;
  // Clicks go straight through to whatever is underneath.
  overlayWindow.setIgnoreMouseEvents(true);
  // Above fullscreen-ish windows too (borderless games); "screen-saver" is the highest level.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  // Keep it out of screen captures (your own screen share, recordings).
  try {
    overlayWindow.setContentProtection(true);
  } catch {
    /* not supported on this platform */
  }
  overlayWindow.webContents.on('did-finish-load', () => {
    overlayLoaded = true;
    pushOverlayState();
  });
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    overlayLoaded = false;
  });
  overlayWindow.loadFile(path.join(__dirname, 'overlay', 'index.html')).catch((error) => {
    console.error('[Desktop] Failed to load the voice overlay:', error);
  });
  return overlayWindow;
}

function pushOverlayState() {
  if (!overlayWindow || overlayWindow.isDestroyed() || !overlayLoaded) {
    return;
  }
  overlayWindow.webContents.send('overlay:state', overlayState);
}

/** Show the overlay while enabled and in voice, hide it otherwise. */
function syncOverlay() {
  const shouldShow = overlayConfig.enabled && overlayState !== null;
  if (!shouldShow) {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      if (overlayWindow.isVisible()) {
        overlayWindow.hide();
      }
      // Clear the page too, so nothing stale (or still animating) shows when it comes back.
      if (overlayLoaded) {
        overlayWindow.webContents.send('overlay:state', null);
      }
    }
    return;
  }
  const window = createOverlayWindow();
  pushOverlayState();
  positionOverlay();
  if (!window.isVisible()) {
    window.showInactive();
  }
}

function destroyOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
  }
  overlayWindow = null;
  overlayLoaded = false;
}

/** Sanitise what the renderer sends before another window draws it. */
function sanitizeOverlayState(state) {
  if (!state || typeof state !== 'object') {
    return null;
  }
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  const imageUrl = (value) => (typeof value === 'string' && /^(https?:|data:image\/)/i.test(value) && value.length < 2_000_000 ? value : null);
  const participants = Array.isArray(state.participants)
    ? state.participants.slice(0, 12).map((entry) => ({
        id: text(entry?.id, 64),
        name: text(entry?.name, 80) || 'Unknown',
        avatarUrl: imageUrl(entry?.avatarUrl),
        speaking: Boolean(entry?.speaking),
        muted: Boolean(entry?.muted),
        deafened: Boolean(entry?.deafened),
        self: Boolean(entry?.self),
      }))
    : [];
  return {
    channelName: text(state.channelName, 80) || 'Voice',
    participants,
    more: Number.isFinite(Number(state.more)) ? Math.max(0, Math.round(Number(state.more))) : 0,
    muted: Boolean(state.muted),
    deafened: Boolean(state.deafened),
    pushToTalk: Boolean(state.pushToTalk),
    transmitting: Boolean(state.transmitting),
  };
}

// ============================================
// Game activity ("Playing <game>")
// ============================================
// Off by default. While the client has it switched on, every ACTIVITY_INTERVAL_MS the
// list of running process names is read with the operating system's own tool, exactly
// what Task Manager or `ps` shows: `tasklist /FO CSV /NH` (PowerShell `Get-Process` as
// the fallback) on Windows, `ps -axo comm=` on macOS and Linux. The names are matched
// against games/catalogue.json and the user's own entries (games/match.js) and only the
// matched title, or null, goes to the renderer. No other process is opened, no window
// of another process is inspected, nothing is injected or hooked and no memory is read,
// so anti-cheat systems see an ordinary application reading a public process list.
const ACTIVITY_INTERVAL_MS = 20_000;
const ACTIVITY_COMMAND_TIMEOUT_MS = 10_000;
const ACTIVITY_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const gameMatch = require('./games/match.js');
let gameCatalogue = { games: {}, launchers: [] };
try {
  gameCatalogue = JSON.parse(fs.readFileSync(path.join(__dirname, 'games', 'catalogue.json'), 'utf8'));
} catch (error) {
  console.error('[Desktop] Could not load the game catalogue:', error?.message ?? error);
}
const activityConfig = { enabled: false, custom: [] };
let activityTimer = null;
let activityScanning = false;
let activityScanQueued = false;
let activityTitle = null;

/** Run a process-list tool and return its stdout; rejects when it fails or times out. */
function runProcessList(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: ACTIVITY_COMMAND_TIMEOUT_MS, maxBuffer: ACTIVITY_MAX_OUTPUT_BYTES, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

/** Lower-cased executable names of every running process, sorted and de-duplicated. */
async function listProcessNames() {
  if (process.platform === 'win32') {
    const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    try {
      return gameMatch.parseTasklist(await runProcessList(path.join(system32, 'tasklist.exe'), ['/FO', 'CSV', '/NH']));
    } catch (error) {
      console.warn('[Desktop] tasklist failed, trying Get-Process:', error?.message ?? error);
    }
    const powershell = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return gameMatch.parseProcessNames(await runProcessList(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process | ForEach-Object ProcessName']));
  }
  return gameMatch.parsePs(await runProcessList('ps', ['-axo', 'comm=']));
}

/** Executable names of this app, left out of the picker. */
function ownExecutables() {
  return [path.basename(process.execPath), 'datasetto.exe', 'datasetto'];
}

function publishActivity(title) {
  if (title === activityTitle) {
    return;
  }
  activityTitle = title;
  console.log('[Desktop] Game activity:', title ? `playing ${title}` : 'nothing detected');
  sendToRenderer('activity:detected', { title });
}

/** One pass: read the process list, match, tell the renderer when the answer changed. */
async function scanActivity() {
  if (!activityConfig.enabled) {
    return activityTitle;
  }
  if (activityScanning) {
    activityScanQueued = true;
    return activityTitle;
  }
  activityScanning = true;
  try {
    const names = await listProcessNames();
    if (activityConfig.enabled) {
      const match = gameMatch.matchGame(names, gameCatalogue, activityConfig.custom);
      publishActivity(match ? match.title : null);
    }
  } catch (error) {
    console.warn('[Desktop] Could not read the process list:', error?.message ?? error);
  } finally {
    activityScanning = false;
  }
  if (activityScanQueued) {
    activityScanQueued = false;
    return scanActivity();
  }
  return activityTitle;
}

function stopActivityScans() {
  if (activityTimer) {
    clearInterval(activityTimer);
    activityTimer = null;
  }
}

/** Apply the client's settings; resolves with the current title once a first scan ran. */
async function configureActivity(options) {
  activityConfig.enabled = Boolean(options?.enabled);
  activityConfig.custom = gameMatch.sanitizeCustomGames(options?.custom);
  if (!activityConfig.enabled) {
    stopActivityScans();
    publishActivity(null);
    return null;
  }
  if (!activityTimer) {
    activityTimer = setInterval(() => {
      void scanActivity();
    }, ACTIVITY_INTERVAL_MS);
    console.log('[Desktop] Game activity scans on, every', ACTIVITY_INTERVAL_MS / 1000, 's;', activityConfig.custom.length, 'own entries');
  }
  return scanActivity();
}

/** Forget the client's settings (reload, window closed, quit): no scans until it asks again. */
function resetActivity() {
  activityConfig.enabled = false;
  activityConfig.custom = [];
  stopActivityScans();
  activityTitle = null;
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

function isExternalUrl(url) {
  return typeof url === 'string' && /^https?:///i.test(url);
}

/** The renderer itself: the bundled file:// page, or the ELECTRON_START_URL origin in development. */
function isAppUrl(url) {
  try {
    const target = new URL(url);
    if (target.protocol === 'file:') {
      return true;
    }
    const startUrl = process.env.ELECTRON_START_URL;
    return Boolean(startUrl) && target.origin === new URL(startUrl).origin;
  } catch {
    return false;
  }
}

function openExternalUrl(url) {
  shell.openExternal(url).catch((error) => {
    console.warn('[Desktop] Failed to open external URL:', error?.message ?? error);
  });
}

/**
 * Logs why a notification was not shown. Since Electron 42 macOS uses UNNotification,
 * which only displays notifications from a code-signed app; the unsigned DMG gets a
 * 'failed' event instead of a visible toast.
 */
function showNotification(notification) {
  notification.on('failed', (_event, error) => {
    console.warn('[Desktop] Notification could not be shown:', error);
  });
  notification.show();
}

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

  // Load the microphone-based tray icons (one per voice state)
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

  // Determine which icon state to show (muted wins over speaking wins over connected)
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

  // window.open(): keep in-app popouts (windows the client renders into itself),
  // send every real URL to the system browser instead of a chromeless Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName, features }) => {
    if (frameName === 'datasetto-video-popout' || features?.includes('menubar=no')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          menuBarVisible: false,
          backgroundColor: '#000000',
          title: 'Datasetto - Video',
          icon: resolveResourcePath('icon.png'),
        }
      };
    }
    if (isExternalUrl(url)) {
      openExternalUrl(url);
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        menuBarVisible: false,
      }
    };
  });

  // Keep the main window on the app: a plain link or a redirect to another site
  // opens in the system browser instead of replacing the client.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) {
      return;
    }
    event.preventDefault();
    if (isExternalUrl(url)) {
      openExternalUrl(url);
    }
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

  // A reload or navigation of the client starts from scratch: it registers its key and
  // feeds the overlay again, so forget what the previous page set up.
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (!details || details.isSameDocument || details.isMainFrame === false) {
      return;
    }
    unregisterPushToTalk();
    overlayState = null;
    syncOverlay();
    resetActivity();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    unregisterPushToTalk();
    overlayState = null;
    syncOverlay();
    resetActivity();
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
          showNotification(hint);
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
    showNotification(warning);
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

  // Keep the overlay in its corner when displays change (resolution, taskbar, monitors).
  screen.on('display-metrics-changed', () => positionOverlay());
  screen.on('display-added', () => positionOverlay());
  screen.on('display-removed', () => positionOverlay());
  try {
    updater = createUpdater({
      onState: (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update:state', state);
        }
      },
      // The tray guard turns a window close into "hide"; installing must really quit.
      beforeInstall: () => {
        isQuitting = true;
      },
    });
    updater.start();
  } catch (error) {
    console.error('[Desktop] Updater failed to start:', error);
  }

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
  destroyOverlay();
  if (updater) {
    updater.stop();
  }
  closeLogging();
});

app.on('will-quit', () => {
  unregisterPushToTalk();
  globalShortcut.unregisterAll();
  resetActivity();
});

// Automatic updates: state for the settings dialog and the banner, the switch, a manual check, restart.
ipcMain.handle('update:get-state', () => (updater ? updater.getState() : null));

ipcMain.handle('update:set-auto', (_event, enabled) => (updater ? updater.setAutoUpdate(Boolean(enabled)) : null));

ipcMain.handle('update:check', async () => (updater ? updater.checkNow() : null));

ipcMain.handle('update:install', () => Boolean(updater && updater.install()));

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

    showNotification(notification);
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
    const selection = await promptScreenshareSource({ requestAudio: payload?.audio !== false, quality: payload?.quality });
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

// System-wide push to talk (see the section above).
ipcMain.handle('ptt:set', (_event, payload) => setPushToTalkShortcut(payload?.accelerator ?? null));

ipcMain.handle('ptt:check', (_event, payload) => checkPushToTalkShortcut(payload?.accelerator));

// Voice overlay (see the section above).
ipcMain.handle('overlay:configure', (_event, options) => {
  overlayConfig.enabled = Boolean(options?.enabled);
  if (OVERLAY_CORNERS.has(options?.corner)) {
    overlayConfig.corner = options.corner;
  }
  syncOverlay();
  return { enabled: overlayConfig.enabled, corner: overlayConfig.corner };
});

ipcMain.on('overlay:state', (_event, state) => {
  overlayState = sanitizeOverlayState(state);
  syncOverlay();
});

// Game activity (see the section above). The client sends its settings at start-up and
// on every change; the answer carries the title found by an immediate scan.
ipcMain.handle('activity:configure', async (_event, options) => {
  const title = await configureActivity(options);
  return { enabled: activityConfig.enabled, title, catalogueSize: Object.keys(gameCatalogue.games ?? {}).length };
});

// Names of the running programs for the "add a game" picker; shown in the settings dialog
// only and never sent anywhere.
ipcMain.handle('activity:processes', async () => {
  try {
    return { processes: gameMatch.pickerProcesses(await listProcessNames(), gameCatalogue, ownExecutables()) };
  } catch (error) {
    console.warn('[Desktop] Could not list processes for the picker:', error?.message ?? error);
    return { processes: [], error: 'unavailable' };
  }
});

// The overlay page reports the height of its card so the window hugs the content.
ipcMain.on('overlay:size', (event, payload) => {
  if (!overlayWindow || overlayWindow.isDestroyed() || event.sender !== overlayWindow.webContents) {
    return;
  }
  const height = Number(payload?.height);
  if (!Number.isFinite(height) || height <= 0) {
    return;
  }
  overlayHeight = height;
  positionOverlay();
});
