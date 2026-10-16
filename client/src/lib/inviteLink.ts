import { runtimeUrls } from '@/lib/runtimeConfig';

/**
 * Registration link for an invite token: `https://host/app?invite=TOKEN`.
 * Web builds use the page origin; the desktop and mobile shells point at the
 * configured server so the link opens in a browser anywhere.
 */
export const inviteLinkFor = (token: string, origin = window.location.origin): string => {
  const base = runtimeUrls.serverUrl && runtimeUrls.serverUrl !== '/' ? runtimeUrls.serverUrl : origin;
  return base.replace(/\/+$/, '') + '/app?invite=' + encodeURIComponent(token);
};
