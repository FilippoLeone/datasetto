import type { VoiceControllerDeps } from './types';
import type { Channel, VoicePeerEvent } from '@/types';
import type { VoicePanelEntry } from '@/ui/VoicePanelController';
import type { ConnectionQuality, PeerConnectionStats } from '@/services/VoiceService';
import { MICROPHONE_PERMISSION_HELP_TEXT } from '@/services/AudioService';
import { ensureForegroundServiceForVoice, stopForegroundServiceForVoice } from '@/services';
import { generateIdenticonDataUri } from '@/utils/avatarGenerator';


const LOCAL_SPEAKING_THRESHOLD = 0.08;
const LOCAL_SPEAKING_RELEASE_MS = 300;
const VOICE_JOIN_TIMEOUT_MS = 10_000;
const VOICE_SESSION_CLOCK_TOLERANCE_MS = 120_000;

type DesktopVoiceActivityPayload = {
  connected: boolean;
  speaking: boolean;
  muted: boolean;
};

type DesktopBridge = {
  updateVoiceActivity?: (payload: DesktopVoiceActivityPayload) => void;
};

interface PendingVoiceJoin {
  id: string;
  name: string;
}

type VoicePopoutCandidate = {
  ownerId: string;
  stream: MediaStream;
  label: string;
  type: 'screen' | 'camera';
  isLocal: boolean;
};

export class VoiceController {
  private deps: VoiceControllerDeps;
  private voiceUsers: Map<string, { id: string; name: string; muted?: boolean; deafened?: boolean; speaking?: boolean; cameraEnabled?: boolean; screenEnabled?: boolean }> = new Map();
  private pendingVoiceJoin: PendingVoiceJoin | null = null;
  private localSpeaking = false;
  private localSpeakingLastPeak = 0;
  private voiceSessionStart: number | null = null;
  private voiceSessionId: string | null = null;
  private voiceSessionTimerHandle: number | null = null;
  private voiceChannelTimerHandle: number | null = null;
  private pttActive = false;
  private poppedOutStream: { peerId: string; type: 'camera' | 'screen' } | null = null;
  private disposers: Array<() => void> = [];
  private activeOutputDeviceId: string | null = null;
  private micRecoveryTimeout: number | null = null;
  private appActive = true;
  private pendingMicRecoverySource: 'stream-interrupted' | 'app-resume' | null = null;
  private voiceJoinTimeoutHandle: number | null = null;
  private desktopAPI: DesktopBridge | null = null;
  private connectionQualityWarningShown = false;
  private lastConnectionQuality: ConnectionQuality = 'unknown';
  // Video call state
  private cameraActive = false;
  private screenShareActive = false;
  private remoteVideoTracks: Map<string, { camera?: MediaStreamTrack; screen?: MediaStreamTrack }> = new Map();
  private remoteVideoStreams: Map<string, { camera?: MediaStream; screen?: MediaStream }> = new Map();
  private availableVideoDevices: MediaDeviceInfo[] = [];
  private currentCameraDeviceId: string | null = null;
  // Debug mode
  private debugMode = false;
  private debugUpdateHandle: number | null = null;

  constructor(deps: VoiceControllerDeps) {
    this.deps = deps;

    if (typeof window !== 'undefined') {
      const bridge = (window as typeof window & { desktopAPI?: DesktopBridge }).desktopAPI;
      if (bridge) {
        this.desktopAPI = bridge;
      }
    }
  }

  initialize(): void {
    this.registerServiceListeners();
    this.registerNativeLifecycleListeners();
    this.deps.registerCleanup(() => this.dispose());
    this.updateMuteButtons();
    this.updateVoiceStatusPanel();
    this.updateVideoButtons();
    this.updateLocalVideoPreview();
    this.updateVoiceVideoToolbar();
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
    this.stopDebugUpdates();

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
    this.emitDesktopVoiceState();
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
    this.emitDesktopVoiceState();
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
    this.emitDesktopVoiceState();
  }

  // ==================== VIDEO CONTROLS ====================

  private async loadVideoDevices(): Promise<void> {
    this.availableVideoDevices = await this.deps.voice.getVideoDevices();
  }

  async flipCamera(): Promise<void> {
    if (!this.cameraActive) {
      return;
    }

    if (this.availableVideoDevices.length < 2) {
      await this.loadVideoDevices();
    }

    if (this.availableVideoDevices.length < 2) {
      this.updateVideoButtons();
      this.deps.notifications.info('No secondary camera available');
      return;
    }

    // Find current index
    let currentIndex = this.availableVideoDevices.findIndex(d => d.deviceId === this.currentCameraDeviceId);
    if (currentIndex === -1) currentIndex = 0;

    const nextIndex = (currentIndex + 1) % this.availableVideoDevices.length;
    const nextDevice = this.availableVideoDevices[nextIndex];

    try {
      await this.deps.voice.switchCamera(nextDevice.deviceId);
      this.currentCameraDeviceId = nextDevice.deviceId;
      await this.loadVideoDevices();
      
      // Update local preview with new stream
      this.updateLocalVideoPreview();
      this.updateVideoButtons();
      
      // Also update the stream in the controller's state if needed, 
      // but VoiceService emits 'video:camera:started' which we might be listening to?
      // Let's check if we need to manually update anything else.
    } catch (error) {
      console.error('[VoiceController] Failed to flip camera:', error);
      this.deps.notifications.error('Failed to switch camera');
    }
  }

  async toggleCamera(): Promise<void> {
    if (!this.deps.state.get('voiceConnected')) {
      this.deps.notifications.warning('Join a voice channel first to share your camera');
      return;
    }

    try {
      if (this.cameraActive) {
        this.deps.voice.stopCamera();
        this.cameraActive = false;
        this.currentCameraDeviceId = null;
        this.updateVideoButtons();
        this.updateLocalVideoPreview();
        this.deps.notifications.info('Camera stopped');
      } else {
        // Load devices if needed
        if (this.availableVideoDevices.length === 0) {
          await this.loadVideoDevices();
        }

        // Use current device ID or default
        const stream = await this.deps.voice.startCamera(this.currentCameraDeviceId || undefined);
        
        // Update current device ID from stream if not set
        if (!this.currentCameraDeviceId) {
          const track = stream.getVideoTracks()[0];
          const settings = track.getSettings();
          if (settings.deviceId) {
            this.currentCameraDeviceId = settings.deviceId;
          } else if (this.availableVideoDevices.length > 0) {
            // Fallback: assume first device if we can't get ID from settings
            this.currentCameraDeviceId = this.availableVideoDevices[0].deviceId;
          }
        }

        this.cameraActive = true;
        await this.loadVideoDevices();
        this.updateVideoButtons();
        this.updateLocalVideoPreview();
        this.deps.notifications.success('Camera started');
      }
    } catch (error) {
      console.error('[VoiceController] Camera toggle failed:', error);
      this.deps.notifications.error(
        error instanceof Error ? error.message : 'Failed to toggle camera'
      );
    }
  }

  async toggleScreenShare(): Promise<void> {
    if (!this.deps.state.get('voiceConnected')) {
      this.deps.notifications.warning('Join a voice channel first to share your screen');
      return;
    }

    try {
      if (this.screenShareActive) {
        this.deps.voice.stopScreenShare();
        this.screenShareActive = false;
        this.updateVideoButtons();
        this.updateLocalVideoPreview();
        this.deps.notifications.info('Screen share stopped');
      } else {
        await this.deps.voice.startScreenShare();
        this.screenShareActive = true;
        this.updateVideoButtons();
        this.updateLocalVideoPreview();
        this.deps.notifications.success('Screen sharing started');
      }
    } catch (error) {
      console.error('[VoiceController] Screen share toggle failed:', error);
      if (error instanceof Error && error.name === 'NotAllowedError') {
        this.deps.notifications.warning('Screen share was cancelled');
      } else {
        this.deps.notifications.error(
          error instanceof Error ? error.message : 'Failed to toggle screen share'
        );
      }
    }
  }

  private announceVideoState(type: 'camera' | 'screen', enabled: boolean): void {
    if (!this.deps.state.get('voiceConnected')) {
      return;
    }

    this.deps.socket.updateVideoState({ type, enabled });
  }

  private updateVideoButtons(): void {
    const cameraBtn = this.deps.elements['toggle-camera'];
    const flipBtn = this.deps.elements['flip-camera'];
    const screenBtn = this.deps.elements['toggle-screenshare'];

    if (cameraBtn) {
      cameraBtn.classList.toggle('active', this.cameraActive);
      cameraBtn.setAttribute('aria-pressed', String(this.cameraActive));
      cameraBtn.title = this.cameraActive ? 'Stop camera' : 'Start camera';
      const label = cameraBtn.querySelector('.voice-toggle-label');
      if (label) {
        label.textContent = this.cameraActive ? 'Stop Cam' : 'Camera';
      }
    }

    if (flipBtn) {
      const isMobile = window.matchMedia('(max-width: 1024px)').matches;
      const canFlip = isMobile && this.cameraActive && this.availableVideoDevices.length > 1;

      flipBtn.classList.toggle('hidden', !isMobile);
      flipBtn.toggleAttribute('disabled', !canFlip);
      flipBtn.setAttribute('aria-disabled', canFlip ? 'false' : 'true');
      flipBtn.title = canFlip ? 'Flip camera' : 'Flip camera unavailable';
    }

    if (screenBtn) {
      screenBtn.classList.toggle('active', this.screenShareActive);
      screenBtn.setAttribute('aria-pressed', String(this.screenShareActive));
      screenBtn.title = this.screenShareActive ? 'Stop sharing' : 'Share screen';
      const label = screenBtn.querySelector('.voice-toggle-label');
      if (label) {
        label.textContent = this.screenShareActive ? 'Stop Share' : 'Screen';
      }
    }
  }

  private updateLocalVideoPreview(): void {
    this.renderVoiceUsers();
  }

  private handleRemoteVideoTrack(payload: {
    peerId: string;
    streamType: 'camera' | 'screen';
    stream: MediaStream;
    track: MediaStreamTrack;
  }): void {
    const { peerId, streamType, stream, track } = payload;
    
    if (!this.remoteVideoTracks.has(peerId)) {
      this.remoteVideoTracks.set(peerId, {});
    }
    this.remoteVideoTracks.get(peerId)![streamType] = track;

    if (!this.remoteVideoStreams.has(peerId)) {
      this.remoteVideoStreams.set(peerId, {});
    }
    this.remoteVideoStreams.get(peerId)![streamType] = stream;

    if (this.setRemoteVideoState(peerId, streamType, true)) {
      this.renderVoiceUsers();
    }
  }

  private setRemoteVideoState(peerId: string, streamType: 'camera' | 'screen', enabled: boolean): boolean {
    const user = this.voiceUsers.get(peerId);
    if (!user) {
      return false;
    }

    if (streamType === 'camera') {
      user.cameraEnabled = enabled;
    } else {
      user.screenEnabled = enabled;
    }

    return true;
  }

  private createOrUpdateRemoteVideoTile(
    _peerId: string,
    _streamType: 'camera' | 'screen',
    _stream: MediaStream
  ): void {
    // Deprecated
  }

  private hideRemoteVideoTile(_peerId: string, _streamType: 'camera' | 'screen'): void {
    // Deprecated
  }

  private removeRemoteVideoTile(peerId: string, streamType?: 'camera' | 'screen'): void {
    let stateChanged = false;

    if (streamType) {
      const streams = this.remoteVideoStreams.get(peerId);
      if (streams) {
        delete streams[streamType];
        if (!streams.camera && !streams.screen) {
          this.remoteVideoStreams.delete(peerId);
        }
      }

      const peerTracks = this.remoteVideoTracks.get(peerId);
      if (peerTracks) {
        delete peerTracks[streamType];
        if (!peerTracks.camera && !peerTracks.screen) {
          this.remoteVideoTracks.delete(peerId);
        }
      }

      stateChanged = this.setRemoteVideoState(peerId, streamType, false) || stateChanged;
    } else {
      this.remoteVideoStreams.delete(peerId);
      this.remoteVideoTracks.delete(peerId);
      stateChanged = this.setRemoteVideoState(peerId, 'camera', false) || stateChanged;
      stateChanged = this.setRemoteVideoState(peerId, 'screen', false) || stateChanged;
    }

    if (stateChanged) {
      this.renderVoiceUsers();
    }
  }



  private updateVoiceVideoToolbar(): void {
    const toolbar = this.deps.elements.voiceVideoToolbar;
    const popoutBtn = this.deps.elements['voice-popout-video'] as HTMLButtonElement | undefined;
    if (!toolbar || !popoutBtn) {
      return;
    }

    const activeChannelType = this.deps.state.get('currentChannelType');
    const mainContent = document.querySelector('.main-content');
    const inVoiceStage = activeChannelType === 'voice' && mainContent?.classList.contains('voice-mode');
    const hasVideo = this.hasActiveVoiceVideo();

    toolbar.classList.toggle('hidden', !(inVoiceStage && hasVideo));
    popoutBtn.disabled = !hasVideo;
    popoutBtn.setAttribute('aria-disabled', hasVideo ? 'false' : 'true');
  }

  private hasActiveVoiceVideo(): boolean {
    if (this.streamHasLiveTrack(this.deps.voice.getCameraStream())) {
      return true;
    }
    if (this.streamHasLiveTrack(this.deps.voice.getScreenStream())) {
      return true;
    }
    for (const streams of this.remoteVideoStreams.values()) {
      if (this.streamHasLiveTrack(streams.camera) || this.streamHasLiveTrack(streams.screen)) {
        return true;
      }
    }
    return false;
  }

  private streamHasLiveTrack(stream?: MediaStream | null): stream is MediaStream {
    if (!stream) {
      return false;
    }
    return stream.getTracks().some((track) => track.readyState === 'live');
  }

  private stopAllVideo(): void {
    if (this.cameraActive) {
      this.deps.voice.stopCamera();
      this.cameraActive = false;
    }
    if (this.screenShareActive) {
      this.deps.voice.stopScreenShare();
      this.screenShareActive = false;
    }
    
    // Clear remote video tiles
    const videoGrid = this.deps.elements['video-call-grid'];
    if (videoGrid) {
      videoGrid.querySelectorAll('.video-tile[data-peer-id]').forEach((el) => el.remove());
    }
    this.remoteVideoTracks.clear();
    this.remoteVideoStreams.clear();
    
    this.updateVideoButtons();
    this.updateLocalVideoPreview();
    this.renderVoiceUsers();
    this.updateVoiceVideoToolbar();
  }

  openActiveVideoPopout(): void {
    if (!this.deps.openVideoPopout) {
      this.deps.notifications.error('Video popout is not available in this build');
      return;
    }

    if (!this.deps.state.get('voiceConnected')) {
      this.deps.notifications.info('Join a voice channel to pop out video');
      return;
    }

    const selection = this.resolveVoicePopoutSelection();
    if (!selection) {
      this.deps.notifications.warning('No cameras or screen shares are active yet');
      return;
    }

    const popoutWindow = this.deps.openVideoPopout({
      stream: selection.primary.stream,
      label: selection.primary.label,
      pipStream: selection.pip?.stream ?? null,
      pipLabel: selection.pip?.label,
    });

    if (popoutWindow) {
      this.handlePopoutOpened(selection.primary.ownerId, selection.primary.type);
      
      let checkTimer: number | null = null;

      const cleanup = () => {
        this.handlePopoutClosed(selection.primary.ownerId, selection.primary.type);
        
        if (checkTimer !== null) {
          clearInterval(checkTimer);
          checkTimer = null;
        }

        try {
          if (typeof popoutWindow.removeEventListener === 'function') {
            popoutWindow.removeEventListener('beforeunload', cleanup);
            popoutWindow.removeEventListener('unload', cleanup);
          }
        } catch (e) { /* ignore */ }
      };
      
      // 1. Try Event Listeners (beforeunload AND unload for max compatibility)
      if (typeof popoutWindow.addEventListener === 'function') {
        popoutWindow.addEventListener('beforeunload', cleanup);
        popoutWindow.addEventListener('unload', cleanup);
      }

      // 2. Always use polling as a safety net (Electron proxies can be tricky)
      checkTimer = window.setInterval(() => {
        if (popoutWindow.closed) {
          cleanup();
        }
      }, 1000);
    }
  }

  private handlePopoutOpened(peerId: string, type: 'camera' | 'screen'): void {
    this.poppedOutStream = { peerId, type };
    if (peerId === 'local') {
      this.updateLocalVideoPreview();
    } else {
      this.hideRemoteVideoTile(peerId, type);
    }
    this.renderVoiceUsers();
  }

  private handlePopoutClosed(peerId: string, type: 'camera' | 'screen'): void {
    if (this.poppedOutStream?.peerId === peerId && this.poppedOutStream?.type === type) {
      this.poppedOutStream = null;
      if (peerId === 'local') {
        this.updateLocalVideoPreview();
      } else {
        const streams = this.remoteVideoStreams.get(peerId);
        if (streams && streams[type]) {
          this.createOrUpdateRemoteVideoTile(peerId, type, streams[type]!);
        }
      }
      this.renderVoiceUsers();
    }
  }

  private resolveVoicePopoutSelection(): { primary: VoicePopoutCandidate; pip?: VoicePopoutCandidate } | null {
    const candidates = this.collectVoicePopoutCandidates();
    if (candidates.length === 0) {
      return null;
    }

    const findCandidate = (predicate: (candidate: VoicePopoutCandidate) => boolean): VoicePopoutCandidate | undefined =>
      candidates.find(predicate);

    const primary =
      findCandidate((candidate) => candidate.type === 'screen' && !candidate.isLocal)
      ?? findCandidate((candidate) => candidate.type === 'screen' && candidate.isLocal)
      ?? findCandidate((candidate) => candidate.type === 'camera' && !candidate.isLocal)
      ?? findCandidate((candidate) => candidate.type === 'camera' && candidate.isLocal);

    if (!primary) {
      return null;
    }

    let pip: VoicePopoutCandidate | undefined;
    if (primary.type === 'screen') {
      pip = candidates.find((candidate) => candidate.ownerId === primary.ownerId && candidate.type === 'camera');
    }

    return { primary, pip };
  }

  private collectVoicePopoutCandidates(): VoicePopoutCandidate[] {
    const candidates: VoicePopoutCandidate[] = [];
    const account = this.deps.state.get('account');
    const selfBaseLabel = account?.displayName?.trim() || account?.username || 'You';
    const selfLabel = this.deps.resolveUserLabel(selfBaseLabel, 'You');

    const localCamera = this.deps.voice.getCameraStream();
    if (this.streamHasLiveTrack(localCamera)) {
      candidates.push({
        ownerId: 'local',
        stream: localCamera,
        label: `${selfLabel} • Camera`,
        type: 'camera',
        isLocal: true,
      });
    }

    const localScreen = this.deps.voice.getScreenStream();
    if (this.streamHasLiveTrack(localScreen)) {
      candidates.push({
        ownerId: 'local',
        stream: localScreen,
        label: `${selfLabel} • Screen`,
        type: 'screen',
        isLocal: true,
      });
    }

    for (const [peerId, streams] of this.remoteVideoStreams) {
      const fallback = peerId || 'Participant';
      const knownName = this.voiceUsers.get(peerId)?.name ?? null;
      const peerLabel = this.deps.resolveUserLabel(knownName, fallback) || fallback;

      if (this.streamHasLiveTrack(streams.screen)) {
        candidates.push({
          ownerId: peerId,
          stream: streams.screen,
          label: `${peerLabel} • Screen`,
          type: 'screen',
          isLocal: false,
        });
      }

      if (this.streamHasLiveTrack(streams.camera)) {
        candidates.push({
          ownerId: peerId,
          stream: streams.camera,
          label: `${peerLabel} • Camera`,
          type: 'camera',
          isLocal: false,
        });
      }
    }

    return candidates;
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

      // Prepare audio playback on user interaction (unlocks audio on mobile/desktop)
      this.deps.voice.prepareAudioPlayback();

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

    // Start connection quality monitoring
    this.deps.voice.startStatsMonitoring();

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

    this.emitDesktopVoiceState();
  }

  async handleVoicePeerJoin(data: VoicePeerEvent): Promise<void> {
    if (!this.shouldProcessRemoteVoiceEvent()) {
      if (import.meta.env.DEV) {
        console.warn('[VoiceController] Ignoring voice peer join while not connected');
      }
      return;
    }

    try {
      this.addVoiceUser(data);

      if (this.deps.voice.hasPeer(data.id)) {
        return;
      }

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
    if (!this.shouldProcessRemoteVoiceEvent()) {
      return;
    }

    this.removeRemoteVideoTile(data.id);
    this.removeVoiceUser(data.id);
    this.deps.voice.removePeer(data.id);
  }

  handleVoicePeerState(data: { id: string; muted: boolean; deafened: boolean }): void {
    if (!this.shouldProcessRemoteVoiceEvent()) {
      return;
    }

    const voiceUser = this.voiceUsers.get(data.id);
    if (!voiceUser) {
      return;
    }

    voiceUser.muted = data.muted;
    voiceUser.deafened = data.deafened;
    this.renderVoiceUsers();
  }

  private handleVoiceVideoState(data: { id: string; type: 'camera' | 'screen'; enabled: boolean }): void {
    if (!this.shouldProcessRemoteVoiceEvent()) {
      return;
    }

    if (this.setRemoteVideoState(data.id, data.type, data.enabled)) {
      this.renderVoiceUsers();
    }
  }

  // ========== Moderation Handlers ==========

  private handleKicked(data: { by: string; reason?: string }): void {
    // Force leave voice
    this.resetVoiceState({ playSound: true });
    this.deps.notifications.warning(data.reason || `You were kicked from voice by ${data.by}`);
  }

  private handleTimedOut(data: { by: string; duration: number; reason?: string }): void {
    // Force leave voice
    this.resetVoiceState({ playSound: true });
    const durationMinutes = Math.ceil(data.duration / 60000);
    this.deps.notifications.warning(data.reason || `You have been timed out from voice for ${durationMinutes} minute(s) by ${data.by}`);
  }

  private handleModeratorKick(targetSocketId: string, targetName: string): void {
    this.deps.socket.sendEvent('voice:kick', { targetSocketId, targetName });
  }

  private handleModeratorTimeout(targetSocketId: string, targetName: string, duration: number): void {
    this.deps.socket.sendEvent('voice:timeout', { targetSocketId, targetName, duration });
  }

  private handleModeratorBan(targetSocketId: string, targetName: string): void {
    // Show confirmation dialog
    const confirmed = confirm(`Are you sure you want to ban ${targetName} from the server? This action cannot be easily undone.`);
    if (confirmed) {
      this.deps.socket.sendEvent('user:ban', { targetSocketId, targetName, reason: 'Banned by moderator' });
    }
  }

  async handleVoiceSignal(data: { from: string; data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } }): Promise<void> {
    if (!this.shouldProcessRemoteVoiceEvent()) {
      if (import.meta.env.DEV) {
        console.warn('[VoiceController] Dropping voice signal while not connected');
      }
      return;
    }

    if (!this.voiceUsers.has(data.from)) {
      if (import.meta.env.DEV) {
        console.warn('[VoiceController] Dropping voice signal from unknown peer', data.from);
      }
      return;
    }

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
      this.deps.socket.on('voice:stream-metadata', (data) => {
        this.deps.voice.handleStreamMetadata(data as never);
      })
    );
    this.disposers.push(
      this.deps.socket.on('voice:state', (data) => {
        this.handleVoicePeerState(data as never);
      })
    );
    this.disposers.push(
      this.deps.socket.on('voice:video:state', (data) => {
        this.handleVoiceVideoState(data as never);
      })
    );

    // Moderation listeners
    this.disposers.push(
      this.deps.socket.on('voice:kicked', (data) => {
        this.handleKicked(data as { by: string; reason?: string });
      })
    );
    this.disposers.push(
      this.deps.socket.on('voice:timeout', (data) => {
        this.handleTimedOut(data as { by: string; duration: number; reason?: string });
      })
    );
    this.disposers.push(
      this.deps.socket.on('moderation:success', (data) => {
        const { action, target, message } = data as { action: string; target: string; message: string };
        this.deps.notifications.success(message || `${action}: ${target}`);
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
      this.deps.voice.on('voice:send-stream-metadata', (payload: unknown) => {
        const { to, metadata } = payload as { to: string; metadata: unknown };
        this.deps.socket.sendStreamMetadata(to, metadata);
      })
    );
    this.disposers.push(
      this.deps.voice.on('voice:speaking', (payload) => {
        const { id, speaking } = payload as { id: string; speaking: boolean };
        this.updateSpeakingIndicator(id, speaking);
      })
    );

    this.disposers.push(
      this.deps.voice.on('voice:stats', (payload) => {
        this.handleConnectionStats(payload as PeerConnectionStats);
      })
    );

    // Video event listeners
    this.disposers.push(
      this.deps.voice.on('video:remote:track', (payload) => {
        this.handleRemoteVideoTrack(payload as {
          peerId: string;
          streamType: 'camera' | 'screen';
          stream: MediaStream;
          track: MediaStreamTrack;
        });
      })
    );
    this.disposers.push(
      this.deps.voice.on('video:remote:track:removed', (payload) => {
        const { peerId, streamType } = payload as { peerId: string; streamType: 'camera' | 'screen' };
        this.removeRemoteVideoTile(peerId, streamType);
      })
    );

    this.disposers.push(
      this.deps.voice.on('video:camera:started', () => {
        this.cameraActive = true;
        this.updateVideoButtons();
        this.updateLocalVideoPreview();
        this.announceVideoState('camera', true);
        this.renderVoiceUsers();
      })
    );

    this.disposers.push(
      this.deps.voice.on('video:camera:stopped', () => {
        this.cameraActive = false;
        this.updateVideoButtons();
        this.updateLocalVideoPreview();
        this.announceVideoState('camera', false);
        this.renderVoiceUsers();
      })
    );

    this.disposers.push(
      this.deps.voice.on('video:screen:started', () => {
        this.screenShareActive = true;
        this.updateVideoButtons();
        this.updateLocalVideoPreview();
        this.announceVideoState('screen', true);
        this.renderVoiceUsers();
      })
    );

    this.disposers.push(
      this.deps.voice.on('video:screen:stopped', () => {
        this.screenShareActive = false;
        this.updateVideoButtons();
        this.updateLocalVideoPreview();
        this.announceVideoState('screen', false);
        this.renderVoiceUsers();
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
        this.updateVoiceVideoToolbar();
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
      cameraEnabled: existing?.cameraEnabled ?? false,
      screenEnabled: existing?.screenEnabled ?? false,
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
    const permissions = this.deps.getRolePermissions?.();
    const canModerate = Boolean(permissions?.canModerate);
    const canBan = Boolean(permissions?.canBanUsers);

    if (state.voiceConnected) {
      entries.push({
        id: 'me',
        name: currentUserLabel,
        muted: state.muted,
        deafened: state.deafened,
        speaking: this.localSpeaking,
        isCurrentUser: true,
        cameraEnabled: this.cameraActive,
        screenEnabled: this.screenShareActive,
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
        cameraEnabled: Boolean(user.cameraEnabled),
        screenEnabled: Boolean(user.screenEnabled),
        onLocalMuteToggle: (muted) => {
          this.deps.voice.setPeerMuted(id, muted);
        },
        onLocalVolumeChange: (volume) => {
          this.deps.voice.setPeerVolume(id, volume);
        },
        // Moderation props
        canModerate,
        moderationCallbacks: canModerate ? {
          onKick: (userId, userName) => this.handleModeratorKick(userId, userName),
          onTimeout: (userId, userName, duration) => this.handleModeratorTimeout(userId, userName, duration),
          onBan: canBan ? (userId, userName) => this.handleModeratorBan(userId, userName) : undefined,
        } : undefined,
      });
    }

    this.deps.voicePanel.render(entries, entries.length);

    if (entries.length > 0 || state.voiceConnected) {
      this.deps.voicePanel.show();
    } else {
      this.deps.voicePanel.hide();
    }

    this.renderGrid(entries, state.voiceConnected);
  }

  private renderGrid(entries: VoicePanelEntry[], voiceConnected: boolean): void {
    const gallery = this.deps.elements['video-call-grid'];
    const stage = this.deps.elements['voice-call-stage'] ?? null;
    const debugToolbar = this.deps.elements['voiceDebugToolbar'] ?? null;
    if (!gallery) {
      return;
    }

    this.updateVoiceVideoToolbar();

    const activeChannelType = this.deps.state.get('currentChannelType');
    const isVoiceChannelActive = activeChannelType === 'voice';

    if (!isVoiceChannelActive) {
      this.applyVoiceStageVisibility({
        show: false,
        stage,
        gallery,
        debugToolbar,
        enableMobileStreamMode: false,
      });
      gallery.replaceChildren();
      this.stopDebugUpdates();
      return;
    }

    const mainContent = document.querySelector('.main-content');
    const isVoiceMode = mainContent?.classList.contains('voice-mode');

    if (!isVoiceMode) {
      this.applyVoiceStageVisibility({
        show: false,
        stage,
        gallery,
        debugToolbar,
        enableMobileStreamMode: false,
      });
      this.stopDebugUpdates();
      return;
    }

    this.applyVoiceStageVisibility({
      show: true,
      stage,
      gallery,
      debugToolbar,
      enableMobileStreamMode: true,
      showDebugToolbar: voiceConnected,
    });

    if (this.pendingVoiceJoin && entries.length === 0) {
      // Loading state...
      return;
    }

    // Update grid layout count
    gallery.dataset.count = String(entries.length);

    const existingTiles = new Map<string, HTMLElement>();
    gallery.querySelectorAll('.voice-user-card').forEach((el) => {
      if (el instanceof HTMLElement && el.dataset.userId) {
        existingTiles.set(el.dataset.userId, el);
      }
    });

    const fragment = document.createDocumentFragment();
    entries.forEach((entry) => {
      let tile = existingTiles.get(entry.id);
      if (tile) {
        this.updateVoiceGalleryTile(tile, entry);
        existingTiles.delete(entry.id);
      } else {
        tile = this.createVoiceGalleryTile(entry);
      }
      fragment.appendChild(tile);
    });

    // Remove stale tiles
    existingTiles.forEach((tile) => tile.remove());

    gallery.appendChild(fragment);
  }

  private applyVoiceStageVisibility(params: {
    show: boolean;
    stage: HTMLElement | null;
    gallery: HTMLElement;
    debugToolbar: HTMLElement | null;
    enableMobileStreamMode: boolean;
    showDebugToolbar?: boolean;
  }): void {
    const { show, stage, gallery, debugToolbar, enableMobileStreamMode, showDebugToolbar = false } = params;

    document.body.classList.toggle('mobile-stream-mode', enableMobileStreamMode);
    stage?.classList.toggle('hidden', !show);
    stage?.setAttribute('aria-hidden', show ? 'false' : 'true');
    gallery.classList.toggle('hidden', !show);
    debugToolbar?.classList.toggle('hidden', !show || !showDebugToolbar);
  }

  private updateVoiceGalleryTile(tile: HTMLElement, entry: VoicePanelEntry): void {
    tile.dataset.userId = entry.id;
    tile.dataset.muted = String(Boolean(entry.muted));
    tile.dataset.deafened = String(Boolean(entry.deafened));
    tile.dataset.currentUser = entry.isCurrentUser ? 'true' : 'false';
    const displayName = (entry.name ?? '').trim() || 'Participant';
    tile.dataset.displayName = entry.isCurrentUser ? `${displayName} (You)` : displayName;
    tile.dataset.camera = entry.cameraEnabled ? 'true' : 'false';
    tile.dataset.screen = entry.screenEnabled ? 'true' : 'false';

    const nameEl = tile.querySelector('.user-name');
    if (nameEl) {
      nameEl.textContent = entry.isCurrentUser ? `${displayName} (You)` : displayName;
    }

    const avatar = tile.querySelector('.avatar-container');
    if (avatar) {
      const existingMainVideo = avatar.querySelector('video.main-video') as HTMLVideoElement | null;
      const existingPipVideo = avatar.querySelector('video.pip-video') as HTMLVideoElement | null;
      const existingImg = avatar.querySelector('img');
      
      // Determine streams
      let mainStream: MediaStream | null = null;
      let pipStream: MediaStream | null = null;

      if (entry.isCurrentUser) {
        const camera = this.deps.voice.getCameraStream();
        const screen = this.deps.voice.getScreenStream();
        
        if (entry.screenEnabled && screen) {
          mainStream = screen;
          if (entry.cameraEnabled && camera) {
            pipStream = camera;
          }
        } else if (entry.cameraEnabled && camera) {
          mainStream = camera;
        }
      } else {
        // Remote user
        const streams = this.remoteVideoStreams.get(entry.id);
        if (streams) {
          if (streams.screen) {
            mainStream = streams.screen;
            if (streams.camera) {
              pipStream = streams.camera;
            }
          } else if (streams.camera) {
            mainStream = streams.camera;
          }
        }
      }

      const isPoppedOut = this.poppedOutStream?.peerId === (entry.isCurrentUser ? 'local' : entry.id);
      
      // Handle Main Video
      if (mainStream && !isPoppedOut) {
        if (existingImg) existingImg.remove();
        
        let video = existingMainVideo;
        if (!video) {
          video = document.createElement('video');
          video.className = 'voice-gallery-video main-video';
          video.autoplay = true;
          video.muted = true;
          video.playsInline = true;
          video.style.width = '100%';
          video.style.height = '100%';
          video.style.objectFit = 'cover';
          video.style.borderRadius = 'inherit';
          avatar.prepend(video);
        }
        
        if (video.srcObject !== mainStream) {
          video.srcObject = mainStream;
          video.play().catch((e) => console.warn('Gallery main video play failed', e));
        }
      } else {
        if (existingMainVideo) existingMainVideo.remove();
        
        // Show avatar if no main video
        if (!existingImg) {
          const avatarImg = document.createElement('img');
          const avatarSeed = entry.name || entry.id || 'participant';
          avatarImg.src = generateIdenticonDataUri(avatarSeed, { size: 160, label: entry.name ?? avatarSeed });
          avatarImg.alt = `${entry.name ?? 'Participant'} avatar`;
          avatarImg.decoding = 'async';
          avatarImg.loading = 'lazy';
          avatarImg.draggable = false;
          avatar.prepend(avatarImg);
        }
      }

      // Handle PiP Video
      if (pipStream && !isPoppedOut) {
        let video = existingPipVideo;
        if (!video) {
          video = document.createElement('video');
          video.className = 'voice-gallery-video pip-video';
          video.autoplay = true;
          video.muted = true;
          video.playsInline = true;
          
          // PiP Styles
          video.style.position = 'absolute';
          video.style.bottom = '12px';
          video.style.right = '12px';
          video.style.width = '25%';
          video.style.minWidth = '80px';
          video.style.aspectRatio = '16/9';
          video.style.objectFit = 'cover';
          video.style.borderRadius = '8px';
          video.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';
          video.style.border = '2px solid rgba(255,255,255,0.1)';
          video.style.zIndex = '5';
          
          avatar.appendChild(video);
        }
        
        if (video.srcObject !== pipStream) {
          video.srcObject = pipStream;
          video.play().catch((e) => console.warn('Gallery pip video play failed', e));
        }
      } else {
        if (existingPipVideo) existingPipVideo.remove();
      }
    }

    this.refreshVoiceGalleryTile(tile, Boolean(entry.speaking));
  }

  private createVoiceGalleryTile(entry: VoicePanelEntry): HTMLElement {
    const tile = document.createElement('article');
    tile.className = 'voice-user-card voice-gallery-item';
    tile.setAttribute('role', 'listitem');
    
    const avatar = document.createElement('div');
    avatar.className = 'avatar-container';
    
    // Status indicator can be added here if needed
    // const status = document.createElement('span');
    // status.className = 'voice-gallery-status';
    // avatar.appendChild(status);
    
    tile.appendChild(avatar);

    const name = document.createElement('p');
    name.className = 'user-name';
    tile.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'voice-gallery-meta';
    tile.appendChild(meta);

    const debugOverlay = document.createElement('div');
    debugOverlay.className = 'voice-debug-overlay';
    debugOverlay.style.display = this.debugMode ? 'block' : 'none';
    tile.appendChild(debugOverlay);

    this.updateVoiceGalleryTile(tile, entry);

    return tile;
  }

  private refreshVoiceGalleryTile(tile: HTMLElement, speaking: boolean): void {
    tile.classList.toggle('speaking', speaking);
    tile.dataset.speaking = String(speaking);

    const muted = tile.dataset.muted === 'true';
    const deafened = tile.dataset.deafened === 'true';
    const isCurrentUser = tile.dataset.currentUser === 'true';
    const cameraEnabled = tile.dataset.camera === 'true';
    const screenEnabled = tile.dataset.screen === 'true';

    const statusEl = tile.querySelector('.voice-gallery-status') as HTMLElement | null;
    this.updateVoiceGalleryStatus(statusEl, { muted, deafened, speaking, isCurrentUser });

  const metaEl = tile.querySelector('.voice-gallery-meta') as HTMLElement | null;
    if (metaEl) {
      this.populateVoiceGalleryMeta(metaEl, { muted, deafened, speaking, cameraEnabled, screenEnabled });
    }

    // Manage "Watch Stream" button
    let watchBtn = tile.querySelector('.voice-gallery-watch-btn') as HTMLButtonElement | null;
    if (screenEnabled && !isCurrentUser) {
      if (!watchBtn) {
        watchBtn = document.createElement('button');
        watchBtn.className = 'voice-gallery-watch-btn mt-2 px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs rounded-full transition-colors z-10 relative';
        watchBtn.textContent = 'Watch Stream';
        watchBtn.onclick = (e) => {
          e.stopPropagation();
          const userId = tile.dataset.userId;
          if (userId) this.watchUserStream(userId);
        };
        tile.appendChild(watchBtn);
      }
    } else if (watchBtn) {
      watchBtn.remove();
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

  private watchUserStream(userId: string): void {
    const streams = this.remoteVideoStreams.get(userId);
    if (streams?.screen) {
      const popoutWindow = this.deps.openVideoPopout?.({
        stream: streams.screen,
        label: `${this.voiceUsers.get(userId)?.name ?? 'User'}'s Screen`,
        pipStream: streams.camera,
        pipLabel: this.voiceUsers.get(userId)?.name
      });

      if (popoutWindow) {
        this.handlePopoutOpened(userId, 'screen');
        
        let checkTimer: number | null = null;

        const cleanup = () => {
          this.handlePopoutClosed(userId, 'screen');
          
          if (checkTimer !== null) {
            clearInterval(checkTimer);
            checkTimer = null;
          }

          try {
            if (typeof popoutWindow.removeEventListener === 'function') {
              popoutWindow.removeEventListener('beforeunload', cleanup);
              popoutWindow.removeEventListener('unload', cleanup);
            }
          } catch (e) { /* ignore */ }
        };
        
        // 1. Try Event Listeners
        if (typeof popoutWindow.addEventListener === 'function') {
          popoutWindow.addEventListener('beforeunload', cleanup);
          popoutWindow.addEventListener('unload', cleanup);
        }

        // 2. Always use polling as a safety net
        checkTimer = window.setInterval(() => {
          if (popoutWindow.closed) {
            cleanup();
          }
        }, 1000);
      }
    } else {
      this.deps.notifications.warning('Stream not available yet');
    }
  }

  private populateVoiceGalleryMeta(
    metaEl: HTMLElement,
    state: { muted: boolean; deafened: boolean; speaking: boolean; cameraEnabled?: boolean; screenEnabled?: boolean }
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

    if (state.screenEnabled) {
      descriptors.push('Sharing Screen');
    } else if (state.cameraEnabled) {
      descriptors.push('Camera On');
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
    const gallery = this.deps.elements['video-call-grid'];
    if (!gallery) {
      return null;
    }

    const safeId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(userId) : userId.replace(/"/g, '\\"');
    return gallery.querySelector<HTMLElement>(`.voice-gallery-item[data-user-id="${safeId}"]`);
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
    this.emitDesktopVoiceState();
  }

  private emitDesktopVoiceState(): void {
    if (!this.desktopAPI?.updateVoiceActivity) {
      return;
    }

    const state = this.deps.state.getState();
    this.desktopAPI.updateVoiceActivity({
      connected: state.voiceConnected,
      speaking: Boolean(state.voiceConnected && this.localSpeaking && !state.muted && !state.deafened),
      muted: Boolean(state.muted || state.deafened),
    });
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
    this.deps.voicePanel.updateSessionTimer(formatted, title);
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

  private handleConnectionStats(_stats: PeerConnectionStats): void {
    const overallQuality = this.deps.voice.getOverallConnectionQuality();
    
    // Update connection quality indicator in UI
    this.updateConnectionQualityIndicator(overallQuality);
    
    // Warn user if connection quality degrades significantly
    if (overallQuality === 'poor' && this.lastConnectionQuality !== 'poor' && !this.connectionQualityWarningShown) {
      this.connectionQualityWarningShown = true;
      this.deps.notifications.warning('Voice connection quality is poor. Audio may be choppy.');
    } else if (overallQuality !== 'poor' && overallQuality !== 'unknown') {
      this.connectionQualityWarningShown = false;
    }
    
    this.lastConnectionQuality = overallQuality;
  }

  private updateConnectionQualityIndicator(quality: ConnectionQuality): void {
    const indicator = this.deps.elements['voice-quality-indicator'] as HTMLElement | null;
    if (!indicator) {
      return;
    }

    indicator.classList.remove('quality-excellent', 'quality-good', 'quality-fair', 'quality-poor', 'quality-unknown');
    indicator.classList.add(`quality-${quality}`);
    
    const qualityLabels: Record<ConnectionQuality, string> = {
      excellent: 'Excellent',
      good: 'Good',
      fair: 'Fair',
      poor: 'Poor',
      unknown: 'Checking...',
    };
    
    // SVG signal bars - varying heights based on quality
    const createSignalBars = (bars: number): string => {
      // bars: 0-4 representing signal strength
      const barHeights = [4, 7, 10, 13]; // Heights for each bar
      const barWidth = 3;
      const gap = 2;
      const totalWidth = barHeights.length * barWidth + (barHeights.length - 1) * gap;
      const maxHeight = 14;
      
      let svg = `<svg width="${totalWidth}" height="${maxHeight}" viewBox="0 0 ${totalWidth} ${maxHeight}" fill="currentColor">`;
      barHeights.forEach((height, i) => {
        const x = i * (barWidth + gap);
        const y = maxHeight - height;
        const opacity = i < bars ? 1 : 0.25;
        svg += `<rect x="${x}" y="${y}" width="${barWidth}" height="${height}" rx="1" opacity="${opacity}"/>`;
      });
      svg += '</svg>';
      return svg;
    };
    
    const signalBars: Record<ConnectionQuality, number> = {
      excellent: 4,
      good: 3,
      fair: 2,
      poor: 1,
      unknown: 0,
    };
    
    indicator.innerHTML = createSignalBars(signalBars[quality]);
    indicator.title = `Connection quality: ${qualityLabels[quality]}`;
    indicator.setAttribute('aria-label', `Voice connection quality: ${qualityLabels[quality]}`);
  }

  private resetVoiceState(options: { playSound?: boolean; notify?: string | null } = {}): void {
    const { playSound = false, notify = null } = options;

    if (playSound) {
      this.deps.soundFX.play('disconnect', 0.7);
    }

    this.clearVoiceJoinTimeout();
    this.clearVoiceSessionTimer();
    this.clearVoiceChannelTimer();
    
    // Reset connection quality tracking
    this.connectionQualityWarningShown = false;
    this.lastConnectionQuality = 'unknown';

    // Stop all video streams
    this.stopAllVideo();

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
    this.updateVideoButtons();

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

    this.emitDesktopVoiceState();
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

      const muteLabel = muteBtn.querySelector('.voice-toggle-label');
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

      const labelEl = deafenBtn.querySelector('.voice-toggle-label');
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

      const comboLabel = comboBtn.querySelector('.voice-toggle-label');
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

  private shouldProcessRemoteVoiceEvent(): boolean {
    return Boolean(this.deps.state.get('voiceConnected'));
  }

  // ============== Debug Mode ==============

  toggleDebugMode(): void {
    this.debugMode = !this.debugMode;
    this.updateDebugModeUI();
    
    if (this.debugMode) {
      this.startDebugUpdates();
    } else {
      this.stopDebugUpdates();
    }
  }

  private updateDebugModeUI(): void {
    const gallery = this.deps.elements['video-call-grid'];
    if (!gallery) return;

    // Update debug toggle button state
    const debugBtn = gallery.parentElement?.querySelector('.voice-debug-toggle') as HTMLButtonElement | null;
    if (debugBtn) {
      debugBtn.classList.toggle('active', this.debugMode);
      debugBtn.setAttribute('aria-pressed', String(this.debugMode));
      debugBtn.title = this.debugMode ? 'Hide Debug Info' : 'Show Debug Info';
    }

    // Toggle debug overlays on all tiles
    const overlays = gallery.querySelectorAll('.voice-debug-overlay');
    overlays.forEach((overlay) => {
      (overlay as HTMLElement).style.display = this.debugMode ? 'block' : 'none';
    });

    if (this.debugMode) {
      this.updateAllDebugOverlays();
    }
  }

  private startDebugUpdates(): void {
    this.stopDebugUpdates();
    this.debugUpdateHandle = window.setInterval(() => {
      if (this.debugMode) {
        this.updateAllDebugOverlays();
      }
    }, 1000);
  }

  private stopDebugUpdates(): void {
    if (this.debugUpdateHandle !== null) {
      window.clearInterval(this.debugUpdateHandle);
      this.debugUpdateHandle = null;
    }
  }

  private updateAllDebugOverlays(): void {
    const gallery = this.deps.elements['video-call-grid'];
    if (!gallery) return;

    const tiles = gallery.querySelectorAll('.voice-gallery-item');
    tiles.forEach((tile) => {
      const userId = (tile as HTMLElement).dataset.userId;
      if (userId) {
        this.updateDebugOverlay(tile as HTMLElement, userId);
      }
    });
  }

  private updateDebugOverlay(tile: HTMLElement, peerId: string): void {
    const overlay = tile.querySelector('.voice-debug-overlay') as HTMLElement | null;
    if (!overlay) return;

    const isCurrentUser = tile.dataset.currentUser === 'true';
    
    if (isCurrentUser) {
      // Local user debug info
      overlay.innerHTML = this.getLocalDebugInfo();
    } else {
      // Remote peer debug info
      const stats = this.deps.voice.getPeerStats(peerId);
      overlay.innerHTML = this.getPeerDebugInfo(peerId, stats);
    }
  }

  /**
   * Calculate Mean Opinion Score (MOS) based on E-model simplified formula
   * Based on ITU-T G.107 E-model approximation
   * Returns a value between 1 (bad) and 5 (excellent)
   */
  private calculateMOS(rttMs: number | null, packetLossPct: number | null, jitterMs: number | null): number {
    // Default R-factor base (assumes codec like Opus)
    const R0 = 93.2;
    
    // Delay impairment (Id) - based on one-way delay (RTT/2)
    const oneWayDelay = (rttMs ?? 0) / 2;
    const Id = oneWayDelay > 177.3 
      ? 0.024 * oneWayDelay + 0.11 * (oneWayDelay - 177.3) 
      : 0.024 * oneWayDelay;
    
    // Effective equipment impairment (Ie-eff) - packet loss impact
    // Opus codec is more resilient, so lower impact
    const loss = packetLossPct ?? 0;
    const Ie_eff = 0 + 30 * Math.log(1 + 15 * loss);
    
    // Jitter buffer impact (approximation)
    const jitterImpact = Math.min((jitterMs ?? 0) * 0.1, 10);
    
    // R-factor calculation
    const R = Math.max(0, Math.min(100, R0 - Id - Ie_eff - jitterImpact));
    
    // Convert R to MOS using ITU-T formula
    if (R < 0) return 1;
    if (R > 100) return 4.5;
    
    const MOS = 1 + 0.035 * R + R * (R - 60) * (100 - R) * 7e-6;
    return Math.max(1, Math.min(5, MOS));
  }

  /**
   * Format MOS score with quality descriptor
   */
  private formatMOS(mos: number): { value: string; label: string; cssClass: string } {
    const value = mos.toFixed(2);
    if (mos >= 4.3) return { value, label: 'Excellent', cssClass: 'debug-excellent' };
    if (mos >= 4.0) return { value, label: 'Good', cssClass: 'debug-good' };
    if (mos >= 3.6) return { value, label: 'Fair', cssClass: 'debug-fair' };
    if (mos >= 3.1) return { value, label: 'Poor', cssClass: 'debug-poor' };
    return { value, label: 'Bad', cssClass: 'debug-critical' };
  }

  /**
   * Calculate effective bandwidth utilization
   */
  private calculateBandwidthEfficiency(bitrate: number | null, packetLoss: number | null): number {
    if (bitrate === null || bitrate <= 0) return 0;
    const lossMultiplier = 1 - (packetLoss ?? 0) / 100;
    return Math.max(0, lossMultiplier * 100);
  }

  private getLocalDebugInfo(): string {
    const voiceConnected = this.deps.state.get('voiceConnected');
    const muted = this.deps.state.get('muted');
    const deafened = this.deps.state.get('deafened');
    const peerCount = this.voiceUsers.size;
    const quality = this.deps.voice.getOverallConnectionQuality();
    const uptime = this.voiceSessionStart ? Math.floor((Date.now() - this.voiceSessionStart) / 1000) : 0;
    
    // Gather aggregate stats from all peers
    let avgRtt = 0, avgLoss = 0, avgJitter = 0, totalBitrate = 0, statCount = 0;
    this.voiceUsers.forEach((_, oderId) => {
      const stats = this.deps.voice.getPeerStats(oderId);
      if (stats) {
        if (stats.roundTripTime !== null) avgRtt += stats.roundTripTime;
        if (stats.packetLoss !== null) avgLoss += stats.packetLoss;
        if (stats.jitter !== null) avgJitter += stats.jitter;
        if (stats.bitrate !== null) totalBitrate += stats.bitrate;
        statCount++;
      }
    });
    
    if (statCount > 0) {
      avgRtt /= statCount;
      avgLoss /= statCount;
      avgJitter /= statCount;
    }

    const mos = this.calculateMOS(avgRtt, avgLoss, avgJitter);
    const mosInfo = this.formatMOS(mos);
    
    const stateIcon = voiceConnected ? '●' : '○';
    const stateClass = voiceConnected ? 'debug-good' : 'debug-critical';
    
    return `
      <div class="debug-header">
        <span class="debug-title">LOCAL ENDPOINT</span>
        <span class="debug-badge ${stateClass}">${stateIcon} ${voiceConnected ? 'LIVE' : 'OFFLINE'}</span>
      </div>
      <div class="debug-section">
        <div class="debug-row">
          <span class="debug-key">Session</span>
          <span class="debug-value">${this.formatDurationCompact(uptime)}</span>
        </div>
        <div class="debug-row">
          <span class="debug-key">Peers</span>
          <span class="debug-value">${peerCount} connected</span>
        </div>
        <div class="debug-row">
          <span class="debug-key">Audio</span>
          <span class="debug-value">${muted ? '🔇 Muted' : '🔊 Active'}${deafened ? ' · Deaf' : ''}</span>
        </div>
        <div class="debug-row">
          <span class="debug-key">Media</span>
          <span class="debug-value">${this.cameraActive ? '📹' : ''}${this.screenShareActive ? '🖥️' : ''}${!this.cameraActive && !this.screenShareActive ? '—' : ''}</span>
        </div>
      </div>
      ${statCount > 0 ? `
      <div class="debug-section debug-metrics">
        <div class="debug-metric">
          <span class="debug-metric-value ${mosInfo.cssClass}">${mosInfo.value}</span>
          <span class="debug-metric-label">MOS</span>
        </div>
        <div class="debug-metric">
          <span class="debug-metric-value">${Math.round(avgRtt)}ms</span>
          <span class="debug-metric-label">Avg RTT</span>
        </div>
        <div class="debug-metric">
          <span class="debug-metric-value">${this.formatBitrate(totalBitrate)}</span>
          <span class="debug-metric-label">↓ Total</span>
        </div>
      </div>
      ` : ''}
      <div class="debug-footer">
        <span class="debug-quality-bar">
          <span class="debug-quality-fill" style="width: ${this.qualityToPercent(quality)}%"></span>
        </span>
        <span class="debug-quality-label">${quality.toUpperCase()}</span>
      </div>
    `;
  }

  private getPeerDebugInfo(peerId: string, stats: PeerConnectionStats | null): string {
    const shortId = peerId.slice(0, 8);
    
    if (!stats) {
      return `
        <div class="debug-header">
          <span class="debug-title">PEER ${shortId}</span>
          <span class="debug-badge debug-muted">NO DATA</span>
        </div>
        <div class="debug-section">
          <span class="debug-empty">Awaiting statistics...</span>
        </div>
      `;
    }

    const rttMs = stats.roundTripTime ?? 0;
    const lossPercent = stats.packetLoss ?? 0;
    const jitterMs = stats.jitter ?? 0;
    const bitrate = stats.bitrate ?? 0;
    
    const mos = this.calculateMOS(rttMs, lossPercent, jitterMs);
    const mosInfo = this.formatMOS(mos);
    const efficiency = this.calculateBandwidthEfficiency(bitrate, lossPercent);
    
    // Determine health indicators
    const rttHealth = this.getMetricHealth(rttMs, [50, 100, 200]);
    const lossHealth = this.getMetricHealth(lossPercent, [1, 3, 8]);
    const jitterHealth = this.getMetricHealth(jitterMs, [20, 50, 100]);

    return `
      <div class="debug-header">
        <span class="debug-title">PEER ${shortId}</span>
        <span class="debug-badge ${mosInfo.cssClass}">${mosInfo.label.toUpperCase()}</span>
      </div>
      <div class="debug-section debug-metrics">
        <div class="debug-metric debug-metric-large">
          <span class="debug-metric-value ${mosInfo.cssClass}">${mosInfo.value}</span>
          <span class="debug-metric-label">MOS Score</span>
        </div>
      </div>
      <div class="debug-section">
        <div class="debug-row">
          <span class="debug-key">RTT (Latency)</span>
          <span class="debug-value ${rttHealth.cssClass}">${Math.round(rttMs)} ms ${rttHealth.icon}</span>
        </div>
        <div class="debug-row">
          <span class="debug-key">Packet Loss</span>
          <span class="debug-value ${lossHealth.cssClass}">${lossPercent.toFixed(2)}% ${lossHealth.icon}</span>
        </div>
        <div class="debug-row">
          <span class="debug-key">Jitter</span>
          <span class="debug-value ${jitterHealth.cssClass}">${jitterMs.toFixed(1)} ms ${jitterHealth.icon}</span>
        </div>
        <div class="debug-row">
          <span class="debug-key">Bitrate</span>
          <span class="debug-value">${this.formatBitrate(bitrate)}</span>
        </div>
        <div class="debug-row">
          <span class="debug-key">Efficiency</span>
          <span class="debug-value">${efficiency.toFixed(1)}%</span>
        </div>
      </div>
      <div class="debug-footer">
        <span class="debug-quality-bar">
          <span class="debug-quality-fill" style="width: ${this.qualityToPercent(stats.quality)}%"></span>
        </span>
        <span class="debug-ts">${this.formatTimestamp(stats.timestamp)}</span>
      </div>
    `;
  }

  private getMetricHealth(value: number, thresholds: [number, number, number]): { icon: string; cssClass: string } {
    if (value <= thresholds[0]) return { icon: '✓', cssClass: 'debug-excellent' };
    if (value <= thresholds[1]) return { icon: '●', cssClass: 'debug-good' };
    if (value <= thresholds[2]) return { icon: '▲', cssClass: 'debug-fair' };
    return { icon: '✗', cssClass: 'debug-critical' };
  }

  private formatBitrate(bps: number): string {
    if (bps <= 0) return '—';
    if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
    if (bps >= 1_000) return `${(bps / 1_000).toFixed(0)} kbps`;
    return `${Math.round(bps)} bps`;
  }

  private formatDurationCompact(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins < 60) return `${mins}m ${secs}s`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
  }

  private formatTimestamp(ts: number): string {
    const date = new Date(ts);
    return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  private qualityToPercent(quality: ConnectionQuality): number {
    const map: Record<ConnectionQuality, number> = {
      excellent: 100,
      good: 75,
      fair: 50,
      poor: 25,
      unknown: 0,
    };
    return map[quality];
  }

  createDebugToggleButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'voice-debug-toggle';
    btn.type = 'button';
    btn.setAttribute('aria-pressed', 'false');
    btn.title = 'Show Debug Info';
    btn.innerHTML = `<span class="icon">🔧</span><span class="label">Debug</span>`;
    btn.addEventListener('click', () => this.toggleDebugMode());
    return btn;
  }
}
