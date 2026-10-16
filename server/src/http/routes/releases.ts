import { Router } from 'express';
import type { AppContext } from '../../context.js';

/** The part of GitHub's "get the latest release" response that we use. */
export interface GitHubRelease {
  tag_name: string;
  name?: string | null;
  html_url: string;
  body?: string | null;
  published_at?: string | null;
  assets?: Array<{
    name: string;
    size: number;
    download_count?: number;
    browser_download_url: string;
  }>;
}

export interface ReleaseFile {
  filename: string;
  platform: 'windows' | 'macos' | 'linux' | 'android' | 'unknown';
  arch: string;
  size: number;
  sizeFormatted: string;
  downloads: number;
  /** Direct link to the asset on GitHub. */
  downloadUrl: string;
  source: 'desktop' | 'mobile';
}

export interface ReleasePayload {
  /** Tag without the leading `v`, or null when nothing is published. */
  version: string | null;
  tag: string | null;
  buildDate: string | null;
  changelog: string | null;
  /** The release page (or the releases list when nothing is published). */
  releaseUrl: string;
  repo: string;
  builds: ReleaseFile[];
  /** Why `builds` is empty, when it is. */
  message?: string;
}

const FETCH_TIMEOUT_MS = 6000;
const PLATFORM_ORDER: Record<ReleaseFile['platform'], number> = { windows: 0, macos: 1, linux: 2, android: 3, unknown: 4 };
/** Build metadata that electron-builder publishes next to the installers. */
const SKIP_ASSET = /\.(blockmap|ya?ml|json|txt|sha256|sig|asc)$/i;

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

const classify = (file: string): Pick<ReleaseFile, 'platform' | 'arch'> => {
  const lower = file.toLowerCase();
  let platform: ReleaseFile['platform'] = 'unknown';
  let arch = 'x64';
  if (lower.endsWith('.apk')) {
    platform = 'android';
    arch = 'universal';
  } else if (lower.includes('-win-') || lower.endsWith('.exe') || lower.endsWith('.msi')) platform = 'windows';
  else if (lower.includes('-mac-') || lower.endsWith('.dmg') || lower.endsWith('.pkg')) platform = 'macos';
  else if (lower.includes('-linux-') || lower.endsWith('.appimage') || lower.endsWith('.deb') || lower.endsWith('.rpm')) platform = 'linux';
  if (lower.includes('arm64') || lower.includes('aarch64')) arch = 'arm64';
  else if (lower.includes('x86_64') || lower.includes('amd64') || lower.includes('x64')) arch = 'x64';
  else if (lower.includes('ia32') || /[-_.]x86[-_.]/.test(lower)) arch = 'x86';
  return { platform, arch };
};

/** Turn a GitHub release into what the landing and downloads pages render. */
export const buildReleasePayload = (repo: string, release: GitHubRelease): ReleasePayload => {
  const builds: ReleaseFile[] = (release.assets ?? [])
    .filter((asset) => !SKIP_ASSET.test(asset.name))
    .map((asset) => ({
      filename: asset.name,
      ...classify(asset.name),
      size: asset.size,
      sizeFormatted: formatBytes(asset.size),
      downloads: asset.download_count ?? 0,
      downloadUrl: asset.browser_download_url,
      source: (asset.name.toLowerCase().endsWith('.apk') ? 'mobile' : 'desktop') as ReleaseFile['source'],
    }))
    .sort((a, b) => PLATFORM_ORDER[a.platform] - PLATFORM_ORDER[b.platform] || a.filename.localeCompare(b.filename));
  return {
    version: release.tag_name.replace(/^v/i, ''),
    tag: release.tag_name,
    buildDate: release.published_at ?? null,
    changelog: release.body?.trim() || null,
    releaseUrl: release.html_url,
    repo,
    builds,
  };
};

const emptyPayload = (repo: string, message: string): ReleasePayload => ({
  version: null,
  tag: null,
  buildDate: null,
  changelog: null,
  releaseUrl: 'https://github.com/' + repo + '/releases',
  repo,
  builds: [],
  message,
});

/**
 * Installers for the landing and downloads pages, read from the latest release
 * of the GitHub repository (`RELEASES_GITHUB_REPO`). Responses are cached for
 * `RELEASES_CACHE_SECONDS`, so the unauthenticated GitHub rate limit is never
 * reached and visitors' browsers never talk to GitHub's API themselves. When
 * GitHub is unreachable the last good answer is served; before the first good
 * answer the payload is empty with a `message`.
 */
export const releasesRouter = (ctx: AppContext, fetchImpl: typeof fetch = fetch): Router => {
  const router = Router();
  const { githubRepo: repo, cacheSeconds } = ctx.config.releases;
  const ttlMs = cacheSeconds * 1000;
  let cached: { payload: ReleasePayload; fetchedAt: number } | null = null;
  let inflight: Promise<ReleasePayload> | null = null;

  const fetchLatest = async (): Promise<ReleasePayload> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl('https://api.github.com/repos/' + repo + '/releases/latest', {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'datasetto-server/' + ctx.config.version,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: controller.signal,
      });
      if (response.status === 404) return emptyPayload(repo, 'No releases published yet');
      if (!response.ok) throw new Error('GitHub responded with HTTP ' + response.status);
      return buildReleasePayload(repo, (await response.json()) as GitHubRelease);
    } finally {
      clearTimeout(timer);
    }
  };

  const load = (): Promise<ReleasePayload> => {
    if (cached && Date.now() - cached.fetchedAt < ttlMs) return Promise.resolve(cached.payload);
    if (!inflight) {
      inflight = fetchLatest()
        .then((payload) => {
          cached = { payload, fetchedAt: Date.now() };
          return payload;
        })
        .catch((error: unknown) => {
          ctx.log.warn({ err: error, repo }, 'could not fetch the latest GitHub release');
          return cached?.payload ?? emptyPayload(repo, 'Release information is temporarily unavailable');
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };

  router.get('/', async (_req, res, next) => {
    try {
      const payload = await load();
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get('/latest', async (_req, res, next) => {
    try {
      const payload = await load();
      if (!payload.version) {
        res.status(404).json({ error: payload.message ?? 'No release information available', code: 'NOT_FOUND' });
        return;
      }
      res.json({ version: payload.version, tag: payload.tag, buildDate: payload.buildDate, changelog: payload.changelog, url: payload.releaseUrl });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
