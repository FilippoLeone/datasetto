import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateAccountCalls: Array<Record<string, unknown>> = [];

vi.mock('@/services/socket/api', () => ({
  api: {
    updateAccount: (payload: Record<string, unknown>) => {
      updateAccountCalls.push(payload);
    },
    logout: () => undefined,
  },
}));
vi.mock('@/services/avatarUpload', () => ({
  uploadAvatar: vi.fn(),
  deleteAvatar: vi.fn(),
}));
vi.mock('@/features/voice/voiceManager', () => ({
  voiceManager: { leave: async () => undefined },
}));

import { ProfileModal } from './ProfileModal';
import { account } from '@/state/session';
import type { Account } from '@/types/protocol';

const host = document.createElement('div');
document.body.appendChild(host);

const me: Account = {
  id: 'acc-1',
  username: 'alice',
  displayName: 'Alice',
  roles: ['user'],
  status: 'active',
  avatarUrl: '/api/avatars/acc-1.webp',
};

const urlInput = (): HTMLInputElement => host.querySelector('input[type="url"]') as HTMLInputElement;
const form = (): HTMLFormElement => host.querySelector('#profile-form') as HTMLFormElement;
const submit = () => act(() => form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
/** Type into the URL field and let Preact re-render before anything else happens. */
const typeUrl = (value: string) =>
  act(() => {
    const input = urlInput();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

beforeEach(() => {
  updateAccountCalls.length = 0;
});

afterEach(() => {
  render(null, host);
  account.value = null;
});

describe('ProfileModal avatar field', () => {
  it('leaves the URL field empty while an uploaded picture is in use, so the form stays valid', () => {
    account.value = me;
    render(<ProfileModal />, host);
    expect(urlInput().value).toBe('');
    expect(urlInput().checkValidity()).toBe(true);
    expect(host.textContent).toContain('Your uploaded picture is in use');
    expect(host.querySelector('img')?.getAttribute('src')).toBe('/api/avatars/acc-1.webp');
  });

  it('does not touch the avatar when saving with the uploaded picture unchanged', () => {
    account.value = me;
    render(<ProfileModal />, host);
    submit();
    expect(updateAccountCalls).toHaveLength(1);
    expect(updateAccountCalls[0]).not.toHaveProperty('avatarUrl');
  });

  it('switches to a typed link and sends it on save', () => {
    account.value = me;
    render(<ProfileModal />, host);
    typeUrl('https://example.com/me.png');
    expect(urlInput().value).toBe('https://example.com/me.png');
    expect(urlInput().checkValidity()).toBe(true);
    expect(host.querySelector('img')?.getAttribute('src')).toBe('https://example.com/me.png');
    submit();
    expect(updateAccountCalls[0]?.avatarUrl).toBe('https://example.com/me.png');
  });

  it('shows an external link in the field and clears it to a generated avatar', () => {
    account.value = { ...me, avatarUrl: 'https://example.com/old.png' };
    render(<ProfileModal />, host);
    expect(urlInput().value).toBe('https://example.com/old.png');
    typeUrl('');
    submit();
    expect(updateAccountCalls[0]?.avatarUrl).toBeNull();
  });
});
