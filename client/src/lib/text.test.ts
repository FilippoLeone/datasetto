import { describe, expect, it } from 'vitest';
import { containsMention, sanitizeUrl } from './text';

describe('sanitizeUrl', () => {
  it('accepts http(s) and rejects other schemes', () => {
    expect(sanitizeUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(sanitizeUrl('http://example.com')).toBe('http://example.com/');
    expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeUrl('not a url')).toBeNull();
  });
});

describe('containsMention', () => {
  it('matches case-insensitively on any of the names', () => {
    expect(containsMention('ping @Alice now', ['alice', 'alice@example.com'])).toBe(true);
    expect(containsMention('no mention', ['alice'])).toBe(false);
  });
});
