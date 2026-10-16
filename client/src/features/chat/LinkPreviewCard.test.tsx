import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinkPreviewCard } from './LinkPreviewCard';
import type { LinkPreview } from '@/types/protocol';

const host = document.createElement('div');
document.body.appendChild(host);

const preview: LinkPreview = {
  url: 'https://www.example.com/post/1',
  title: 'A fine post',
  description: 'Something worth reading, with <b>no</b> markup rendered.',
  image: 'https://cdn.example.com/card.png',
  siteName: 'Example',
};

afterEach(() => render(null, host));

describe('LinkPreviewCard', () => {
  it('shows site, title, description and a thumbnail that never sends a referrer', () => {
    render(<LinkPreviewCard preview={preview} />, host);
    const card = host.querySelector('[data-link-preview]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('Example');
    expect(card.textContent).toContain('A fine post');
    expect(card.textContent).toContain('with <b>no</b> markup rendered');
    expect(card.querySelector('b')).toBeNull();
    const link = card.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(preview.url);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    const image = card.querySelector('img') as HTMLImageElement;
    expect(image.getAttribute('src')).toBe(preview.image);
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(image.getAttribute('loading')).toBe('lazy');
    expect(card.querySelector('button[aria-label="Remove preview"]')).toBeNull();
  });

  it('falls back to the host as title and site, renders nothing without content, and hides a broken image', async () => {
    render(<LinkPreviewCard preview={{ url: 'https://www.example.com/x', title: null, description: 'Only a description', image: null, siteName: null }} />, host);
    expect(host.textContent).toContain('example.com');
    expect(host.querySelectorAll('img')).toHaveLength(0);
    render(<LinkPreviewCard preview={{ url: 'https://example.com', title: null, description: null, image: null, siteName: null }} />, host);
    expect(host.querySelector('[data-link-preview]')).toBeNull();
    render(<LinkPreviewCard preview={null} />, host);
    expect(host.innerHTML).toBe('');

    render(<LinkPreviewCard preview={{ ...preview, title: null, description: null }} />, host);
    const only = host.querySelector('img') as HTMLImageElement;
    expect(only.className).toContain('max-h-64');
    only.dispatchEvent(new Event('error'));
    // Preact re-renders on the next tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.querySelector('[data-link-preview]')).toBeNull();
  });

  it('offers the remove control only when allowed and calls back', () => {
    const onRemove = vi.fn();
    render(<LinkPreviewCard preview={preview} canRemove onRemove={onRemove} />, host);
    const button = host.querySelector('button[aria-label="Remove preview"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    button.click();
    expect(onRemove).toHaveBeenCalledTimes(1);
    render(<LinkPreviewCard preview={preview} canRemove={false} onRemove={onRemove} />, host);
    expect(host.querySelector('button[aria-label="Remove preview"]')).toBeNull();
  });
});
