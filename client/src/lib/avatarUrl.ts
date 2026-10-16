import { runtimeUrls } from '@/lib/runtimeConfig';

/**
 * Uploaded avatars are stored as server-relative URLs (`/api/avatars/<id>.webp?v=…`).
 * The web app can use them as-is; the desktop and mobile shells talk to an absolute
 * server URL, so prefix it there. External URLs pass through untouched.
 */
export const resolveAvatarUrl = (url: string | null | undefined): string | null => {
  if (!url) return null;
  if (url.startsWith('/api/')) return runtimeUrls.apiBaseUrl ? runtimeUrls.apiBaseUrl + url : url;
  return url;
};
