// @vitest-environment node
/// <reference types="node" />
/**
 * The desktop shell's screen-share audio helpers (desktop/picker/share-audio.js), loaded
 * as they ship: plain CommonJS with no Electron in it.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type * as ShareAudio from '../../../desktop/picker/share-audio';

const load = createRequire(import.meta.url);
const shareAudio = load('../../../desktop/picker/share-audio.js') as typeof ShareAudio;

describe('own-audio exclusion per operating system (Chromium 152 rules)', () => {
  it('is available from Windows 11 (build 22000) on', () => {
    expect(shareAudio.ownAudioExclusion('win32', '10.0.26100').supported).toBe(true);
    expect(shareAudio.ownAudioExclusion('win32', '10.0.22000').supported).toBe(true);
    expect(shareAudio.ownAudioExclusion('win32', '10.0.19045').supported).toBe(false);
    expect(shareAudio.ownAudioExclusion('win32', '').supported).toBe(false);
  });

  it('is available from macOS 14.2 on and never on Linux', () => {
    expect(shareAudio.ownAudioExclusion('darwin', '14.2').supported).toBe(true);
    expect(shareAudio.ownAudioExclusion('darwin', '15.0.1').supported).toBe(true);
    expect(shareAudio.ownAudioExclusion('darwin', '14.1.2').supported).toBe(false);
    expect(shareAudio.ownAudioExclusion('darwin', '13.6').supported).toBe(false);
    expect(shareAudio.ownAudioExclusion('linux', '6.8.0-45-generic').supported).toBe(false);
  });

  it('gives the picker one honest line for each case', () => {
    const win11 = shareAudio.shareAudioHint(shareAudio.ownAudioExclusion('win32', '10.0.26100'));
    expect(win11).toMatch(/never Datasetto itself/);
    const win10 = shareAudio.shareAudioHint(shareAudio.ownAudioExclusion('win32', '10.0.19045'));
    expect(win10).toMatch(/^Windows 10 cannot leave Datasetto out.*Windows 11 can\.$/);
    expect(shareAudio.shareAudioHint(shareAudio.ownAudioExclusion('darwin', '13.6'))).toMatch(/macOS 14\.2 or later can\.$/);
    expect(shareAudio.shareAudioHint(shareAudio.ownAudioExclusion('linux', '6.8'))).toMatch(/^Linux cannot leave Datasetto out/);
    for (const hint of [win11, win10]) expect(hint).not.toMatch(/headphones/i);
  });
});

describe('hand-over from the picker to getDisplayMedia()', () => {
  const clock = () => {
    let now = 1_000;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  };

  it('serves the picked source to the same page a few times, then forgets it', () => {
    const time = clock();
    const grants = shareAudio.createGrantStore(time.now);
    expect(grants.arm(7, { id: 'screen:0:0', name: 'Screen 1' }, true)).toBe(true);
    expect(grants.take(8)).toBeNull();
    const first = grants.take(7);
    expect(first).toEqual({ source: { id: 'screen:0:0', name: 'Screen 1' }, shareAudio: true });
    for (let use = 1; use < shareAudio.GRANT_MAX_USES; use += 1) expect(grants.take(7)).not.toBeNull();
    expect(grants.take(7)).toBeNull();
  });

  it('expires and can be cleared', () => {
    const time = clock();
    const grants = shareAudio.createGrantStore(time.now);
    grants.arm(1, { id: 'window:123:0', name: '' }, false);
    time.advance(shareAudio.GRANT_TTL_MS + 1);
    expect(grants.take(1)).toBeNull();
    grants.arm(1, { id: 'window:123:0' }, false);
    expect(grants.take(1)?.source.name).toBe('Screen');
    grants.clear();
    expect(grants.take(1)).toBeNull();
  });

  it('only accepts screen and window ids from the picker', () => {
    const grants = shareAudio.createGrantStore();
    expect(grants.arm(1, { id: 'web-contents-media-stream://1:2' }, true)).toBe(false);
    expect(grants.arm(1, null, true)).toBe(false);
    expect(grants.take(1)).toBeNull();
  });

  it('answers with loopback audio only when the page asked and the user left sound on', () => {
    const grant = { source: { id: 'screen:0:0', name: 'Screen 1' }, shareAudio: true };
    expect(shareAudio.displayMediaAnswer({ audioRequested: true }, grant)).toEqual({ video: { id: 'screen:0:0', name: 'Screen 1' }, audio: 'loopback' });
    expect(shareAudio.displayMediaAnswer({ audioRequested: false }, grant)).toEqual({ video: { id: 'screen:0:0', name: 'Screen 1' } });
    expect(shareAudio.displayMediaAnswer({ audioRequested: true }, { ...grant, shareAudio: false })).not.toHaveProperty('audio');
  });

  it('logs the kind of source and the audio mode, never the window title', () => {
    const exclusion = shareAudio.ownAudioExclusion('win32', '10.0.26100');
    const line = shareAudio.describeAnswer({ video: { id: 'window:99:0', name: 'Secret plans.docx' }, audio: 'loopback' }, exclusion);
    expect(line).toBe('window, audio loopback (own audio excluded when the page asks)');
    expect(line).not.toMatch(/Secret/);
    expect(shareAudio.describeAnswer({ video: { id: 'screen:0:0', name: 'Screen 1' } }, exclusion)).toBe('screen, no audio');
    expect(shareAudio.describeAnswer({ video: { id: 'screen:0:0', name: 'Screen 1' }, audio: 'loopback' }, shareAudio.ownAudioExclusion('linux', '6'))).toMatch(/cannot exclude/);
  });
});
