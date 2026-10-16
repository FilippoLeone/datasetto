import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReleasePayload, releasesRouter, type GitHubRelease } from '../src/http/routes/releases.js';
import type { AppContext } from '../src/context.js';
import { makeContext } from './helpers.js';

const release: GitHubRelease = {
  tag_name: 'v0.1.6',
  html_url: 'https://github.com/FilippoLeone/datasetto/releases/tag/v0.1.6',
  body: 'Notes',
  published_at: '2026-02-10T21:36:22Z',
  assets: [
    { name: 'datasetto-android-v0.1.6-debug.apk', size: 4293996, download_count: 5, browser_download_url: 'https://example.test/app.apk' },
    { name: 'Datasetto-0.1.0-linux-x86_64.AppImage', size: 108355681, download_count: 4, browser_download_url: 'https://example.test/app.AppImage' },
    { name: 'Datasetto-0.1.0-mac-arm64.dmg', size: 96650869, download_count: 5, browser_download_url: 'https://example.test/app.dmg' },
    { name: 'Datasetto-0.1.0-win-x64.exe', size: 79482157, download_count: 6, browser_download_url: 'https://example.test/app.exe' },
    { name: 'Datasetto-0.1.0-win-x64.exe.blockmap', size: 1000, download_count: 0, browser_download_url: 'https://example.test/app.exe.blockmap' },
    { name: 'latest.yml', size: 300, download_count: 0, browser_download_url: 'https://example.test/latest.yml' },
  ],
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('releases', () => {
  let ctx: AppContext | null = null;

  afterEach(() => {
    ctx?.db.close();
    ctx = null;
  });

  it('maps a GitHub release to the downloads payload', () => {
    const payload = buildReleasePayload('FilippoLeone/datasetto', release);
    expect(payload.version).toBe('0.1.6');
    expect(payload.tag).toBe('v0.1.6');
    expect(payload.releaseUrl).toBe(release.html_url);
    expect(payload.builds.map((build) => [build.platform, build.arch, build.source])).toEqual([
      ['windows', 'x64', 'desktop'],
      ['macos', 'arm64', 'desktop'],
      ['linux', 'x64', 'desktop'],
      ['android', 'universal', 'mobile'],
    ]);
    expect(payload.builds[0]).toMatchObject({ downloads: 6, sizeFormatted: '75.8 MB', downloadUrl: 'https://example.test/app.exe' });
  });

  it('serves the latest release and caches it', async () => {
    ctx = makeContext();
    let calls = 0;
    const fetchStub = (async () => {
      calls += 1;
      return jsonResponse(release);
    }) as unknown as typeof fetch;
    const app = express().use('/api/releases', releasesRouter(ctx, fetchStub));

    const list = await request(app).get('/api/releases').expect(200);
    expect(list.body.version).toBe('0.1.6');
    expect(list.body.builds).toHaveLength(4);

    const latest = await request(app).get('/api/releases/latest').expect(200);
    expect(latest.body).toMatchObject({ version: '0.1.6', tag: 'v0.1.6', url: release.html_url });
    expect(calls).toBe(1);
  });

  it('answers with an empty list when GitHub is unreachable or has no releases', async () => {
    ctx = makeContext();
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const offline = await request(express().use('/api/releases', releasesRouter(ctx, failing))).get('/api/releases').expect(200);
    expect(offline.body.builds).toEqual([]);
    expect(offline.body.message).toMatch(/unavailable/);
    expect(offline.body.releaseUrl).toBe('https://github.com/FilippoLeone/datasetto/releases');

    const none = (async () => jsonResponse({ message: 'Not Found' }, 404)) as unknown as typeof fetch;
    const empty = await request(express().use('/api/releases', releasesRouter(ctx, none))).get('/api/releases/latest').expect(404);
    expect(empty.body.code).toBe('NOT_FOUND');
  });
});
