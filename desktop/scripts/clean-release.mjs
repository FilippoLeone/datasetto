import { rm, stat } from 'node:fs/promises';
import { platform } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const desktopRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const releaseDir = path.resolve(desktopRoot, 'release');

async function ensureWindowsProcessStopped() {
  if (platform() !== 'win32') {
    return;
  }

  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/IM', 'Datasetto.exe', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });

    killer.on('exit', () => resolve());
    killer.on('error', () => resolve());
  });
}

async function directoryExists(target) {
  try {
    const stats = await stat(target);
    return stats.isDirectory();
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

(async () => {
  try {
    await ensureWindowsProcessStopped();

    const exists = await directoryExists(releaseDir);
    if (!exists) {
      return;
    }

    await rm(releaseDir, { recursive: true, force: true });
    console.log('[desktop] Cleared release directory before packaging.');
  } catch (error) {
    console.warn('[desktop] Failed to clean release directory:', error?.message ?? error);
  }
})();
