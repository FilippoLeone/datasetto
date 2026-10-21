import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { AttachmentGrid } from './AttachmentGrid';
import { setMediaTicket } from '@/lib/media';
import type { Attachment } from '@/types/protocol';

const host = document.createElement('div');
document.body.appendChild(host);

const picture: Attachment = { id: 'att-pic', kind: 'image', fileName: 'cat.png', mime: 'image/png', size: 1000, width: 800, height: 600, url: '/api/uploads/att-pic.png', previewUrl: '/api/uploads/att-pic.preview.webp', previewWidth: 800, previewHeight: 600 };
const clip: Attachment = { id: 'att-clip', kind: 'video', fileName: 'datasetto-clip-alices-screen-2026-10-21_20-40-09.webm', mime: 'video/webm', size: 10 * 1024 * 1024, width: 1280, height: 720, url: '/api/uploads/att-clip.webm', previewUrl: '/api/uploads/att-clip.webm', previewWidth: 1280, previewHeight: 720 };

afterEach(() => {
  render(null, host);
  setMediaTicket(null);
});

describe('AttachmentGrid', () => {
  it('plays a posted clip in a video element with the media ticket, named and sized under it', () => {
    setMediaTicket({ ticket: 'tkt', expiresAt: Date.now() + 60_000 });
    render(<AttachmentGrid attachments={[clip]} />, host);
    const figure = host.querySelector('[data-attachment-video="att-clip"]') as HTMLElement;
    expect(figure).not.toBeNull();
    const video = figure.querySelector('video') as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe('/api/uploads/att-clip.webm?t=tkt');
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.getAttribute('preload')).toBe('metadata');
    expect(video.style.aspectRatio).toBe('1280 / 720');
    expect(figure.querySelector('figcaption')?.textContent).toContain('datasetto-clip-alices-screen-2026-10-21_20-40-09.webm');
    expect(figure.querySelector('figcaption')?.textContent).toContain('10.0 MB');
    // Videos have no lightbox tile.
    expect(host.querySelector('button')).toBeNull();
  });

  it('keeps pictures in their grid and lists videos after them', () => {
    render(<AttachmentGrid attachments={[clip, picture]} />, host);
    const grid = host.querySelector('[data-attachments]') as HTMLElement;
    expect(grid.getAttribute('data-attachments')).toBe('1');
    expect(grid.querySelector('button[aria-label="Open cat.png"]')).not.toBeNull();
    expect(host.querySelectorAll('video')).toHaveLength(1);
    expect(grid.compareDocumentPosition(host.querySelector('[data-attachment-video]') as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    render(<AttachmentGrid attachments={[]} />, host);
    expect(host.innerHTML).toBe('');
  });
});
