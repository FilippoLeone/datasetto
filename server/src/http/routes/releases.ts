import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { AppContext } from '../../context.js';

interface ReleaseFile {
  filename: string;
  platform: 'android' | 'windows' | 'macos' | 'linux' | 'unknown';
  arch: string;
  size: number;
  sizeFormatted: string;
  downloads: number;
  downloadUrl: string;
  source: 'desktop' | 'mobile';
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return value.toFixed(1) + ' ' + units[unit];
};

const contentTypeFor = (filename: string): string => {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.exe': 'application/vnd.microsoft.portable-executable',
    '.dmg': 'application/x-apple-diskimage',
    '.deb': 'application/vnd.debian.binary-package',
    '.appimage': 'application/x-executable',
    '.apk': 'application/vnd.android.package-archive',
    '.zip': 'application/zip',
  };
  return map[ext] ?? 'application/octet-stream';
};

const classify = (file: string): Pick<ReleaseFile, 'platform' | 'arch'> => {
  const lower = file.toLowerCase();
  let platform: ReleaseFile['platform'] = 'unknown';
  let arch = 'x64';
  if (lower.endsWith('.apk')) {
    platform = 'android';
    arch = 'universal';
  } else if (lower.includes('-win-') || lower.endsWith('.exe')) platform = 'windows';
  else if (lower.includes('-mac-') || lower.endsWith('.dmg')) platform = 'macos';
  else if (lower.includes('-linux-') || lower.endsWith('.appimage') || lower.endsWith('.deb')) platform = 'linux';
  if (lower.includes('arm64') || lower.includes('aarch64')) arch = 'arm64';
  return { platform, arch };
};

/** Read-only listing of desktop/mobile installers for the downloads page. */
export const releasesRouter = (ctx: AppContext): Router => {
  const router = Router();
  const dirs: Record<'desktop' | 'mobile', string | null> = {
    desktop: ctx.config.releases.desktopDir,
    mobile: ctx.config.releases.mobileDir,
  };
  const downloadCounts = new Map<string, number>();

  const scan = async (source: 'desktop' | 'mobile'): Promise<ReleaseFile[]> => {
    const dir = dirs[source];
    if (!dir) return [];
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    const files: ReleaseFile[] = [];
    for (const file of entries) {
      if (/\.(blockmap|ya?ml|json)$/i.test(file)) continue;
      const stat = await fs.stat(path.join(dir, file)).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      files.push({
        filename: file,
        ...classify(file),
        size: stat.size,
        sizeFormatted: formatBytes(stat.size),
        downloads: downloadCounts.get(file) ?? 0,
        downloadUrl: '/api/releases/download/' + source + '/' + encodeURIComponent(file),
        source,
      });
    }
    return files;
  };

  const readManifest = async (): Promise<{ version: string | null; buildDate: string | null; changelog?: string | null }> => {
    if (!dirs.desktop) return { version: null, buildDate: null };
    try {
      const raw = await fs.readFile(path.join(dirs.desktop, 'builds.json'), 'utf-8');
      const parsed = JSON.parse(raw) as { version?: string; buildDate?: string; changelog?: string };
      return { version: parsed.version ?? null, buildDate: parsed.buildDate ?? null, changelog: parsed.changelog ?? null };
    } catch {
      return { version: null, buildDate: null };
    }
  };

  router.get('/', async (_req, res, next) => {
    try {
      const builds = [...(await scan('desktop')), ...(await scan('mobile'))];
      const manifest = await readManifest();
      if (builds.length === 0) {
        res.json({ version: null, builds: [], message: 'No releases available yet' });
        return;
      }
      res.json({ version: manifest.version ?? 'unknown', buildDate: manifest.buildDate, builds });
    } catch (error) {
      next(error);
    }
  });

  router.get('/latest', async (_req, res, next) => {
    try {
      const manifest = await readManifest();
      if (!manifest.version) {
        res.status(404).json({ error: 'No release information available', code: 'NOT_FOUND' });
        return;
      }
      res.json(manifest);
    } catch (error) {
      next(error);
    }
  });

  router.get('/download/:source/:filename', async (req, res, next) => {
    try {
      const source = req.params.source === 'mobile' ? 'mobile' : 'desktop';
      const dir = dirs[source];
      const filename = path.basename(String(req.params.filename ?? ''));
      if (!dir || !filename) {
        res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });
        return;
      }
      const filePath = path.join(dir, filename);
      const [realPath, realDir] = await Promise.all([fs.realpath(filePath), fs.realpath(dir)]).catch(() => [null, null]);
      if (!realPath || !realDir || !realPath.startsWith(realDir)) {
        res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });
        return;
      }
      const stat = await fs.stat(realPath);
      downloadCounts.set(filename, (downloadCounts.get(filename) ?? 0) + 1);
      res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Content-Type', contentTypeFor(filename));
      createReadStream(realPath).pipe(res);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
