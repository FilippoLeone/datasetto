import { describe, expect, it } from 'vitest';
import { formatDuration, initials, primaryRole } from './format';

describe('format helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(65_000)).toBe('01:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
  });

  it('picks the highest role', () => {
    expect(primaryRole(['user', 'moderator'])).toBe('moderator');
    expect(primaryRole(['admin', 'superuser'])).toBe('superuser');
    expect(primaryRole([])).toBe('user');
    expect(primaryRole(undefined)).toBe('user');
  });

  it('derives initials', () => {
    expect(initials('Alice Smith')).toBe('AS');
    expect(initials('bob')).toBe('BO');
    expect(initials('')).toBe('?');
  });
});
