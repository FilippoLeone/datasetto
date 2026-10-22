import { batch, effect, signal } from '@preact/signals';
import { api } from '@/services/socket/api';
import { socketClient } from '@/services/socket/client';
import { serverConfig } from '@/services/ServerConfigService';
import { applyScreenEncoding, applyScreenQualityToStream, captureScreen, isCancelError, screenAudioNotice } from '@/services/screenCapture';
import { dtlsFingerprint } from '@/services/voice/VoiceService';
import { screenshareSessions, setScreenshareSession } from '@/state/misc';
import { account, socketId } from '@/state/session';
import { audioSettings } from '@/state/settings';
import { toast } from '@/state/ui';
import type {
  HeldPeerConnection,
  ScreenshareReplacedEvent,
  ScreenshareSessionEvent,
  ScreenshareSignalEvent,
  ScreenshareViewerPendingEvent,
  ScreenshareViewerSeatedEvent,
  ServerError,
} from '@/types/protocol';
import { reconcilePeers, type KnownPeer, type PeerHealth } from '@/features/voice/peerReconcile';
import { initialShareState, isSharePending, reduceShare, type ShareEffect, type ShareEvent, type ShareState } from './screenshareRejoin';

type Role = 'idle' | 'host' | 'viewer';

/** Local screenshare-room state. */
export const screenshareRole = signal<Role>('idle');
export const screenshareChannel = signal<string | null>(null);
/** The stream being shown: our own capture when hosting, the host's when viewing. */
export const screenshareStream = signal<MediaStream | null>(null);
export const screenshareStatus = signal<string>('');

/** How often the rejoin clock runs while the room is held together. */
const TICK_MS = 5_000;

const newRtcSessionId = (): string => {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return 'share-' + random;
};

interface PeerEntry {
  /** The remote socket id; changes when they reconnect (rekey). Callbacks read it live. */
  id: string;
  pc: RTCPeerConnection;
  accountId: string | null;
  rtcSessionId: string | null;
  receive: boolean;
}

/**
 * One presenter streams their screen to any number of viewers through direct
 * WebRTC connections (one peer connection per viewer on the host).
 *
 * The socket going away does not end the room: the capture and the peer
 * connections stay (the media never went through the server), the state machine
 * in screenshareRejoin.ts decides when to tell the server "I am still presenting"
 * or "still watching", and the server's answers (`viewer:pending` for the host,
 * `viewer:seated` / `session` for a viewer) are reconciled with the connections
 * still held: same person, same media session, still holding ours → keep, moved
 * to the new socket id; otherwise negotiate afresh.
 */
class ScreenshareService {
  private peers = new Map<string, PeerEntry>();
  private candidateQueue = new Map<string, RTCIceCandidateInit[]>();
  private localStream: MediaStream | null = null;
  private initialized = false;
  /** Our media session id: peers keep their connection to us while it does not change. */
  private rtcSessionId: string | null = null;
  private share: ShareState = initialShareState;
  private tickTimer: number | null = null;
  /** The clip permission the room was last told about while hosting (null when not hosting). */
  private sentAllowClips: boolean | null = null;
  /** The server confirmed our host seat (a `screenshare:update` before that is refused as NOT_HOST). */
  private hostConfirmed = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    socketClient.on<ScreenshareSessionEvent>('screenshare:session', (session) => this.onSession(session));
    socketClient.on<ScreenshareSignalEvent>('screenshare:signal', (payload) => void this.onSignal(payload));
    socketClient.on<ScreenshareViewerPendingEvent>('screenshare:viewer:pending', (payload) => void this.onViewerPending(payload));
    socketClient.on<ScreenshareViewerSeatedEvent>('screenshare:viewer:seated', (payload) => this.onSeated(payload));
    socketClient.on<ScreenshareReplacedEvent>('screenshare:replaced', (payload) => this.onReplaced(payload));
    socketClient.on<ServerError>('screenshare:error', (payload) => this.onError(payload));
    socketClient.on('disconnect', () => this.onSocketLost());
    socketClient.on('auth:success', () => this.dispatch({ type: 'authenticated', at: Date.now() }));
    // A preset change while hosting applies to the running capture and every viewer.
    effect(() => {
      const quality = audioSettings.value.screenQuality;
      if (screenshareRole.value !== 'host' || !this.localStream) return;
      applyScreenQualityToStream(this.localStream, quality);
      for (const entry of this.peers.values()) this.applyEncoding(entry.pc);
    });
    // Changing "let viewers clip" while hosting tells the room; the start itself carries the flag.
    effect(() => {
      void audioSettings.value.shareClipsAllowed;
      void screenshareRole.value;
      void screenshareChannel.value;
      this.syncAllowClips();
    });
  }

  // ------------------------------------------------------------------ host

  async startHosting(channelId: string): Promise<void> {
    if (screenshareRole.value === 'host') return;
    if (screenshareRole.value === 'viewer') this.stopViewing();
    try {
      const capture = await captureScreen(audioSettings.value.screenQuality);
      const stream = capture.stream;
      this.localStream = stream;
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (screenshareRole.value === 'host') this.stopHosting();
      });
      this.rtcSessionId = newRtcSessionId();
      batch(() => {
        screenshareRole.value = 'host';
        screenshareChannel.value = channelId;
        screenshareStream.value = stream;
        screenshareStatus.value = !capture.hasAudio
          ? 'Sharing your screen without sound'
          : capture.ownAudio === 'included'
            ? "Sharing your screen with sound (Datasetto's own sound is in it too)"
            : 'Sharing your screen with sound';
      });
      this.dispatch({ type: 'started', role: 'host', channelId });
      this.hostConfirmed = false;
      this.sentAllowClips = audioSettings.value.shareClipsAllowed;
      api.startScreenshare(channelId, this.rtcSessionId, [], this.sentAllowClips);
      const audioNotice = screenAudioNotice(capture);
      if (audioNotice) toast.warning(audioNotice, 9000);
    } catch (error) {
      if (!isCancelError(error)) toast.error(error instanceof Error ? error.message : 'Could not capture the screen');
      this.localStream?.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
  }

  stopHosting(): void {
    if (screenshareRole.value !== 'host') return;
    const channelId = screenshareChannel.value;
    if (channelId && socketClient.connected) api.stopScreenshare(channelId);
    this.teardown();
  }

  /**
   * A viewer took a seat, or is back on a new socket. Their connection to us
   * survives when they say so and nothing broke; otherwise they get a fresh offer.
   */
  private async onViewerPending(event: ScreenshareViewerPendingEvent): Promise<void> {
    if (screenshareRole.value !== 'host' || screenshareChannel.value !== event.channelId || !this.localStream) return;
    const [action] = reconcilePeers(
      this.knownPeers(),
      [{ id: event.viewerId, accountId: event.viewerAccountId ?? '', rtcSessionId: event.rtcSessionId ?? null, holding: event.holding }],
      { accountId: account.value?.id ?? null, rtcSessionId: this.rtcSessionId },
      { partial: true },
    );
    if (!action) return;
    if (action.action === 'keep') {
      if (this.peerHealth(action.id) === 'broken') void this.restartIce(action.id);
      return;
    }
    if (action.action === 'rekey') {
      this.rekeyPeer(action.from, action.to);
      if (action.restartIce) void this.restartIce(action.to);
      return;
    }
    if (action.action !== 'rebuild') return;
    if (action.from) this.closePeer(action.from);
    const entry = this.createPeer(event.viewerId, event.channelId, false, event.viewerAccountId ?? null, event.rtcSessionId ?? null);
    for (const track of this.localStream.getTracks()) entry.pc.addTrack(track, this.localStream);
    this.applyEncoding(entry.pc);
    await this.offer(entry, event.channelId);
  }

  private async offer(entry: PeerEntry, channelId: string, options: RTCOfferOptions = {}): Promise<void> {
    try {
      const offer = await entry.pc.createOffer(options);
      await entry.pc.setLocalDescription(offer);
      api.sendScreenshareSignal(entry.id, { sdp: entry.pc.localDescription ?? offer }, channelId);
    } catch (error) {
      console.error('[screenshare] offer failed', error);
      this.closePeer(entry.id);
    }
  }

  /** Our transport to a viewer broke while the socket was down: renegotiate it with an ICE restart. */
  private async restartIce(remoteId: string): Promise<void> {
    const entry = this.peers.get(remoteId);
    const channelId = screenshareChannel.value;
    if (!entry || !channelId || entry.receive) return;
    try {
      entry.pc.restartIce?.();
    } catch {
      /* older engines */
    }
    await this.offer(entry, channelId, { iceRestart: true });
  }

  private applyEncoding(peer: RTCPeerConnection): void {
    const quality = audioSettings.value.screenQuality;
    for (const sender of peer.getSenders()) applyScreenEncoding(sender, quality);
  }

  // ---------------------------------------------------------------- viewer

  /** Ask to watch the current presenter in a channel (no-op when nobody shares). */
  watch(channelId: string): void {
    if (screenshareRole.value === 'host') return;
    const session = screenshareSessions.value[channelId];
    if (!session?.active || !session.hostId || session.hostId === socketId.value) return;
    if (screenshareRole.value === 'viewer' && screenshareChannel.value === channelId) return;
    if (screenshareRole.value === 'viewer') this.stopViewing();
    this.rtcSessionId = newRtcSessionId();
    batch(() => {
      screenshareRole.value = 'viewer';
      screenshareChannel.value = channelId;
      screenshareStatus.value = 'Connecting to ' + (session.hostName ?? 'presenter') + '…';
    });
    this.dispatch({ type: 'started', role: 'viewer', channelId, hostAccountId: session.hostAccountId ?? null, hostRtcSessionId: session.rtcSessionId ?? null });
    api.joinScreenshareViewer(channelId, this.rtcSessionId, this.holding());
  }

  stopViewing(): void {
    if (screenshareRole.value !== 'viewer') return;
    const channelId = screenshareChannel.value;
    if (channelId && socketClient.connected) api.leaveScreenshareViewer(channelId);
    this.teardown();
  }

  /** Leave whatever we are doing in this channel (page closed). */
  leaveChannel(channelId: string): void {
    if (screenshareChannel.value !== channelId) return;
    if (screenshareRole.value === 'host') this.stopHosting();
    else if (screenshareRole.value === 'viewer') this.stopViewing();
  }

  /** Our seat is confirmed, with the presenter's identity: settle and follow their socket id. */
  private onSeated(event: ScreenshareViewerSeatedEvent): void {
    if (screenshareRole.value !== 'viewer' || screenshareChannel.value !== event.channelId) return;
    this.followHost(event.hostId, event.hostAccountId, event.rtcSessionId);
    this.dispatch({ type: 'settled', at: Date.now(), hostAccountId: event.hostAccountId, hostRtcSessionId: event.rtcSessionId });
    if (screenshareStream.value) screenshareStatus.value = '';
  }

  /**
   * The presenter is (back) on `hostId`. The connection we hold is kept and moved to
   * that id when it is the same person with the same media session; a new media
   * session means they rebuilt, so ours goes and the next offer starts over.
   */
  private followHost(hostId: string | null, hostAccountId: string | null, rtcSessionId: string | null): void {
    const entry = Array.from(this.peers.values())[0];
    if (!entry || !hostId || entry.id === hostId) return;
    const samePerson = entry.accountId === null || hostAccountId === null || entry.accountId === hostAccountId;
    const sameSession = entry.rtcSessionId !== null && entry.rtcSessionId === rtcSessionId;
    if (samePerson && sameSession) this.rekeyPeer(entry.id, hostId);
    else this.closePeer(entry.id);
  }

  // --------------------------------------------------------------- events

  private onSession(session: ScreenshareSessionEvent): void {
    setScreenshareSession(session);
    if (screenshareChannel.value !== session.channelId) return;
    const role = screenshareRole.value;
    if (role === 'host') {
      if (session.active && session.hostId === socketId.value) {
        this.dispatch({ type: 'settled', at: Date.now() });
        this.hostConfirmed = true;
        this.syncAllowClips(session);
      } else if (session.active && session.hostAccountId && session.hostAccountId !== account.value?.id) {
        this.teardown((session.hostName ?? 'Someone else') + ' is sharing in this room now');
      }
      return;
    }
    if (role !== 'viewer') return;
    if (!session.active) {
      if (session.endedBy === 'host') {
        this.teardown('The presenter stopped sharing');
        return;
      }
      if (this.share.phase === 'active' || this.share.phase === 'rejoining') {
        screenshareStatus.value = 'Waiting for ' + (screenshareSessions.value[session.channelId]?.hostName ?? 'the presenter') + ' to come back…';
      }
      this.dispatch({ type: 'sessionInactive', at: Date.now() });
      this.startTick();
      return;
    }
    this.followHost(session.hostId, session.hostAccountId ?? null, session.rtcSessionId ?? null);
    this.dispatch({ type: 'sessionActive', at: Date.now(), hostAccountId: session.hostAccountId ?? null, hostRtcSessionId: session.rtcSessionId ?? null });
  }

  private onSocketLost(): void {
    if (screenshareRole.value === 'idle') return;
    this.dispatch({ type: 'socketLost', at: Date.now() });
    screenshareStatus.value = screenshareRole.value === 'host' ? 'Reconnecting… your screen stays shared' : 'Reconnecting…';
    this.startTick();
  }

  private onReplaced(event: ScreenshareReplacedEvent): void {
    if (screenshareChannel.value !== event.channelId || screenshareRole.value !== event.role) return;
    toast.info(event.role === 'host' ? 'Your screen share moved to your other window' : 'Watching moved to your other window');
    this.teardown();
  }

  private onError(payload: ServerError): void {
    if (screenshareRole.value === 'idle' || !payload?.code) return;
    if (payload.channelId && payload.channelId !== screenshareChannel.value) return;
    this.dispatch({ type: 'refused', at: Date.now(), code: payload.code });
  }

  private async onSignal(payload: ScreenshareSignalEvent): Promise<void> {
    const role = screenshareRole.value;
    const channelId = payload.channelId ?? screenshareChannel.value;
    if (role === 'idle' || !channelId || channelId !== screenshareChannel.value) return;
    try {
      if (role === 'viewer') {
        const session = screenshareSessions.value[channelId];
        if (session?.hostId && session.hostId !== payload.from) return;
        let entry = this.peers.get(payload.from) ?? null;
        if (payload.data.sdp?.type === 'offer') {
          // An offer from a connection the host rebuilt (new DTLS certificate) cannot be applied to
          // the one we hold: start over on our side too.
          if (entry?.pc.remoteDescription?.sdp) {
            const previous = dtlsFingerprint(entry.pc.remoteDescription.sdp);
            const next = dtlsFingerprint(payload.data.sdp.sdp);
            if (previous && next && previous !== next) {
              this.closePeer(entry.id);
              entry = null;
            }
          }
          entry ??= this.createPeer(payload.from, channelId, true, session?.hostAccountId ?? this.share.hostAccountId, session?.rtcSessionId ?? this.share.hostRtcSessionId);
          if (entry.pc.signalingState === 'have-local-offer') await entry.pc.setLocalDescription({ type: 'rollback' });
          await entry.pc.setRemoteDescription(new RTCSessionDescription(payload.data.sdp));
          this.flushCandidates(payload.from);
          const answer = await entry.pc.createAnswer();
          await entry.pc.setLocalDescription(answer);
          api.sendScreenshareSignal(payload.from, { sdp: entry.pc.localDescription ?? answer }, channelId);
        } else if (payload.data.candidate) {
          this.queueOrAddCandidate(payload.from, payload.data.candidate);
        }
      } else if (role === 'host') {
        const entry = this.peers.get(payload.from);
        if (!entry) return;
        if (payload.data.sdp?.type === 'answer') {
          await entry.pc.setRemoteDescription(new RTCSessionDescription(payload.data.sdp));
          this.flushCandidates(payload.from);
          // Encodings set before negotiation do not always stick; apply them again now that they are negotiated.
          this.applyEncoding(entry.pc);
        } else if (payload.data.candidate) {
          this.queueOrAddCandidate(payload.from, payload.data.candidate);
        }
      }
    } catch (error) {
      console.error('[screenshare] signal failed', error);
    }
  }

  // --------------------------------------------------------------- rejoin

  private dispatch(event: ShareEvent): void {
    const step = reduceShare(this.share, event);
    this.share = step.state;
    for (const effect of step.effects) this.runEffect(effect);
    if (!isSharePending(this.share)) this.stopTick();
  }

  private runEffect(effect: ShareEffect): void {
    const channelId = screenshareChannel.value;
    if (effect.type === 'restartHosting') {
      this.hostConfirmed = false;
      this.sentAllowClips = audioSettings.value.shareClipsAllowed;
      api.startScreenshare(effect.channelId, this.rtcSessionId, this.holding(), this.sentAllowClips);
      return;
    }
    if (effect.type === 'rejoinViewer') {
      api.joinScreenshareViewer(effect.channelId, this.rtcSessionId, this.holding());
      return;
    }
    const role = screenshareRole.value;
    const message =
      effect.reason === 'new-host'
        ? ''
        : effect.reason === 'host-gone'
          ? 'The presenter did not come back.'
          : effect.reason === 'timeout'
            ? 'The connection was down for too long.'
            : effect.reason === 'refused'
              ? (role === 'host' ? 'Could not share the screen' : 'Could not watch') + (effect.code ? ' (' + effect.code + ')' : '') + '.'
              : 'The server kept refusing the rejoin.';
    if (message) toast.warning((role === 'host' ? 'Screen share stopped. ' : 'Stopped watching. ') + message, 8000);
    this.teardown(message);
    // Someone else took over the room while we were waiting: watch them instead.
    if (effect.reason === 'new-host' && channelId) this.watch(channelId);
  }

  private startTick(): void {
    if (this.tickTimer !== null) return;
    this.tickTimer = window.setInterval(() => {
      if (!isSharePending(this.share)) {
        this.stopTick();
        return;
      }
      this.dispatch({ type: 'tick', at: Date.now() });
    }, TICK_MS);
  }

  private stopTick(): void {
    if (this.tickTimer !== null) window.clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  // ---------------------------------------------------------------- peers

  /** The connections we still hold, told to the server on a rejoin so the other side knows what to keep. */
  private holding(): HeldPeerConnection[] {
    return Array.from(this.peers.values())
      .filter((entry) => entry.accountId && this.peerHealth(entry.id) !== 'missing')
      .map((entry) => ({ accountId: entry.accountId as string, rtcSessionId: entry.rtcSessionId }));
  }

  private knownPeers(): KnownPeer[] {
    return Array.from(this.peers.values()).map((entry) => ({ id: entry.id, accountId: entry.accountId, rtcSessionId: entry.rtcSessionId, health: this.peerHealth(entry.id) }));
  }

  private peerHealth(remoteId: string): PeerHealth {
    const entry = this.peers.get(remoteId);
    if (!entry) return 'missing';
    const { pc } = entry;
    if (pc.connectionState === 'closed' || pc.connectionState === 'failed') return 'broken';
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') return 'broken';
    if (pc.connectionState === 'connected') return 'connected';
    return 'connecting';
  }

  /** The same person is back on a new socket with the same media session: keep the connection, file it under the new id. */
  private rekeyPeer(from: string, to: string): void {
    const entry = this.peers.get(from);
    if (!entry || from === to) return;
    if (this.peers.has(to)) this.closePeer(to);
    this.peers.delete(from);
    entry.id = to;
    this.peers.set(to, entry);
    const queued = this.candidateQueue.get(from) ?? [];
    this.candidateQueue.delete(from);
    this.candidateQueue.set(to, queued);
  }

  private createPeer(remoteId: string, channelId: string, receive: boolean, accountId: string | null, rtcSessionId: string | null): PeerEntry {
    const pc = new RTCPeerConnection({ iceServers: serverConfig.iceServers() });
    const entry: PeerEntry = { id: remoteId, pc, accountId, rtcSessionId, receive };
    pc.onicecandidate = (event) => {
      if (event.candidate) api.sendScreenshareSignal(entry.id, { candidate: event.candidate.toJSON() }, channelId);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState !== 'failed' && pc.connectionState !== 'closed') return;
      // While the room is being held together the reconcile after the rejoin deals with it.
      if (isSharePending(this.share)) return;
      this.closePeer(entry.id);
      if (receive && screenshareRole.value === 'viewer') screenshareStatus.value = 'Connection to the presenter failed';
    };
    if (receive) {
      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (stream) {
          batch(() => {
            screenshareStream.value = stream;
            screenshareStatus.value = '';
          });
        }
      };
    }
    this.peers.set(remoteId, entry);
    this.candidateQueue.set(remoteId, []);
    return entry;
  }

  private queueOrAddCandidate(remoteId: string, candidate: RTCIceCandidateInit): void {
    const entry = this.peers.get(remoteId);
    if (!entry) return;
    if (!entry.pc.remoteDescription) {
      this.candidateQueue.get(remoteId)?.push(candidate);
      return;
    }
    entry.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => undefined);
  }

  private flushCandidates(remoteId: string): void {
    const entry = this.peers.get(remoteId);
    const queued = this.candidateQueue.get(remoteId) ?? [];
    this.candidateQueue.set(remoteId, []);
    if (!entry) return;
    for (const candidate of queued) entry.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => undefined);
  }

  private closePeer(remoteId: string): void {
    this.peers.get(remoteId)?.pc.close();
    this.peers.delete(remoteId);
    this.candidateQueue.delete(remoteId);
  }

  /**
   * Keep the room's clip permission equal to the setting while we host: after the seat is
   * confirmed (with what the server holds, so a change made meanwhile is not lost) and on
   * every later change of the setting.
   */
  private syncAllowClips(session?: ScreenshareSessionEvent): void {
    const channelId = screenshareChannel.value;
    if (screenshareRole.value !== 'host' || !channelId || !this.hostConfirmed) return;
    const allowClips = audioSettings.value.shareClipsAllowed;
    const known = session ? session.allowClips !== false : this.sentAllowClips;
    if (known === allowClips) {
      this.sentAllowClips = allowClips;
      return;
    }
    if (!socketClient.connected) return;
    this.sentAllowClips = allowClips;
    api.updateScreenshare(channelId, allowClips);
  }

  private teardown(message = ''): void {
    this.share = initialShareState;
    this.stopTick();
    this.rtcSessionId = null;
    this.hostConfirmed = false;
    this.sentAllowClips = null;
    for (const id of Array.from(this.peers.keys())) this.closePeer(id);
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    batch(() => {
      screenshareRole.value = 'idle';
      screenshareChannel.value = null;
      screenshareStream.value = null;
      screenshareStatus.value = message;
    });
  }
}

export const screenshareService = new ScreenshareService();
