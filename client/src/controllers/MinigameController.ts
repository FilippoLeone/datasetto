import { isMobileDevice } from '@/utils/device';
/**
 * Voice minigame coordinator for the Slither arena
 */
import type { MinigameControllerDeps } from './types';
import type { VoiceMinigamePlayerState, VoiceMinigameState, VoicePeerEvent } from '@/types';

const INPUT_SEND_INTERVAL_MS = 16;
const DEFAULT_STATUS = 'No slither arena open. Start a round to glide together!';
const GRID_SPACING = 160;
const BACKGROUND_COLOR = '#080c16';

const END_REASON_LABELS: Record<string, string> = {
  ended_by_host: 'ended by host',
  all_players_left: 'everyone left the arena',
  everyone_crashed: 'everyone crashed',
  winner: 'winner decided',
  error: 'unexpected error',
  arena_closed: 'arena closed',
};

const describeEndReason = (reason: string): string => {
  if (!reason) {
    return 'ended';
  }

  return END_REASON_LABELS[reason] ?? reason.replace(/_/g, ' ');
};

type MovementVector = { x: number; y: number };

type ViewTransform = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

export class MinigameController {
  private deps: MinigameControllerDeps;
  private disposers: Array<() => void> = [];
  private stage: HTMLElement | null = null;
  private container: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private openButton: HTMLButtonElement | null = null;
  private closeButton: HTMLButtonElement | null = null;
  private startButton: HTMLButtonElement | null = null;
  private endButton: HTMLButtonElement | null = null;
  private joinButton: HTMLButtonElement | null = null;
  private leaveButton: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private scoresEl: HTMLElement | null = null;
  private currentState: VoiceMinigameState | null = null;
  private lastEndReason: string | null = null;
  private renderHandle: number | null = null;
  private inputTimeout: number | null = null;
  private lastInputAt = 0;
  private lastSentVector: MovementVector = { x: 0, y: 0 };
  private pendingVector: MovementVector | null = null;
  private canUseMinigame = false;
  private isViewPinned = false;
  private voiceParticipants: Map<string, { id: string; name: string }> = new Map();
  private pointerTarget: { x: number; y: number } | null = null;
  private pointerActive = false;
  private viewTransform: ViewTransform | null = null;
  private viewCenter: { x: number; y: number } | null = null;
  private currentScale = 1;
  private keyboardInput = { up: false, down: false, left: false, right: false };
  private isMobile: boolean;

  constructor(deps: MinigameControllerDeps) {
    this.deps = deps;
    this.isMobile = isMobileDevice();
  }

  initialize(): void {
    this.stage = this.deps.elements['voice-call-stage'] ?? null;
    this.container = this.deps.elements['voice-minigame-container'] ?? null;
    this.canvas = (this.deps.elements['voice-minigame-canvas'] as HTMLCanvasElement) ?? null;
    this.openButton = (this.deps.elements['voice-minigame-open'] as HTMLButtonElement) ?? null;
    this.closeButton = (this.deps.elements['voice-minigame-close'] as HTMLButtonElement) ?? null;
    this.startButton = (this.deps.elements['voice-minigame-start'] as HTMLButtonElement) ?? null;
    this.endButton = (this.deps.elements['voice-minigame-end'] as HTMLButtonElement) ?? null;
    this.joinButton = (this.deps.elements['voice-minigame-join'] as HTMLButtonElement) ?? null;
    this.leaveButton = (this.deps.elements['voice-minigame-leave'] as HTMLButtonElement) ?? null;
    this.statusEl = this.deps.elements['voice-minigame-status'] ?? null;
    this.scoresEl = this.deps.elements['voice-minigame-scores'] ?? null;

    if (this.canvas) {
      this.ctx = this.canvas.getContext('2d', { alpha: false });
      if (this.ctx) {
        this.ctx.imageSmoothingEnabled = true;
      }
    }

    this.bindUi();
    this.registerSocketListeners();
    this.registerStateObserver();
    this.deps.registerCleanup(() => this.dispose());

    const persisted = this.deps.state.get('voiceMinigame');
    if (persisted) {
      this.currentState = persisted;
    }

    this.updateVisibility();
    this.updateControls();
    this.updateStatus();
    this.renderScores();
    this.drawState();
    this.syncStageMode();
  }

  dispose(): void {
    this.stopRenderLoop();

    if (this.inputTimeout !== null) {
      window.clearTimeout(this.inputTimeout);
      this.inputTimeout = null;
    }

    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error('[MinigameController] Error during dispose handler', error);
        }
      }
    }
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (!this.shouldCaptureKeyboard(event)) {
      return false;
    }

    const handled = this.applyKeyboardState(event.code, true);
    if (handled) {
      event.preventDefault();
    }
    return handled;
  }

  handleKeyUp(event: KeyboardEvent): boolean {
    if (!this.shouldCaptureKeyboard(event)) {
      return false;
    }

    return this.applyKeyboardState(event.code, false);
  }

  private applyKeyboardState(code: string, pressed: boolean): boolean {
    if (!this.currentState || this.currentState.status !== 'running') {
      return false;
    }

    let matched = true;
    switch (code) {
      case 'ArrowUp':
      case 'KeyW':
        this.keyboardInput.up = pressed;
        break;
      case 'ArrowDown':
      case 'KeyS':
        this.keyboardInput.down = pressed;
        break;
      case 'ArrowLeft':
      case 'KeyA':
        this.keyboardInput.left = pressed;
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.keyboardInput.right = pressed;
        break;
      default:
        matched = false;
        break;
    }

    if (!matched) {
      return false;
    }

    if (this.pointerActive) {
      return true;
    }

    const vector = this.getKeyboardVector();
    this.queueInputVector(vector);
    return true;
  }

  private getKeyboardVector(): MovementVector {
    const x = (this.keyboardInput.right ? 1 : 0) - (this.keyboardInput.left ? 1 : 0);
    const y = (this.keyboardInput.down ? 1 : 0) - (this.keyboardInput.up ? 1 : 0);
    if (x === 0 && y === 0) {
      return { x: 0, y: 0 };
    }

    const length = Math.hypot(x, y) || 1;
    return { x: x / length, y: y / length };
  }

  private shouldCaptureKeyboard(event: KeyboardEvent): boolean {
    if (!this.currentState || this.currentState.status !== 'running') {
      return false;
    }

    const target = event.target as HTMLElement | null;
    if (!target) {
      return true;
    }

    const tagName = target.tagName;
    if (tagName === 'INPUT' || tagName === 'TEXTAREA') {
      return false;
    }

    if (target.isContentEditable) {
      return false;
    }

    return true;
  }

  private bindUi(): void {
    this.deps.addListener(this.openButton, 'click', () => {
      if (!this.canUseMinigame) {
        return;
      }
      this.isViewPinned = true;
      this.syncStageMode();
      this.updateControls();
    });

    this.deps.addListener(this.closeButton, 'click', () => {
      this.isViewPinned = false;
      this.syncStageMode();
    });

    this.deps.addListener(this.startButton, 'click', () => {
      this.lastEndReason = null;
  this.deps.socket.startVoiceMinigame({ type: 'slither' });
    });

    this.deps.addListener(this.endButton, 'click', () => {
      this.deps.socket.endVoiceMinigame();
    });

    this.deps.addListener(this.joinButton, 'click', () => {
      this.deps.socket.joinVoiceMinigame();
    });

    this.deps.addListener(this.leaveButton, 'click', () => {
      this.deps.socket.leaveVoiceMinigame();
    });

    this.deps.addListener(window, 'resize', () => {
      this.resizeCanvas();
      this.requestRender();
    });

    this.deps.addListener(this.canvas, 'pointermove', (event) => {
      this.handlePointerMove(event as PointerEvent);
    });

    this.deps.addListener(this.canvas, 'pointerdown', (event) => {
      this.handlePointerMove(event as PointerEvent);
    });

    this.deps.addListener(this.canvas, 'pointerover', (event) => {
      this.handlePointerMove(event as PointerEvent);
    });

    this.deps.addListener(this.canvas, 'pointerleave', () => {
      this.handlePointerLeave();
    });
  }

  private getHeadDirection(points: Array<{ x: number; y: number }> | undefined): { x: number; y: number } {
    if (!points || points.length === 0) {
      return { x: 1, y: 0 };
    }
    const head = points[0];
    const neck = points[1] ?? { x: head.x + 1, y: head.y };
    const dx = head.x - neck.x;
    const dy = head.y - neck.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: dx / length, y: dy / length };
  }

  private registerSocketListeners(): void {
    this.disposers.push(
      this.deps.socket.on('voice:game:state', (state) => {
        this.applyState(state as VoiceMinigameState);
      })
    );

    this.disposers.push(
      this.deps.socket.on('voice:game:update', (state) => {
        this.applyState(state as VoiceMinigameState);
      })
    );

    this.disposers.push(
      this.deps.socket.on('voice:game:started', (state) => {
        this.lastEndReason = null;
        this.deps.soundFX.play('notification', 0.4);
        this.applyState(state as VoiceMinigameState);
      })
    );

    this.disposers.push(
      this.deps.socket.on('voice:game:ended', (payload) => {
        const data = payload as { reason: string; state?: VoiceMinigameState | null };
        const humanReason = describeEndReason(data?.reason ?? 'ended');
        this.lastEndReason = humanReason;
        this.deps.notifications.info(`Arena closed — ${humanReason}`, 4500);
        if (data?.state) {
          this.applyState(data.state as VoiceMinigameState);
        } else {
          this.applyState(null);
        }
      })
    );

    this.disposers.push(
      this.deps.socket.on('voice:game:error', (payload) => {
        const data = payload as { message?: string };
        if (data?.message) {
          this.deps.soundFX.play('error', 0.4);
          this.deps.notifications.error(data.message);
        }
      })
    );

    this.disposers.push(
      this.deps.socket.on('voice:joined', (payload) => {
        const data = payload as { peers?: VoicePeerEvent[] | null };
        this.rebuildVoiceParticipants(data?.peers ?? []);
      })
    );

    this.disposers.push(
      this.deps.socket.on('voice:peer-join', (payload) => {
        const data = payload as VoicePeerEvent;
        this.addVoiceParticipant(data);
      })
    );

    this.disposers.push(
      this.deps.socket.on('voice:peer-leave', (payload) => {
        const data = payload as { id: string };
        this.removeVoiceParticipant(data.id);
      })
    );
  }

  private registerStateObserver(): void {
    this.disposers.push(
      this.deps.state.on('state:change', (appState) => {
        this.updateVisibility(appState.voiceConnected);
      })
    );
  }

  private updateVisibility(forceConnected?: boolean): void {
    if (!this.container) {
      return;
    }

    if (this.isMobile) {
      this.container.classList.add('hidden');
      this.stage?.classList.remove('minigame-active');
      this.openButton?.classList.add('hidden');
      this.closeButton?.classList.add('hidden');
      return;
    }

    const voiceConnected = typeof forceConnected === 'boolean'
      ? forceConnected
      : this.deps.state.get('voiceConnected');
    const channelType = this.deps.state.get('currentChannelType');
    const isVoiceChannelActive = channelType === 'voice';

    this.canUseMinigame = Boolean(voiceConnected && isVoiceChannelActive);

    if (!this.canUseMinigame) {
      this.isViewPinned = false;
      this.container.classList.add('hidden');
      this.stage?.classList.remove('minigame-active');
      this.resetVoiceParticipants();
      this.applyState(null);
      this.lastEndReason = null;
      this.updateLauncherState();
      this.syncStageMode();
      return;
    }

    this.updateLauncherState();
    this.syncStageMode();
    this.updateControls();
  }

  private applyState(state: VoiceMinigameState | null): void {
    this.currentState = state;
    if (!state || state.status !== 'running') {
      this.resetInputState();
      this.viewCenter = null;
      this.currentScale = 1;
      this.viewTransform = null;
    }

    if (state?.status === 'running') {
      this.isViewPinned = true;
    }

    const persisted = this.deps.state.get('voiceMinigame');
    const shouldPersist = (() => {
      if (!state && !persisted) {
        return false;
      }
      if (!state || !persisted) {
        return true;
      }
      return state.gameId !== persisted.gameId || state.sequence !== persisted.sequence;
    })();

    if (shouldPersist) {
      this.deps.state.setVoiceMinigameState(state ?? null);
    }

    this.updateControls();
    this.updateStatus();
    this.renderScores();
    this.requestRender();
    this.updateLauncherState();
    this.syncStageMode();
  }

  private resetInputState(): void {
    this.pointerActive = false;
    this.pointerTarget = null;
    this.keyboardInput = { up: false, down: false, left: false, right: false };
    this.pendingVector = null;
    this.lastSentVector = { x: 0, y: 0 };
    if (this.inputTimeout !== null) {
      window.clearTimeout(this.inputTimeout);
      this.inputTimeout = null;
    }
  }

  private updateControls(): void {
    const state = this.currentState;
    const localId = this.deps.socket.getId();
    const voiceConnected = this.deps.state.get('voiceConnected');

    const isRunning = state?.status === 'running';
    const isHost = Boolean(state && localId && state.hostId === localId);
    const playerEntry = state?.players.find((entry) => entry.id === localId);
    const isRegistered = Boolean(playerEntry);

    if (this.startButton) {
      const canStart = this.canUseMinigame && voiceConnected && !isRunning;
      this.startButton.classList.toggle('hidden', !this.canUseMinigame);
      this.startButton.toggleAttribute('disabled', !canStart);
      if (this.startButton.textContent !== 'Start Slither Arena') {
        this.startButton.textContent = 'Start Slither Arena';
      }
    }

    if (this.endButton) {
      const shouldShowEnd = voiceConnected && isRunning && isHost;
      this.endButton.classList.toggle('hidden', !shouldShowEnd);
      this.endButton.toggleAttribute('disabled', !shouldShowEnd);
    }

    if (this.joinButton) {
      const shouldShowJoin = Boolean(state && state.status === 'running' && !isRegistered);
      this.joinButton.classList.toggle('hidden', !shouldShowJoin);
      this.joinButton.textContent = 'Join';
    }

    if (this.leaveButton) {
      const shouldShowLeave = Boolean(state && isRegistered);
      this.leaveButton.classList.toggle('hidden', !shouldShowLeave);
    }
  }

  private updateStatus(): void {
    if (!this.statusEl) {
      return;
    }

    const state = this.currentState;
    if (!state) {
      this.statusEl.textContent = this.lastEndReason ? `Last arena: ${this.lastEndReason}` : DEFAULT_STATUS;
      return;
    }

    if (state.status === 'running') {
      const alive = state.players.filter((player) => player.alive).length;
      const total = state.players.length;
      const pellets = state.pellets.length;
      const top = state.leaderboard?.[0];
      const parts: string[] = [`${alive}/${total} snakes slithering`, `${pellets} pellets`];
      if (top) {
        parts.push(`Top length ${Math.round(top.length)}`);
      }
      this.statusEl.textContent = `Arena live — ${parts.join(' · ')}`;
      return;
    }

    this.statusEl.textContent = this.lastEndReason ? `Arena finished — ${this.lastEndReason}` : 'Arena finished';
  }

  private renderScores(): void {
    if (!this.scoresEl) {
      return;
    }

    const state = this.currentState;
    const localId = this.deps.socket.getId();
    const list = this.scoresEl;

    list.innerHTML = '';

    if (!state) {
      const participants = Array.from(this.voiceParticipants.values());
      if (participants.length === 0) {
        const item = document.createElement('li');
        item.className = 'text-2xs text-text-muted';
        item.textContent = 'No one in voice yet. Join the channel to get ready!';
        list.appendChild(item);
        return;
      }

      participants.forEach((participant) => {
        const item = document.createElement('li');
        item.className = 'flex items-center justify-between gap-3 text-2xs';

        const name = document.createElement('span');
        name.className = 'font-semibold text-text-normal';
        name.textContent = participant.name;

        const badge = document.createElement('span');
        badge.className = 'rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted';
        badge.textContent = 'Ready';

        item.append(name, badge);
        list.appendChild(item);
      });
      return;
    }

    const byId = new Map<string, VoiceMinigamePlayerState>(state.players.map((player) => [player.id, player]));
    const leaderboard = state.leaderboard?.length ? state.leaderboard : state.players;

    leaderboard.forEach((entry, index) => {
      const player = typeof entry === 'object' && 'id' in entry ? byId.get(entry.id) ?? (entry as VoiceMinigamePlayerState) : undefined;
      const resolved = player ?? (entry as VoiceMinigamePlayerState);

      const item = document.createElement('li');
      item.className = 'flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-2xs';

      const nameWrap = document.createElement('div');
      nameWrap.className = 'flex items-center gap-2 truncate';

      const rank = document.createElement('span');
      rank.className = 'w-6 text-right font-semibold text-text-muted';
      rank.textContent = `${index + 1}.`;

      const marker = document.createElement('span');
      marker.className = 'inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full';
      marker.style.backgroundColor = resolved.color;

      const name = document.createElement('span');
      name.className = 'truncate font-semibold text-text-normal';
      name.textContent = resolved.name;
      if (resolved.id === localId) {
        name.classList.add('text-brand-primary');
      }

      if (!resolved.alive) {
        name.classList.add('opacity-70');
      }

      nameWrap.append(rank, marker, name);

      const statsWrap = document.createElement('div');
      statsWrap.className = 'flex items-center gap-2';

      const score = document.createElement('span');
      score.className = 'font-semibold text-text-normal tabular-nums';
      score.textContent = `${Math.round(resolved.score)} pts`;
      statsWrap.append(score);

  const lengthBadge = document.createElement('span');
  lengthBadge.className = 'rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted tabular-nums';
  lengthBadge.textContent = `Length ${Math.round(resolved.length)}`;
  statsWrap.append(lengthBadge);

  const speedBadge = document.createElement('span');
  speedBadge.className = 'hidden rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted tabular-nums sm:inline-flex';
  speedBadge.textContent = `Speed ${Math.round(resolved.speed)}`;
  statsWrap.append(speedBadge);

      const status = document.createElement('span');
      if (resolved.alive) {
        status.className = 'rounded-full bg-success/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-success';
        status.textContent = 'Active';
      } else {
        status.className = 'rounded-full bg-warning/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-warning';
        const remaining = Math.ceil(resolved.respawnInMs / 1000);
        status.textContent = remaining > 0 ? `Respawning ${remaining}s` : 'Respawning';
      }
      statsWrap.append(status);

      item.append(nameWrap, statsWrap);
      list.appendChild(item);
    });
  }

  private rebuildVoiceParticipants(peers: VoicePeerEvent[]): void {
    this.voiceParticipants.clear();
    this.addLocalVoiceParticipant();
    peers.forEach((peer) => this.voiceParticipants.set(peer.id, { id: peer.id, name: peer.name }));
    this.renderScores();
  }

  private addLocalVoiceParticipant(): void {
    const localId = this.deps.socket.getId();
    if (!localId) {
      return;
    }

    const account = this.deps.state.get('account');
    const name = account?.displayName || account?.username || 'You';
    this.voiceParticipants.set(localId, { id: localId, name });
  }

  private addVoiceParticipant(peer: VoicePeerEvent): void {
    if (!peer?.id) {
      return;
    }

    if (this.voiceParticipants.size === 0) {
      this.addLocalVoiceParticipant();
    }

    this.voiceParticipants.set(peer.id, { id: peer.id, name: peer.name });
    this.renderScores();
  }

  private removeVoiceParticipant(id: string): void {
    if (!id) {
      return;
    }

    if (this.voiceParticipants.delete(id)) {
      this.renderScores();
    }
  }

  private resetVoiceParticipants(): void {
    if (this.voiceParticipants.size === 0) {
      return;
    }

    this.voiceParticipants.clear();
    this.renderScores();
  }

  private resizeCanvas(): void {
    if (!this.canvas) {
      return;
    }

    const width = Math.max(this.canvas.clientWidth, 240);
    const height = Math.max(this.canvas.clientHeight || width, 240);
    const size = Math.floor(Math.min(width, height));

    if (size > 0 && (this.canvas.width !== size || this.canvas.height !== size)) {
      this.canvas.width = size;
      this.canvas.height = size;
    }
  }

  private shouldForceMinigame(): boolean {
    return this.currentState?.status === 'running';
  }

  private shouldShowMinigame(): boolean {
    return this.canUseMinigame && (this.shouldForceMinigame() || this.isViewPinned);
  }

  private updateLauncherState(): void {
    if (!this.openButton) {
      return;
    }

    const label = this.currentState?.status === 'running' ? 'Return to Arena' : 'Minigame';
    this.openButton.textContent = label;
  }

  private syncStageMode(): void {
    if (!this.stage || !this.container) {
      return;
    }

    const shouldForce = this.shouldForceMinigame();
    const shouldShow = this.shouldShowMinigame();

    if (shouldShow) {
      this.stage.classList.remove('hidden');
    }

    this.stage.classList.toggle('minigame-active', shouldShow);
    this.container.classList.toggle('hidden', !shouldShow);

    if (shouldShow) {
      this.resizeCanvas();
      this.requestRender();
    }

    if (this.closeButton) {
      const showClose = shouldShow && !shouldForce;
      this.closeButton.classList.toggle('hidden', !showClose);
      this.closeButton.toggleAttribute('disabled', !showClose);
    }

    if (this.openButton) {
      const showLauncher = this.canUseMinigame && !shouldShow;
      this.openButton.classList.toggle('hidden', !showLauncher);
      this.openButton.toggleAttribute('disabled', !showLauncher);
    }
  }

  private requestRender(): void {
    if (this.currentState?.status === 'running' && this.shouldShowMinigame()) {
      this.startRenderLoop();
    } else {
      this.stopRenderLoop();
      this.drawState();
    }
  }

  private startRenderLoop(): void {
    if (this.renderHandle !== null) {
      return;
    }

    const step = () => {
      this.renderHandle = window.requestAnimationFrame(step);
      this.drawState();
    };

    this.renderHandle = window.requestAnimationFrame(step);
    this.drawState();
  }

  private stopRenderLoop(): void {
    if (this.renderHandle !== null) {
      cancelAnimationFrame(this.renderHandle);
      this.renderHandle = null;
    }
  }

  private getLocalPlayer(state: VoiceMinigameState | null): VoiceMinigamePlayerState | null {
    if (!state) {
      return null;
    }
    const localId = this.deps.socket.getId();
    if (!localId) {
      return null;
    }
    return state.players.find((player) => player.id === localId) ?? null;
  }

  private clamp(value: number, min: number, max: number): number {
    if (Number.isNaN(value)) {
      return min;
    }
    if (value < min) {
      return min;
    }
    if (value > max) {
      return max;
    }
    return value;
  }

  private lerp(from: number, to: number, alpha: number): number {
    const t = this.clamp(alpha, 0, 1);
    return from + (to - from) * t;
  }

  private computeZoom(player: VoiceMinigamePlayerState | null): number {
    if (!player) {
      return 12;
    }

    const lengthFactor = Math.max(player.length, 1) / 220;
    const damping = Math.log10(lengthFactor + 1);
    const zoom = 14 - damping * 6;
    return this.clamp(zoom, 8, 14);
  }

  private calculateViewTransform(
    state: VoiceMinigameState,
    canvasWidth: number,
    canvasHeight: number
  ): ViewTransform {
    const { world } = state;
    const baseScale = Math.min(canvasWidth / world.width, canvasHeight / world.height) || 1;
    const localPlayer = this.getLocalPlayer(state);

    const playerHead = localPlayer?.head ?? localPlayer?.segments?.[0];
    const targetCenter = playerHead ?? { x: world.width / 2, y: world.height / 2 };
    if (!this.viewCenter) {
      this.viewCenter = { ...targetCenter };
    }

    const currentCenter = this.viewCenter ?? targetCenter;
    const centerLerp = localPlayer ? 0.2 : 0.1;
    this.viewCenter = {
      x: this.lerp(currentCenter.x, targetCenter.x, centerLerp),
      y: this.lerp(currentCenter.y, targetCenter.y, centerLerp),
    };

    const targetScale = baseScale * this.computeZoom(localPlayer ?? null);
    this.currentScale = this.lerp(this.currentScale || targetScale, targetScale, 0.15);
    const scale = this.currentScale || targetScale;

    const halfViewWidth = canvasWidth / (scale * 2);
    const halfViewHeight = canvasHeight / (scale * 2);

    const maxCenterX = world.width - halfViewWidth;
    const maxCenterY = world.height - halfViewHeight;

    const clampedCenterX = halfViewWidth > maxCenterX
      ? world.width / 2
      : this.clamp(this.viewCenter.x, halfViewWidth, maxCenterX);
    const clampedCenterY = halfViewHeight > maxCenterY
      ? world.height / 2
      : this.clamp(this.viewCenter.y, halfViewHeight, maxCenterY);

    this.viewCenter = { x: clampedCenterX, y: clampedCenterY };

    const offsetX = canvasWidth / 2 - clampedCenterX * scale;
    const offsetY = canvasHeight / 2 - clampedCenterY * scale;

    this.viewTransform = { scale, offsetX, offsetY };
    return this.viewTransform;
  }

  private drawState(): void {
    if (!this.canvas || !this.ctx) {
      return;
    }

    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;

    ctx.fillStyle = BACKGROUND_COLOR;
    ctx.fillRect(0, 0, width, height);

    const state = this.currentState;
    if (!state || !state.world) {
      this.viewTransform = null;
      this.drawPlaceholder(ctx, width, height);
      return;
    }

    const transform = this.calculateViewTransform(state, width, height);
    const { scale, offsetX, offsetY } = transform;

    this.drawGrid(ctx, state.world, scale, offsetX, offsetY);
    this.drawPellets(ctx, state, scale, offsetX, offsetY);
    this.drawPlayers(ctx, state, scale, offsetX, offsetY);
  }

  private drawPlaceholder(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.fillStyle = '#0f1727';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#3a5277';
    const fontSize = Math.max(Math.floor(Math.min(width, height) / 18), 14);
    ctx.font = `600 ${fontSize}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Launch the slither arena to get started', width / 2, height / 2);
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D,
    world: { width: number; height: number },
    scale: number,
    offsetX: number,
    offsetY: number
  ): void {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;

    for (let x = GRID_SPACING; x < world.width; x += GRID_SPACING) {
      const pos = offsetX + x * scale;
      ctx.beginPath();
      ctx.moveTo(Math.round(pos) + 0.5, offsetY);
      ctx.lineTo(Math.round(pos) + 0.5, offsetY + world.height * scale);
      ctx.stroke();
    }

    for (let y = GRID_SPACING; y < world.height; y += GRID_SPACING) {
      const pos = offsetY + y * scale;
      ctx.beginPath();
      ctx.moveTo(offsetX, Math.round(pos) + 0.5);
      ctx.lineTo(offsetX + world.width * scale, Math.round(pos) + 0.5);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 2;
    ctx.strokeRect(offsetX + 1, offsetY + 1, world.width * scale - 2, world.height * scale - 2);
    ctx.restore();
  }

  private drawPellets(
    ctx: CanvasRenderingContext2D,
    state: VoiceMinigameState,
    scale: number,
    offsetX: number,
    offsetY: number
  ): void {
    ctx.save();
    const width = ctx.canvas.width;
    const height = ctx.canvas.height;
    const margin = 140;
    for (const pellet of state.pellets) {
      const radius = Math.max(pellet.radius * scale, 3);
      const x = offsetX + pellet.x * scale;
      const y = offsetY + pellet.y * scale;
      if (
        x + radius < -margin ||
        x - radius > width + margin ||
        y + radius < -margin ||
        y - radius > height + margin
      ) {
        continue;
      }

      ctx.beginPath();
      ctx.fillStyle = pellet.color;
      ctx.globalAlpha = 0.9;
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawPlayers(
    ctx: CanvasRenderingContext2D,
    state: VoiceMinigameState,
    scale: number,
    offsetX: number,
    offsetY: number
  ): void {
    const localId = this.deps.socket.getId();
    const width = ctx.canvas.width;
    const height = ctx.canvas.height;
    const visibilityMarginBase = 200;

    state.players.forEach((player) => {
      const points = player.segments ?? [];
      if (!points.length) {
        return;
      }

  const strokeWidth = Math.max((player.thickness ?? 12) * scale, 6);
  const visibilityMargin = Math.max(strokeWidth * 3, visibilityMarginBase);
  const stride = Math.max(1, Math.floor(points.length / 36));

      let hasVisiblePoint = false;
      let headScreenX = 0;
      let headScreenY = 0;

      ctx.save();
      ctx.globalAlpha = player.alive ? 0.96 : 0.45;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = strokeWidth;
      ctx.strokeStyle = player.color;

      ctx.beginPath();
      for (let index = 0; index < points.length; index += stride) {
        const point = points[index];
        const px = offsetX + point.x * scale;
        const py = offsetY + point.y * scale;

        if (!hasVisiblePoint && px >= -visibilityMargin && px <= width + visibilityMargin && py >= -visibilityMargin && py <= height + visibilityMargin) {
          hasVisiblePoint = true;
        }

        if (index === 0) {
          headScreenX = px;
          headScreenY = py;
          ctx.moveTo(px, py);
        } else {
          ctx.lineTo(px, py);
        }
      }

      if (!hasVisiblePoint) {
        ctx.restore();
        return;
      }

      ctx.stroke();

      const headRadius = Math.max(strokeWidth * 0.55, 6);
      ctx.fillStyle = player.color;
      ctx.beginPath();
      ctx.arc(headScreenX, headScreenY, headRadius, 0, Math.PI * 2);
      ctx.fill();

      ctx.lineWidth = Math.max(1.2, headRadius * 0.32);
      ctx.strokeStyle = player.id === localId ? 'rgba(255, 255, 255, 0.9)' : 'rgba(255, 255, 255, 0.55)';
      ctx.stroke();

      const heading = this.getHeadDirection(points);
      const dirX = heading.x;
      const dirY = heading.y;
      const perpX = -dirY;
      const perpY = dirX;
      const eyeOffset = headRadius * 0.65;
      const eyeRadius = Math.max(1.8, headRadius * 0.24);

      const drawEye = (offset: number) => {
        const centerX = headScreenX + dirX * eyeOffset + perpX * eyeRadius * offset;
        const centerY = headScreenY + dirY * eyeOffset + perpY * eyeRadius * offset;
        ctx.beginPath();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.arc(centerX, centerY, eyeRadius, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.fillStyle = 'rgba(18, 24, 32, 0.95)';
        ctx.arc(centerX + dirX * eyeRadius * 0.35, centerY + dirY * eyeRadius * 0.35, eyeRadius * 0.45, 0, Math.PI * 2);
        ctx.fill();
      };

      drawEye(0.85);
      drawEye(-0.85);

      ctx.font = `${Math.max(11, headRadius * 0.42)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.globalAlpha = 0.92;
      ctx.fillText(player.name, headScreenX, headScreenY - headRadius - Math.max(12, headRadius * 0.25));

      ctx.font = `${Math.max(12, headRadius * 0.5)}px system-ui`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.fillText(`${Math.round(player.length)}`, headScreenX, headScreenY);

      if (!player.alive) {
        const remaining = Math.ceil(player.respawnInMs / 1000);
        if (remaining > 0) {
          ctx.font = `${Math.max(10, headRadius * 0.4)}px system-ui`;
          ctx.fillStyle = 'rgba(255, 208, 128, 0.85)';
          ctx.fillText(`Respawn ${remaining}`, headScreenX, headScreenY + headRadius + Math.max(10, headRadius * 0.2));
        }
      }

      ctx.restore();
    });
  }

  private handlePointerMove(event: PointerEvent): void {
    if (!this.canvas) {
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    this.pointerTarget = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    this.pointerActive = true;

    const vector = this.getPointerVector();
    if (vector) {
      this.queueInputVector(vector);
    }
  }

  private handlePointerLeave(): void {
    this.pointerTarget = null;
    this.pointerActive = false;
    if (this.keyboardInput.up || this.keyboardInput.down || this.keyboardInput.left || this.keyboardInput.right) {
      this.queueInputVector(this.getKeyboardVector());
    } else {
      this.queueInputVector({ x: 0, y: 0 });
    }
  }

  private getPointerVector(): MovementVector | null {
    if (!this.pointerTarget || !this.viewTransform || !this.currentState) {
      return null;
    }

    const localId = this.deps.socket.getId();
    if (!localId) {
      return null;
    }

    const player = this.currentState.players.find((entry) => entry.id === localId);
    if (!player || !player.alive) {
      return null;
    }

    const head = player.head ?? player.segments?.[0];
    if (!head) {
      return null;
    }

    const worldX = (this.pointerTarget.x - this.viewTransform.offsetX) / this.viewTransform.scale;
    const worldY = (this.pointerTarget.y - this.viewTransform.offsetY) / this.viewTransform.scale;

    const dx = worldX - head.x;
    const dy = worldY - head.y;
    const distance = Math.hypot(dx, dy);

    if (!Number.isFinite(distance) || distance < 1) {
      return { x: 0, y: 0 };
    }

    return { x: dx / distance, y: dy / distance };
  }

  private queueInputVector(vector: MovementVector): void {
    if (!this.currentState || this.currentState.status !== 'running') {
      return;
    }

    const localId = this.deps.socket.getId();
    if (!localId) {
      return;
    }

    const player = this.currentState.players.find((entry) => entry.id === localId);
    if (!player || !player.alive) {
      return;
    }

    const normalized = this.normalizeVector(vector);
    if (this.vectorsAreClose(normalized, this.lastSentVector)) {
      return;
    }

    this.pendingVector = normalized;
    this.flushInputVector();
  }

  private normalizeVector(vector: MovementVector): MovementVector {
    const length = Math.hypot(vector.x, vector.y);
    if (!length) {
      return { x: 0, y: 0 };
    }
    return { x: vector.x / length, y: vector.y / length };
  }

  private vectorsAreClose(a: MovementVector, b: MovementVector): boolean {
    return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
  }

  private flushInputVector(): void {
    if (!this.pendingVector) {
      return;
    }

    const now = Date.now();
    const elapsed = now - this.lastInputAt;
    if (elapsed < INPUT_SEND_INTERVAL_MS) {
      if (this.inputTimeout !== null) {
        return;
      }
      const delay = Math.max(0, INPUT_SEND_INTERVAL_MS - elapsed);
      this.inputTimeout = window.setTimeout(() => {
        this.inputTimeout = null;
        this.flushInputVector();
      }, delay);
      return;
    }

    const vector = this.pendingVector;
    this.pendingVector = null;
    this.deps.socket.sendVoiceMinigameInput({ vector });
    this.lastInputAt = now;
    this.lastSentVector = vector;
  }
}
