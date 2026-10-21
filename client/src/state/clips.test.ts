import { afterEach, describe, expect, it } from 'vitest';
import { clipsOn, isClipsOn, setClipsOn } from './clips';
import { DEFAULT_CLIP_SHORTCUT, normalizeAudioSettings } from './settings';

describe('clips on/off per source', () => {
  afterEach(() => {
    for (const key of Object.keys(clipsOn.value)) setClipsOn(key, false);
    localStorage.clear();
  });

  it('remembers the switch per source key in localStorage', () => {
    expect(isClipsOn('stream:ch1')).toBe(false);
    setClipsOn('stream:ch1', true);
    setClipsOn('voice:account:acct-bob', true);
    expect(isClipsOn('stream:ch1')).toBe(true);
    expect(isClipsOn(null)).toBe(false);
    expect(JSON.parse(localStorage.getItem('rtmpdisc.clipsOn.v1') ?? '[]').sort()).toEqual(['stream:ch1', 'voice:account:acct-bob']);
    setClipsOn('stream:ch1', false);
    expect(isClipsOn('stream:ch1')).toBe(false);
    expect(JSON.parse(localStorage.getItem('rtmpdisc.clipsOn.v1') ?? '[]')).toEqual(['voice:account:acct-bob']);
  });
});

describe('clip settings', () => {
  it('defaults to 30 s, no voice, Alt+C, shares clippable, and drops values this build does not know', () => {
    const defaults = normalizeAudioSettings({});
    expect(defaults.clipSeconds).toBe(30);
    expect(defaults.clipIncludeVoice).toBe(false);
    expect(defaults.clipShortcut).toBe(DEFAULT_CLIP_SHORTCUT);
    expect(defaults.shareClipsAllowed).toBe(true);

    const stored = normalizeAudioSettings({ clipSeconds: 45 as 30, clipIncludeVoice: 1 as unknown as boolean, clipShortcut: '+++', shareClipsAllowed: false });
    expect(stored.clipSeconds).toBe(30);
    expect(stored.clipIncludeVoice).toBe(true);
    expect(stored.clipShortcut).toBe(DEFAULT_CLIP_SHORTCUT);
    expect(stored.shareClipsAllowed).toBe(false);

    // A cleared key stays cleared; a stored combination keeps its canonical form.
    expect(normalizeAudioSettings({ clipShortcut: '' }).clipShortcut).toBe('');
    expect(normalizeAudioSettings({ clipShortcut: 'Shift+Ctrl+KeyX' }).clipShortcut).toBe('Ctrl+Shift+KeyX');
    expect(normalizeAudioSettings({ clipSeconds: 60 }).clipSeconds).toBe(60);
  });
});
