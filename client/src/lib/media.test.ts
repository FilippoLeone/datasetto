import { beforeEach, describe, expect, it } from 'vitest';
import { mediaTicket, mediaTicketStale, mediaUrl, setMediaTicket, TICKET_RENEW_MARGIN_MS } from './media';

describe('media ticket', () => {
  beforeEach(() => {
    setMediaTicket(null);
  });

  it('appends the ticket to picture URLs and leaves them alone without one', () => {
    expect(mediaUrl('/api/uploads/att-1.png')).toBe('/api/uploads/att-1.png');
    setMediaTicket({ ticket: 'abc.def', expiresAt: Date.now() + 10_000 });
    expect(mediaUrl('/api/uploads/att-1.png')).toBe('/api/uploads/att-1.png?t=abc.def');
    expect(mediaUrl('/api/uploads/att-1.png?v=2')).toBe('/api/uploads/att-1.png?v=2&t=abc.def');
    expect(mediaUrl('/api/uploads/att-1.png', { ticket: 'x y', expiresAt: 1 })).toBe('/api/uploads/att-1.png?t=x%20y');
  });

  it('knows when a ticket needs renewing and ignores malformed ones', () => {
    expect(mediaTicketStale()).toBe(true);
    setMediaTicket({ ticket: 't', expiresAt: Date.now() + TICKET_RENEW_MARGIN_MS + 60_000 });
    expect(mediaTicketStale()).toBe(false);
    expect(mediaTicketStale(Date.now() + 120_000)).toBe(true);
    setMediaTicket({ ticket: 42, expiresAt: 'soon' } as unknown as { ticket: string; expiresAt: number });
    expect(mediaTicket.value).toBeNull();
  });
});
