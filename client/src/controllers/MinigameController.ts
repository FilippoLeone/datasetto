/**
 * Voice minigame coordinator for the Slither arena
 */
import type { MinigameControllerDeps } from './types';
import type { PacmanState, VoiceMinigamePellet, VoiceMinigamePlayerState, VoiceMinigameState, VoicePeerEvent } from '@/types';

// Network optimization: 50ms interval = ~20 inputs/sec (was 16ms = ~62 inputs/sec)
const INPUT_SEND_INTERVAL_MS = 50;
// Force refresh input every 200ms even if direction unchanged (keepalive)
const INPUT_REFRESH_INTERVAL_MS = 200;
// Threshold for considering vectors as "same direction" (radians)
const INPUT_DEDUP_THRESHOLD = 0.05;
const DEFAULT_STATUS = 'No slither arena open. Start a round to glide together!';
const GRID_SPACING = 80;
const BACKGROUND_COLOR = '#0b101a';
const SELECTION_BUTTON_WIDTH = 220;
const SELECTION_BUTTON_HEIGHT = 90;
const SELECTION_BUTTON_GAP = 26;

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
type PacmanDirection = 'up' | 'down' | 'left' | 'right';
const KEY_DIRECTION: Record<string, PacmanDirection | null> = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
};

type ViewTransform = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

class SpriteCache {
  private cache = new Map<string, HTMLCanvasElement>();

  get(color: string, type: 'body' | 'head' | 'pellet'): HTMLCanvasElement {
    const key = `${type}-${color}`;
    let canvas = this.cache.get(key);
    if (!canvas) {
      canvas = this.create(color, type);
      this.cache.set(key, canvas);
    }
    return canvas;
  }

  private create(color: string, type: 'body' | 'head' | 'pellet'): HTMLCanvasElement {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 2;

    if (type === 'pellet') {
      const glow = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
      glow.addColorStop(0, color);
      glow.addColorStop(0.4, color);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, size, size);
      
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 0.95;
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      const shadow = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.2, r * 0.8, cx, cy, r);
      shadow.addColorStop(0, 'rgba(0,0,0,0)');
      shadow.addColorStop(1, 'rgba(0,0,0,0.4)');
      ctx.fillStyle = shadow;
      ctx.fill();

      const highlight = ctx.createRadialGradient(cx - r * 0.4, cy - r * 0.4, 0, cx - r * 0.4, cy - r * 0.4, r * 0.6);
      highlight.addColorStop(0, 'rgba(255,255,255,0.5)');
      highlight.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = highlight;
      ctx.fill();
    }

    return canvas;
  }
}

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
  size: number;
};

class ParticleSystem {
  private particles: Particle[] = [];

  spawn(x: number, y: number, color: string, count: number, speed: number, spread: number = Math.PI * 2) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * spread;
      const v = Math.random() * speed;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * v,
        vy: Math.sin(angle) * v,
        life: 1.0,
        color,
        size: Math.random() * 0.6 + 0.4,
      });
    }
  }

  update() {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.02;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D, offsetX: number, offsetY: number, scale: number) {
    ctx.save();
    for (const p of this.particles) {
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      const size = p.size * scale * (0.5 + p.life * 0.5);
      ctx.beginPath();
      ctx.arc(offsetX + p.x * scale, offsetY + p.y * scale, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

export class MinigameController {
  private deps: MinigameControllerDeps;
  private disposers: Array<() => void> = [];
  private stage: HTMLElement | null = null;
  private voiceStage: HTMLElement | null = null;
  private mainContent: HTMLElement | null = null;
  private container: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private openButton: HTMLButtonElement | null = null;
  private launcherStatusEl: HTMLElement | null = null;
  private closeButton: HTMLButtonElement | null = null;
  private startButton: HTMLButtonElement | null = null;
  private endButton: HTMLButtonElement | null = null;
  private joinButton: HTMLButtonElement | null = null;
  private leaveButton: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private scoresEl: HTMLElement | null = null;
  private gameSelectorBtn: HTMLButtonElement | null = null;
  private gameSelectorDropdown: HTMLElement | null = null;
  private gameSelectorLabel: HTMLElement | null = null;
  private gameSelectorIcon: HTMLElement | null = null;
  private selectedGameType: 'slither' | 'pacman' = 'slither';
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
  private pacmanKeyHistory: PacmanDirection[] = [];
  private isMobile: boolean;
  private spriteCache = new SpriteCache();
  private particles = new ParticleSystem();
  private stateBuffer: Array<{ state: VoiceMinigameState; timestamp: number }> = [];
  private pelletCache: Map<string, VoiceMinigamePellet> | null = null; // Delta compression cache
  private readonly INTERPOLATION_DELAY = 100; // ms delay to allow for smooth interpolation
  private readonly PACMAN_INTERPOLATION_DELAY = 40;

  constructor(deps: MinigameControllerDeps) {
    this.deps = deps;
    this.isMobile = window.matchMedia('(max-width: 1024px)').matches;
  }

  initialize(): void {
    this.stage = this.deps.elements['minigame-stage'] ?? null;
    this.voiceStage = this.deps.elements['voice-call-stage'] ?? null;
    this.mainContent = document.querySelector('.main-content');
    this.container = this.deps.elements['minigame-container'] ?? null;
    this.canvas = (this.deps.elements['minigame-canvas'] as HTMLCanvasElement) ?? null;
    this.openButton = (this.deps.elements['minigame-open'] as HTMLButtonElement) ?? null;
    this.launcherStatusEl = this.deps.elements['minigame-launcher-status'] ?? null;
    this.closeButton = (this.deps.elements['minigame-close'] as HTMLButtonElement) ?? null;
    this.startButton = (this.deps.elements['minigame-start'] as HTMLButtonElement) ?? null;
    this.endButton = (this.deps.elements['minigame-end'] as HTMLButtonElement) ?? null;
    this.joinButton = (this.deps.elements['minigame-join'] as HTMLButtonElement) ?? null;
    this.leaveButton = (this.deps.elements['minigame-leave'] as HTMLButtonElement) ?? null;
    this.statusEl = this.deps.elements['minigame-status'] ?? null;
    this.scoresEl = this.deps.elements['minigame-scores'] ?? null;
    this.gameSelectorBtn = document.getElementById('game-selector-btn') as HTMLButtonElement | null;
    this.gameSelectorDropdown = document.getElementById('game-selector-dropdown');
    this.gameSelectorLabel = document.getElementById('game-selector-label');
    this.gameSelectorIcon = document.getElementById('game-selector-icon');

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

    if (this.currentState?.type === 'pacman') {
      const direction = KEY_DIRECTION[code] ?? null;
      this.updatePacmanKeyHistory(direction, pressed);
    }

    if (this.pointerActive && this.currentState?.type !== 'pacman') {
      return true;
    }

    const vector = this.getKeyboardVector();
    this.queueInputVector(vector);
    return true;
  }

  private getKeyboardVector(): MovementVector {
    if (this.currentState?.type === 'pacman') {
      return this.getPacmanVector();
    }

    const x = (this.keyboardInput.right ? 1 : 0) - (this.keyboardInput.left ? 1 : 0);
    const y = (this.keyboardInput.down ? 1 : 0) - (this.keyboardInput.up ? 1 : 0);
    if (x === 0 && y === 0) {
      return { x: 0, y: 0 };
    }

    const length = Math.hypot(x, y) || 1;
    return { x: x / length, y: y / length };
  }

  private getPacmanVector(): MovementVector {
    for (let i = this.pacmanKeyHistory.length - 1; i >= 0; i--) {
      const direction = this.pacmanKeyHistory[i];
      if (this.isPacmanDirectionActive(direction)) {
        return this.directionToVector(direction);
      }
    }

    // Fallback to current key state ordering if history was cleared
    if (this.keyboardInput.up) return this.directionToVector('up');
    if (this.keyboardInput.left) return this.directionToVector('left');
    if (this.keyboardInput.down) return this.directionToVector('down');
    if (this.keyboardInput.right) return this.directionToVector('right');

    return { x: 0, y: 0 };
  }

  private isPacmanDirectionActive(direction: PacmanDirection): boolean {
    switch (direction) {
      case 'up':
        return this.keyboardInput.up;
      case 'down':
        return this.keyboardInput.down;
      case 'left':
        return this.keyboardInput.left;
      case 'right':
        return this.keyboardInput.right;
      default:
        return false;
    }
  }

  private directionToVector(direction: PacmanDirection): MovementVector {
    switch (direction) {
      case 'up':
        return { x: 0, y: -1 };
      case 'down':
        return { x: 0, y: 1 };
      case 'left':
        return { x: -1, y: 0 };
      case 'right':
      default:
        return { x: 1, y: 0 };
    }
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

  private updatePacmanKeyHistory(direction: PacmanDirection | null, pressed: boolean): void {
    if (!direction) {
      return;
    }

    this.pacmanKeyHistory = this.pacmanKeyHistory.filter((dir) => dir !== direction);
    if (pressed) {
      this.pacmanKeyHistory.push(direction);
    }
  }

  private bindUi(): void {
    this.deps.addListener(this.openButton, 'click', () => {
      if (!this.canUseMinigame) {
        this.deps.notifications.info('Join a voice channel to launch the arena.', 3000);
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
      this.deps.socket.startVoiceMinigame({ type: this.selectedGameType });
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

    // Game selector dropdown
    this.deps.addListener(this.gameSelectorBtn, 'click', () => {
      this.toggleGameSelector();
    });

    // Game option clicks
    const gameOptions = document.querySelectorAll('.game-option');
    gameOptions.forEach((option) => {
      this.deps.addListener(option, 'click', () => {
        const gameType = option.getAttribute('data-game') as 'slither' | 'pacman';
        if (gameType) {
          this.selectGame(gameType);
        }
      });
    });

    // Close dropdown when clicking outside
    this.deps.addListener(document, 'click', (event) => {
      const target = event.target as HTMLElement;
      const wrapper = document.getElementById('game-selector-wrapper');
      if (wrapper && !wrapper.contains(target)) {
        this.closeGameSelector();
      }
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

    this.deps.addListener(this.canvas, 'click', (event) => {
      this.handleCanvasClick(event as MouseEvent);
    });

    // Initialize game selector display
    this.updateGameSelectorDisplay();
  }

  private toggleGameSelector(): void {
    if (!this.gameSelectorDropdown) return;
    const isHidden = this.gameSelectorDropdown.classList.contains('hidden');
    if (isHidden) {
      this.gameSelectorDropdown.classList.remove('hidden');
    } else {
      this.gameSelectorDropdown.classList.add('hidden');
    }
  }

  private closeGameSelector(): void {
    if (!this.gameSelectorDropdown) return;
    this.gameSelectorDropdown.classList.add('hidden');
  }

  private selectGame(gameType: 'slither' | 'pacman'): void {
    this.selectedGameType = gameType;
    this.updateGameSelectorDisplay();
    this.closeGameSelector();

    // If a game is already running, switch to the new game type
    if (this.currentState?.status === 'running') {
      // End current game and start new one
      this.deps.socket.endVoiceMinigame();
      setTimeout(() => {
        this.deps.socket.startVoiceMinigame({ type: gameType });
      }, 300);
    }
  }

  private updateGameSelectorDisplay(): void {
    if (!this.gameSelectorLabel || !this.gameSelectorIcon) return;

    const currentGameType = this.currentState?.type ?? this.selectedGameType;

    if (currentGameType === 'pacman') {
      this.gameSelectorLabel.textContent = 'Pacman Chase';
      this.gameSelectorIcon.textContent = '👻';
    } else {
      this.gameSelectorLabel.textContent = 'Slither Arena';
      this.gameSelectorIcon.textContent = '🐍';
    }

    // Update dropdown active states
    const gameOptions = document.querySelectorAll('.game-option');
    gameOptions.forEach((option) => {
      const gameType = option.getAttribute('data-game');
      const isActive = gameType === currentGameType;
      option.setAttribute('data-active', isActive ? 'true' : 'false');
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
      this.stage?.classList.add('hidden');
      this.openButton?.classList.add('hidden');
      this.closeButton?.classList.add('hidden');
      return;
    }

    const voiceConnected = typeof forceConnected === 'boolean'
      ? forceConnected
      : this.deps.state.get('voiceConnected');

    this.canUseMinigame = Boolean(voiceConnected);

    if (!this.canUseMinigame) {
      this.isViewPinned = false;
      this.container.classList.add('hidden');
      if (this.stage) {
        this.stage.classList.add('hidden');
        this.stage.setAttribute('aria-hidden', 'true');
      }
      this.mainContent?.classList.remove('minigame-active');
      this.resetVoiceParticipants();
      this.applyState(null);
      this.lastEndReason = null;
    }

    this.updateLauncherState();
    this.syncStageMode();
    this.updateControls();
  }

  private applyState(state: VoiceMinigameState | null): void {
    const now = Date.now();

    // Process delta-compressed pellet data if present
    if (state && state.pelletData) {
      state = this.processPelletDelta(state);
    }

    // Detect deaths for particle effects (using the latest authoritative state)
    if (this.currentState && state && state.status === 'running') {
      this.currentState.players.forEach((prev) => {
        const curr = state.players.find((p) => p.id === prev.id);
        if (prev.alive && curr && !curr.alive) {
          const head = prev.head ?? prev.segments?.[0];
          if (head) {
            this.particles.spawn(head.x, head.y, prev.color, 30, 1.5);
            this.deps.soundFX.play('error', 0.2);
          }
        }
      });
    }

    const previousGameType = this.currentState?.type ?? null;

    if (state) {
      this.stateBuffer.push({ state, timestamp: now });
      // Keep buffer clean
      if (this.stateBuffer.length > 20) {
        this.stateBuffer.shift();
      }
    } else {
      this.stateBuffer = [];
    }

    // We still update currentState immediately for non-render logic (UI, scores, etc)
    // But rendering will use getRenderState()
    this.currentState = state;

    if (state?.type === 'pacman') {
      this.pointerActive = false;
      this.pointerTarget = null;
      if (previousGameType !== 'pacman') {
        this.pacmanKeyHistory = [];
      }
    } else if (previousGameType === 'pacman') {
      this.pacmanKeyHistory = [];
    }

    if (!state || state.status !== 'running') {
      this.resetInputState();
      this.viewCenter = null;
      this.currentScale = 1;
      this.viewTransform = null;
      this.pelletCache = null; // Clear pellet cache when game ends
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

  /**
   * Process delta-compressed pellet data from server.
   * Reconstructs full pellets array from delta updates.
   */
  private processPelletDelta(state: VoiceMinigameState): VoiceMinigameState {
    const pelletData = state.pelletData;
    if (!pelletData) {
      return state;
    }

    let pellets: VoiceMinigamePellet[];

    if (pelletData.full && pelletData.pellets) {
      // Full sync - use server's pellet list directly
      pellets = pelletData.pellets;
      // Cache pellets by ID for delta processing
      this.pelletCache = new Map(pellets.map(p => [p.id, p]));
    } else {
      // Delta sync - apply changes to cached pellets
      if (!this.pelletCache) {
        // No cache yet, request full sync by returning empty (will trigger resync on next update)
        pellets = [];
        this.pelletCache = new Map();
      } else {
        // Apply removals
        if (pelletData.removed) {
          for (const id of pelletData.removed) {
            this.pelletCache.delete(id);
          }
        }
        // Apply additions
        if (pelletData.added) {
          for (const pellet of pelletData.added) {
            this.pelletCache.set(pellet.id, pellet);
          }
        }
        pellets = Array.from(this.pelletCache.values());
      }
    }

    // Return state with reconstructed pellets array
    return {
      ...state,
      pellets,
    };
  }

  private getRenderState(): VoiceMinigameState | null {
    if (this.stateBuffer.length === 0) {
      return this.currentState;
    }

    const now = Date.now();
    const interpolationDelay = this.currentState?.type === 'pacman'
      ? this.PACMAN_INTERPOLATION_DELAY
      : this.INTERPOLATION_DELAY;
    const renderTime = now - interpolationDelay;

    // Find the two states surrounding renderTime
    let prevIndex = -1;
    for (let i = this.stateBuffer.length - 1; i >= 0; i--) {
      if (this.stateBuffer[i].timestamp <= renderTime) {
        prevIndex = i;
        break;
      }
    }

    // If we are behind the buffer (lag), return the oldest
    if (prevIndex === -1) {
      return this.stateBuffer[0].state;
    }

    // If we are at the newest, return it
    if (prevIndex === this.stateBuffer.length - 1) {
      return this.stateBuffer[prevIndex].state;
    }

    const prev = this.stateBuffer[prevIndex];
    const next = this.stateBuffer[prevIndex + 1];

    const total = next.timestamp - prev.timestamp;
    const elapsed = renderTime - prev.timestamp;
    const alpha = Math.max(0, Math.min(1, elapsed / total));

    return this.interpolateState(prev.state, next.state, alpha);
  }

  private interpolateState(prev: VoiceMinigameState, next: VoiceMinigameState, alpha: number): VoiceMinigameState {
    // Deep clone next state to avoid mutating buffer
    const interpolated: VoiceMinigameState = {
      ...next,
      players: next.players.map(p => ({ ...p, segments: p.segments ? [...p.segments] : undefined })),
      pellets: next.pellets // Pellets don't move usually, so no interpolation needed
    };

    interpolated.players.forEach(nextPlayer => {
      const prevPlayer = prev.players.find(p => p.id === nextPlayer.id);
      if (!prevPlayer || !prevPlayer.alive || !nextPlayer.alive) return;

      if (next.type === 'pacman') {
        // Linear interpolation for Pacman
        if (prevPlayer.x !== undefined && nextPlayer.x !== undefined) {
          nextPlayer.x = this.lerp(prevPlayer.x, nextPlayer.x, alpha);
        }
        if (prevPlayer.y !== undefined && nextPlayer.y !== undefined) {
          nextPlayer.y = this.lerp(prevPlayer.y, nextPlayer.y, alpha);
        }
        return;
      }

      // Interpolate Head
      const prevHead = prevPlayer.head ?? prevPlayer.segments?.[0];
      const nextHead = nextPlayer.head ?? nextPlayer.segments?.[0];

      if (prevHead && nextHead) {
        const ix = this.lerp(prevHead.x, nextHead.x, alpha);
        const iy = this.lerp(prevHead.y, nextHead.y, alpha);
        
        // Apply to head property if exists
        if (nextPlayer.head) {
          nextPlayer.head = { x: ix, y: iy };
        }

        // Apply to segments
        // Strategy: Shift the entire body by the delta of the head interpolation
        // This prevents "accordion" effects when segment counts change
        const dx = ix - nextHead.x;
        const dy = iy - nextHead.y;

        if (nextPlayer.segments) {
          nextPlayer.segments = nextPlayer.segments.map(s => ({
            x: s.x + dx,
            y: s.y + dy
          }));
        }
      }
    });

    return interpolated;
  }

  private resetInputState(): void {
    this.pointerActive = false;
    this.pointerTarget = null;
    this.keyboardInput = { up: false, down: false, left: false, right: false };
    this.pacmanKeyHistory = [];
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

    // Start button - show when no game running
    if (this.startButton) {
      const shouldShowStart = voiceConnected && !isRunning;
      this.startButton.classList.toggle('hidden', !shouldShowStart);
      this.startButton.textContent = `Start ${this.selectedGameType === 'pacman' ? 'Pacman' : 'Slither'}`;
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

    // Update game selector display based on current game
    this.updateGameSelectorDisplay();
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
      if (state.type === 'pacman') {
        this.statusEl.textContent = this.buildPacmanStatus(state);
        return;
      }
      const alive = state.players.filter((player) => player.alive).length;
      const total = state.players.length;
      const pellets = state.pellets.length;
      const top = state.leaderboard?.[0];
      const parts: string[] = [`${alive}/${total} snakes slithering`, `${pellets} pellets`];
      if (top) {
        parts.push(`Top length ${Math.round(top.length ?? 0)}`);
      }
      this.statusEl.textContent = `Arena live — ${parts.join(' · ')}`;
      return;
    }

    this.statusEl.textContent = this.lastEndReason ? `Arena finished — ${this.lastEndReason}` : 'Arena finished';
  }

  private buildPacmanStatus(state: VoiceMinigameState): string {
    const pacState = state.pacmanState;
    const now = Date.now();
    const pelletsRemaining = pacState?.pelletsRemaining ?? state.pellets.length;
    const mapName = state.world.mapName ?? state.world.mapId ?? 'Mystery Grid';
    const parts: string[] = [];

    if (pacState) {
      parts.push(`Round ${pacState.round}`);
      const phaseLabel = this.formatPacmanPhase(pacState.phase);
      const countdown = pacState.phaseEndsAt ? this.formatCountdown(Math.max(0, pacState.phaseEndsAt - now)) : '';
      parts.push(countdown ? `${phaseLabel} ${countdown}` : phaseLabel);
      if (pacState.speedMultiplier && pacState.speedMultiplier !== 1) {
        parts.push(`${Math.round(pacState.speedMultiplier * 100)}% speed`);
      }
      parts.push(`${pelletsRemaining} pellets left`);
    } else {
      parts.push(`${pelletsRemaining} pellets live`);
    }

    parts.push(`Map ${mapName}`);

    const top = state.leaderboard?.[0];
    if (top) {
      parts.push(`Top score ${Math.round(top.score ?? 0)}`);
    }

    return `Maze live — ${parts.join(' · ')}`;
  }

  private formatPacmanPhase(phase: PacmanState['phase']): string {
    switch (phase) {
      case 'setup':
        return 'Setup';
      case 'overtime':
        return 'Overtime';
      case 'reset':
        return 'Reset';
      default:
        return 'Live';
    }
  }

  private formatCountdown(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) {
      return '';
    }
    const seconds = Math.ceil(ms / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `${minutes}:${remainder.toString().padStart(2, '0')}`;
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
        item.textContent = 'Waiting for players...';
        list.appendChild(item);
        return;
      }

      // Compact horizontal display for waiting players
      participants.forEach((participant) => {
        const item = document.createElement('li');
        item.className = 'inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1';

        const name = document.createElement('span');
        name.className = 'text-2xs font-medium text-text-normal truncate max-w-[80px]';
        name.textContent = participant.name;

        const badge = document.createElement('span');
        badge.className = 'h-1.5 w-1.5 rounded-full bg-success/60';

        item.append(badge, name);
        list.appendChild(item);
      });
      return;
    }

    const byId = new Map<string, VoiceMinigamePlayerState>(state.players.map((player) => [player.id, player]));
    const leaderboard = state.leaderboard?.length ? state.leaderboard : state.players;
    const isPacman = state.type === 'pacman';

    // Compact horizontal score chips
    leaderboard.slice(0, 6).forEach((entry, index) => {
      const player = typeof entry === 'object' && 'id' in entry ? byId.get(entry.id) ?? (entry as VoiceMinigamePlayerState) : undefined;
      const resolved = player ?? (entry as VoiceMinigamePlayerState);

      const item = document.createElement('li');
      item.className = 'inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/30 px-2.5 py-1';
      if (!resolved.alive) {
        item.classList.add('opacity-60');
      }

      // Rank badge
      const rank = document.createElement('span');
      rank.className = 'text-2xs font-bold text-text-muted';
      rank.textContent = `#${index + 1}`;

      // Color marker
      const marker = document.createElement('span');
      marker.className = 'h-2 w-2 flex-shrink-0 rounded-full';
      marker.style.backgroundColor = resolved.color;

      // Name
      const name = document.createElement('span');
      name.className = 'text-2xs font-semibold text-text-normal truncate max-w-[60px]';
      name.textContent = resolved.name;
      if (resolved.id === localId) {
        name.classList.add('text-brand-primary');
      }

      // Score
      const score = document.createElement('span');
      score.className = 'text-2xs font-bold text-white tabular-nums';
      if (isPacman) {
        score.textContent = `${Math.round(resolved.score)}`;
      } else {
        score.textContent = `${Math.round(resolved.length ?? 0)}`;
      }

      // Status dot
      const statusDot = document.createElement('span');
      if (resolved.alive) {
        statusDot.className = 'h-1.5 w-1.5 rounded-full bg-success';
      } else {
        statusDot.className = 'h-1.5 w-1.5 rounded-full bg-warning animate-pulse';
      }

      item.append(rank, marker, name, score, statusDot);
      list.appendChild(item);
    });

    // Show overflow indicator if more players
    if (leaderboard.length > 6) {
      const more = document.createElement('li');
      more.className = 'inline-flex items-center rounded-full border border-white/5 bg-black/20 px-2 py-1 text-2xs text-text-muted';
      more.textContent = `+${leaderboard.length - 6} more`;
      list.appendChild(more);
    }
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

    if (width > 0 && height > 0 && (this.canvas.width !== width || this.canvas.height !== height)) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  private shouldForceMinigame(): boolean {
    return this.currentState?.status === 'running';
  }

  private shouldShowMinigame(): boolean {
    if (this.shouldForceMinigame()) {
      return true;
    }
    return this.canUseMinigame && this.isViewPinned;
  }

  private updateLauncherState(): void {
    const isLive = this.currentState?.status === 'running';

    if (this.launcherStatusEl) {
      const label = !this.canUseMinigame
        ? 'Join Voice'
        : isLive
          ? 'Live'
          : 'Available';
      this.launcherStatusEl.textContent = label;
    }

    if (this.openButton) {
      this.openButton.classList.toggle('is-disabled', !this.canUseMinigame);
      this.openButton.setAttribute('aria-disabled', this.canUseMinigame ? 'false' : 'true');
    }
  }

  private syncStageMode(): void {
    if (!this.stage || !this.container) {
      return;
    }

    const shouldForce = this.shouldForceMinigame();
    const shouldShow = this.shouldShowMinigame();

    this.stage.classList.toggle('hidden', !shouldShow);
    this.stage.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
    this.container.classList.toggle('hidden', !shouldShow);

    if (this.mainContent) {
      this.mainContent.classList.toggle('minigame-active', shouldShow);
    }

    if (this.voiceStage) {
      this.voiceStage.classList.toggle('hidden', shouldShow);
      this.voiceStage.setAttribute('aria-hidden', shouldShow ? 'true' : 'false');
    }

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
      this.openButton.classList.toggle('active', shouldShow);
      this.openButton.setAttribute('aria-pressed', shouldShow ? 'true' : 'false');
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

    const lengthFactor = Math.max(player.length ?? 10, 1) / 220;
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
    // Smoother camera lerp
    const centerLerp = localPlayer ? 0.1 : 0.05;
    this.viewCenter = {
      x: this.lerp(currentCenter.x, targetCenter.x, centerLerp),
      y: this.lerp(currentCenter.y, targetCenter.y, centerLerp),
    };

    const targetScale = baseScale * this.computeZoom(localPlayer ?? null);
    this.currentScale = this.lerp(this.currentScale || targetScale, targetScale, 0.1);
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

    // Use interpolated state for rendering
    const state = this.getRenderState();
    
    if (!state || !state.world) {
      this.viewTransform = null;
      this.drawPlaceholder(ctx, width, height);
      return;
    }

    if (state.type === 'pacman') {
      this.drawPacman(ctx, state, width, height);
      return;
    }

    const transform = this.calculateViewTransform(state, width, height);
    const { scale, offsetX, offsetY } = transform;

    this.drawGrid(ctx, state.world, scale, offsetX, offsetY);
    this.drawShadows(ctx, state, scale, offsetX, offsetY);
    this.drawPellets(ctx, state, scale, offsetX, offsetY);
    this.drawPlayers(ctx, state, scale, offsetX, offsetY);
    this.particles.update();
    this.particles.draw(ctx, offsetX, offsetY, scale);
    this.drawMinimap(ctx, state, width, height);
  }

  private drawPacman(
    ctx: CanvasRenderingContext2D,
    state: VoiceMinigameState,
    width: number,
    height: number
  ): void {
    const { world } = state;
    const scale = Math.min(width / world.width, height / world.height) * 0.9;
    const offsetX = (width - world.width * scale) / 2;
    const offsetY = (height - world.height * scale) / 2;

    this.viewTransform = { scale, offsetX, offsetY };

    // Draw Map
    if (world.map) {
      const tileSize = world.width / world.map[0].length * scale;
      ctx.fillStyle = '#1a237e';
      for (let y = 0; y < world.map.length; y++) {
        for (let x = 0; x < world.map[y].length; x++) {
          if (world.map[y][x] === 1) {
            ctx.fillRect(offsetX + x * tileSize, offsetY + y * tileSize, tileSize, tileSize);
          }
        }
      }
    }

    // Draw Pellets
    state.pellets.forEach(pellet => {
      const px = offsetX + pellet.x * scale;
      const py = offsetY + pellet.y * scale;
      const radius = (pellet.radius ?? 3) * scale;
      
      ctx.beginPath();
      ctx.fillStyle = pellet.color;
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();

      if (pellet.isPowerup) {
        ctx.shadowColor = pellet.color;
        ctx.shadowBlur = 10;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    });

    // Draw Players
    state.players.forEach(player => {
      if (!player.alive) return;
      const px = offsetX + (player.x || 0) * scale;
      const py = offsetY + (player.y || 0) * scale;
      const size = 15 * scale;

      ctx.save();
      ctx.translate(px, py);
      
      // Rotate based on direction
      let angle = 0;
      if (player.direction === 'down') angle = Math.PI / 2;
      if (player.direction === 'left') angle = Math.PI;
      if (player.direction === 'up') angle = -Math.PI / 2;
      ctx.rotate(angle);

      // Pacman Body
      ctx.beginPath();
      ctx.fillStyle = player.color;
      // Mouth animation
      const mouthOpen = Math.abs(Math.sin(Date.now() / 100)) * 0.5;
      ctx.arc(0, 0, size, mouthOpen, Math.PI * 2 - mouthOpen);
      ctx.lineTo(0, 0);
      ctx.fill();

      // Powerup Effect
      if (player.powerupExpiresAt && player.powerupExpiresAt > Date.now()) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.restore();

      // Name
      ctx.font = `bold ${Math.max(10, size)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = 'white';
      ctx.fillText(player.name, px, py - size - 4);
    });

    this.drawPacmanHud(ctx, state, width);
  }

  private drawPacmanHud(
    ctx: CanvasRenderingContext2D,
    state: VoiceMinigameState,
    width: number
  ): void {
    const pacState = state.pacmanState;
    const mapName = state.world.mapName ?? state.world.mapId ?? 'Pacman Grid';
    const pelletsRemaining = pacState?.pelletsRemaining ?? state.pellets.length;
    const initialPellets = pacState?.initialPellets ?? (pelletsRemaining || 1);
    const progress = this.clamp(1 - pelletsRemaining / Math.max(initialPellets, 1), 0, 1);
    const overlayWidth = Math.min(420, width - 32);
    const overlayHeight = 110;
    const baseX = 18;
    const baseY = 18;

    ctx.save();
    ctx.translate(baseX, baseY);

    ctx.beginPath();
    ctx.roundRect(0, 0, overlayWidth, overlayHeight, 12);
    ctx.fillStyle = 'rgba(6, 8, 18, 0.85)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#fef3c7';
    ctx.font = '600 18px system-ui';
    ctx.fillText(mapName, 16, 14);

    const phaseLabel = pacState ? this.formatPacmanPhase(pacState.phase) : 'Live';
    const countdown = pacState?.phaseEndsAt ? this.formatCountdown(Math.max(0, pacState.phaseEndsAt - Date.now())) : '';
    const roundLabel = pacState ? `Round ${pacState.round}` : 'Round 1';
    const metaLine = countdown ? `${roundLabel} · ${phaseLabel} ${countdown}` : `${roundLabel} · ${phaseLabel}`;

    ctx.fillStyle = 'rgba(226, 232, 240, 0.85)';
    ctx.font = '500 13px system-ui';
    ctx.fillText(metaLine, 16, 40);

    if (pacState?.speedMultiplier && pacState.speedMultiplier !== 1) {
      ctx.textAlign = 'right';
      ctx.fillStyle = '#facc15';
      ctx.font = '600 12px system-ui';
      ctx.fillText(`${Math.round(pacState.speedMultiplier * 100)}% speed`, overlayWidth - 16, 40);
      ctx.textAlign = 'left';
    }

    const barX = 16;
    const barY = 66;
    const barWidth = overlayWidth - barX * 2;
    const barHeight = 12;

    ctx.beginPath();
    ctx.roundRect(barX, barY, barWidth, barHeight, 6);
    ctx.fillStyle = 'rgba(30, 41, 59, 0.9)';
    ctx.fill();

    ctx.beginPath();
    ctx.roundRect(barX, barY, Math.max(barWidth * progress, 6), barHeight, 6);
    ctx.fillStyle = '#fbbf24';
    ctx.fill();

    ctx.fillStyle = '#f8fafc';
    ctx.font = '600 12px system-ui';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${pelletsRemaining}/${Math.max(initialPellets, 1)} pellets`, 16, barY + barHeight + 20);

    ctx.restore();
  }

  private handleCanvasClick(event: MouseEvent): void {
    // Allow clicks on the game selection canvas when no game is running
    if (this.currentState?.status === 'running' || !this.canvas) {
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;
    const width = this.canvas.width;
    const height = this.canvas.height;

    const layout = this.getSelectionButtonLayout(width, height);

    if (y >= layout.startY && y <= layout.startY + layout.buttonHeight) {
      if (x >= layout.slitherX && x <= layout.slitherX + layout.buttonWidth) {
        this.selectGame('slither');
        // Auto-start the game if voice connected
        if (this.canUseMinigame) {
          this.deps.socket.startVoiceMinigame({ type: 'slither' });
        }
      } else if (x >= layout.pacmanX && x <= layout.pacmanX + layout.buttonWidth) {
        this.selectGame('pacman');
        // Auto-start the game if voice connected
        if (this.canUseMinigame) {
          this.deps.socket.startVoiceMinigame({ type: 'pacman' });
        }
      }
    }
  }

  private drawPlaceholder(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.fillStyle = '#0f1727';
    ctx.fillRect(0, 0, width, height);

    this.renderSelectionUI(ctx, width, height);
  }

  private renderSelectionUI(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#030712');
    gradient.addColorStop(0.45, '#060b1c');
    gradient.addColorStop(1, '#010407');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // Neon grid overlay
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.025)';
    ctx.lineWidth = 1;
    const grid = Math.max(36, Math.min(width, height) / 18);
    for (let gx = 0; gx <= width; gx += grid) {
      ctx.beginPath();
      ctx.moveTo(gx + 0.5, 0);
      ctx.lineTo(gx + 0.5, height);
      ctx.stroke();
    }
    for (let gy = 0; gy <= height; gy += grid) {
      ctx.beginPath();
      ctx.moveTo(0, gy + 0.5);
      ctx.lineTo(width, gy + 0.5);
      ctx.stroke();
    }
    ctx.restore();

    // Title + subtitle
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const titleSize = Math.max(Math.floor(Math.min(width, height) / 16), 28);
    ctx.fillStyle = '#f8fafc';
    ctx.font = `800 ${titleSize}px system-ui`;
    const titleY = height / 2 - SELECTION_BUTTON_HEIGHT - 60;
    ctx.fillText('Game Arena', width / 2, titleY);

    ctx.font = `500 ${Math.max(16, titleSize * 0.35)}px system-ui`;
    ctx.fillStyle = 'rgba(248, 250, 252, 0.75)';
    ctx.fillText('Pick a mode to rally your squad', width / 2, titleY + 36);

    const layout = this.getSelectionButtonLayout(width, height);
    const cards = [
      {
        label: 'Slither Arena',
        description: 'Neon swarm royale',
        accent: '#60a5fa',
        icon: '🌀',
      },
      {
        label: 'Pacman Chase',
        description: 'Retro maze chaos',
        accent: '#fde047',
        icon: '💥',
      },
    ];

    this.drawSelectionCard(ctx, layout.slitherX, layout.startY, layout.buttonWidth, layout.buttonHeight, cards[0]);
    this.drawSelectionCard(ctx, layout.pacmanX, layout.startY, layout.buttonWidth, layout.buttonHeight, cards[1]);

    ctx.font = `600 ${Math.max(13, titleSize * 0.32)}px system-ui`;
    ctx.fillStyle = 'rgba(148, 163, 184, 0.85)';
    const hint = this.canUseMinigame 
      ? 'Click a game to start playing' 
      : 'Join a voice channel to unlock the arena';
    ctx.fillText(hint, width / 2, layout.startY + layout.buttonHeight + 50);
  }

  private getSelectionButtonLayout(width: number, height: number) {
    const buttonWidth = SELECTION_BUTTON_WIDTH;
    const buttonHeight = SELECTION_BUTTON_HEIGHT;
    const startY = height / 2 - buttonHeight / 2 + 48;
    const slitherX = width / 2 - buttonWidth - SELECTION_BUTTON_GAP / 2;
    const pacmanX = width / 2 + SELECTION_BUTTON_GAP / 2;

    return { buttonWidth, buttonHeight, startY, slitherX, pacmanX };
  }

  private drawSelectionCard(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    card: { label: string; description: string; accent: string; icon: string }
  ): void {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 24);
    ctx.fillStyle = '#0b1221';
    ctx.fill();

    const accentGradient = ctx.createLinearGradient(x, y, x + width, y + height);
    accentGradient.addColorStop(0, `${card.accent}1a`);
    accentGradient.addColorStop(1, `${card.accent}40`);
    ctx.fillStyle = accentGradient;
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.fillStyle = `${card.accent}4d`;
    ctx.fillRect(x + 24, y + 18, width - 48, 2);

    ctx.font = `700 ${Math.max(20, height * 0.28)}px system-ui`;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(card.label, x + 32, y + height / 2);

    ctx.font = `500 ${Math.max(12, height * 0.18)}px system-ui`;
    ctx.fillStyle = 'rgba(226, 232, 240, 0.9)';
    ctx.fillText(card.description, x + 32, y + height / 2 + 26);

    ctx.font = `${Math.floor(height * 0.45)}px system-ui`;
    ctx.textAlign = 'right';
    ctx.fillText(card.icon, x + width - 28, y + height / 2 + 12);
    ctx.restore();
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D,
    world: { width: number; height: number },
    scale: number,
    offsetX: number,
    offsetY: number
  ): void {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;

    // Draw a hexagonal-like or just tighter grid
    const startX = Math.floor(-offsetX / scale / GRID_SPACING) * GRID_SPACING;
    const endX = Math.ceil((ctx.canvas.width - offsetX) / scale / GRID_SPACING) * GRID_SPACING;
    const startY = Math.floor(-offsetY / scale / GRID_SPACING) * GRID_SPACING;
    const endY = Math.ceil((ctx.canvas.height - offsetY) / scale / GRID_SPACING) * GRID_SPACING;

    for (let x = startX; x <= endX; x += GRID_SPACING) {
      if (x < 0 || x > world.width) continue;
      const pos = offsetX + x * scale;
      ctx.beginPath();
      ctx.moveTo(Math.round(pos) + 0.5, 0);
      ctx.lineTo(Math.round(pos) + 0.5, ctx.canvas.height);
      ctx.stroke();
    }

    for (let y = startY; y <= endY; y += GRID_SPACING) {
      if (y < 0 || y > world.height) continue;
      const pos = offsetY + y * scale;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(pos) + 0.5);
      ctx.lineTo(ctx.canvas.width, Math.round(pos) + 0.5);
      ctx.stroke();
    }

    // World border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 2;
    ctx.strokeRect(offsetX, offsetY, world.width * scale, world.height * scale);
    ctx.restore();
  }

  private drawShadows(
    ctx: CanvasRenderingContext2D,
    state: VoiceMinigameState,
    scale: number,
    offsetX: number,
    offsetY: number
  ): void {
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    const shadowOffset = 8 * scale;

    state.players.forEach((player) => {
      if (!player.alive || !player.segments?.length) return;
      
      const radius = (player.thickness ?? 12) * scale * 0.5;
      
      ctx.beginPath();
      player.segments.forEach((point, i) => {
        if (i % 3 !== 0) return; // Optimization
        const px = offsetX + point.x * scale + shadowOffset;
        const py = offsetY + point.y * scale + shadowOffset;
        ctx.moveTo(px + radius, py);
        ctx.arc(px, py, radius, 0, Math.PI * 2);
      });
      ctx.fill();
    });
    ctx.restore();
  }

  private drawPellets(
    ctx: CanvasRenderingContext2D,
    state: VoiceMinigameState,
    scale: number,
    offsetX: number,
    offsetY: number
  ): void {
    const width = ctx.canvas.width;
    const height = ctx.canvas.height;
    const margin = 50;

    for (const pellet of state.pellets) {
      const radius = Math.max((pellet.radius ?? 3) * scale, 4);
      const x = offsetX + pellet.x * scale;
      const y = offsetY + pellet.y * scale;

      if (x < -margin || x > width + margin || y < -margin || y > height + margin) {
        continue;
      }

      const sprite = this.spriteCache.get(pellet.color, 'pellet');
      const size = radius * 2.5; // Glow is larger
      ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
    }
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
    const margin = 100;

    // Sort players by length so smaller ones are on top? Or just draw.
    // Usually z-index doesn't matter much in slither, but maybe local player on top.
    const sortedPlayers = [...state.players].sort((a, b) => {
      if (a.id === localId) return 1;
      if (b.id === localId) return -1;
      return (a.length ?? 0) - (b.length ?? 0);
    });

    sortedPlayers.forEach((player) => {
      const points = player.segments ?? [];
      if (!points.length) return;

      const thickness = player.thickness ?? 12;
      const radius = thickness * scale * 0.5;
      const spriteSize = radius * 2;
      const bodySprite = this.spriteCache.get(player.color, 'body');
      
      // Draw body from tail to head
      // We need to draw enough circles to cover the gaps
      // Distance between points is roughly 'speed' per tick.
      // We can interpolate or just draw at points.
      
      let lastX = -9999;
      let lastY = -9999;
      const drawThreshold = radius * 0.4; // Overlap factor

      // Draw segments
      for (let i = points.length - 1; i >= 0; i--) {
        const point = points[i];
        const px = offsetX + point.x * scale;
        const py = offsetY + point.y * scale;

        // Trail effect for boosting players
        if (i === points.length - 1 && player.alive && (player.speed ?? 0) > 8) {
           if (Math.random() > 0.5) {
             this.particles.spawn(point.x, point.y, player.color, 1, 0.5);
           }
        }

        // Culling
        if (px < -margin || px > width + margin || py < -margin || py > height + margin) {
          continue;
        }

        const dx = px - lastX;
        const dy = py - lastY;
        if (dx * dx + dy * dy < drawThreshold * drawThreshold) {
          continue;
        }

        ctx.drawImage(bodySprite, px - radius, py - radius, spriteSize, spriteSize);
        lastX = px;
        lastY = py;
      }

      // Draw Head
      const head = points[0];
      const headX = offsetX + head.x * scale;
      const headY = offsetY + head.y * scale;
      
      // Head sprite (same as body for now, maybe slightly larger)
      const headRadius = radius * 1.1;
      const headSize = headRadius * 2;
      ctx.drawImage(bodySprite, headX - headRadius, headY - headRadius, headSize, headSize);

      // Eyes
      const heading = this.getHeadDirection(points);
      const dirX = heading.x;
      const dirY = heading.y;
      const perpX = -dirY;
      const perpY = dirX;
      
      const eyeOffset = headRadius * 0.6;
      const eyeSpacing = headRadius * 0.4;
      const eyeRadius = headRadius * 0.35;

      const drawEye = (side: number) => {
        const ex = headX + dirX * eyeOffset + perpX * eyeSpacing * side;
        const ey = headY + dirY * eyeOffset + perpY * eyeSpacing * side;
        
        ctx.beginPath();
        ctx.fillStyle = 'white';
        ctx.arc(ex, ey, eyeRadius, 0, Math.PI * 2);
        ctx.fill();
        
        // Pupil
        const px = ex + dirX * eyeRadius * 0.5;
        const py = ey + dirY * eyeRadius * 0.5;
        ctx.beginPath();
        ctx.fillStyle = 'black';
        ctx.arc(px, py, eyeRadius * 0.5, 0, Math.PI * 2);
        ctx.fill();
      };

      drawEye(1);
      drawEye(-1);

      // Name
      if (player.alive) {
        ctx.font = `bold ${Math.max(10, radius)}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'white';
        ctx.shadowColor = 'black';
        ctx.shadowBlur = 4;
        ctx.fillText(player.name, headX, headY - headRadius - 4);
        ctx.shadowBlur = 0;
      }
    });
  }

  private handlePointerMove(event: PointerEvent): void {
    if (this.currentState?.type === 'pacman') {
      return;
    }

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
    const now = Date.now();
    const vectorChanged = !this.vectorsAreClose(normalized, this.lastSentVector);
    const shouldRefresh = now - this.lastInputAt >= INPUT_REFRESH_INTERVAL_MS;
    if (!vectorChanged && !shouldRefresh) {
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
    // Use angular comparison for smoother deduplication
    const dotProduct = a.x * b.x + a.y * b.y;
    const magA = Math.hypot(a.x, a.y);
    const magB = Math.hypot(b.x, b.y);
    
    // Both zero vectors are identical
    if (magA < 0.01 && magB < 0.01) return true;
    // One zero, one not - different
    if (magA < 0.01 || magB < 0.01) return false;
    
    // Angular similarity: cos(angle) close to 1 means similar direction
    const cosAngle = dotProduct / (magA * magB);
    // cos(0.05 rad) ≈ 0.999, so threshold at ~3 degrees difference
    return cosAngle > (1 - INPUT_DEDUP_THRESHOLD);
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

  private drawMinimap(
    ctx: CanvasRenderingContext2D,
    state: VoiceMinigameState,
    canvasWidth: number,
    canvasHeight: number
  ): void {
    const mapSize = Math.min(canvasWidth, canvasHeight) * 0.25;
    const margin = 20;
    const x = canvasWidth - mapSize - margin;
    const y = canvasHeight - mapSize - margin;

    ctx.save();

    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, mapSize, mapSize);
    ctx.strokeRect(x, y, mapSize, mapSize);

    // Players
    const scaleX = mapSize / state.world.width;
    const scaleY = mapSize / state.world.height;

    const localId = this.deps.socket.getId();

    state.players.forEach((player) => {
      if (!player.alive || !player.head) return;

      ctx.fillStyle = player.id === localId ? '#ffffff' : player.color;
      const size = player.id === localId ? 3 : 2;

      ctx.beginPath();
      ctx.arc(x + player.head.x * scaleX, y + player.head.y * scaleY, size, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.restore();
  }
}
