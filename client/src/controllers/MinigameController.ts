/**
 * Voice minigame coordinator (Snake)
 */
import type { MinigameControllerDeps } from './types';
import type {
  VoiceMinigamePlayerState,
  VoiceMinigameState,
  VoicePeerEvent,
  VoiceMinigameFood,
  VoiceMinigameHazard,
} from '@/types';
const INPUT_COOLDOWN_MS = 45;
const DEFAULT_STATUS = 'No game running. Start a round to play with the channel!';
const HYPER_FOOD_LIFETIME_MS = 8_000;

const END_REASON_LABELS: Record<string, string> = {
  ended_by_host: 'ended by host',
  all_players_left: 'all players left',
  everyone_crashed: 'everyone crashed',
  winner: 'winner decided',
  error: 'unexpected error',
  arena_closed: 'arena collapsed',
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
  private voiceParticipants: Map<string, { id: string; name: string }> = new Map();
  private cursorTarget: { x: number; y: number } | null = null;
  private lastCursorDirection: 'up' | 'down' | 'left' | 'right' | null = null;

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
    const handled = this.attemptDirectionChange(direction);
    if (handled) {
      event.preventDefault();
    }
    return handled;
  }

  handleKeyUp(_event: KeyboardEvent): boolean {
    return false;
  }

  private attemptDirectionChange(direction: 'up' | 'down' | 'left' | 'right'): boolean {
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
      return false;
    }

    if (player.direction === direction) {
      return false;
    }

    this.deps.socket.sendVoiceMinigameInput(direction);
    this.lastInputAt = now;
    if (this.cursorTarget) {
      this.lastCursorDirection = direction;
    }
    return true;
  }

  private handlePointerMove(event: PointerEvent): void {
    if (!this.canvas) {
      return;
    }

    this.cursorTarget = {
      x: event.offsetX,
      y: event.offsetY,
    };

    this.evaluateCursorSteering();
  }

  private handlePointerLeave(): void {
    this.cursorTarget = null;
    this.lastCursorDirection = null;
  }

  private evaluateCursorSteering(): void {
    if (!this.canvas || !this.cursorTarget) {
      return;
    }

    const state = this.currentState;
    if (!state || state.status !== 'running') {
      return;
    }

    const localId = this.deps.socket.getId();
    if (!localId) {
      return;
    }

    const player = state.players.find((entry) => entry.id === localId);
    if (!player || !player.alive || player.body.length === 0) {
      return;
    }

    const head = player.body[0];
    if (!head) {
      return;
    }

    const cellWidth = this.canvas.width / state.board.width;
    const cellHeight = this.canvas.height / state.board.height;

    const headX = (head.x + 0.5) * cellWidth;
    const headY = (head.y + 0.5) * cellHeight;

    const dx = this.cursorTarget.x - headX;
    const dy = this.cursorTarget.y - headY;

    const minDistance = Math.max(cellWidth, cellHeight) * 0.2;
    if (Math.abs(dx) < minDistance && Math.abs(dy) < minDistance) {
      return;
    }

    let desired: 'up' | 'down' | 'left' | 'right';
    if (Math.abs(dx) > Math.abs(dy)) {
      desired = dx >= 0 ? 'right' : 'left';
    } else {
      desired = dy >= 0 ? 'down' : 'up';
    }

    if (desired === this.lastCursorDirection) {
      return;
    }

    const opposite: Record<'up' | 'down' | 'left' | 'right', 'up' | 'down' | 'left' | 'right'> = {
      up: 'down',
      down: 'up',
      left: 'right',
      right: 'left',
    };

    if (player.direction === opposite[desired]) {
      return;
    }

    this.attemptDirectionChange(desired);
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

    this.deps.addListener(this.canvas, 'pointermove', (event) => {
      this.handlePointerMove(event as PointerEvent);
    });

    this.deps.addListener(this.canvas, 'pointerleave', () => {
      this.handlePointerLeave();
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
      this.updateControls();
      return;
    }

    this.updateLauncherState();
    this.syncStageMode();
    this.updateControls();
  }

  private applyState(state: VoiceMinigameState | null): void {
    this.currentState = state;
    if (!state || state.status !== 'running') {
      this.lastInputAt = 0;
      this.lastCursorDirection = null;
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
      const canStart = this.canUseMinigame && voiceConnected && !isRunning;
      this.startButton.classList.toggle('hidden', !this.canUseMinigame);
      this.startButton.toggleAttribute('disabled', !canStart);
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
      const parts: string[] = [`${alive}/${total} snakes alive`];
      if (state.tickIntervalMs) {
        const movesPerSecond = 1000 / state.tickIntervalMs;
        parts.push(`${movesPerSecond.toFixed(1)} moves/s`);
      }

      if (state.hazardRing > 0) {
        parts.push(`Sudden death ring ${state.hazardRing}`);
      } else if (state.suddenDeathAt) {
        const remainingMs = Math.max(0, state.suddenDeathAt - Date.now());
        const remainingSeconds = Math.ceil(remainingMs / 1000);
        if (remainingSeconds > 0) {
          parts.push(`Sudden death in ${remainingSeconds}s`);
        }
      }

      if (state.food?.type === 'hyper') {
        parts.push('Hyper fruit on field');
      }

      this.statusEl.textContent = `Game in progress — ${parts.join(' · ')}`;
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

    state.players.forEach((player, index) => {
      const item = document.createElement('li');
      item.className = 'flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-2xs';

      const nameWrap = document.createElement('div');
      nameWrap.className = 'flex items-center gap-2 truncate';

      const rank = document.createElement('span');
      rank.className = 'w-6 text-right font-semibold text-text-muted';
      rank.textContent = `${index + 1}.`;

      const marker = document.createElement('span');
      marker.className = 'inline-block h-2.5 w-2.5 rounded-full flex-shrink-0';
      marker.style.backgroundColor = player.color;

      const name = document.createElement('span');
      name.className = 'truncate font-semibold text-text-normal';
      name.textContent = player.name;
      if (player.id === localId) {
        name.classList.add('text-brand-primary');
      }

      if (!player.alive) {
        name.classList.add('opacity-70');
      }

      nameWrap.append(rank, marker, name);

      const scoresWrap = document.createElement('div');
      scoresWrap.className = 'flex items-center gap-2';

      const score = document.createElement('span');
      score.className = 'font-semibold text-text-normal tabular-nums';
      score.textContent = `${player.score} pts`;
      if (!player.alive) {
        score.classList.add('opacity-60');
      }

      scoresWrap.append(score);

      const combo = document.createElement('span');
      combo.className = 'hidden rounded-full border border-brand-primary/40 bg-brand-primary/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider';
      const currentCombo = player.combo ?? 0;
      if (currentCombo > 1) {
        combo.textContent = `Combo x${currentCombo}`;
        combo.classList.remove('hidden');
        combo.classList.add('text-brand-primary');
      } else {
        const longestCombo = player.longestCombo ?? 0;
        if (longestCombo > 1) {
          combo.textContent = `Best x${longestCombo}`;
          combo.classList.remove('hidden');
          combo.classList.add('text-text-muted');
        }
      }

      if (!player.alive) {
        combo.classList.add('border-white/15');
      }

      if (!combo.classList.contains('hidden')) {
        scoresWrap.append(combo);
      }

      const aliveBadge = document.createElement('span');
      aliveBadge.className = player.alive
        ? 'rounded-full bg-success/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-success'
        : 'rounded-full bg-danger/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-danger';
      aliveBadge.textContent = player.alive ? 'Alive' : 'Out';

      scoresWrap.append(aliveBadge);

      item.append(nameWrap, scoresWrap);
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
    ctx.fillStyle = '#050a14';
    ctx.fillRect(0, 0, width, height);

    const state = this.currentState;
    if (!state) {
      this.drawPlaceholder(ctx, width, height);
      return;
    }

    const { board } = state;
    const cellWidth = width / board.width;
    const cellHeight = height / board.height;

    this.drawGrid(ctx, board, cellWidth, cellHeight, width, height);

    if (state.hazards?.length) {
      this.drawHazards(ctx, state.hazards, cellWidth, cellHeight);
    }

    if (state.food) {
      this.drawFood(ctx, state.food, cellWidth, cellHeight);
    }

    state.players.forEach((player) => {
      this.drawPlayer(ctx, player, cellWidth, cellHeight);
    });

    this.evaluateCursorSteering();
  }

  private drawPlaceholder(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.fillStyle = '#0f1727';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#334866';
    const fontSize = Math.max(Math.floor(Math.min(width, height) / 18), 14);
    ctx.font = `600 ${fontSize}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Launch the turbo snake arena to get started', width / 2, height / 2);
  }

  private drawPlayer(
    ctx: CanvasRenderingContext2D,
    player: VoiceMinigamePlayerState,
    cellWidth: number,
    cellHeight: number
  ): void {
    ctx.save();
    ctx.fillStyle = player.color;
    const alive = Boolean(player.alive);
    const combo = player.combo ?? 0;

    if (alive && combo > 1) {
      ctx.shadowColor = 'rgba(255, 200, 40, 0.55)';
      ctx.shadowBlur = Math.max(cellWidth, cellHeight) * 0.65;
    }

    player.body.forEach((segment, index) => {
      const x = segment.x * cellWidth;
      const y = segment.y * cellHeight;
      const inset = index === 0 ? Math.max(1, Math.min(cellWidth, cellHeight) * 0.08) : Math.max(2, Math.min(cellWidth, cellHeight) * 0.18);
      const segmentAlpha = index === 0 ? 1 : 0.78;
      ctx.globalAlpha = alive ? segmentAlpha : segmentAlpha * 0.35;

      const drawWidth = Math.max(cellWidth - inset * 2, 2);
      const drawHeight = Math.max(cellHeight - inset * 2, 2);

      ctx.fillRect(x + inset, y + inset, drawWidth, drawHeight);

      if (index === 0) {
        ctx.globalAlpha = alive ? 0.9 : 0.45;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
        ctx.lineWidth = Math.max(1, Math.min(cellWidth, cellHeight) * 0.1);
        ctx.strokeRect(x + inset, y + inset, drawWidth, drawHeight);

        if (combo > 1 && alive) {
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = 'rgba(255, 200, 60, 0.85)';
          ctx.lineWidth = Math.max(1, Math.min(cellWidth, cellHeight) * 0.15);
          ctx.strokeRect(x + inset + 1, y + inset + 1, Math.max(drawWidth - 2, 1), Math.max(drawHeight - 2, 1));
        }
      }
    });

    ctx.restore();
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D,
    board: { width: number; height: number },
    cellWidth: number,
    cellHeight: number,
    width: number,
    height: number
  ): void {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;

    for (let x = 1; x < board.width; x += 1) {
      const pos = x * cellWidth;
      ctx.beginPath();
      ctx.moveTo(Math.round(pos) + 0.5, 0);
      ctx.lineTo(Math.round(pos) + 0.5, height);
      ctx.stroke();
    }

    for (let y = 1; y < board.height; y += 1) {
      const pos = y * cellHeight;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(pos) + 0.5);
      ctx.lineTo(width, Math.round(pos) + 0.5);
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawHazards(
    ctx: CanvasRenderingContext2D,
    hazards: VoiceMinigameHazard[],
    cellWidth: number,
    cellHeight: number
  ): void {
    ctx.save();
    ctx.fillStyle = 'rgba(255, 90, 90, 0.24)';
    hazards.forEach(({ x, y }) => {
      ctx.fillRect(x * cellWidth, y * cellHeight, cellWidth, cellHeight);
    });

    ctx.restore();
  }

  private drawFood(
    ctx: CanvasRenderingContext2D,
    food: VoiceMinigameFood,
    cellWidth: number,
    cellHeight: number
  ): void {
    const x = food.x * cellWidth;
    const y = food.y * cellHeight;
    const inset = Math.max(2, Math.min(cellWidth, cellHeight) * 0.18);
    const w = Math.max(cellWidth - inset * 2, 2);
    const h = Math.max(cellHeight - inset * 2, 2);

    if (food.type === 'hyper') {
      const cx = x + cellWidth / 2;
      const cy = y + cellHeight / 2;
      const gradient = ctx.createRadialGradient(cx, cy, Math.min(inset, 6), cx, cy, Math.max(cellWidth, cellHeight) / 2);
      gradient.addColorStop(0, 'rgba(255, 220, 90, 0.95)');
      gradient.addColorStop(1, 'rgba(255, 220, 90, 0.05)');
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, cellWidth, cellHeight);

      ctx.fillStyle = '#ffe066';
      ctx.fillRect(x + inset, y + inset, w, h);

      if (food.expiresAt) {
        const remaining = Math.max(0, food.expiresAt - Date.now());
        const ratio = Math.max(0, Math.min(1, remaining / HYPER_FOOD_LIFETIME_MS));
        ctx.strokeStyle = 'rgba(255, 236, 153, 0.9)';
        ctx.lineWidth = Math.max(1, Math.min(cellWidth, cellHeight) * 0.18);
        ctx.beginPath();
        const radius = Math.max(cellWidth, cellHeight) / 2 - ctx.lineWidth / 2;
        ctx.arc(cx, cy, Math.max(radius, 2), -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio, false);
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = '#ff4757';
      ctx.fillRect(x + inset, y + inset, w, h);
    }
  }
}
