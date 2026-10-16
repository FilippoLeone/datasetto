import { runtimeUrls } from '@/lib/runtimeConfig';
import { sessionToken } from '@/state/session';

export interface HlsTicket {
  ticket: string;
  expiresAt: number;
  ttlSeconds: number;
}

export class HlsTicketError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Asks the server for a short-lived viewer ticket for one stream. The server
 * also sets a cookie scoped to the stream's HLS path, which covers players that
 * cannot add request headers (Safari's native HLS).
 */
export const fetchHlsTicket = async (channelName: string): Promise<HlsTicket> => {
  const token = sessionToken.value;
  if (!token) throw new HlsTicketError('NOT_AUTHENTICATED', 'Sign in to watch', 401);
  const base = (runtimeUrls.apiBaseUrl || '').replace(/[/]+$/, '');
  const response = await fetch(`${base}/api/stream/${encodeURIComponent(channelName)}/ticket`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
    credentials: 'include',
    cache: 'no-store',
  });
  const body = (await response.json().catch(() => ({}))) as Partial<HlsTicket> & { error?: string; code?: string };
  if (!response.ok || typeof body.ticket !== 'string') {
    throw new HlsTicketError(body.code ?? 'TICKET_FAILED', body.error ?? 'Could not start playback', response.status);
  }
  return { ticket: body.ticket, expiresAt: body.expiresAt ?? Date.now() + 5 * 60_000, ttlSeconds: body.ttlSeconds ?? 300 };
};
