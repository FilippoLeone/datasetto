import type { VoiceControllerDeps } from './types';
import type { Channel, VoicePeerEvent } from '@/types';
import type { VoicePanelEntry } from '@/ui/VoicePanelController';

const LOCAL_SPEAKING_THRESHOLD = 0.08;
const LOCAL_SPEAKING_RELEASE_MS = 300;

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

  constructor(deps: VoiceControllerDeps) {
    this.deps = deps;
  }

  initialize(): void {
    this.registerServiceListeners();
    this.deps.registerCleanup(() => this.dispose());
    this.updateMuteButtons();
    this.updateVoiceStatusPanel();

    const channels = this.deps.state.get('channels') ?? [];
    if (Array.isArray(channels) && channels.length > 0) {
      this.updateChannelTimers(channels);
    }
  }

  dispose(): void {
    this.clearVoiceSessionTimer();
    this.clearVoiceChannelTimer();

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
        console.log('🎤 Joining voice channel:', channelName);
      }

      this.pendingVoiceJoin = { id: channelId, name: channelName };

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

    this.pendingVoiceJoin = null;

    this.deps.state.setActiveVoiceChannel(data.channelId, channelName);
    this.deps.state.setVoiceConnected(true);

    const sessionId = data.sessionId ?? null;
    this.startVoiceSessionTimer(data.startedAt ?? null, sessionId);

    await this.syncMicrophoneState();
    this.announceVoiceState();

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
      this.deps.state.on('state:change', () => {
        this.updateMuteButtons();
        this.updateVoiceStatusPanel();
      })
    );
  }

  private async syncMicrophoneState(forceRestart = false): Promise<void> {
    const { muted } = this.deps.state.getState();
    const shouldDisable = muted;
    const isVoiceSessionActive = this.deps.state.get('voiceConnected') || Boolean(this.pendingVoiceJoin);

    if (shouldDisable) {
      this.deps.audio.setMuted(true);
      if (this.deps.audio.hasActiveStream()) {
        this.deps.audio.stopLocalStream();
      }
      if (isVoiceSessionActive) {
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
      const stream = await this.deps.audio.getLocalStream(forceRestart);
      this.deps.audio.setMuted(false);
      this.deps.voice.setLocalStream(stream);
    } catch (error) {
      console.error('Error enabling microphone:', error);
      this.deps.state.setMuted(true);
      this.updateMuteButtons();
      this.renderVoiceUsers();
      this.announceVoiceState();
      this.deps.notifications.error('Failed to enable microphone. Please check permissions.');
    }
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

    const userRow = document.querySelector(`[data-id="${userId}"]`);
    if (userRow) {
      userRow.classList.toggle('speaking', speaking);
    }
  }

  private startVoiceSessionTimer(startedAt: number | null | undefined, sessionId: string | null): void {
    const startTime = this.sanitizeCallTimestamp(startedAt) ?? Date.now();

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
    if (drift >= 0 && drift < 60_000) {
      return now;
    }

    return timestamp;
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
    this.deps.voicePanel.updateSessionTimer(`⏱ ${formatted}`, title);
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
      el.textContent = `⏱ ${this.formatDuration(duration)}`;
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

    this.clearVoiceSessionTimer();
    this.clearVoiceChannelTimer();

    this.deps.voice.dispose();
    this.deps.audio.stopLocalStream();
    this.setLocalSpeaking(false);

    if (this.deps.socket.isConnected()) {
      this.deps.socket.leaveVoiceChannel();
    }

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
}
