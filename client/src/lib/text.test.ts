import { describe, expect, it } from 'vitest';
import { containsMention, sanitizeUrl, tokenizeMessage } from './text';

describe('sanitizeUrl', () => {
  it('accepts http(s) and rejects other schemes', () => {
    expect(sanitizeUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(sanitizeUrl('http://example.com')).toBe('http://example.com/');
    expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeUrl('not a url')).toBeNull();
  });
});

describe('tokenizeMessage', () => {
  it('splits links, mentions and line breaks', () => {
    const tokens = tokenizeMessage('hey @bob see https://example.com/x\nthanks');
    expect(tokens).toEqual([
      { type: 'text', value: 'hey ' },
      { type: 'mention', value: '@bob' },
      { type: 'text', value: ' see ' },
      { type: 'link', value: 'https://example.com/x', href: 'https://example.com/x' },
      { type: 'break' },
      { type: 'text', value: 'thanks' },
    ]);
  });

  it('keeps unsafe urls as plain text', () => {
    expect(tokenizeMessage('x')).toEqual([{ type: 'text', value: 'x' }]);
    expect(tokenizeMessage('')).toEqual([]);
  });
});

describe('containsMention', () => {
  it('matches case-insensitively on any of the names', () => {
    expect(containsMention('ping @Alice now', ['alice', 'alice@example.com'])).toBe(true);
    expect(containsMention('no mention', ['alice'])).toBe(false);
  });
});
