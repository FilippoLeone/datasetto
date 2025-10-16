import type { VoiceControllerDeps } from './types';
import type { Channel, VoicePeerEvent } from '@/types';
import type { VoicePanelEntry } from '@/ui/VoicePanelController';
import { MICROPHONE_PERMISSION_HELP_TEXT } from '@/services/AudioService';
import { ensureForegroundServiceForVoice, stopForegroundServiceForVoice } from '@/services';
import { generateIdenticonDataUri } from '@/utils/avatarGenerator';
import { createSpinnerWithText } from '@/components/feedback/Spinner';

const LOCAL_SPEAKING_THRESHOLD = 0.08;
const LOCAL_SPEAKING_RELEASE_MS = 300;
const VOICE_JOIN_TIMEOUT_MS = 10_000;
const VOICE_SESSION_CLOCK_TOLERANCE_MS = 120_000;

interface PendingVoiceJoin {
  id: string;
  name: string;
}

export class VoiceController {
  private deps: VoiceControllerDeps;
  private voiceUsers: Map<string, { id: string; name: string; muted?: boolean; deafened?: boolean; speaking?: boolean }> = new Map();
  private pendingVoiceJoin: PendingVoiceJoin | null = null;
  private localSpeaking = false;
  private localSpeakingLastPeak = 0;
  private voiceSessionStart: number | null = null;
  private voiceSessionId: string | null = null;
  private voiceSessionTimerHandle: number | null = null;
  private voiceChannelTimerHandle: number | null = null;
  private pttActive = false;
  private disposers: Array<() => void> = [];
  private activeOutputDeviceId: string | null = null;
  private micRecoveryTimeout: number | null = null;
  private appActive = true;
  private pendingMicRecoverySource: 'stream-interrupted' | 'app-resume' | null = null;
  private voiceJoinTimeoutHandle: number | null = null;

  constructor(deps: VoiceControllerDeps) {
    this.deps = deps;
  }

  initialize(): void {
    this.registerServiceListeners();
    this.registerNativeLifecycleListeners();
    this.deps.registerCleanup(() => this.dispose());
    this.updateMuteButtons();
    this.updateVoiceStatusPanel();
    void this.applySpeakerPreference();

    const channels = this.deps.state.get('channels') ?? [];
    if (Array.isArray(channels) && channels.length > 0) {
      this.updateChannelTimers(channels);
    }
  }

  dispose(): void {
    this.clearVoiceSessionTimer();
    this.clearVoiceChannelTimer();
    this.clearVoiceJoinTimeout();

    if (this.micRecoveryTimeout !== null) {
      window.clearTimeout(this.micRecoveryTimeout);
      this.micRecoveryTimeout = null;
    }

    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error('[VoiceController] Error during dispose handler:', error);
        }
      }
    }
  }

  async toggleMute(): Promise<void> {
    const muted = this.deps.state.toggleMute();
    if (muted) {
      this.setLocalSpeaking(false);
    }

    await this.syncMicrophoneState();
    this.announceVoiceState();

    this.deps.soundFX.play(muted ? 'mute' : 'unmute');
    this.updateMuteButtons();
    this.renderVoiceUsers();
  }

  async toggleDeafen(): Promise<void> {
    const deafened = this.deps.state.toggleDeafen();
    this.deps.voice.setDeafened(deafened);

    if (deafened) {
      this.setLocalSpeaking(false);
    }

    await this.syncMicrophoneState();
    this.announceVoiceState();

    this.deps.soundFX.play(deafened ? 'deafen' : 'undeafen');
    this.updateMuteButtons();
    this.renderVoiceUsers();
  }

  async toggleMuteAndDeafen(): Promise<void> {
    const state = this.deps.state.getState();
    const enableSilence = !(state.muted && state.deafened);

    this.deps.state.setMuted(enableSilence);
    this.deps.state.setDeafened(enableSilence);
    this.deps.voice.setDeafened(enableSilence);

    if (enableSilence) {
      this.setLocalSpeaking(false);
    }

    await this.syncMicrophoneState();
    this.announceVoiceState();

    this.deps.soundFX.play(enableSilence ? 'deafen' : 'undeafen');
    this.updateMuteButtons();
    this.renderVoiceUsers();
  }

  async joinChannel(channelId: string, channelName: string): Promise<void> {
    const isAuthenticated = Boolean(this.deps.state.get('session')?.token ?? this.deps.state.get('account'));
    if (!isAuthenticated) {
      this.deps.notifications.warning('Please log in to join voice channels');
      return;
    }

    const channels = this.deps.state.get('channels');
    const channel = channels.find((ch) => ch.id === channelId);
    if (!channel || channel.type !== 'voice') {
      this.deps.notifications.error('Cannot join voice: selected channel is not a voice channel');
      return;
    }

    const activeVoiceChannelId = this.deps.state.get('activeVoiceChannelId');
    if (this.deps.state.get('voiceConnected') && activeVoiceChannelId === channelId) {
      this.deps.notifications.info(`Already connected to ${channelName}`);
      return;
    }

    if (this.pendingVoiceJoin && this.pendingVoiceJoin.id === channelId) {
      this.deps.notifications.info('Already connecting to this voice channel...');
      return;
    }

    if (this.pendingVoiceJoin && this.pendingVoiceJoin.id !== channelId) {
      this.resetVoiceState();
    }

    try {
      if (this.deps.state.get('voiceConnected') && activeVoiceChannelId && activeVoiceChannelId !== channelId) {
        await this.disconnect({ playSound: true, notify: 'Switched voice channels' });
      }

      if (import.meta.env.DEV) {
        console.log('Joining voice channel:', channelName);
      }

      this.pendingVoiceJoin = { id: channelId, name: channelName };
  this.startVoiceJoinTimeout(channelId, channelName);

      this.voiceUsers.clear();
      this.renderVoiceUsers();

      this.deps.socket.joinChannel(channelId);
      await this.syncMicrophoneState(true);

      this.deps.notifications.info(`Connecting to voice in ${channelName}...`);
      this.deps.socket.joinVoiceChannel(channelId);
    } catch (error) {
      this.resetVoiceState();
      console.error('[VoiceController] Error joining voice:', error);
      this.deps.soundFX.play('error', 0.5);
      this.deps.notifications.error(error instanceof Error ? error.message : 'Failed to join voice');
    }
  }

  async disconnect(options: { playSound?: boolean; notify?: string | null } = {}): Promise<void> {
    this.resetVoiceState(options);
  }

  handleChannelsUpdate(channels: Channel[]): void {
    this.syncVoiceSessionFromChannels(channels);
    this.updateChannelTimers(channels);
    this.updateVoiceStatusPanel();
  }

  updateChannelTimers(channels: Channel[]): void {
    this.updateVoiceChannelTimerIndicators(channels);
  }

  async handleKeyDown(event: KeyboardEvent): Promise<void> {
    const settings = this.deps.state.get('settings');

    if (settings.pttEnable && event.code === settings.pttKey && !this.pttActive) {
      this.pttActive = true;
      this.deps.state.setMuted(false);
      await this.syncMicrophoneState();
      this.announceVoiceState();
      this.deps.soundFX.play('ptt_on', 0.4);
    }
  }

  async handleKeyUp(event: KeyboardEvent): Promise<void> {
    const settings = this.deps.state.get('settings');
    if (settings.pttEnable && event.code === settings.pttKey && this.pttActive) {
      this.pttActive = false;
      this.deps.state.setMuted(true);
      await this.syncMicrophoneState();
      this.announceVoiceState();
      this.deps.soundFX.play('ptt_off', 0.4);
    }
  }

  handleAuthSessionInvalidated(): void {
    this.resetVoiceState();
  }

  handleConnectionStatusChange(payload: { connected: boolean; reconnecting: boolean }): void {
    const { connected, reconnecting } = payload;
    const wasVoiceActive = this.deps.state.get('voiceConnected') || Boolean(this.pendingVoiceJoin);

    if (!connected && wasVoiceActive) {
      this.resetVoiceState();

      if (reconnecting) {
        if (import.meta.env.DEV) {
          console.log('⚠️ Voice resources released while attempting to reconnect');
        }
      } else {
        this.deps.notifications.warning('Voice disconnected due to network issues');
      }
    }
  }

  handleServerError(code: string): void {
    if (code === 'VOICE_JOIN_FAILED') {
      this.clearVoiceJoinTimeout();
      this.resetVoiceState();
    }
  }

  async handleVoiceJoined(data: { channelId: string; peers: VoicePeerEvent[]; startedAt?: number | null; sessionId?: string | null }): Promise<void> {
    if (import.meta.env.DEV) {
      console.log('Voice joined confirmation received:', data);
    }

    const channels = this.deps.state.get('channels') ?? [];
    const channel = channels.find((ch) => ch.id === data.channelId);
    const channelName = channel?.name || this.pendingVoiceJoin?.name || data.channelId;

    this.clearVoiceJoinTimeout();
    this.pendingVoiceJoin = null;

    this.deps.state.setActiveVoiceChannel(data.channelId, channelName);
    this.deps.state.setVoiceConnected(true);

    const sessionId = data.sessionId ?? null;
    const hasRemotePeers = Array.isArray(data.peers) && data.peers.length > 0;
    this.startVoiceSessionTimer(data.startedAt ?? null, sessionId, {
      preferNow: !hasRemotePeers,
    });

    await this.syncMicrophoneState();
    this.announceVoiceState();

  await this.applySpeakerPreference();

    this.voiceUsers.clear();
    data.peers.forEach((peer) => {
      const label = this.deps.resolveUserLabel(peer.name, peer.id);
      this.voiceUsers.set(peer.id, {
        id: peer.id,
        name: label,
        muted: Boolean(peer.muted),
        deafened: Boolean(peer.deafened),
        speaking: false,
      });
    });

    this.updateVoiceStatusPanel();
    this.renderVoiceUsers();

    this.deps.refreshChannels();

    this.deps.soundFX.play('call', 0.6);
    this.deps.notifications.success(`Joined voice in ${channelName}`);
  }

  async handleVoicePeerJoin(data: VoicePeerEvent): Promise<void> {
    try {
      this.addVoiceUser(data);
      await this.deps.voice.createOffer(data.id);
    } catch (error) {
      console.error('Error creating offer:', error);
      this.voiceUsers.delete(data.id);
      this.deps.voice.removePeer(data.id);
      this.renderVoiceUsers();
    }
  }

  async setOutputDevice(deviceId: string | null): Promise<void> {
    try {
      await this.deps.voice.setOutputDevice(deviceId ?? '');
      this.activeOutputDeviceId = deviceId ?? '';
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error('[VoiceController] Failed to switch output device:', error);
      }
      throw error instanceof Error ? error : new Error('Unable to switch speaker output.');
    }
  }

  handleVoicePeerLeave(data: { id: string }): void {
    this.removeVoiceUser(data.id);
    this.deps.voice.removePeer(data.id);
  }

  handleVoicePeerState(data: { id: string; muted: boolean; deafened: boolean }): void {
    const voiceUser = this.voiceUsers.get(data.id);
    if (!voiceUser) {
      return;
    }

    voiceUser.muted = data.muted;
    voiceUser.deafened = data.deafened;
    this.renderVoiceUsers();
  }

  async handleVoiceSignal(data: { from: string; data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } }): Promise<void> {
    try {
      if (data.data.sdp) {
        if (data.data.sdp.type === 'offer') {
          await this.deps.voice.handleOffer(data.from, data.data.sdp);
        } else if (data.data.sdp.type === 'answer') {
          await this.deps.voice.handleAnswer(data.from, data.data.sdp);
        }
      } else if (data.data.candidate) {
        await this.deps.voice.handleIceCandidate(data.from, data.data.candidate);
      }
    } catch (error) {
      console.error('Error handling voice signal:', error);
    }
  }

  handleMicLevel(level: number): void {
    const micLevelEl = this.deps.elements.micLevel;
    if (micLevelEl) {
      const percent = Math.min(100, Math.round(level * 100));
      micLevelEl.style.width = `${percent}%`;
    }

    const state = this.deps.state.getState();
    const now = performance.now();
    const shouldTrackLocal =
      state.voiceConnected &&
      !state.muted &&
      this.deps.audio.hasActiveStream();

    if (shouldTrackLocal && level > LOCAL_SPEAKING_THRESHOLD) {
      this.localSpeakingLastPeak = now;
      this.setLocalSpeaking(true);
    } else if (!shouldTrackLocal) {
      this.setLocalSpeaking(false);
    } else if (this.localSpeaking && now - this.localSpeakingLastPeak > LOCAL_SPEAKING_RELEASE_MS) {
      this.setLocalSpeaking(false);
    }
  }

  getPendingJoin(): PendingVoiceJoin | null {
    return this.pendingVoiceJoin;
  }

  public refreshVoiceInterface(): void {
    this.renderVoiceUsers();
  }

  private async applySpeakerPreference(): Promise<void> {
    const settings = this.deps.state.get('settings');
    const targetDeviceId = settings.spkDeviceId ?? '';

    if (targetDeviceId === this.activeOutputDeviceId) {
      return;
    }

    try {
      await this.deps.voice.setOutputDevice(targetDeviceId);
      this.activeOutputDeviceId = targetDeviceId;
    } catch (error) {
      if (targetDeviceId && import.meta.env.DEV) {
        console.warn('[VoiceController] Unable to apply speaker preference:', error);
      }
    }
  }

  private registerServiceListeners(): void {
    this.disposers.push(
      this.deps.socket.on('voice:joined', (data) => {
        void this.handleVoiceJoined(data as never);
      })
    );
    this.disposers.push(
      this.deps.socket.on('voice:peer-join', (data) => {
        void this.handleVoicePeerJoin(data as never);
      })
    );
    this.disposers.push(
      this.deps.socket.on('voice:peer-leave', (data) => {
        this.handleVoicePeerLeave(data as never);
      })
    );
    this.disposers.push(
      this.deps.socket.on('voice:signal', (data) => {
        void this.handleVoiceSignal(data as never);
      })
    );
    this.disposers.push(
      this.deps.socket.on('voice:state', (data) => {
        this.handleVoicePeerState(data as never);
      })
    );

    this.disposers.push(
      this.deps.voice.on('voice:offer', (payload: unknown) => {
        const { peerId, offer } = payload as { peerId: string; offer: RTCSessionDescriptionInit };
        this.deps.socket.sendSignal(peerId, { sdp: offer });
      })
    );
    this.disposers.push(
      this.deps.voice.on('voice:answer', (payload: unknown) => {
        const { peerId, answer } = payload as { peerId: string; answer: RTCSessionDescriptionInit };
        this.deps.socket.sendSignal(peerId, { sdp: answer });
      })
    );
    this.disposers.push(
      this.deps.voice.on('voice:ice-candidate', (payload: unknown) => {
        const { peerId, candidate } = payload as { peerId: string; candidate: RTCIceCandidateInit };
        this.deps.socket.sendSignal(peerId, { candidate });
      })
    );
    this.disposers.push(
      this.deps.voice.on('voice:speaking', (payload) => {
        const { id, speaking } = payload as { id: string; speaking: boolean };
        this.updateSpeakingIndicator(id, speaking);
      })
    );

    this.disposers.push(
      this.deps.audio.on('mic:level', (level: unknown) => {
        this.handleMicLevel(level as number);
      })
    );

    this.disposers.push(
      this.deps.audio.on('stream:active', (stream) => {
        this.handleAudioStreamActive(stream as MediaStream);
      })
    );

    this.disposers.push(
      this.deps.audio.on('stream:interrupted', (payload) => {
        this.handleAudioStreamInterrupted(payload as { reason: 'ended' | 'muted' });
      })
    );

    this.disposers.push(
      this.deps.state.on('state:change', () => {
        this.updateMuteButtons();
        this.updateVoiceStatusPanel();
        void this.applySpeakerPreference();
      })
    );
  }

  private registerNativeLifecycleListeners(): void {
    const registerDomLifecycleFallback = (): void => {
      const handleVisibilityChange = (): void => {
        if (document.visibilityState === 'visible') {
          this.handleAppResumed();
        } else {
          this.handleAppPaused();
        }
      };

      const handleWindowFocus = (): void => {
        this.handleAppResumed();
      };

      const handleWindowBlur = (): void => {
        this.handleAppPaused();
      };

      document.addEventListener('visibilitychange', handleVisibilityChange);
      window.addEventListener('focus', handleWindowFocus);
      window.addEventListener('blur', handleWindowBlur);

      this.disposers.push(() => {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        window.removeEventListener('focus', handleWindowFocus);
        window.removeEventListener('blur', handleWindowBlur);
      });
    };

    void (async () => {
      try {
        const { Capacitor } = await import('@capacitor/core');
        if (!Capacitor.isNativePlatform()) {
          registerDomLifecycleFallback();
          return;
        }

        const { App } = await import('@capacitor/app');
        const handles: Array<{ remove: () => Promise<void> }> = [];

        handles.push(
          await App.addListener('appStateChange', ({ isActive }) => {
            if (isActive) {
              this.handleAppResumed();
            } else {
              this.handleAppPaused();
            }
          })
        );

        handles.push(
          await App.addListener('resume', () => {
            this.handleAppResumed();
          })
        );

        handles.push(
          await App.addListener('pause', () => {
            this.handleAppPaused();
          })
        );

        this.disposers.push(() => {
          handles.forEach((handle) => {
            handle
              .remove()
              .catch((error) => {
                if (import.meta.env.DEV) {
                  console.warn('[VoiceController] Failed to remove native lifecycle listener:', error);
                }
              });
          });
        });
      } catch (error) {
        registerDomLifecycleFallback();
        if (import.meta.env.DEV) {
          console.warn('[VoiceController] Falling back to DOM lifecycle listeners:', error);
        }
      }
    })();
  }

  private handleAppResumed(): void {
    this.appActive = true;

    const voiceActive = this.deps.state.get('voiceConnected');
    if (!voiceActive && !this.pendingVoiceJoin) {
      this.pendingMicRecoverySource = null;
      return;
    }

    void ensureForegroundServiceForVoice();

    const recoverySource = this.pendingMicRecoverySource ?? 'app-resume';
    this.pendingMicRecoverySource = null;
    this.scheduleMicrophoneRecovery(recoverySource, 250);
  }

  private handleAppPaused(): void {
    this.appActive = false;

    const voiceActive = this.deps.state.get('voiceConnected') || Boolean(this.pendingVoiceJoin);
    if (voiceActive) {
      this.pendingMicRecoverySource = 'app-resume';
      void ensureForegroundServiceForVoice();
    }
  }

  private scheduleMicrophoneRecovery(_source: 'stream-interrupted' | 'app-resume', delayMs = 250): void {
    const voiceActive = this.deps.state.get('voiceConnected') || Boolean(this.pendingVoiceJoin);
    if (!voiceActive) {
      return;
    }

    if (!this.appActive) {
      this.pendingMicRecoverySource = _source;
      return;
    }

    if (this.micRecoveryTimeout !== null) {
      window.clearTimeout(this.micRecoveryTimeout);
    }

    this.micRecoveryTimeout = window.setTimeout(() => {
      this.micRecoveryTimeout = null;
      const { muted } = this.deps.state.getState();
      if (muted) {
        return;
      }

      void this.syncMicrophoneState(true).catch((error) => {
        if (import.meta.env.DEV) {
          console.warn('[VoiceController] Microphone recovery attempt failed:', error);
        }
      });
    }, Math.max(0, delayMs));
  }

  private async syncMicrophoneState(forceRestart = false): Promise<void> {
    const { muted } = this.deps.state.getState();
    const shouldDisable = muted;
    const isVoiceSessionActive = this.deps.state.get('voiceConnected') || Boolean(this.pendingVoiceJoin);

    if (shouldDisable) {
      this.deps.audio.setMuted(true);
      if (!isVoiceSessionActive && this.deps.audio.hasActiveStream()) {
        this.deps.audio.stopLocalStream();
        this.deps.voice.setLocalStream(null);
      }
      this.setLocalSpeaking(false);
      this.announceVoiceState();
      return;
    }

    if (!isVoiceSessionActive) {
      return;
    }

    try {
      const permissionState = await this.deps.audio.getMicrophonePermissionStatus();
      if (permissionState === 'denied') {
        this.handleMicrophonePermissionDenied();
        return;
      }
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[VoiceController] Unable to determine microphone permission status:', error);
      }
    }

    try {
      const stream = await this.deps.audio.getLocalStream(forceRestart);
      this.deps.audio.setMuted(false);
      this.deps.voice.setLocalStream(stream);
    } catch (error) {
      console.error('Error enabling microphone:', error);
      this.deps.state.setMuted(true);
      this.updateMuteButtons();
      this.renderVoiceUsers();
      this.announceVoiceState();
      this.deps.notifications.error(error instanceof Error ? error.message : 'Failed to enable microphone. Please check permissions.');
    }
  }

  private handleMicrophonePermissionDenied(): void {
    this.deps.state.setMuted(true);
    this.deps.audio.stopLocalStream();
    this.setLocalSpeaking(false);
    this.updateMuteButtons();
    this.renderVoiceUsers();
    this.announceVoiceState();
    this.deps.notifications.error(MICROPHONE_PERMISSION_HELP_TEXT);
  }

  private handleAudioStreamActive(stream: MediaStream): void {
    if (!(stream instanceof MediaStream)) {
      return;
    }

    const voiceActive = this.deps.state.get('voiceConnected') || Boolean(this.pendingVoiceJoin);
    if (!voiceActive) {
      return;
    }

    this.deps.voice.setLocalStream(stream);

    const { muted } = this.deps.state.getState();
    this.deps.audio.setMuted(muted);
  }

  private handleAudioStreamInterrupted(payload: { reason: 'ended' | 'muted' }): void {
    if (!payload) {
      return;
    }

    if (import.meta.env.DEV) {
      console.warn(`[VoiceController] Microphone stream interrupted (${payload.reason})`);
    }

    this.scheduleMicrophoneRecovery('stream-interrupted', 400);
  }

  private announceVoiceState(): void {
    if (!this.deps.state.get('voiceConnected')) {
      return;
    }

    const state = this.deps.state.getState();
    this.deps.socket.updateVoiceState({
      muted: state.muted,
      deafened: state.deafened,
    });
  }

  private addVoiceUser(peer: VoicePeerEvent): void {
    const label = this.deps.resolveUserLabel(peer.name, peer.id);
    const existing = this.voiceUsers.get(peer.id);

    this.voiceUsers.set(peer.id, {
      id: peer.id,
      name: label,
      muted: Boolean(peer.muted),
      deafened: Boolean(peer.deafened),
      speaking: existing?.speaking ?? false,
    });

    this.renderVoiceUsers();

    if (!existing) {
      this.deps.soundFX.play('userJoin', 0.6);
      this.deps.notifications.info(`${label} joined voice`);
    }
  }

  private removeVoiceUser(id: string): void {
    const user = this.voiceUsers.get(id);
    if (user) {
      this.deps.soundFX.play('userLeave', 0.6);
      this.deps.notifications.info(`${user.name} left voice`);
    }
    this.voiceUsers.delete(id);
    this.renderVoiceUsers();
  }

  private renderVoiceUsers(): void {
    const entries: VoicePanelEntry[] = [];
    const state = this.deps.state.getState();
    const account = this.deps.state.get('account');
    const currentUserLabel = account ? (account.displayName?.trim() || account.username) : 'You';

    if (state.voiceConnected) {
      entries.push({
        id: 'me',
        name: currentUserLabel,
        muted: state.muted,
        deafened: state.deafened,
        speaking: this.localSpeaking,
        isCurrentUser: true,
      });
    }

    for (const [id, user] of this.voiceUsers) {
      const preference = this.deps.voice.getPeerAudioPreference(id);
      entries.push({
        id,
        name: user.name,
        muted: user.muted,
        deafened: user.deafened,
        speaking: user.speaking,
        showLocalControls: true,
        localMuted: preference.muted,
        localVolume: preference.volume,
        onLocalMuteToggle: (muted) => {
          this.deps.voice.setPeerMuted(id, muted);
        },
        onLocalVolumeChange: (volume) => {
          this.deps.voice.setPeerVolume(id, volume);
        },
      });
    }

    this.deps.voicePanel.render(entries, entries.length);

    if (entries.length > 0 || state.voiceConnected) {
      this.deps.voicePanel.show();
    } else {
      this.deps.voicePanel.hide();
    }

    this.renderVoiceGallery(entries, state.voiceConnected);
  }

  private renderVoiceGallery(entries: VoicePanelEntry[], voiceConnected: boolean): void {
    const gallery = this.deps.elements.voiceGallery;
    const stage = this.deps.elements['voice-call-stage'] ?? null;
    if (!gallery) {
      return;
    }

    const activeChannelType = this.deps.state.get('currentChannelType');
    const isVoiceChannelActive = activeChannelType === 'voice';

    if (!isVoiceChannelActive) {
      stage?.classList.add('hidden');
      this.updateVoiceGalleryLayoutState(gallery, 0);
      gallery.classList.add('hidden');
      gallery.classList.remove('empty', 'loading');
      gallery.setAttribute('aria-hidden', 'true');
      gallery.removeAttribute('aria-busy');
      gallery.replaceChildren();
      return;
    }

    const mainContent = document.querySelector('.main-content');
    const isVoiceMode = mainContent?.classList.contains('voice-mode');

    if (!isVoiceMode) {
      stage?.classList.add('hidden');
      this.updateVoiceGalleryLayoutState(gallery, 0);
      gallery.classList.add('hidden');
      gallery.classList.remove('empty', 'loading');
      gallery.setAttribute('aria-hidden', 'true');
      gallery.removeAttribute('aria-busy');
      return;
    }

    stage?.classList.remove('hidden');
    gallery.classList.remove('hidden');
    gallery.setAttribute('aria-hidden', 'false');

    if (this.pendingVoiceJoin && entries.length === 0) {
      const channelName = this.pendingVoiceJoin.name?.trim() || 'voice';
      this.setVoiceGalleryLoadingState(`Connecting to ${channelName}...`);
      return;
    }

    if (!voiceConnected && entries.length === 0) {
      stage?.classList.remove('hidden');
      this.updateVoiceGalleryLayoutState(gallery, 0);
      gallery.classList.remove('empty', 'loading');
      gallery.removeAttribute('aria-busy');
      gallery.replaceChildren();
      return;
    }

    if (entries.length === 0) {
      this.updateVoiceGalleryLayoutState(gallery, 0);
      this.setVoiceGalleryEmptyState('No one else is here yet. Share the invite!');
      return;
    }

    gallery.classList.remove('empty', 'loading');
    gallery.setAttribute('aria-busy', 'false');
    this.updateVoiceGalleryLayoutState(gallery, entries.length);

    const fragment = document.createDocumentFragment();
    entries.forEach((entry) => {
      fragment.appendChild(this.createVoiceGalleryTile(entry));
    });

    gallery.replaceChildren(fragment);
  }

  private createVoiceGalleryTile(entry: VoicePanelEntry): HTMLElement {
  const tile = document.createElement('article');
  tile.className = 'voice-gallery-item';
  tile.setAttribute('role', 'listitem');
  tile.dataset.userId = entry.id;
  tile.dataset.muted = String(Boolean(entry.muted));
  tile.dataset.deafened = String(Boolean(entry.deafened));
  tile.dataset.currentUser = entry.isCurrentUser ? 'true' : 'false';
  const displayName = (entry.name ?? '').trim() || 'Participant';
  tile.dataset.displayName = entry.isCurrentUser ? `${displayName} (You)` : displayName;

    const avatar = document.createElement('div');
    avatar.className = 'voice-gallery-avatar';

    const avatarImg = document.createElement('img');
    const avatarSeed = entry.name || entry.id || 'participant';
    avatarImg.src = generateIdenticonDataUri(avatarSeed, { size: 160, label: entry.name ?? avatarSeed });
    avatarImg.alt = `${entry.name ?? 'Participant'} avatar`;
    avatarImg.decoding = 'async';
    avatarImg.loading = 'lazy';
    avatarImg.draggable = false;
    avatar.appendChild(avatarImg);

  const status = document.createElement('span');
    status.className = 'voice-gallery-status';
    avatar.appendChild(status);

    tile.appendChild(avatar);

    const name = document.createElement('p');
    name.className = 'voice-gallery-name';
    name.textContent = entry.isCurrentUser ? `${displayName} (You)` : displayName;
    tile.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'voice-gallery-meta';
    tile.appendChild(meta);

  this.refreshVoiceGalleryTile(tile, Boolean(entry.speaking));

    return tile;
  }

  private refreshVoiceGalleryTile(tile: HTMLElement, speaking: boolean): void {
    tile.classList.toggle('speaking', speaking);
    tile.dataset.speaking = String(speaking);

    const avatarEl = tile.querySelector('.voice-gallery-avatar') as HTMLElement | null;
    if (avatarEl) {
      avatarEl.classList.toggle('voice-speaking', speaking);
    }

    const muted = tile.dataset.muted === 'true';
    const deafened = tile.dataset.deafened === 'true';
    const isCurrentUser = tile.dataset.currentUser === 'true';

    const statusEl = tile.querySelector('.voice-gallery-status') as HTMLElement | null;
    this.updateVoiceGalleryStatus(statusEl, { muted, deafened, speaking, isCurrentUser });

  const metaEl = tile.querySelector('.voice-gallery-meta') as HTMLElement | null;
    if (metaEl) {
      this.populateVoiceGalleryMeta(metaEl, { muted, deafened, speaking });
    }

    const labelParts: string[] = [];
    if (isCurrentUser) {
      labelParts.push('You');
    }
    if (deafened) {
      labelParts.push('Deafened');
    } else if (muted) {
      labelParts.push('Muted');
    }
    if (!deafened && !muted) {
      labelParts.push(speaking ? 'Speaking' : 'Listening');
    } else if (speaking) {
      labelParts.push('Speaking');
    }

  const displayName = tile.dataset.displayName ?? 'Participant';
    const labelDescription = labelParts.length > 0 ? labelParts.join(', ') : 'Connected';
    tile.setAttribute('aria-label', `${displayName} — ${labelDescription}`);
  }

  private populateVoiceGalleryMeta(
    metaEl: HTMLElement,
    state: { muted: boolean; deafened: boolean; speaking: boolean }
  ): void {
    const descriptors: string[] = [];

    if (state.deafened) {
      descriptors.push('Audio Off');
    }

    if (state.muted) {
      descriptors.push('Mic Off');
    }

    if (!state.muted && !state.deafened) {
      descriptors.push(state.speaking ? 'Now Speaking' : 'Listening');
    } else if (state.speaking) {
      descriptors.push('Speaking');
    }

    if (descriptors.length === 0) {
      descriptors.push('Connected');
    }

    metaEl.replaceChildren();
    descriptors.forEach((label) => {
      const span = document.createElement('span');
      span.textContent = label;
      metaEl.appendChild(span);
    });
  }

  private updateVoiceGalleryStatus(
    statusEl: HTMLElement | null,
    state: { muted: boolean; deafened: boolean; speaking: boolean; isCurrentUser: boolean }
  ): void {
    if (!statusEl) {
      return;
    }

    let label: string;

    if (state.isCurrentUser) {
      if (state.deafened) {
        label = 'You • Deafened';
      } else if (state.muted) {
        label = 'You • Muted';
      } else if (state.speaking) {
        label = 'You • Speaking';
      } else {
        label = 'You';
      }
    } else if (state.deafened) {
      label = 'Deafened';
    } else if (state.muted) {
      label = 'Muted';
    } else if (state.speaking) {
      label = 'Speaking';
    } else {
      label = 'Participant';
    }

    statusEl.textContent = label;
  }

  private updateVoiceGallerySpeakingState(userId: string, speaking: boolean): void {
    const tile = this.findVoiceGalleryTile(userId);
    if (!tile) {
      return;
    }

    this.refreshVoiceGalleryTile(tile, speaking);
  }

  private findVoiceGalleryTile(userId: string): HTMLElement | null {
    const gallery = this.deps.elements.voiceGallery;
    if (!gallery) {
      return null;
    }

    const safeId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(userId) : userId.replace(/"/g, '\\"');
    return gallery.querySelector<HTMLElement>(`.voice-gallery-item[data-user-id="${safeId}"]`);
  }

  private setVoiceGalleryEmptyState(message: string): void {
    const gallery = this.deps.elements.voiceGallery;
    if (!gallery) {
      return;
    }

    gallery.classList.add('empty');
    gallery.classList.remove('loading');
    gallery.setAttribute('aria-busy', 'false');
    this.updateVoiceGalleryLayoutState(gallery, 0);
    gallery.replaceChildren();

    const messageEl = document.createElement('div');
    messageEl.className = 'voice-gallery-empty-message';
    messageEl.textContent = message;
    gallery.appendChild(messageEl);
  }

  private setVoiceGalleryLoadingState(message: string): void {
    const gallery = this.deps.elements.voiceGallery;
    if (!gallery) {
      return;
    }

    gallery.classList.add('loading');
    gallery.classList.remove('empty');
    gallery.setAttribute('aria-busy', 'true');
    this.updateVoiceGalleryLayoutState(gallery, 0);
    gallery.replaceChildren();

    const spinner = createSpinnerWithText(message, { size: 'medium', variant: 'white' });
    spinner.classList.add('voice-gallery-loading');
    gallery.appendChild(spinner);
  }

  private updateVoiceGalleryLayoutState(gallery: HTMLElement, participantCount: number): void {
    const layoutClasses = [
      'voice-gallery--single',
      'voice-gallery--double',
      'voice-gallery--trio',
      'voice-gallery--quad',
      'voice-gallery--stage',
      'voice-gallery--grid',
      'voice-gallery--grid-xl',
      'voice-gallery--multi',
    ];
    gallery.classList.remove(...layoutClasses);

    if (participantCount <= 0) {
      delete gallery.dataset.participantCount;
      return;
    }

    gallery.dataset.participantCount = String(participantCount);

    if (participantCount === 1) {
      gallery.classList.add('voice-gallery--single');
      return;
    }

    if (participantCount === 2) {
      gallery.classList.add('voice-gallery--double');
      return;
    }

    gallery.classList.add('voice-gallery--multi');

    if (participantCount === 3) {
      gallery.classList.add('voice-gallery--trio');
      return;
    }

    if (participantCount === 4) {
      gallery.classList.add('voice-gallery--quad');
      return;
    }

    if (participantCount <= 6) {
      gallery.classList.add('voice-gallery--stage');
      return;
    }

    if (participantCount <= 9) {
      gallery.classList.add('voice-gallery--grid');
      return;
    }

    gallery.classList.add('voice-gallery--grid-xl');
  }

  private setLocalSpeaking(speaking: boolean): void {
    if (this.localSpeaking === speaking) {
      return;
    }

    this.localSpeaking = speaking;
    if (!speaking) {
      this.localSpeakingLastPeak = 0;
    }
    this.updateSpeakingIndicator('me', speaking);
  }

  private updateSpeakingIndicator(userId: string, speaking: boolean): void {
    const user = this.voiceUsers.get(userId);
    if (user) {
      user.speaking = speaking;
    }

    this.deps.voicePanel.updateSpeakingIndicator(userId, speaking);
    this.updateVoiceGallerySpeakingState(userId, speaking);
  }

  private startVoiceSessionTimer(
    startedAt: number | null | undefined,
    sessionId: string | null,
    options: { preferNow?: boolean } = {}
  ): void {
    const startTime = this.resolveVoiceSessionStart(startedAt, options.preferNow ?? false);

    this.clearVoiceSessionTimer();

    this.voiceSessionStart = startTime;
    this.voiceSessionId = sessionId ?? null;
    this.deps.state.setVoiceSession(this.voiceSessionStart, this.voiceSessionId);

    this.updateVoiceSessionTimerDisplay();
    this.voiceSessionTimerHandle = window.setInterval(() => {
      this.updateVoiceSessionTimerDisplay();
    }, 1000);
  }

  private clearVoiceSessionTimer(): void {
    if (this.voiceSessionTimerHandle !== null) {
      window.clearInterval(this.voiceSessionTimerHandle);
      this.voiceSessionTimerHandle = null;
    }

    this.voiceSessionStart = null;
    this.voiceSessionId = null;
    this.deps.state.setVoiceSession(null, null);
    this.deps.voicePanel.updateSessionTimer(null);
  }

  private sanitizeCallTimestamp(raw: number | null | undefined): number | null {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
      return null;
    }

    let timestamp = raw;
    if (timestamp < 1_000_000_000_000) {
      timestamp *= 1000;
    }

    const now = Date.now();
    if (timestamp > now) {
      return now;
    }

    const drift = now - timestamp;
    if (drift >= 0 && drift < VOICE_SESSION_CLOCK_TOLERANCE_MS) {
      return now;
    }

    return timestamp;
  }

  private resolveVoiceSessionStart(raw: number | null | undefined, preferNow: boolean): number {
    if (preferNow) {
      return Date.now();
    }

    const sanitized = this.sanitizeCallTimestamp(raw);
    return sanitized ?? Date.now();
  }

  private updateVoiceSessionTimerDisplay(): void {
    if (!this.voiceSessionStart) {
      this.deps.voicePanel.updateSessionTimer(null);
      return;
    }

    const elapsed = Date.now() - this.voiceSessionStart;
    const formatted = this.formatDuration(elapsed);
    let title: string | undefined;
    try {
      title = `Call started ${new Date(this.voiceSessionStart).toLocaleTimeString()}`;
    } catch {
      title = undefined;
    }
    this.deps.voicePanel.updateSessionTimer(`⏱️ ${formatted}`, title);
  }

  private formatDuration(milliseconds: number): string {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const secondsPart = seconds.toString().padStart(2, '0');

    if (hours > 0) {
      const minutesPart = minutes.toString().padStart(2, '0');
      return `${hours}:${minutesPart}:${secondsPart}`;
    }

    return `${minutes}:${secondsPart}`;
  }

  private syncVoiceSessionFromChannels(channels: Channel[]): void {
    const activeVoiceChannelId = this.deps.state.get('activeVoiceChannelId');
    if (!activeVoiceChannelId || !this.deps.state.get('voiceConnected')) {
      return;
    }

    const channel = channels.find((ch) => ch.id === activeVoiceChannelId);
    if (!channel) {
      return;
    }

    const startedAt = channel.voiceStartedAt ?? null;
    const sessionId = channel.voiceSessionId ?? null;

    if (sessionId) {
      if (!this.voiceSessionId || sessionId !== this.voiceSessionId) {
        this.startVoiceSessionTimer(startedAt ?? null, sessionId);
        return;
      }

      if (!this.voiceSessionStart) {
        this.startVoiceSessionTimer(startedAt ?? null, sessionId);
      }
      return;
    }

    if (this.voiceSessionId && (channel.count ?? 0) === 0) {
      this.clearVoiceSessionTimer();
    }
  }

  private updateVoiceChannelTimerIndicators(channels: Channel[]): void {
    const channelsList = this.deps.elements.channelsList;
    if (!channelsList) {
      return;
    }

    let hasActiveTimers = false;

    channels
      .filter((channel) => channel.type === 'voice')
      .forEach((channel) => {
        const item = channelsList.querySelector(`.channel-item[data-channel-id="${channel.id}"]`);
        const timerEl = item?.querySelector('.voice-call-timer') as HTMLElement | null;
        if (!timerEl) {
          return;
        }

        if (channel.voiceStartedAt) {
          const sanitizedStart = this.sanitizeCallTimestamp(channel.voiceStartedAt);
          if (!sanitizedStart) {
            timerEl.classList.add('hidden');
            delete timerEl.dataset.voiceStart;
            timerEl.textContent = '';
            timerEl.removeAttribute('title');
            return;
          }

          timerEl.dataset.voiceStart = sanitizedStart.toString();
          timerEl.classList.remove('hidden');
          timerEl.classList.add('inline-flex');
          try {
            timerEl.title = `Call started ${new Date(sanitizedStart).toLocaleTimeString()}`;
          } catch {
            timerEl.title = 'Call in progress';
          }
          hasActiveTimers = true;
        } else {
          timerEl.classList.add('hidden');
          delete timerEl.dataset.voiceStart;
          timerEl.textContent = '';
          timerEl.removeAttribute('title');
        }
      });

    if (hasActiveTimers) {
      this.refreshVoiceChannelTimerElements();
      if (this.voiceChannelTimerHandle === null) {
        this.voiceChannelTimerHandle = window.setInterval(() => {
          this.refreshVoiceChannelTimerElements();
        }, 1000);
      }
    } else {
      this.clearVoiceChannelTimer();
    }
  }

  private refreshVoiceChannelTimerElements(): void {
    const now = Date.now();
    document.querySelectorAll<HTMLElement>('.voice-call-timer[data-voice-start]').forEach((el) => {
      const start = Number(el.dataset.voiceStart);
      if (!Number.isFinite(start) || start <= 0) {
        el.textContent = '';
        el.classList.add('hidden');
        delete el.dataset.voiceStart;
        return;
      }

      const duration = now - start;
      el.textContent = `⏱️ ${this.formatDuration(duration)}`;
      el.classList.remove('hidden');
      el.classList.add('inline-flex');
    });
  }

  private clearVoiceChannelTimer(): void {
    if (this.voiceChannelTimerHandle !== null) {
      window.clearInterval(this.voiceChannelTimerHandle);
      this.voiceChannelTimerHandle = null;
    }
  }

  private resetVoiceState(options: { playSound?: boolean; notify?: string | null } = {}): void {
    const { playSound = false, notify = null } = options;

    if (playSound) {
      this.deps.soundFX.play('disconnect', 0.7);
    }

    this.clearVoiceJoinTimeout();
    this.clearVoiceSessionTimer();
    this.clearVoiceChannelTimer();

    this.deps.voice.dispose();
    this.deps.audio.stopLocalStream();
    this.setLocalSpeaking(false);

    if (this.deps.socket.isConnected()) {
      this.deps.socket.leaveVoiceChannel();
    }

    void stopForegroundServiceForVoice();

    this.deps.state.setVoiceConnected(false);
    this.deps.state.setActiveVoiceChannel(null, null);

    this.voiceUsers.clear();
    this.renderVoiceUsers();
    this.updateVoiceStatusPanel();

    this.pendingVoiceJoin = null;

    this.deps.closeMobileVoicePanel?.();

    const channels = this.deps.state.get('channels') ?? [];
    if (Array.isArray(channels)) {
      this.updateChannelTimers(channels);
    }

    this.deps.refreshChannels();

    if (notify) {
      this.deps.notifications.info(notify);
    }
  }

  private updateVoiceStatusPanel(): void {
    const panel = this.deps.elements['voice-status-panel'];
    const voiceConnected = this.deps.state.get('voiceConnected');

    if (panel) {
      panel.classList.toggle('hidden', !voiceConnected);
      panel.classList.toggle('connected', voiceConnected);
    }

    if (!voiceConnected) {
      this.deps.closeMobileVoicePanel?.();
    }

    const channelNameEl = this.deps.elements['connected-voice-channel'];
    if (channelNameEl) {
      if (voiceConnected) {
        const activeVoiceName = this.deps.state.get('activeVoiceChannelName');
        if (activeVoiceName) {
          channelNameEl.textContent = activeVoiceName;
        } else {
          const activeVoiceId = this.deps.state.get('activeVoiceChannelId');
          const channelInfo = this.deps.state.get('channels').find((ch) => ch.id === activeVoiceId);
          channelNameEl.textContent = channelInfo?.name || activeVoiceId || 'Voice';
        }
      } else {
        channelNameEl.textContent = 'Not connected';
      }
    }

    this.deps.updateStreamIndicator();
  }

  private updateMuteButtons(): void {
    const state = this.deps.state.getState();

    const muteBtn = this.deps.elements.mute;
    if (muteBtn) {
      const label = state.muted ? 'Unmute Mic' : 'Mute Mic';
      const title = state.muted ? 'Unmute microphone' : 'Mute microphone';
      muteBtn.classList.toggle('muted', state.muted);
      muteBtn.setAttribute('title', title);
      muteBtn.setAttribute('aria-label', title);
      muteBtn.setAttribute('aria-pressed', state.muted ? 'true' : 'false');

      const muteLabel = muteBtn.querySelector('.mute-label');
      if (muteLabel) {
        muteLabel.textContent = label;
      }
    }

    const deafenBtn = this.deps.elements.deafen;
    if (deafenBtn) {
      const isOutputMuted = state.deafened;
      const title = isOutputMuted ? 'Restore output audio' : 'Mute output audio';
      deafenBtn.classList.toggle('deafened', isOutputMuted);
      deafenBtn.setAttribute('title', title);
      deafenBtn.setAttribute('aria-label', title);
      deafenBtn.setAttribute('aria-pressed', isOutputMuted ? 'true' : 'false');

      const labelEl = deafenBtn.querySelector('.output-label');
      if (labelEl) {
        labelEl.textContent = isOutputMuted ? 'Restore Out' : 'Mute Out';
      }
    }

    const comboBtn = this.deps.elements['mute-output-combo'];
    if (comboBtn) {
      const bothMuted = state.muted && state.deafened;
      const comboTitle = bothMuted ? 'Restore mic and output audio' : 'Mute mic and output audio';
      comboBtn.classList.toggle('active', bothMuted);
      comboBtn.setAttribute('title', comboTitle);
      comboBtn.setAttribute('aria-label', comboTitle);
      comboBtn.setAttribute('aria-pressed', bothMuted ? 'true' : 'false');

      const comboLabel = comboBtn.querySelector('.mute-output-label');
      if (comboLabel) {
        comboLabel.textContent = bothMuted ? 'Restore All' : 'Mute All';
      }
    }
  }

  private startVoiceJoinTimeout(channelId: string, channelName: string): void {
    this.clearVoiceJoinTimeout();

    this.voiceJoinTimeoutHandle = window.setTimeout(() => {
      this.voiceJoinTimeoutHandle = null;

      if (!this.pendingVoiceJoin || this.pendingVoiceJoin.id !== channelId) {
        return;
      }

      if (import.meta.env.DEV) {
        console.warn(`[VoiceController] Voice join timed out for ${channelName} (${channelId})`);
      }

      this.pendingVoiceJoin = null;
      this.resetVoiceState();
      this.deps.notifications.error(`Unable to connect to voice in ${channelName}. Please try again.`);
      this.deps.soundFX.play('error', 0.6);
    }, VOICE_JOIN_TIMEOUT_MS);
  }

  private clearVoiceJoinTimeout(): void {
    if (this.voiceJoinTimeoutHandle !== null) {
      window.clearTimeout(this.voiceJoinTimeoutHandle);
      this.voiceJoinTimeoutHandle = null;
    }
  }
}
