import { signal } from '@preact/signals';
import { runtimeUrls } from '@/lib/runtimeConfig';
import type { MediaTicket } from '@/types/protocol';

/**
 * Pictures in chat are served from `/api/uploads/<file>` only to signed-in viewers who
 * may read the channel. An `<img>` cannot send the session token, so the server hands
 * out a signed media ticket (bound to the account, valid a day) that goes into every
 * picture URL as `?t=`. It arrives with `auth:success` and is renewed before it expires.
 */
export const mediaTicket = signal<MediaTicket | null>(null);

/** Renew this long before the ticket expires. */
export const TICKET_RENEW_MARGIN_MS = 60 * 60 * 1000;

export const setMediaTicket = (ticket: MediaTicket | null | undefined): void => {
  mediaTicket.value = ticket && typeof ticket.ticket === 'string' && typeof ticket.expiresAt === 'number' ? ticket : null;
};

/** Is the ticket missing or about to expire? */
export const mediaTicketStale = (now = Date.now()): boolean => {
  const current = mediaTicket.value;
  return !current || current.expiresAt - now < TICKET_RENEW_MARGIN_MS;
};

/**
 * Absolute URL for a server-relative picture path with the viewer's ticket attached.
 * Without a ticket the path is returned as is (the server answers 401 and the image
 * simply does not load until the ticket arrives and the URL changes).
 */
export const mediaUrl = (path: string, ticket: MediaTicket | null = mediaTicket.value): string => {
  const base = path.startsWith('/api/') && runtimeUrls.apiBaseUrl ? runtimeUrls.apiBaseUrl + path : path;
  if (!ticket) return base;
  return base + (base.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(ticket.ticket);
};
