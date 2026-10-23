import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { Sheet } from './Sheet';

// The sheet renders into a portal on document.body, not into the host.

const host = document.createElement('div');
document.body.appendChild(host);

afterEach(() => render(null, host));

describe('Sheet footer', () => {
  it('keeps the footer outside the scrolling content, padded clear of the home indicator', async () => {
    await act(async () => {
      render(
        <Sheet title="Arcade" onClose={() => undefined} footer={<button type="button" data-test-start>Start</button>}>
          <p data-test-body>Body</p>
        </Sheet>,
        host,
      );
    });
    const start = document.querySelector('[data-test-start]') as HTMLElement;
    const body = document.querySelector('[data-test-body]') as HTMLElement;
    const scroller = body.closest('.overflow-y-auto') as HTMLElement;
    expect(scroller).not.toBeNull();
    // The footer never scrolls away with the content...
    expect(scroller.contains(start)).toBe(false);
    // ...and carries the bottom safe-area inset itself, while the scroller no longer does.
    expect(start.parentElement?.className).toContain('pb-[env(safe-area-inset-bottom,0px)]');
    expect(scroller.className).not.toContain('safe-area-inset-bottom');
  });

  it('pads the scrolling content for the home indicator when there is no footer', async () => {
    await act(async () => {
      render(
        <Sheet title="Arcade" onClose={() => undefined}>
          <p data-test-body>Body</p>
        </Sheet>,
        host,
      );
    });
    const scroller = (document.querySelector('[data-test-body]') as HTMLElement).closest('.overflow-y-auto') as HTMLElement;
    expect(scroller.className).toContain('safe-area-inset-bottom');
  });
});
