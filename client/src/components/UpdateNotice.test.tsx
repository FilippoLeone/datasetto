import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UpdateNotice } from './UpdateNotice';
import { isPhone } from '@/state/ui';
import { dismissedUpdateVersion, updateNotice } from '@/state/updates';

const host = document.createElement('div');
document.body.appendChild(host);

const card = (): HTMLElement | null => host.querySelector('[data-testid="update-notice"]');

const show = async (placement?: 'floating' | 'sidebar') => {
  await act(async () => {
    render(<UpdateNotice placement={placement} />, host);
  });
  // The presence hook mounts on the next frame.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
};

beforeEach(() => {
  dismissedUpdateVersion.value = null;
  isPhone.value = false;
});

afterEach(() => {
  render(null, host);
  updateNotice.value = null;
  isPhone.value = false;
});

describe('UpdateNotice', () => {
  it('sits in the sidebar flow, never fixed over the composer', async () => {
    updateNotice.value = { kind: 'ready', version: '9.9.9' };
    await show('sidebar');
    const el = card();
    expect(el?.dataset.placement).toBe('sidebar');
    expect(el?.className).not.toContain('fixed');
    expect(el?.textContent).toContain('Update ready');
    expect(el?.textContent).toContain('Version 9.9.9.');
    expect(el?.textContent).toContain('Restart now');
  });

  it('floats in the bottom corner on wide screens and under the header on phones', async () => {
    updateNotice.value = { kind: 'available', version: '9.9.9', url: 'https://example.com/downloads', reload: true };
    await show();
    expect(card()?.className).toContain('bottom-4');
    render(null, host);
    isPhone.value = true;
    await show();
    const el = card();
    expect(el?.className).toContain('top-[calc(env(safe-area-inset-top,0px)+3.5rem)]');
    expect(el?.className).not.toContain('bottom-');
    expect([...(el?.querySelectorAll('button') ?? [])].map((b) => b.textContent?.trim() || b.getAttribute('aria-label'))).toEqual(['Dismiss', 'Reload', 'Download']);
  });

  it('renders nothing once dismissed', async () => {
    updateNotice.value = { kind: 'ready', version: '9.9.9' };
    dismissedUpdateVersion.value = '9.9.9';
    await show('sidebar');
    expect(card()).toBeNull();
  });
});
