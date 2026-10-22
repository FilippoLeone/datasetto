/// <reference types="node" />
/**
 * Idle costs nothing: no endless animation runs while nothing happens. An endless CSS animation
 * keeps the page drawing every frame (240 a second on a 240 Hz screen), and one that animates
 * paint (box-shadow, background-position) also repaints on the main thread every frame.
 *
 * 1. app.css: only allowlisted rules may animate forever, each tied to a state that is not idle.
 * 2. Sources: Tailwind's endless utilities (animate-spin, -pulse, -ping, -bounce) appear only in
 *    allowlisted files, each shown only while something is loading or reconnecting.
 * 3. Rendered idle shell (sidebar, signed in, connected, a live stream, someone in voice, nobody
 *    speaking): no element carries a class that animates forever.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/socket/api', () => ({ api: new Proxy({}, { get: () => () => undefined }) }));
vi.mock('@/features/voice/voiceManager', () => ({
  voiceManager: new Proxy({}, { get: () => () => undefined }),
}));

import { Avatar } from '@/components';
import { Sidebar } from '@/app/layout/Sidebar';
import { setChannels } from '@/state/channels';
import { users } from '@/state/presence';
import { account, connectionStatus } from '@/state/session';
import type { Account, Channel, User } from '@/types/protocol';

// Read from disk: Vitest turns CSS imports (even ?raw) into empty strings.
const cssText = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../styles/app.css'), 'utf8');

/** Rules allowed to animate forever, and why that is not idle. */
const CSS_ALLOWLIST: Record<string, string> = {
  '.speaking-ring::before, .speaking-ring::after': 'only while someone speaks; opacity on pseudo-elements, which the compositor runs without repainting',
};

/** Files allowed to use an endless Tailwind animation, and when it shows. */
const UTILITY_ALLOWLIST: Record<string, string> = {
  'src/components/Spinner.tsx': 'loading spinner, mounted only while something loads',
  'src/app/ConnectionBanner.tsx': 'spinner while the connection is down',
  'src/app/layout/Sidebar.tsx': 'reconnecting icon, only while not connected',
  'src/features/settings/GameActivitySection.tsx': 'refresh icon spins only while the game list loads',
};

const ENDLESS_UTILITIES = ['animate-spin', 'animate-pulse', 'animate-ping', 'animate-bounce'];

/** Every `selector { … }` block of a stylesheet whose animation repeats forever. */
const endlessRules = (css: string): string[] => {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: string[] = [];
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selector, body] = match;
    if (/animation(-iteration-count)?\s*:[^;]*\binfinite\b/.test(body)) found.push(selector.trim().replace(/\s+/g, ' '));
  }
  return found;
};

/** Class names that select an endless animation: the CSS rules' classes plus Tailwind's utilities. */
const endlessClasses = (): string[] => {
  const fromCss = endlessRules(cssText).flatMap((selector) => [...selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1]));
  return [...new Set([...fromCss, ...ENDLESS_UTILITIES])];
};

describe('idle animations', () => {
  it('app.css animates forever only in allowlisted rules', () => {
    const rules = endlessRules(cssText);
    expect(rules.length).toBeGreaterThan(0); // the parser sees the speaking pulse
    expect(rules.filter((rule) => !(rule in CSS_ALLOWLIST))).toEqual([]);
  });

  it('the sidebar live dot, skeletons and the clips indicator stop on their own', () => {
    const text = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
    const animationOf = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(escaped + '\\s*\\{[^}]*animation:\\s*([^;]+);').exec(text)?.[1] ?? '';
    };
    expect(animationOf('.live-dot::before')).toMatch(/pulse-dot .* 3$/);
    expect(animationOf('.skeleton::after')).toMatch(/shimmer .* 20$/);
    expect(animationOf('.clip-pulse')).toMatch(/clip-pulse .* 1$/);
    // Paint-heavy properties are not animated any more.
    const keyframes = (name: string) => new RegExp('@keyframes ' + name + '\\s*\\{([\\s\\S]*?)\\n\\}').exec(text)?.[1] ?? '';
    expect(keyframes('speaking-pulse')).not.toMatch(/box-shadow/);
    expect(keyframes('shimmer')).not.toMatch(/background-position/);
  });

  it('endless Tailwind animations appear only in allowlisted files', () => {
    const sources = import.meta.glob(['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}', '!/src/test/**'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      const file = path.replace(/^\//, '');
      const uses = ENDLESS_UTILITIES.some((name) => new RegExp('\\b' + name + '\\b').test(source)) || /animation[^;\n]*\binfinite\b/.test(source);
      if (uses && !(file in UTILITY_ALLOWLIST)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  describe('rendered idle shell', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    afterEach(() => {
      render(null, host);
      account.value = null;
      users.value = [];
      setChannels([]);
    });

    const me: Account = { id: 'acc-1', username: 'ada', displayName: 'Ada', roles: ['user'], status: 'active', avatarUrl: null };
    const channel = (id: string, type: Channel['type'], extra: Partial<Channel> = {}): Channel =>
      ({ id, name: id, type, position: 0, groupId: null, visibility: 'public', isLive: false, ...extra }) as Channel;

    const classesInUse = (): Set<string> => {
      const used = new Set<string>();
      for (const element of host.querySelectorAll('*')) {
        const name = element.getAttribute('class') ?? '';
        for (const part of name.split(/\s+/)) if (part) used.add(part);
      }
      return used;
    };

    it('the signed-in sidebar, connected, with a live stream and nobody speaking, has no endless animation', () => {
      account.value = me;
      connectionStatus.value = 'connected';
      setChannels([channel('general', 'text'), channel('lobby', 'voice'), channel('main-stream', 'stream', { isLive: true })]);
      const bo: User = { id: 'sock-2', accountId: 'acc-2', username: 'bo', displayName: 'Bo', roles: ['user'], isSuperuser: false, voiceChannel: 'lobby' };
      users.value = [bo];
      act(() => render(h(Sidebar, null), host));

      const used = classesInUse();
      expect(host.textContent).toContain('main-stream');
      expect(host.textContent).toContain('Bo'); // listed under the voice channel, not speaking
      expect(used.has('live-dot')).toBe(true); // the live stream is shown, and its dot is finite
      const endless = endlessClasses().filter((name) => used.has(name));
      expect(endless).toEqual([]);
    });

    it('an avatar gets the speaking ring only while speaking', () => {
      act(() => render(h(Avatar, { seed: 'acc-2', name: 'Bo', speaking: false }), host));
      expect(classesInUse().has('speaking-ring')).toBe(false);
      act(() => render(h(Avatar, { seed: 'acc-2', name: 'Bo', speaking: true }), host));
      expect(host.firstElementChild?.classList.contains('speaking-ring')).toBe(true);
      expect(host.querySelector('img.speaking-ring')).toBeNull();
    });
  });
});
