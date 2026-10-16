import { batch, effect } from '@preact/signals';
import { AudioService } from '@/services/voice/AudioService';
import { VoiceService, type PeerConnectionStats } from '@/services/voice/VoiceService';
import { api } from '@/services/socket/api';
import { socketClient } from '@/services/socket/client';
import { sounds } from '@/services/sounds';
import { updateDesktopVoiceActivity } from '@/services/native/desktop';
import { ensureForegroundServiceForVoice, stopForegroundServiceForVoice } from '@/services/native/ForegroundServiceManager';
import { isCancelError, missingAudioHint } from '@/services/screenCapture';
import { CameraError } from '@/services/voice/cameraCapture';
import { isDesktopApp } from '@/services/native/desktop';
import { parseShortcut, shortcutMatchesEvent } from '@/lib/shortcut';
import { channelsById } from '@/state/channels';
import { displayNameFor } from '@/state/presence';
import { account, isAuthenticated } from '@/state/session';
import { audioSettings } from '@/state/settings';
import { toast } from '@/state/ui';
import {
  localCameraStream,
  localDeafened,
  localMuted,
  localScreenStream,
  localSpeaking,
  micLevel,
  overallQuality,
  pttPressed,
  removePeer,
  resetVoiceState,
  setRemoteVideo,
  upsertPeer,
  voiceChannelId,
  voicePeers,
  voiceStartedAt,
  voiceStatus,
  type ConnectionQuality,
} from '@/state/voice';
import type { AudioSettings, DeviceInfo, VoiceJoinedEvent, VoicePeerEvent, VoiceSignalEvent } from '@/types/protocol';

const JOIN_TIMEOUT_MS = 15_000;
const SPEAKING_HOLD_MS = 350;

/**
 * Owns the microphone (AudioService) and the WebRTC mesh (VoiceService) and
 * keeps the voice store in sync with the server. Components only call the
 * public methods below and read signals.
 */
class VoiceManager {
  private readonly audio: AudioService;
  private readonly voice: VoiceService;
  private pendingJoin: string | null = null;
  private joinTimer: number | null = null;
  private speakingTimer: number | null = null;
  private appActive = true;
  private micRecoveryTimer: number | null = null;
  private facingMode: 'user' | 'environment' = 'user';
  private initialized = false;
  private readonly pttSources = { window: false, global: false };

  constructor() {
    const settings = audioSettings.value;
    this.audio = new AudioService(settings);
    this.voice = new VoiceService(settings.voiceBitrate, settings.dtx, settings.vadThreshold);
    this.voice.setScreenQuality(settings.screenQuality);
  }

  /** Attach socket, service and lifecycle listeners. Idempotent. */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.bindSocket();
    this.bindServices();
    this.bindLifecycle();

    effect(() => {
      updateDesktopVoiceActivity({
        connected: voiceStatus.value === 'connected',
        speaking: localSpeaking.value,
        muted: localMuted.value || localDeafened.value,
      });
    });
  }

  // ------------------------------------------------------------- joining

  async join(channelId: string): Promise<void> {
    if (!isAuthenticated.value) {
      toast.warning('Sign in to join voice');
      return;
    }
    const channel = channelsById.value.get(channelId);
    if (!channel || channel.type !== 'voice') return;
    if (voiceStatus.value === 'connected' && voiceChannelId.value === channelId) return;
    if (this.pendingJoin === channelId) return;

    if (voiceStatus.value !== 'idle') {
      await this.leave({ silent: true, switching: true });
    }

    try {
      this.voice.prepareAudioPlayback();
      this.pendingJoin = channelId;
      batch(() => {
        voiceStatus.value = 'connecting';
        voiceChannelId.value = channelId;
        voicePeers.value = {};
      });
      this.startJoinTimeout(channelId);
      await this.syncMicrophone(true);
      api.joinVoice(channelId);
    } catch (error) {
      this.resetLocal();
      sounds.play('error', 0.5);
      toast.error(error instanceof Error ? error.message : 'Could not join voice');
    }
  }

  async leave(options: { silent?: boolean; switching?: boolean } = {}): Promise<void> {
    if (voiceStatus.value === 'idle' && !this.pendingJoin) return;
    if (!options.silent) sounds.play('disconnect', 0.6);
    if (socketClient.connected) api.leaveVoice();
    this.resetLocal();
    if (!options.switching && !options.silent) toast.info('Left voice');
  }

  private resetLocal(): void {
    this.clearJoinTimeout();
    this.pendingJoin = null;
    this.pttSources.window = false;
    this.pttSources.global = false;
    this.voice.stopStatsMonitoring();
    this.stopAllVideo();
    this.voice.dispose();
    this.audio.stopLocalStream();
    void stopForegroundServiceForVoice();
    resetVoiceState();
  }

  /** Android: the persistent notification names the channel and offers Leave (no-op elsewhere). */
  private syncForegroundService(): void {
    const channel = voiceChannelId.value ? channelsById.value.get(voiceChannelId.value) : null;
    void ensureForegroundServiceForVoice({ channelName: channel?.name ?? 'Voice', onLeave: () => void this.leave() });
  }

  private startJoinTimeout(channelId: string): void {
    this.clearJoinTimeout();
    this.joinTimer = window.setTimeout(() => {
      if (this.pendingJoin === channelId && voiceStatus.value === 'connecting') {
        toast.error('Voice connection timed out. Check your connection and try again.');
        this.resetLocal();
      }
    }, JOIN_TIMEOUT_MS);
  }

  private clearJoinTimeout(): void {
    if (this.joinTimer !== null) window.clearTimeout(this.joinTimer);
    this.joinTimer = null;
  }

  // ------------------------------------------------------------- controls

  async toggleMute(): Promise<void> {
    const next = !localMuted.value;
    localMuted.value = next;
    if (!next && localDeafened.value) localDeafened.value = false;
    sounds.play(next ? 'mute' : 'unmute', 0.4);
    this.voice.setDeafened(localDeafened.value);
    await this.syncMicrophone();
    this.announceState();
  }

  async toggleDeafen(): Promise<void> {
    const next = !localDeafened.value;
    batch(() => {
      localDeafened.value = next;
      if (next) localMuted.value = true;
    });
    sounds.play(next ? 'deafen' : 'undeafen', 0.4);
    this.voice.setDeafened(next);
    await this.syncMicrophone();
    this.announceState();
  }

  /** Push-to-talk: hold the configured key to transmit (key events of the focused window). */
  handlePttKey(event: KeyboardEvent, pressed: boolean): void {
    const settings = audioSettings.value;
    if (!settings.pttEnable || !settings.pttKey) return;
    const shortcut = parseShortcut(settings.pttKey);
    if (!shortcut || !shortcutMatchesEvent(shortcut, event, pressed ? 'down' : 'up')) return;
    if (voiceStatus.value !== 'connected') return;
    event.preventDefault();
    this.setPushToTalkHeld('window', pressed);
  }

  /**
   * The push-to-talk key went down or up. Two sources feed this: the window's key events
   * and, in the desktop app, the system-wide shortcut (features/voice/desktopVoice.ts);
   * the mic transmits while either holds the key.
   */
  setPushToTalkHeld(source: 'window' | 'global', held: boolean): void {
    this.pttSources[source] = held;
    const pressed = this.pttSources.window || this.pttSources.global;
    if (!audioSettings.value.pttEnable || voiceStatus.value !== 'connected') {
      if (pttPressed.value) pttPressed.value = false;
      return;
    }
    if (pttPressed.value === pressed) return;
    pttPressed.value = pressed;
    sounds.play(pressed ? 'ptt_on' : 'ptt_off', 0.3);
    this.audio.setMuted(!this.shouldTransmit());
    if (!pressed) this.setLocalSpeaking(false);
  }

  private shouldTransmit(): boolean {
    if (localMuted.value || localDeafened.value) return false;
    if (audioSettings.value.pttEnable) return pttPressed.value;
    return true;
  }

  private announceState(): void {
    if (voiceStatus.value === 'connected') api.setVoiceState(localMuted.value, localDeafened.value);
  }

  async toggleCamera(): Promise<void> {
    if (voiceStatus.value !== 'connected') return;
    try {
      if (this.voice.isCameraActive()) {
        this.voice.stopCamera();
      } else {
        await this.voice.startCamera();
      }
    } catch (error) {
      toast.error(describeMediaError(error, 'camera'));
    }
  }

  async flipCamera(): Promise<void> {
    if (!this.voice.isCameraActive()) return;
    try {
      const devices = await this.voice.getVideoDevices();
      if (devices.length < 2) return;
      this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
      const wanted = devices.find((device) => new RegExp(this.facingMode === 'user' ? 'front|user' : 'back|rear|environment', 'i').test(device.label));
      const current = this.voice.getCameraStream()?.getVideoTracks()[0]?.getSettings().deviceId;
      const target = wanted ?? devices.find((device) => device.deviceId !== current) ?? devices[0];
      await this.voice.switchCamera(target.deviceId);
    } catch (error) {
      toast.error(describeMediaError(error, 'camera'));
    }
  }

  async toggleScreenShare(): Promise<void> {
    if (voiceStatus.value !== 'connected') return;
    try {
      if (this.voice.isScreenShareActive()) {
        this.voice.stopScreenShare();
      } else {
        await this.voice.startScreenShare();
      }
    } catch (error) {
      if (!isCancelError(error)) toast.error(describeMediaError(error, 'screen'));
    }
  }

  private stopAllVideo(): void {
    if (this.voice.isCameraActive()) this.voice.stopCamera();
    if (this.voice.isScreenShareActive()) this.voice.stopScreenShare();
  }

  // ------------------------------------------------------------- devices

  getDevices(): Promise<{ mics: DeviceInfo[]; speakers: DeviceInfo[] }> {
    return this.audio.getDevices();
  }

  supportsOutputSelection(): boolean {
    return this.audio.supportsOutputDeviceSelection();
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    await this.voice.setOutputDevice(deviceId);
  }

  /** Apply saved audio settings to the live pipeline. */
  async applySettings(settings: AudioSettings): Promise<void> {
    this.voice.updateVoiceSettings(settings.voiceBitrate, settings.dtx, settings.vadThreshold);
    this.voice.setScreenQuality(settings.screenQuality);
    this.voice.setOutputVolume(settings.outputVol);
    try {
      await this.audio.updateSettings(settings);
    } catch (error) {
      toast.error(describeMediaError(error, 'microphone'));
    }
    if (settings.spkDeviceId !== undefined) {
      try {
        await this.voice.setOutputDevice(settings.spkDeviceId);
      } catch {
        /* unsupported browsers */
      }
    }
    if (!settings.pttEnable) {
      this.pttSources.window = false;
      this.pttSources.global = false;
      pttPressed.value = false;
    }
    this.audio.setMuted(!this.shouldTransmit());
  }

  /** Open the microphone outside a call so the settings dialog can show a level meter. */
  async startMicTest(): Promise<void> {
    try {
      await this.audio.getLocalStream(false);
      this.audio.setMuted(false);
    } catch (error) {
      toast.error(describeMediaError(error, 'microphone'));
    }
  }

  stopMicTest(): void {
    if (voiceStatus.value === 'idle' && !this.pendingJoin) {
      this.audio.stopLocalStream();
      micLevel.value = 0;
    }
  }

  runDiagnostics() {
    return this.voice.runDiagnostics();
  }

  // ------------------------------------------------------------ moderation

  kick(peerId: string): void {
    api.kickFromVoice(peerId, displayNameFor(peerId, voicePeers.value[peerId]?.name ?? 'user'));
  }

  timeout(peerId: string, minutes: number): void {
    api.timeoutFromVoice(peerId, displayNameFor(peerId, voicePeers.value[peerId]?.name ?? 'user'), minutes * 60_000);
  }

  setPeerVolume(peerId: string, volume: number): void {
    this.voice.setPeerVolume(peerId, volume);
  }

  setPeerMuted(peerId: string, muted: boolean): void {
    this.voice.setPeerMuted(peerId, muted);
  }

  peerVolume(peerId: string): { muted: boolean; volume: number } {
    return this.voice.getPeerAudioPreference(peerId);
  }

  // ----------------------------------------------------------- microphone

  private async syncMicrophone(forceRestart = false): Promise<void> {
    const active = voiceStatus.value !== 'idle' || this.pendingJoin !== null;
    if (!active) return;
    if (localMuted.value || localDeafened.value) {
      this.audio.setMuted(true);
      this.setLocalSpeaking(false);
      return;
    }
    try {
      const permission = await this.audio.getMicrophonePermissionStatus();
      if (permission === 'denied') {
        toast.error('Microphone access is blocked. Allow it in your browser settings to talk.');
        localMuted.value = true;
        return;
      }
    } catch {
      /* permissions API unsupported */
    }
    try {
      const stream = await this.audio.getLocalStream(forceRestart);
      this.audio.setMuted(!this.shouldTransmit());
      this.voice.setLocalStream(stream);
    } catch (error) {
      localMuted.value = true;
      toast.error(describeMediaError(error, 'microphone'));
    }
  }

  private setLocalSpeaking(speaking: boolean): void {
    if (speaking) {
      if (!localSpeaking.value) localSpeaking.value = true;
      if (this.speakingTimer !== null) window.clearTimeout(this.speakingTimer);
      this.speakingTimer = window.setTimeout(() => {
        localSpeaking.value = false;
        this.speakingTimer = null;
      }, SPEAKING_HOLD_MS);
    } else if (this.speakingTimer === null && localSpeaking.value) {
      localSpeaking.value = false;
    }
  }

  // -------------------------------------------------------------- binding

  private bindSocket(): void {
    socketClient.on<VoiceJoinedEvent>('voice:joined', (data) => void this.onJoined(data));
    socketClient.on<VoicePeerEvent>('voice:peer-join', (peer) => void this.onPeerJoin(peer));
    socketClient.on<{ id: string }>('voice:peer-leave', ({ id }) => {
      this.voice.removePeer(id);
      removePeer(id);
      if (voiceStatus.value === 'connected') sounds.play('userLeave', 0.3);
    });
    socketClient.on<VoiceSignalEvent>('voice:signal', (data) => void this.onSignal(data));
    socketClient.on<{ from: string; metadata: { streamId: string; type: 'camera' | 'screen' } }>('voice:stream-metadata', (data) => {
      this.voice.handleStreamMetadata(data);
    });
    socketClient.on<{ id: string; muted: boolean; deafened: boolean }>('voice:state', ({ id, muted, deafened }) => {
      if (voicePeers.value[id]) upsertPeer({ id, muted, deafened });
    });
    socketClient.on<{ id: string; type: 'camera' | 'screen'; enabled: boolean }>('voice:video:state', ({ id, type, enabled }) => {
      if (voicePeers.value[id]) upsertPeer({ id, [type]: enabled });
    });
    socketClient.on<{ by: string; reason?: string }>('voice:kicked', (data) => {
      toast.warning(data.reason || 'You were removed from voice by ' + data.by);
      this.resetLocal();
    });
    socketClient.on<{ by: string; reason?: string }>('voice:timeout', (data) => {
      toast.warning(data.reason || 'You were timed out from voice by ' + data.by);
      this.resetLocal();
    });
    socketClient.on('disconnect', () => {
      if (voiceStatus.value !== 'idle') {
        toast.warning('Voice dropped with the connection. Rejoin when you are back online.');
        this.resetLocal();
      }
    });
  }

  private bindServices(): void {
    this.voice.on('voice:offer', ({ peerId, offer }) => api.sendVoiceSignal(peerId, { sdp: offer }));
    this.voice.on('voice:answer', ({ peerId, answer }) => api.sendVoiceSignal(peerId, { sdp: answer }));
    this.voice.on('voice:ice-candidate', ({ peerId, candidate }) => api.sendVoiceSignal(peerId, { candidate }));
    this.voice.on('voice:send-stream-metadata', ({ to, metadata }) => api.sendStreamMetadata(to, metadata));
    this.voice.on('voice:speaking', ({ id, speaking }) => {
      if (voicePeers.value[id]) upsertPeer({ id, speaking });
    });
    this.voice.on('voice:stats', (stats) => {
      const data = stats as PeerConnectionStats;
      if (voicePeers.value[data.peerId]) upsertPeer({ id: data.peerId, quality: data.quality as ConnectionQuality });
      overallQuality.value = this.voice.getOverallConnectionQuality();
    });
    this.voice.on('notification', (notification) => {
      toast[notification.type](notification.message);
    });
    this.voice.on('video:remote:track', ({ peerId, streamType, stream }) => {
      setRemoteVideo(peerId, streamType, stream);
      upsertPeer({ id: peerId, [streamType]: true });
    });
    this.voice.on('video:remote:track:removed', ({ peerId, streamType }) => {
      setRemoteVideo(peerId, streamType, null);
      if (voicePeers.value[peerId]) upsertPeer({ id: peerId, [streamType]: false });
    });
    this.voice.on('video:camera:started', ({ stream }) => {
      localCameraStream.value = stream;
      api.setVideoState('camera', true);
    });
    this.voice.on('video:camera:stopped', () => {
      localCameraStream.value = null;
      if (voiceStatus.value === 'connected') api.setVideoState('camera', false);
    });
    this.voice.on('video:screen:started', ({ stream, hasAudio }) => {
      localScreenStream.value = stream;
      api.setVideoState('screen', true);
      if (!hasAudio) toast.warning(missingAudioHint(isDesktopApp() ? 'desktop' : 'browser'), 9000);
    });
    this.voice.on('video:screen:stopped', () => {
      localScreenStream.value = null;
      if (voiceStatus.value === 'connected') api.setVideoState('screen', false);
    });

    this.audio.on('mic:level', (level) => {
      const value = typeof level === 'number' ? level : 0;
      micLevel.value = value;
      if (voiceStatus.value === 'connected' && this.shouldTransmit()) {
        this.setLocalSpeaking(value > audioSettings.value.vadThreshold);
      }
    });
    this.audio.on('stream:active', (stream) => {
      if (voiceStatus.value !== 'idle') this.voice.setLocalStream(stream as MediaStream);
    });
    this.audio.on('stream:interrupted', () => {
      if (voiceStatus.value !== 'idle') this.scheduleMicRecovery();
    });
  }

  private bindLifecycle(): void {
    const resumed = () => {
      this.appActive = true;
      if (voiceStatus.value === 'idle') return;
      this.syncForegroundService();
      this.scheduleMicRecovery();
    };
    const paused = () => {
      this.appActive = false;
      if (voiceStatus.value !== 'idle') this.syncForegroundService();
    };
    document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? resumed() : paused()));

    void (async () => {
      try {
        const { Capacitor } = await import('@capacitor/core');
        if (!Capacitor.isNativePlatform()) return;
        const { App: CapApp } = await import('@capacitor/app');
        await CapApp.addListener('appStateChange', ({ isActive }) => (isActive ? resumed() : paused()));
      } catch {
        /* not running inside Capacitor */
      }
    })();
  }

  private scheduleMicRecovery(): void {
    if (!this.appActive) return;
    if (this.micRecoveryTimer !== null) window.clearTimeout(this.micRecoveryTimer);
    this.micRecoveryTimer = window.setTimeout(() => {
      this.micRecoveryTimer = null;
      if (voiceStatus.value === 'idle' || localMuted.value) return;
      void this.syncMicrophone(true);
    }, 300);
  }

  // ------------------------------------------------------- socket events

  private async onJoined(data: VoiceJoinedEvent): Promise<void> {
    this.clearJoinTimeout();
    this.pendingJoin = null;
    const now = Date.now();
    const startedAt = typeof data.startedAt === 'number' && data.startedAt > 0 && data.startedAt <= now ? data.startedAt : now;
    batch(() => {
      voiceStatus.value = 'connected';
      voiceChannelId.value = data.channelId;
      voiceStartedAt.value = data.peers.length > 0 ? startedAt : now;
      const peers: typeof voicePeers.value = {};
      for (const peer of data.peers) {
        peers[peer.id] = {
          id: peer.id,
          name: displayNameFor(peer.id, peer.name),
          muted: Boolean(peer.muted),
          deafened: Boolean(peer.deafened),
          speaking: false,
          camera: false,
          screen: false,
          quality: 'unknown',
        };
      }
      voicePeers.value = peers;
    });

    this.voice.startStatsMonitoring();
    await this.syncMicrophone();
    this.announceState();
    this.syncForegroundService();

    const settings = audioSettings.value;
    this.voice.setOutputVolume(settings.outputVol);
    if (settings.spkDeviceId) {
      this.voice.setOutputDevice(settings.spkDeviceId).catch(() => undefined);
    }

    const channelName = channelsById.value.get(data.channelId)?.name ?? 'voice';
    sounds.play('call', 0.5);
    toast.success('Joined ' + channelName);
  }

  private async onPeerJoin(peer: VoicePeerEvent): Promise<void> {
    if (voiceStatus.value !== 'connected') return;
    upsertPeer({ id: peer.id, name: displayNameFor(peer.id, peer.name), muted: peer.muted, deafened: peer.deafened });
    sounds.play('userJoin', 0.3);
    if (this.voice.hasPeer(peer.id)) return;
    try {
      await this.voice.createOffer(peer.id);
    } catch (error) {
      console.error('[voice] offer failed', error);
      this.voice.removePeer(peer.id);
    }
  }

  private async onSignal(data: VoiceSignalEvent): Promise<void> {
    if (voiceStatus.value !== 'connected' || !voicePeers.value[data.from]) return;
    try {
      if (data.data.sdp?.type === 'offer') await this.voice.handleOffer(data.from, data.data.sdp);
      else if (data.data.sdp?.type === 'answer') await this.voice.handleAnswer(data.from, data.data.sdp);
      else if (data.data.candidate) await this.voice.handleIceCandidate(data.from, data.data.candidate);
    } catch (error) {
      console.error('[voice] signal failed', error);
    }
  }
}

const describeMediaError = (error: unknown, device: 'microphone' | 'camera' | 'screen'): string => {
  // The camera path already distinguishes "in use or blocked", "constraints refused" and "no camera".
  if (error instanceof CameraError) return error.message;
  const name = (error as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Permission to use the ' + device + ' was denied.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No ' + device + ' was found.';
  if (name === 'NotReadableError') return 'The ' + device + ' is in use by another application.';
  return error instanceof Error && error.message ? error.message : 'Could not access the ' + device + '.';
};

export const voiceManager = new VoiceManager();

// Keep the live pipeline in sync with saved settings.
let lastApplied: AudioSettings | null = null;
effect(() => {
  const settings = audioSettings.value;
  if (lastApplied === settings) return;
  const first = lastApplied === null;
  lastApplied = settings;
  if (!first && account.value) void voiceManager.applySettings(settings);
});
