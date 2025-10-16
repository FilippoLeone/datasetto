/**
 * Voice minigame coordinator (Snake)
 */
import type { MinigameControllerDeps } from './types';
import type { VoiceMinigamePlayerState, VoiceMinigameState } from '@/types';

const INPUT_COOLDOWN_MS = 90;
const DEFAULT_STATUS = 'No game running. Start a round to play with the channel!';

const END_REASON_LABELS: Record<string, string> = {
  ended_by_host: 'ended by host',
  all_players_left: 'all players left',
  everyone_crashed: 'everyone crashed',
  winner: 'winner decided',
  error: 'unexpected error',
};

const describeEndReason = (reason: string): string => {
  if (!reason) {
    return 'ended';
  }

  return END_REASON_LABELS[reason] ?? reason.replace(/_/g, ' ');
};

const KEY_DIRECTION_MAP: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
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
  private lastInputAt = 0;
  private canUseMinigame = false;
  private isViewPinned = false;

  constructor(deps: MinigameControllerDeps) {
    this.deps = deps;
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
        this.ctx.imageSmoothingEnabled = false;
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
    if (this.renderHandle !== null) {
      cancelAnimationFrame(this.renderHandle);
      this.renderHandle = null;
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
    const direction = KEY_DIRECTION_MAP[event.code];
    if (!direction) {
      return false;
    }

    if (!this.currentState || this.currentState.status !== 'running') {
      return false;
    }

    const localId = this.deps.socket.getId();
    if (!localId) {
      return false;
    }

    const player = this.currentState.players.find((entry) => entry.id === localId);
    if (!player) {
      return false;
    }

    const now = Date.now();
    if (now - this.lastInputAt < INPUT_COOLDOWN_MS) {
      return true;
    }

    this.deps.socket.sendVoiceMinigameInput(direction);
    this.lastInputAt = now;
    event.preventDefault();
    return true;
  }

  handleKeyUp(_event: KeyboardEvent): boolean {
    return false;
  }

  private bindUi(): void {
    this.deps.addListener(this.openButton, 'click', () => {
      if (!this.canUseMinigame) {
        return;
      }
      this.isViewPinned = true;
      this.syncStageMode();
    });

    this.deps.addListener(this.closeButton, 'click', () => {
      this.isViewPinned = false;
      this.syncStageMode();
    });

    this.deps.addListener(this.startButton, 'click', () => {
      this.lastEndReason = null;
      this.deps.socket.startVoiceMinigame({ type: 'snake' });
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
        this.deps.notifications.info(`Minigame finished — ${humanReason}`, 4500);
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
      this.applyState(null);
      this.lastEndReason = null;
      this.updateLauncherState();
      this.syncStageMode();
      return;
    }

    this.updateLauncherState();
    this.syncStageMode();
  }

  private applyState(state: VoiceMinigameState | null): void {
    this.currentState = state;
    if (!state) {
      this.lastInputAt = 0;
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

  private updateControls(): void {
    const state = this.currentState;
    const localId = this.deps.socket.getId();
    const voiceConnected = this.deps.state.get('voiceConnected');

    const isRunning = state?.status === 'running';
    const isHost = Boolean(state && localId && state.hostId === localId);
    const playerEntry = state?.players.find((entry) => entry.id === localId);
    const isRegistered = Boolean(playerEntry);
    const isAlive = Boolean(playerEntry?.alive);

    if (this.startButton) {
      const shouldShowStart = voiceConnected && !isRunning;
      this.startButton.classList.toggle('hidden', !shouldShowStart);
      this.startButton.toggleAttribute('disabled', !shouldShowStart);
    }

    if (this.endButton) {
      const shouldShowEnd = voiceConnected && isRunning && isHost;
      this.endButton.classList.toggle('hidden', !shouldShowEnd);
      this.endButton.toggleAttribute('disabled', !shouldShowEnd);
    }

    if (this.joinButton) {
      const shouldShowJoin = Boolean(state && state.status === 'running' && (!isRegistered || !isAlive));
      this.joinButton.classList.toggle('hidden', !shouldShowJoin);
      if (shouldShowJoin && !isAlive && isRegistered) {
        this.joinButton.textContent = 'Respawn';
      } else {
        this.joinButton.textContent = 'Join';
      }
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
      this.statusEl.textContent = this.lastEndReason ? `Last round: ${this.lastEndReason}` : DEFAULT_STATUS;
      return;
    }

    if (state.status === 'running') {
      const alive = state.players.filter((player) => player.alive).length;
      const total = state.players.length;
      this.statusEl.textContent = `Game in progress — ${alive}/${total} snakes alive`;
      return;
    }

    this.statusEl.textContent = this.lastEndReason
      ? `Round ended — ${this.lastEndReason}`
      : 'Round ended';
  }

  private renderScores(): void {
    if (!this.scoresEl) {
      return;
    }

    const state = this.currentState;
    const localId = this.deps.socket.getId();
    const list = this.scoresEl;

    list.innerHTML = '';

    if (!state || state.players.length === 0) {
      const item = document.createElement('li');
      item.className = 'text-2xs text-text-muted';
      item.textContent = 'No players yet.';
      list.appendChild(item);
      return;
    }

    state.players.forEach((player, index) => {
      const item = document.createElement('li');
      item.className = 'flex items-center justify-between gap-3 text-2xs';

      const left = document.createElement('span');
      left.className = 'flex items-center gap-2 truncate';

      const marker = document.createElement('span');
      marker.className = 'inline-block w-2.5 h-2.5 rounded-full flex-shrink-0';
      marker.style.backgroundColor = player.color;

      const label = document.createElement('span');
      label.className = 'truncate';
      label.textContent = `${index + 1}. ${player.name}${player.id === localId ? ' (You)' : ''}`;

      left.appendChild(marker);
      left.appendChild(label);

      const right = document.createElement('span');
      right.className = 'font-semibold text-text-normal tabular-nums';
      right.textContent = `${player.score}`;

      if (!player.alive) {
        label.classList.add('opacity-70');
        right.classList.add('opacity-60');
      }

      item.appendChild(left);
      item.appendChild(right);
      list.appendChild(item);
    });
  }

  private resizeCanvas(): void {
    if (!this.canvas) {
      return;
    }

    const width = Math.max(this.canvas.clientWidth, 200);
    const height = Math.max(this.canvas.clientHeight || width, 200);
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

    const label = this.currentState?.status === 'running' ? 'Return to Minigame' : 'Minigame';
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
    if (this.renderHandle !== null) {
      return;
    }

    this.renderHandle = window.requestAnimationFrame(() => {
      this.renderHandle = null;
      this.drawState();
    });
  }

  private drawState(): void {
    if (!this.canvas || !this.ctx) {
      return;
    }

    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;
    ctx.fillStyle = '#0b101a';
    ctx.fillRect(0, 0, width, height);

    const state = this.currentState;
    if (!state) {
      this.drawPlaceholder(ctx, width, height);
      return;
    }

    const { board } = state;
    const cellWidth = width / board.width;
    const cellHeight = height / board.height;

    if (state.food) {
      ctx.fillStyle = '#ff4757';
      ctx.fillRect(
        state.food.x * cellWidth + 2,
        state.food.y * cellHeight + 2,
        Math.max(cellWidth - 4, 2),
        Math.max(cellHeight - 4, 2)
      );
    }

    state.players.forEach((player) => {
      this.drawPlayer(ctx, player, cellWidth, cellHeight);
    });
  }

  private drawPlaceholder(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.fillStyle = '#162034';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#2c3e50';
    const fontSize = Math.max(Math.floor(Math.min(width, height) / 18), 14);
    ctx.font = `600 ${fontSize}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Launch a voice minigame to get started', width / 2, height / 2);
  }

  private drawPlayer(
    ctx: CanvasRenderingContext2D,
    player: VoiceMinigamePlayerState,
    cellWidth: number,
    cellHeight: number
  ): void {
    ctx.save();
    ctx.fillStyle = player.color;
    const baseAlpha = player.alive ? 1 : 0.35;

    player.body.forEach((segment, index) => {
      const x = segment.x * cellWidth;
      const y = segment.y * cellHeight;
      const inset = index === 0 ? 1 : 2;
      const segmentAlpha = index === 0 ? baseAlpha : baseAlpha * 0.85;
      ctx.globalAlpha = Math.max(segmentAlpha, 0.2);
      ctx.fillRect(x + inset, y + inset, Math.max(cellWidth - inset * 2, 2), Math.max(cellHeight - inset * 2, 2));

      if (index === 0) {
        ctx.strokeStyle = '#ffffffaa';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + inset, y + inset, Math.max(cellWidth - inset * 2, 2), Math.max(cellHeight - inset * 2, 2));
      }
    });

    ctx.restore();
  }
}
