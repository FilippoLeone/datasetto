import { describe, expect, it } from 'vitest';
import { compareVersions, isNewerVersion, parseVersion } from './version';

describe('parseVersion', () => {
  it('reads plain, prefixed and pre-release versions', () => {
    expect(parseVersion('0.1.12')).toEqual({ numbers: [0, 1, 12], prerelease: '' });
    expect(parseVersion('v0.1.12')).toEqual({ numbers: [0, 1, 12], prerelease: '' });
    expect(parseVersion(' V1.2 ')).toEqual({ numbers: [1, 2], prerelease: '' });
    expect(parseVersion('1.2.0-beta.1')).toEqual({ numbers: [1, 2, 0], prerelease: 'beta.1' });
    expect(parseVersion('0.1.11-3-gabc123')).toEqual({ numbers: [0, 1, 11], prerelease: '3-gabc123' });
    expect(parseVersion('1.0.0+build.7')).toEqual({ numbers: [1, 0, 0], prerelease: 'build.7' });
  });

  it('rejects what is not a version', () => {
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion('unknown')).toBeNull();
    expect(parseVersion('1.')).toBeNull();
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
  });

  it('treats missing parts as zero and ignores the v prefix', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('v0.1.11', '0.1.11')).toBe(0);
    expect(compareVersions('1.2.0.1', '1.2')).toBeGreaterThan(0);
  });

  it('puts pre-releases and git describe suffixes below the plain release', () => {
    expect(compareVersions('1.2.0-beta.1', '1.2.0')).toBeLessThan(0);
    expect(compareVersions('1.2.0', '1.2.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0-beta.2', '1.2.0-beta.10')).toBeLessThan(0);
    expect(compareVersions('1.2.0-alpha', '1.2.0-beta')).toBeLessThan(0);
    expect(compareVersions('1.2.0-beta', '1.2.0-beta.1')).toBeLessThan(0);
    expect(compareVersions('0.1.11-3-gabc123', '0.1.11')).toBeLessThan(0);
    expect(compareVersions('0.1.11-3-gabc123', '0.1.10')).toBeGreaterThan(0);
    expect(compareVersions('0.1.11-3-gabc123', '0.1.12')).toBeLessThan(0);
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
    expect(isNewerVersion('v0.1.12', '0.1.11-3-gabc123')).toBe(true);
    expect(isNewerVersion('0.1.11', '0.1.11')).toBe(false);
    expect(isNewerVersion('0.1.10', '0.1.11')).toBe(false);
  });

  it('never fires when either side is unknown', () => {
    expect(isNewerVersion('0.1.12', '')).toBe(false);
    expect(isNewerVersion('0.1.12', 'unknown')).toBe(false);
    expect(isNewerVersion(null, '0.1.11')).toBe(false);
    expect(isNewerVersion('latest', '0.1.11')).toBe(false);
  });
});
