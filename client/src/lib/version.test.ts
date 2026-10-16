import { describe, expect, it } from 'vitest';
import { compareVersions, isNewerVersion, parseVersion } from './version';

describe('parseVersion', () => {
  it('reads plain, prefixed and pre-release versions', () => {
    expect(parseVersion('0.1.12')).toEqual({ numbers: [0, 1, 12], prerelease: '', commits: 0 });
    expect(parseVersion('v0.1.12')).toEqual({ numbers: [0, 1, 12], prerelease: '', commits: 0 });
    expect(parseVersion(' V1.2 ')).toEqual({ numbers: [1, 2], prerelease: '', commits: 0 });
    expect(parseVersion('1.2.0-beta.1')).toEqual({ numbers: [1, 2, 0], prerelease: 'beta.1', commits: 0 });
    expect(parseVersion('1.0.0+build.7')).toEqual({ numbers: [1, 0, 0], prerelease: 'build.7', commits: 0 });
  });

  it('reads a git describe version as the tag plus a number of commits', () => {
    expect(parseVersion('0.1.12-2-gabc123')).toEqual({ numbers: [0, 1, 12], prerelease: '', commits: 2 });
    expect(parseVersion('v0.1.12-15-g0a1b2c3d')).toEqual({ numbers: [0, 1, 12], prerelease: '', commits: 15 });
    // Describing from a pre-release tag keeps the pre-release.
    expect(parseVersion('0.2.0-beta.1-3-gabc123')).toEqual({ numbers: [0, 2, 0], prerelease: 'beta.1', commits: 3 });
    // Not a describe tail: too short for a hash, or not hexadecimal.
    expect(parseVersion('1.2.0-1-gabc')).toEqual({ numbers: [1, 2, 0], prerelease: '1-gabc', commits: 0 });
    expect(parseVersion('1.2.0-1-gamma')).toEqual({ numbers: [1, 2, 0], prerelease: '1-gamma', commits: 0 });
  });

  it('rejects what is not a version', () => {
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion('unknown')).toBeNull();
    expect(parseVersion('1.')).toBeNull();
    expect(parseVersion('-2-gabc123')).toBeNull();
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders by number, not by string', () => {
    expect(compareVersions('0.1.9', '0.1.10')).toBeLessThan(0);
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.1.12', '0.1.12')).toBe(0);
  });

  it('treats missing parts as zero and ignores the v prefix', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('v0.1.11', '0.1.11')).toBe(0);
    expect(compareVersions('1.2.0.1', '1.2')).toBeGreaterThan(0);
  });

  it('puts pre-releases below the plain release', () => {
    expect(compareVersions('1.2.0-beta.1', '1.2.0')).toBeLessThan(0);
    expect(compareVersions('1.2.0', '1.2.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0-beta.2', '1.2.0-beta.10')).toBeLessThan(0);
    expect(compareVersions('1.2.0-alpha', '1.2.0-beta')).toBeLessThan(0);
    expect(compareVersions('1.2.0-beta', '1.2.0-beta.1')).toBeLessThan(0);
    expect(compareVersions('0.2.0-beta.1', '0.1.12')).toBeGreaterThan(0);
  });

  it('puts a git describe build above its base release and below the next one', () => {
    // Commits after the tag make the build newer than the tag itself.
    expect(compareVersions('0.1.12-2-gabc123', '0.1.12')).toBeGreaterThan(0);
    expect(compareVersions('0.1.12', '0.1.12-2-gabc123')).toBeLessThan(0);
    expect(compareVersions('0.1.12-2-gabc123', 'v0.1.12')).toBeGreaterThan(0);
    expect(compareVersions('0.1.12-2-gabc123', '0.1.11')).toBeGreaterThan(0);
    // The next release is still newer.
    expect(compareVersions('0.1.12-2-gabc123', '0.1.13')).toBeLessThan(0);
    expect(compareVersions('0.1.12-99-gabc123', '0.2.0')).toBeLessThan(0);
    // More commits after the same tag is newer; the same distance is equal.
    expect(compareVersions('0.1.12-3-gabc123', '0.1.12-2-gdef456')).toBeGreaterThan(0);
    expect(compareVersions('0.1.12-2-gabc123', '0.1.12-2-gdef456')).toBe(0);
    // A describe from a pre-release tag stays below the plain release.
    expect(compareVersions('0.2.0-beta.1-3-gabc123', '0.2.0-beta.1')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0-beta.1-3-gabc123', '0.2.0')).toBeLessThan(0);
  });

  it('ranks unparseable input lowest', () => {
    expect(compareVersions('unknown', '0.0.1')).toBeLessThan(0);
    expect(compareVersions('0.0.1', '')).toBeGreaterThan(0);
    expect(compareVersions(null, undefined)).toBe(0);
  });
});

describe('isNewerVersion', () => {
  it('is true only for a strictly newer valid version', () => {
    expect(isNewerVersion('0.1.12', '0.1.11')).toBe(true);
    expect(isNewerVersion('0.1.11', '0.1.11')).toBe(false);
    expect(isNewerVersion('0.1.10', '0.1.11')).toBe(false);
    expect(isNewerVersion('0.2.0', '0.2.0-beta.1')).toBe(true);
    expect(isNewerVersion('0.2.0-beta.1', '0.2.0')).toBe(false);
  });

  it('does not announce the latest release to a build made after it', () => {
    expect(isNewerVersion('0.1.12', '0.1.12-2-gabc123')).toBe(false);
    expect(isNewerVersion('v0.1.12', '0.1.12-2-gabc123')).toBe(false);
    expect(isNewerVersion('0.1.13', '0.1.12-2-gabc123')).toBe(true);
    expect(isNewerVersion('v0.1.12', '0.1.11-3-gabc123')).toBe(true);
  });

  it('never fires when either side is unknown', () => {
    expect(isNewerVersion('0.1.12', '')).toBe(false);
    expect(isNewerVersion('0.1.12', 'unknown')).toBe(false);
    expect(isNewerVersion(null, '0.1.11')).toBe(false);
    expect(isNewerVersion('latest', '0.1.11')).toBe(false);
  });
});
