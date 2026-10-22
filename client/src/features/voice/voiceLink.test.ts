import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/services/socket/api';
import { VoiceService } from '@/services/voice/VoiceService';
import { updateAudioSettings } from '@/state/settings';
import { resetVoiceState, upsertPeer, voiceStatus } from '@/state/voice';
import type { VoiceSignalEvent } from '@/types/protocol';
import { voiceManager } from './voiceManager';

/** The `voice:link` message rides the `voice:signal` relay: `data: {link: {constrained}}`. */
const onSignal = (data: VoiceSignalEvent) => (voiceManager as unknown as { onSignal: (event: VoiceSignalEvent) => Promise<void> }).onSignal(data);

const spies = () => ({
  link: vi.spyOn(VoiceService.prototype, 'setPeerLinkConstrained').mockImplementation(() => undefined),
  offer: vi.spyOn(VoiceService.prototype, 'handleOffer').mockResolvedValue(undefined),
  answer: vi.spyOn(VoiceService.prototype, 'handleAnswer').mockResolvedValue(undefined),
  candidate: vi.spyOn(VoiceService.prototype, 'handleIceCandidate').mockResolvedValue(undefined),
});

describe('voice:link from a peer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetVoiceState();
  });

  it('caps the sender to that peer and touches no SDP or ICE handling', async () => {
    const spy = spies();
    voiceStatus.value = 'connected';
    upsertPeer({ id: 'sock-bob' });

    await onSignal({ from: 'sock-bob', data: { link: { constrained: true } } } as unknown as VoiceSignalEvent);
    await onSignal({ from: 'sock-bob', data: { link: { constrained: false } } } as unknown as VoiceSignalEvent);
    // Anything but `true` counts as not constrained.
    await onSignal({ from: 'sock-bob', data: { link: { constrained: 'yes' } } } as unknown as VoiceSignalEvent);
    expect(spy.link.mock.calls).toEqual([
      ['sock-bob', true],
      ['sock-bob', false],
      ['sock-bob', false],
    ]);
    expect(spy.offer).not.toHaveBeenCalled();
    expect(spy.answer).not.toHaveBeenCalled();
    expect(spy.candidate).not.toHaveBeenCalled();
  });

  it('is ignored from someone outside the call, and outside a call', async () => {
    const spy = spies();
    voiceStatus.value = 'connected';
    await onSignal({ from: 'sock-stranger', data: { link: { constrained: true } } } as unknown as VoiceSignalEvent);
    voiceStatus.value = 'idle';
    upsertPeer({ id: 'sock-bob' });
    await onSignal({ from: 'sock-bob', data: { link: { constrained: true } } } as unknown as VoiceSignalEvent);
    expect(spy.link).not.toHaveBeenCalled();
  });

  it('does nothing in an older client, whose signal handler acts on sdp and candidate only', async () => {
    // The dispatch of shells built before data-saver voice, as it was in this file.
    const oldShell = async (data: VoiceSignalEvent, voice: Pick<VoiceService, 'handleOffer' | 'handleAnswer' | 'handleIceCandidate'>) => {
      if (data.data.sdp?.type === 'offer') await voice.handleOffer(data.from, data.data.sdp);
      else if (data.data.sdp?.type === 'answer') await voice.handleAnswer(data.from, data.data.sdp);
      else if (data.data.candidate) await voice.handleIceCandidate(data.from, data.data.candidate);
    };
    const voice = { handleOffer: vi.fn(), handleAnswer: vi.fn(), handleIceCandidate: vi.fn() };
    await oldShell({ from: 'sock-bob', data: { link: { constrained: true } } } as unknown as VoiceSignalEvent, voice);
    expect(voice.handleOffer).not.toHaveBeenCalled();
    expect(voice.handleAnswer).not.toHaveBeenCalled();
    expect(voice.handleIceCandidate).not.toHaveBeenCalled();
  });
});

describe('voice:link to the peers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetVoiceState();
    updateAudioSettings({ dataSaverVoice: 'auto' });
  });

  it('tells every peer once per change, a newcomer the current state, and everyone again after a rejoin', () => {
    const sent = vi.spyOn(api, 'sendVoiceSignal').mockImplementation(() => undefined);
    const own = vi.spyOn(VoiceService.prototype, 'setLinkConstrained');
    updateAudioSettings({ dataSaverVoice: 'off' });
    voiceManager.init();
    voiceStatus.value = 'connected';
    upsertPeer({ id: 'sock-bob' });
    upsertPeer({ id: 'sock-carol' });
    // Peers assume "not constrained": nothing to say yet.
    expect(sent).not.toHaveBeenCalled();

    updateAudioSettings({ dataSaverVoice: 'on' });
    expect(own).toHaveBeenLastCalledWith(true);
    expect(sent.mock.calls).toEqual([
      ['sock-bob', { link: { constrained: true } }],
      ['sock-carol', { link: { constrained: true } }],
    ]);
    // Unrelated peer updates send nothing more.
    upsertPeer({ id: 'sock-bob', speaking: true });
    expect(sent).toHaveBeenCalledTimes(2);

    upsertPeer({ id: 'sock-dave' });
    expect(sent.mock.calls.at(-1)).toEqual(['sock-dave', { link: { constrained: true } }]);
    expect(sent).toHaveBeenCalledTimes(3);

    // The socket drops and comes back: everyone who heard from us hears it again.
    voiceStatus.value = 'reconnecting';
    voiceStatus.value = 'connected';
    expect(sent).toHaveBeenCalledTimes(6);

    updateAudioSettings({ dataSaverVoice: 'off' });
    expect(own).toHaveBeenLastCalledWith(false);
    expect(sent.mock.calls.slice(-3).map(([, data]) => data)).toEqual([
      { link: { constrained: false } },
      { link: { constrained: false } },
      { link: { constrained: false } },
    ]);
    expect(sent).toHaveBeenCalledTimes(9);
  });
});
