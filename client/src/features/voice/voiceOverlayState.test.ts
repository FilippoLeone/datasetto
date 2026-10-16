import { describe, expect, it } from 'vitest';
import { buildOverlayState, isOverlayCorner, OVERLAY_MAX_ROWS, sameOverlayState, type OverlayInput } from './voiceOverlayState';
import type { VoicePeer } from '@/state/voice';

const peer = (id: string, name: string, extra: Partial<VoicePeer> = {}): VoicePeer => ({
  id,
  name,
  muted: false,
  deafened: false,
  speaking: false,
  camera: false,
  screen: false,
  quality: 'unknown',
  ...extra,
});

const input = (overrides: Partial<OverlayInput> = {}): OverlayInput => ({
  status: 'connected',
  channelName: 'lobby',
  me: { id: 'me', name: 'Alice', avatarUrl: 'data:image/svg+xml;base64,QQ==' },
  peers: [peer('p2', 'carol', { speaking: true }), peer('p1', 'Bob', { muted: true })],
  avatarFor: (id) => (id === 'p1' ? 'http://localhost:4000/api/avatars/bob.webp' : null),
  localMuted: false,
  localDeafened: false,
  localSpeaking: true,
  pttEnable: false,
  pttPressed: false,
  ...overrides,
});

describe('voice overlay state', () => {
  it('is hidden while not connected', () => {
    expect(buildOverlayState(input({ status: 'idle' }))).toBeNull();
    expect(buildOverlayState(input({ status: 'connecting' }))).toBeNull();
    expect(buildOverlayState(input({ me: null }))).toBeNull();
  });

  it('lists you first, then friends by name, with speaking rings and avatars', () => {
    const state = buildOverlayState(input());
    expect(state).not.toBeNull();
    expect(state!.channelName).toBe('lobby');
    expect(state!.participants.map((p) => p.name)).toEqual(['Alice', 'Bob', 'carol']);
    expect(state!.participants[0]).toMatchObject({ self: true, speaking: true, muted: false, avatarUrl: 'data:image/svg+xml;base64,QQ==' });
    expect(state!.participants[1]).toMatchObject({ self: false, muted: true, speaking: false, avatarUrl: 'http://localhost:4000/api/avatars/bob.webp' });
    expect(state!.participants[2]).toMatchObject({ speaking: true, avatarUrl: null });
    expect(state!.more).toBe(0);
    expect(state!.muted).toBe(false);
    expect(state!.transmitting).toBe(false);
  });

  it('shows your mute, deafen and push-to-talk state', () => {
    const muted = buildOverlayState(input({ localMuted: true }))!;
    expect(muted.muted).toBe(true);
    expect(muted.participants[0]).toMatchObject({ muted: true, speaking: false });

    const deafened = buildOverlayState(input({ localDeafened: true }))!;
    expect(deafened).toMatchObject({ muted: true, deafened: true });
    expect(deafened.participants[0].deafened).toBe(true);

    const pttIdle = buildOverlayState(input({ pttEnable: true, pttPressed: false }))!;
    expect(pttIdle).toMatchObject({ pushToTalk: true, transmitting: false, muted: false });
    expect(pttIdle.participants[0]).toMatchObject({ muted: true, speaking: false });

    const pttHeld = buildOverlayState(input({ pttEnable: true, pttPressed: true }))!;
    expect(pttHeld).toMatchObject({ pushToTalk: true, transmitting: true });
    expect(pttHeld.participants[0]).toMatchObject({ muted: false, speaking: true });
  });

  it('never shows a muted friend as speaking', () => {
    const state = buildOverlayState(input({ peers: [peer('p1', 'Bob', { muted: true, speaking: true })] }))!;
    expect(state.participants[1]).toMatchObject({ muted: true, speaking: false });
  });

  it('cuts long lists and counts the rest', () => {
    const many = Array.from({ length: OVERLAY_MAX_ROWS + 3 }, (_, i) => peer('p' + i, 'user' + String(i).padStart(2, '0')));
    const state = buildOverlayState(input({ peers: many }))!;
    expect(state.participants).toHaveLength(OVERLAY_MAX_ROWS);
    expect(state.participants[0].self).toBe(true);
    expect(state.more).toBe(4);
  });

  it('falls back to a generic channel name', () => {
    expect(buildOverlayState(input({ channelName: null }))!.channelName).toBe('Voice');
  });

  it('compares states by content so unchanged ones are not resent', () => {
    const a = buildOverlayState(input());
    const b = buildOverlayState(input());
    expect(sameOverlayState(a, b)).toBe(true);
    expect(sameOverlayState(a, null)).toBe(false);
    expect(sameOverlayState(null, null)).toBe(true);
    expect(sameOverlayState(a, buildOverlayState(input({ localSpeaking: false })))).toBe(false);
    expect(sameOverlayState(a, buildOverlayState(input({ peers: [peer('p1', 'Bob', { muted: true })] })))).toBe(false);
  });

  it('validates corners', () => {
    expect(isOverlayCorner('bottom-left')).toBe(true);
    expect(isOverlayCorner('middle')).toBe(false);
    expect(isOverlayCorner(undefined)).toBe(false);
  });
});
