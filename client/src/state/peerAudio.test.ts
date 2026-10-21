import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PEER_AUDIO,
  clampPeerVolume,
  parsePeerAudioPrefs,
  peerAccountId,
  peerAudioPref,
  peerAudioPrefs,
  resetPeerAudioPref,
  setPeerAudioPref,
  volumePercent,
} from './peerAudio';
import { users } from './presence';
import { voicePeers } from './voice';

const KEY = 'rtmpdisc.peerAudio.v1';
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? 'null');

describe('per-person audio prefs', () => {
  beforeEach(() => {
    peerAudioPrefs.value = {};
    voicePeers.value = {};
    users.value = [];
    localStorage.clear();
  });

  it('defaults to 100 % unmuted for anyone without a setting', () => {
    expect(peerAudioPref('acc-nobody')).toEqual(DEFAULT_PEER_AUDIO);
    expect(peerAudioPref(null)).toEqual(DEFAULT_PEER_AUDIO);
    expect(peerAudioPref(undefined)).toEqual(DEFAULT_PEER_AUDIO);
  });

  it('clamps the volume to 0..200 % in whole percents', () => {
    expect(clampPeerVolume(3)).toBe(2);
    expect(clampPeerVolume(-1)).toBe(0);
    expect(clampPeerVolume(Number.NaN)).toBe(1);
    expect(clampPeerVolume('abc')).toBe(1);
    expect(clampPeerVolume(0.35000000000000003)).toBe(0.35);
    expect(clampPeerVolume(1.234)).toBe(1.23);
    expect(setPeerAudioPref('a', { volume: 9 }).volume).toBe(2);
    expect(setPeerAudioPref('a', { volume: -5 }).volume).toBe(0);
    expect(volumePercent(1.5)).toBe(150);
    expect(volumePercent(0.35)).toBe(35);
  });

  it('remembers volume and mute per account and persists them under the account id', () => {
    setPeerAudioPref('acc-bob', { volume: 0.4 });
    setPeerAudioPref('acc-bob', { muted: true });
    setPeerAudioPref('acc-carol', { volume: 1.8 });
    expect(peerAudioPref('acc-bob')).toEqual({ volume: 0.4, muted: true });
    expect(peerAudioPref('acc-carol')).toEqual({ volume: 1.8, muted: false });
    expect(stored()).toEqual({ 'acc-bob': { volume: 0.4, muted: true }, 'acc-carol': { volume: 1.8, muted: false } });
  });

  it('loads what was stored, dropping malformed entries and defaults', () => {
    expect(parsePeerAudioPrefs(null)).toEqual({});
    expect(parsePeerAudioPrefs('nope')).toEqual({});
    expect(parsePeerAudioPrefs({ ok: { muted: 1, volume: '0.5' }, bad: 'x', '': { muted: true }, loud: { volume: 5 }, plain: { volume: 1, muted: false } })).toEqual({
      ok: { muted: true, volume: 0.5 },
      loud: { muted: false, volume: 2 },
    });
    expect(parsePeerAudioPrefs({ quiet: { volume: 0 } })).toEqual({ quiet: { muted: false, volume: 0 } });
  });

  it('a mute keeps the volume, so unmuting brings it back', () => {
    setPeerAudioPref('acc-bob', { volume: 0.6 });
    setPeerAudioPref('acc-bob', { muted: true });
    expect(peerAudioPref('acc-bob')).toEqual({ volume: 0.6, muted: true });
    setPeerAudioPref('acc-bob', { muted: false });
    expect(peerAudioPref('acc-bob')).toEqual({ volume: 0.6, muted: false });
  });

  it('moving the slider to an audible level unmutes; moving it to 0 does not', () => {
    setPeerAudioPref('acc-bob', { muted: true });
    expect(setPeerAudioPref('acc-bob', { volume: 1.2 })).toEqual({ volume: 1.2, muted: false });
    setPeerAudioPref('acc-bob', { muted: true });
    expect(setPeerAudioPref('acc-bob', { volume: 0 })).toEqual({ volume: 0, muted: true });
    // Setting both at once is taken as given.
    expect(setPeerAudioPref('acc-bob', { volume: 1.5, muted: true })).toEqual({ volume: 1.5, muted: true });
  });

  it('reset returns to 100 % unmuted and removes the stored entry', () => {
    setPeerAudioPref('acc-bob', { volume: 0.2, muted: true });
    setPeerAudioPref('acc-carol', { volume: 1.5 });
    resetPeerAudioPref('acc-bob');
    expect(peerAudioPref('acc-bob')).toEqual(DEFAULT_PEER_AUDIO);
    expect(stored()).toEqual({ 'acc-carol': { volume: 1.5, muted: false } });
    // Setting the default by hand drops the entry too.
    setPeerAudioPref('acc-carol', { volume: 1 });
    expect(stored()).toEqual({});
    resetPeerAudioPref('acc-unknown');
    expect(stored()).toEqual({});
  });

  it('finds the account behind a voice peer from the room or from presence', () => {
    expect(peerAccountId(null)).toBeNull();
    expect(peerAccountId('sock-1')).toBeNull();
    voicePeers.value = { 'sock-1': { id: 'sock-1', name: 'bob', muted: false, deafened: false, speaking: false, camera: false, screen: false, quality: 'unknown', accountId: 'acc-bob' } };
    expect(peerAccountId('sock-1')).toBe('acc-bob');
    users.value = [{ id: 'sock-2', accountId: 'acc-carol', username: 'carol', displayName: 'carol', roles: [], isSuperuser: false }];
    expect(peerAccountId('sock-2')).toBe('acc-carol');
  });
});
