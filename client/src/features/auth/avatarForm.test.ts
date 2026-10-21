import { describe, expect, it } from 'vitest';
import { avatarFormState, effectiveAvatarUrl, isUploadedAvatar } from './avatarForm';

describe('avatar form state', () => {
  it('recognizes only our own avatar paths as uploads', () => {
    expect(isUploadedAvatar('/api/avatars/abc-123.webp')).toBe(true);
    expect(isUploadedAvatar('/api/avatars/abc-123.png?v=2')).toBe(true);
    expect(isUploadedAvatar('https://example.com/api/avatars/abc.webp')).toBe(false);
    expect(isUploadedAvatar('https://example.com/me.png')).toBe(false);
    expect(isUploadedAvatar('')).toBe(false);
    expect(isUploadedAvatar(null)).toBe(false);
    expect(isUploadedAvatar(undefined)).toBe(false);
  });

  it('keeps an uploaded picture out of the URL field', () => {
    expect(avatarFormState('/api/avatars/abc-123.webp')).toEqual({ uploadedUrl: '/api/avatars/abc-123.webp', externalUrl: '' });
  });

  it('shows an external link in the URL field and nothing for a generated avatar', () => {
    expect(avatarFormState('https://example.com/me.png')).toEqual({ uploadedUrl: null, externalUrl: 'https://example.com/me.png' });
    expect(avatarFormState(null)).toEqual({ uploadedUrl: null, externalUrl: '' });
    expect(avatarFormState(undefined)).toEqual({ uploadedUrl: null, externalUrl: '' });
  });

  it('stores the typed link first, then the uploaded picture, then nothing', () => {
    expect(effectiveAvatarUrl({ uploadedUrl: '/api/avatars/a.webp', externalUrl: '' })).toBe('/api/avatars/a.webp');
    expect(effectiveAvatarUrl({ uploadedUrl: '/api/avatars/a.webp', externalUrl: '  ' })).toBe('/api/avatars/a.webp');
    expect(effectiveAvatarUrl({ uploadedUrl: '/api/avatars/a.webp', externalUrl: ' https://example.com/me.png ' })).toBe('https://example.com/me.png');
    expect(effectiveAvatarUrl({ uploadedUrl: null, externalUrl: '' })).toBeNull();
  });
});
