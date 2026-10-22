import { batch, effect } from '@preact/signals';
import { AudioService, type MicSample } from '@/services/voice/AudioService';
import type { NeuralStatus } from '@/services/voice/neuralSuppression';
import { VoiceService, type PeerConnectionStats } from '@/services/voice/VoiceService';
import { api } from '@/services/socket/api';
import { socketClient } from '@/services/socket/client';
import { sounds } from '@/services/sounds';
import { updateDesktopVoiceActivity } from '@/services/native/desktop';
import { ensureForegroundServiceForVoice, stopForegroundServiceForVoice } from '@/services/native/ForegroundServiceManager';
import { isCancelError } from '@/services/screenCapture';
import { clipManager } from '@/services/clips/clipManager';
import { CameraError } from '@/services/voice/cameraCapture';
import { parseShortcut, shortcutMatchesEvent } from '@/lib/shortcut';
import { channelsById } from '@/state/channels';
import { DEFAULT_PEER_AUDIO, peerAudioPrefs } from '@/state/peerAudio';
import { displayNameFor, usersById } from '@/state/presence';
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
  noiseSuppressionStatus,
  overallQuality,
  pttPressed,
  rekeyPeer,
  removePeer,
  resetVoiceState,
  setRemoteScreenClips,
  setRemoteVideo,
  upsertPeer,
  voiceChannelId,
  voicePeers,
  voiceStartedAt,
  voiceStatus,
  type ConnectionQuality,
} from '@/state/voice';
import type { AudioSettings, DeviceInfo, HeldPeerConnection, ServerError, StreamMetadata, VoiceJoinedEvent, VoicePeerEvent, VoicePeerLeaveEvent, VoiceSignalEvent } from '@/types/protocol';
import { reconcilePeers, type KnownPeer, type RoomPeer, type SelfIdentity } from './peerReconcile';
import { initialRejoinState, isRejoinPending, PERMANENT_JOIN_ERRORS, reduceRejoin, type RejoinEffect, type RejoinEvent, type RejoinState } from './voiceRejoin';

const JOIN_TIMEOUT_MS = 15_000;
const SPEAKING_HOLD_MS = 350;
/** How often the rejoin clock and the stale-peer sweep run while in a call. */
const CALL_TICK_MS = 5_000;
/** A friend missing from the room after our rejoin is kept this long while their media still flows. */
const STALE_PEER_MAX_MS = 60_000;
/** After a rekey, give the transport this long to recover by itself before asking for an ICE restart. */
const ICE_RESTART_GRACE_MS = 1_500;

const newRtcSessionId = (): string => {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return 'rtc-' + random;
};

/**
 * Owns the microphone (AudioService) and the WebRTC mesh (VoiceService) and
 * keeps the voice store in sync with the server. Components only call the
 * public methods below and read signals.
 *
 * A lost socket does not end the call: the peer connections are peer to peer
 * and keep carrying audio. The call goes to `reconnecting`, keeps the
 * microphone, mute and deafen state, rejoins the room when the socket is back
 * (voiceRejoin.ts) and reconciles the room's new socket ids with the
 * connections it still has (peerReconcile.ts).
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
  /** Our media session id: peers keep their connection to us as long as it does not change. */
  private rtcSessionId: string | null = null;
  private rejoin: RejoinState = initialRejoinState;
  private tickTimer: number | null = null;
  private readonly iceGraceTimers = new Map<string, number>();

  constructor() {
    const settings = audioSettings.value;
    this.audio = new AudioService(settings);
    this.voice = new VoiceService(settings.voiceBitrate, settings.dtx, settings.vadThreshold);
    this.voice.setScreenQuality(settings.screenQuality);
    this.voice.setShareClipsAllowed(settings.shareClipsAllowed);
    noiseSuppressionStatus.value = this.audio.getNeuralStatus();
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
        connected: voiceStatus.value === 'connected' || voiceStatus.value === 'reconnecting',
        speaking: localSpeaking.value,
        muted: localMuted.value || localDeafened.value,
      });
    });

    // What I hear of each person: the account's remembered volume and "mute for me"
    // (state/peerAudio.ts) is pushed to the service for every peer in the room, so it
    // applies when they join, when they come back on a new socket and when I move a slider.
    effect(() => {
      const prefs = peerAudioPrefs.value;
      const people = usersById.value;
      for (const peer of Object.values(voicePeers.value)) {
        const accountId = peer.accountId ?? people.get(peer.id)?.accountId ?? null;
        this.voice.setPeerAudio(peer.id, (accountId && prefs[accountId]) || DEFAULT_PEER_AUDIO);
      }
    });
  }

  /** In a call: connected, or holding it together while the socket reconnects. */
  private inCall(): boolean {
    return voiceStatus.value === 'connected' || voiceStatus.value === 'reconnecting';
  }

  // ------------------------------------------------------------- joining

  async join(channelId: string): Promise<void> {
    if (!isAuthenticated.value) {
      toast.warning('Sign in to join voice');
      return;
    }
    const channel = channelsById.value.get(channelId);
    if (!channel || channel.type !== 'voice') return;
    if (this.inCall() && voiceChannelId.value === channelId) return;
    if (this.pendingJoin === channelId) return;

    if (voiceStatus.value !== 'idle') {
      await this.leave({ silent: true, switching: true });
    }

    try {
      // Both audio contexts start inside the tap on "Join": Safari would keep one created after the permission prompt silent.
      this.voice.prepareAudioPlayback();
      this.audio.unlock();
      this.pendingJoin = channelId;
      this.rtcSessionId = newRtcSessionId();
      batch(() => {
        voiceStatus.value = 'connecting';
        voiceChannelId.value = channelId;
        voicePeers.value = {};
      });
      this.startJoinTimeout(channelId);
      await this.syncMicrophone(true);
      api.joinVoice(channelId, this.rtcSessionId);
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
    this.stopTick();
    for (const timer of this.iceGraceTimers.values()) window.clearTimeout(timer);
    this.iceGraceTimers.clear();
    this.pendingJoin = null;
    this.rtcSessionId = null;
    this.rejoin = initialRejoinState;
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
      if (this.rejoin.phase === 'rejoining' && voiceChannelId.value === channelId) {
        // No answer to the rejoin: the state machine decides whether to try again.
        this.dispatch({ type: 'joinFailed', at: Date.now(), code: 'TIMEOUT' });
        return;
      }
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

  // -------------------------------------------------------------- rejoin

  private dispatch(event: RejoinEvent): void {
    const step = reduceRejoin(this.rejoin, event);
    this.rejoin = step.state;
    for (const effect of step.effects) this.runRejoinEffect(effect);
  }

  private runRejoinEffect(effect: RejoinEffect): void {
    if (effect.type === 'rejoin') {
      if (voiceStatus.value !== 'idle') voiceStatus.value = 'reconnecting';
      this.startJoinTimeout(effect.channelId);
      api.joinVoice(effect.channelId, this.rtcSessionId, this.heldConnections());
      return;
    }
    const why =
      effect.reason === 'timeout'
        ? 'The connection was down for too long.'
        : effect.reason === 'attempts'
          ? 'The server kept refusing the rejoin.'
          : 'The server refused the rejoin' + (effect.code ? ' (' + effect.code + ')' : '') + '.';
    toast.warning('You left voice. ' + why + ' Join again when you are ready.', 8000);
    sounds.play('disconnect', 0.4);
    this.resetLocal();
  }

  /** The socket dropped: keep the call, wait for the next sign-in to rejoin. */
  private onSocketLost(): void {
    if (voiceStatus.value === 'idle') return;
    if (voiceStatus.value === 'connecting') {
      // The join was still in flight: nothing to hold on to.
      toast.warning('The connection dropped before voice was up. Join again when you are back online.');
      this.resetLocal();
      return;
    }
    voiceStatus.value = 'reconnecting';
    this.clearJoinTimeout();
    this.dispatch({ type: 'socketLost', at: Date.now() });
    this.startTick();
  }

  /** Signed in again on a new socket: rejoin the room we were in. */
  private onAuthenticated(): void {
    if (!isRejoinPending(this.rejoin)) return;
    this.dispatch({ type: 'authenticated', at: Date.now() });
  }

  private startTick(): void {
    if (this.tickTimer !== null) return;
    this.tickTimer = window.setInterval(() => this.tick(), CALL_TICK_MS);
  }

  private stopTick(): void {
    if (this.tickTimer !== null) window.clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private tick(): void {
    if (!this.inCall()) {
      this.stopTick();
      return;
    }
    const now = Date.now();
    if (isRejoinPending(this.rejoin)) this.dispatch({ type: 'tick', at: now });
    // Friends the server no longer lists: keep them while their audio still flows, drop them
    // once the media path is gone or they stayed away too long.
    for (const peer of Object.values(voicePeers.value)) {
      if (peer.staleSince === null || peer.staleSince === undefined) continue;
      const health = this.voice.peerHealth(peer.id);
      if (health === 'missing' || health === 'broken' || now - peer.staleSince > STALE_PEER_MAX_MS) {
        this.voice.removePeer(peer.id);
        removePeer(peer.id);
      }
    }
  }

  /** What we know about the people we are connected to, for peerReconcile.ts. */
  private knownPeers(): KnownPeer[] {
    return Object.values(voicePeers.value).map((peer) => ({ id: peer.id, accountId: peer.accountId ?? null, rtcSessionId: peer.rtcSessionId ?? null, health: this.voice.peerHealth(peer.id) }));
  }

  /** The connections we still hold, told to the room on a rejoin so a peer we lost offers afresh. */
  private heldConnections(): HeldPeerConnection[] {
    return Object.values(voicePeers.value)
      .filter((peer) => peer.accountId && this.voice.peerHealth(peer.id) !== 'missing')
      .map((peer) => ({ accountId: peer.accountId as string, rtcSessionId: peer.rtcSessionId ?? null }));
  }

  private self(): SelfIdentity {
    return { accountId: account.value?.id ?? null, rtcSessionId: this.rtcSessionId };
  }

  private roomPeer(peer: VoicePeerEvent): RoomPeer {
    return { id: peer.id, accountId: peer.accountId ?? '', rtcSessionId: peer.rtcSessionId ?? null, holding: peer.holding };
  }

  private peerFields(peer: VoicePeerEvent) {
    return {
      name: displayNameFor(peer.id, peer.name),
      muted: Boolean(peer.muted),
      deafened: Boolean(peer.deafened),
      accountId: peer.accountId ?? null,
      rtcSessionId: peer.rtcSessionId ?? null,
      staleSince: null,
    };
  }

  /** Our transport to a kept peer is broken: ask for an ICE restart unless it recovers on its own first. */
  private restartIceSoon(peerId: string): void {
    const existing = this.iceGraceTimers.get(peerId);
    if (existing !== undefined) window.clearTimeout(existing);
    this.iceGraceTimers.set(
      peerId,
      window.setTimeout(() => {
        this.iceGraceTimers.delete(peerId);
        if (this.inCall() && this.voice.peerHealth(peerId) === 'broken') {
          this.voice.restartIce(peerId).catch((error) => console.error('[voice] ICE restart failed', error));
        }
      }, ICE_RESTART_GRACE_MS),
    );
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
    if (!this.inCall()) return;
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
    if (!audioSettings.value.pttEnable || !this.inCall()) {
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

  /** Tell the room our mute/deafen state; while reconnecting it is re-sent by the rejoin. */
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
    this.voice.setShareClipsAllowed(settings.shareClipsAllowed);
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
      this.audio.unlock();
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

  /** Records the open microphone, raw and processed, for the settings dialog's playback. */
  recordMicSample(seconds = 5): Promise<MicSample> {
    return this.audio.recordMicSample(seconds);
  }

  playMicSample(sample: MicSample, which: 'raw' | 'processed'): Promise<void> {
    return this.audio.playSample(which === 'raw' ? sample.raw : sample.processed, sample.sampleRate);
  }

  /** Downloads the neural model early when the saved level is `strong` (called once the user is signed in). */
  prepareNoiseSuppression(): void {
    this.audio.prepareNeuralSuppression();
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

  /** The gain a peer's voice plays at for me right now, or null while their audio is not attached. */
  peerGain(peerId: string): number | null {
    return this.voice.peerGain(peerId);
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
    socketClient.on<VoicePeerLeaveEvent>('voice:peer-leave', (event) => this.onPeerLeave(event));
    socketClient.on<VoiceSignalEvent>('voice:signal', (data) => void this.onSignal(data));
    socketClient.on<{ from: string; metadata: StreamMetadata }>('voice:stream-metadata', (data) => {
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
    // Another socket of ours (a second tab) took the seat in this room.
    socketClient.on<{ channelId: string }>('voice:replaced', () => {
      if (voiceStatus.value === 'idle') return;
      toast.info('Voice moved to your other window');
      this.resetLocal();
    });
    socketClient.on('disconnect', () => this.onSocketLost());
    socketClient.on('auth:success', () => this.onAuthenticated());
    // A refused `voice:join` arrives on the generic error event; only refusals matter while rejoining.
    socketClient.on<ServerError>('error', (payload) => {
      if (this.rejoin.phase !== 'rejoining' || !payload?.code) return;
      if (PERMANENT_JOIN_ERRORS.has(payload.code) || payload.code === 'VOICE_JOIN_FAILED' || payload.code === 'RATE_LIMITED') {
        this.dispatch({ type: 'joinFailed', at: Date.now(), code: payload.code });
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
    // The sharer's say on clipping their screen, and the voices the clip mixer may record.
    this.voice.on('video:remote:clips', ({ peerId, allowed }) => setRemoteScreenClips(peerId, allowed));
    this.voice.on('voice:remote-audio', () => clipManager.setVoiceStreams(this.voice.remoteAudioStreams()));
    this.voice.on('video:camera:started', ({ stream }) => {
      localCameraStream.value = stream;
      api.setVideoState('camera', true);
    });
    this.voice.on('video:camera:stopped', () => {
      localCameraStream.value = null;
      if (voiceStatus.value === 'connected') api.setVideoState('camera', false);
    });
    this.voice.on('video:screen:started', ({ stream, audioNotice }) => {
      localScreenStream.value = stream;
      api.setVideoState('screen', true);
      if (audioNotice) toast.warning(audioNotice, 9000);
    });
    this.voice.on('video:screen:stopped', () => {
      localScreenStream.value = null;
      if (voiceStatus.value === 'connected') api.setVideoState('screen', false);
    });

    this.audio.on('mic:level', (level) => {
      const value = typeof level === 'number' ? level : 0;
      micLevel.value = value;
      if (this.inCall() && this.shouldTransmit()) {
        this.setLocalSpeaking(value > audioSettings.value.vadThreshold);
      }
    });
    this.audio.on('stream:active', (stream) => {
      if (voiceStatus.value !== 'idle') this.voice.setLocalStream(stream as MediaStream);
    });
    this.audio.on('stream:interrupted', () => {
      if (voiceStatus.value !== 'idle') this.scheduleMicRecovery();
    });
    this.audio.on('neural:status', (status) => {
      noiseSuppressionStatus.value = status as NeuralStatus;
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

  /**
   * The server confirmed our seat, after a fresh join or a rejoin. The room's list is
   * reconciled with the connections we hold: the same person on a new socket keeps
   * their connection (rekey), someone who rebuilt theirs or is new waits for an offer
   * from us only in `onPeerJoin`; here we are the newcomer and they offer.
   */
  private async onJoined(data: VoiceJoinedEvent): Promise<void> {
    this.clearJoinTimeout();
    const rejoining = voiceStatus.value === 'reconnecting';
    this.pendingJoin = null;
    const now = Date.now();
    const startedAt = typeof data.startedAt === 'number' && data.startedAt > 0 && data.startedAt <= now ? data.startedAt : now;
    const actions = reconcilePeers(this.knownPeers(), data.peers.map((peer) => this.roomPeer(peer)), this.self());
    const byId = new Map(data.peers.map((peer) => [peer.id, peer]));

    batch(() => {
      voiceStatus.value = 'connected';
      voiceChannelId.value = data.channelId;
      if (!rejoining) voiceStartedAt.value = data.peers.length > 0 ? startedAt : now;
      for (const action of actions) {
        switch (action.action) {
          case 'keep':
            upsertPeer({ id: action.id, ...this.peerFields(byId.get(action.id)!) });
            break;
          case 'rekey':
            this.voice.rekeyPeer(action.from, action.to);
            rekeyPeer(action.from, action.to, this.peerFields(byId.get(action.to)!));
            if (action.restartIce) this.restartIceSoon(action.to);
            break;
          case 'rebuild':
            if (action.from) {
              this.voice.removePeer(action.from);
              removePeer(action.from);
            }
            upsertPeer({ id: action.to, ...this.peerFields(byId.get(action.to)!), speaking: false, camera: false, screen: false, quality: 'unknown' });
            break;
          case 'stale':
            upsertPeer({ id: action.id, staleSince: voicePeers.value[action.id]?.staleSince ?? now });
            break;
        }
      }
    });
    this.dispatch({ type: 'joined', channelId: data.channelId });

    this.voice.startStatsMonitoring();
    await this.syncMicrophone();
    this.announceState();
    this.syncForegroundService();
    this.startTick();

    const settings = audioSettings.value;
    this.voice.setOutputVolume(settings.outputVol);
    if (settings.spkDeviceId) {
      this.voice.setOutputDevice(settings.spkDeviceId).catch(() => undefined);
    }

    if (rejoining) {
      toast.success('Voice is back', 2500);
      return;
    }
    const channelName = channelsById.value.get(data.channelId)?.name ?? 'voice';
    sounds.play('call', 0.5);
    toast.success('Joined ' + channelName);
  }

  /** Someone (re)joined the room while we are in it: we offer, unless we already hold their connection. */
  private async onPeerJoin(peer: VoicePeerEvent): Promise<void> {
    if (!this.inCall()) return;
    const [action] = reconcilePeers(this.knownPeers(), [this.roomPeer(peer)], this.self(), { partial: true });
    if (!action) return;
    if (action.action === 'keep') {
      upsertPeer({ id: peer.id, ...this.peerFields(peer) });
      return;
    }
    if (action.action === 'rekey') {
      this.voice.rekeyPeer(action.from, action.to);
      rekeyPeer(action.from, action.to, this.peerFields(peer));
      if (action.restartIce) this.restartIceSoon(action.to);
      return;
    }
    if (action.action !== 'rebuild') return;
    if (action.from) {
      this.voice.removePeer(action.from);
      removePeer(action.from);
    } else {
      sounds.play('userJoin', 0.3);
    }
    upsertPeer({ id: peer.id, ...this.peerFields(peer) });
    if (this.voice.hasPeer(peer.id)) return;
    try {
      await this.voice.createOffer(peer.id);
    } catch (error) {
      console.error('[voice] offer failed', error);
      this.voice.removePeer(peer.id);
    }
  }

  private onPeerLeave({ id, reason }: VoicePeerLeaveEvent): void {
    if (reason === 'replaced') {
      // The same person is taking the seat over with a new socket: their connection stays
      // until the matching peer-join moves it over (or the sweep drops it).
      if (voicePeers.value[id]) upsertPeer({ id, staleSince: Date.now() });
      return;
    }
    this.voice.removePeer(id);
    removePeer(id);
    if (voiceStatus.value === 'connected') sounds.play('userLeave', 0.3);
  }

  private async onSignal(data: VoiceSignalEvent): Promise<void> {
    if (!this.inCall() || !voicePeers.value[data.from]) return;
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

// With the strong level saved, fetch the model once signed in so the first call does not wait for it.
let prepared = false;
effect(() => {
  if (prepared || !account.value || audioSettings.value.noiseSuppressionLevel !== 'strong') return;
  prepared = true;
  voiceManager.prepareNoiseSuppression();
});
