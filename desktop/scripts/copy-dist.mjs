import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const desktopRoot = path.resolve(__dirname, '..');
const clientDist = path.resolve(desktopRoot, '..', 'client', 'dist');
const rendererDir = path.resolve(desktopRoot, 'renderer');

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

(async () => {
  const hasClientBuild = await exists(clientDist);
  if (!hasClientBuild) {
    console.error('[desktop] No client build found at', clientDist);
    console.error('Please run "npm run build" inside the client workspace before packaging the desktop app.');
    process.exit(1);
  }

  await rm(rendererDir, { recursive: true, force: true });
  await mkdir(rendererDir, { recursive: true });
  await cp(clientDist, rendererDir, { recursive: true });

  console.log('[desktop] Copied client dist assets into renderer/.');
})();
