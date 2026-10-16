import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SCREEN_AUDIO, parseScreenAudioPrefs, screenAudioPref, screenAudioPrefs, setScreenAudioPref } from './screenAudio';

describe('screen audio prefs', () => {
  beforeEach(() => {
    screenAudioPrefs.value = {};
    localStorage.clear();
  });

  it('defaults to unmuted full volume for unknown hosts', () => {
    expect(screenAudioPref('account:nobody')).toEqual(DEFAULT_SCREEN_AUDIO);
    expect(screenAudioPref(null)).toEqual(DEFAULT_SCREEN_AUDIO);
  });

  it('remembers mute and volume per host and persists them', () => {
    setScreenAudioPref('account:a', { volume: 0.4 });
    setScreenAudioPref('account:a', { muted: true });
    setScreenAudioPref('account:b', { volume: 0.9 });
    expect(screenAudioPref('account:a')).toEqual({ muted: true, volume: 0.4 });
    expect(screenAudioPref('account:b')).toEqual({ muted: false, volume: 0.9 });
    expect(JSON.parse(localStorage.getItem('rtmpdisc.screenAudio.v1') ?? '{}')).toEqual({
      'account:a': { muted: true, volume: 0.4 },
      'account:b': { muted: false, volume: 0.9 },
    });
  });

  it('clamps volume to 0..1', () => {
    expect(setScreenAudioPref('account:a', { volume: 3 }).volume).toBe(1);
    expect(setScreenAudioPref('account:a', { volume: -1 }).volume).toBe(0);
    expect(setScreenAudioPref('account:a', { volume: Number.NaN }).volume).toBe(1);
  });

  it('drops malformed stored entries', () => {
    expect(parseScreenAudioPrefs(null)).toEqual({});
    expect(parseScreenAudioPrefs({ ok: { muted: 1, volume: '0.5' }, bad: 'x', '': { muted: true } })).toEqual({ ok: { muted: true, volume: 0.5 } });
    expect(parseScreenAudioPrefs({ loud: { volume: 5 } })).toEqual({ loud: { muted: false, volume: 1 } });
  });
});
