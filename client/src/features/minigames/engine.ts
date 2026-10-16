/**
 * Framework-agnostic minigame rendering/input engine.
 *
 * Ported from the legacy vanilla-TS `MinigameController`: it owns the <canvas>
 * (sprite cache, particles, state interpolation, camera, draw routines) and the
 * player input pipeline (pointer vectors, keyboard, virtual d-pad, throttled
 * `voice:game:input` payloads). Everything that touched other DOM elements
 * (status text, score lists, buttons, launcher, socket wiring) lives in the UI.
 */
import type {
  MinigameType,
  PacmanState,
  VoiceMinigamePellet,
  VoiceMinigamePlayerState,
  VoiceMinigameState,
} from '@/types/protocol';

// Network optimization: 50ms interval = ~20 inputs/sec
const INPUT_SEND_INTERVAL_MS = 50;
// Force refresh input every 200ms even if direction unchanged (keepalive)
const INPUT_REFRESH_INTERVAL_MS = 200;
// Threshold for considering vectors as "same direction" (radians)
const INPUT_DEDUP_THRESHOLD = 0.05;
// Virtual "block" button: re-send while held (server drops the guard after 200ms,
// which keyboard auto-repeat used to keep alive).
const BLOCK_REPEAT_INTERVAL_MS = 150;
const GRID_SPACING = 80;
const BACKGROUND_COLOR = '#0b101a';
const INTERPOLATION_DELAY_MS = 100; // ms delay to allow for smooth interpolation
const PACMAN_INTERPOLATION_DELAY_MS = 40;
const STATE_BUFFER_LIMIT = 20;
const MIN_CANVAS_SIZE = 240;

export type Direction = 'up' | 'down' | 'left' | 'right';
export type FighterAction = 'punch' | 'kick' | 'block';
type FighterInputAction = 'jump' | FighterAction;

export interface MinigameEngineOptions {
  /** Socket id of the local player (null when spectating). */
  getLocalPlayerId: () => string | null;
  /**
   * Sends an input payload to the server (`voice:game:input`).
   * Shapes: `{ vector: { x, y } }` for movement (all games) and
   * `{ action: 'jump' | 'punch' | 'kick' | 'block' }` for fighter actions.
   */
  sendInput: (payload: unknown) => void;
}

type MovementVector = { x: number; y: number };
type Point = { x: number; y: number };
type KeyboardInput = Record<Direction, boolean>;

type ViewTransform = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

const KEY_DIRECTION: Record<string, Direction> = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
};

const FIGHTER_ACTION_KEYS: Record<string, FighterInputAction> = {
  Space: 'jump',
  KeyZ: 'punch',
  KeyJ: 'punch',
  KeyX: 'kick',
  KeyK: 'kick',
  KeyC: 'block',
  KeyL: 'block',
};

const clamp = (value: number, min: number, max: number): number => {
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
};

const lerp = (from: number, to: number, alpha: number): number => {
  const t = clamp(alpha, 0, 1);
  return from + (to - from) * t;
};

const createOffscreenCanvas = (width: number, height: number): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

type SpriteType = 'body' | 'head' | 'pellet' | 'shadow';

class SpriteCache {
  private cache = new Map<string, HTMLCanvasElement>();

  get(color: string, type: SpriteType): HTMLCanvasElement {
    const key = `${type}-${color}`;
    let canvas = this.cache.get(key);
    if (!canvas) {
      canvas = this.create(color, type);
      this.cache.set(key, canvas);
    }
    return canvas;
  }

  private create(color: string, type: SpriteType): HTMLCanvasElement {
    const size = 64;
    const canvas = createOffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return canvas;
    }
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 2;

    if (type === 'shadow') {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.fill();
    } else if (type === 'pellet') {
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

  spawn(x: number, y: number, color: string, count: number, speed: number, spread: number = Math.PI * 2): void {
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

  update(): void {
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

  draw(ctx: CanvasRenderingContext2D, offsetX: number, offsetY: number, scale: number): void {
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

  clear(): void {
    this.particles = [];
  }
}

export class MinigameEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly options: MinigameEngineOptions;
  private readonly disposers: Array<() => void> = [];

  private currentState: VoiceMinigameState | null = null;
  private lastGameType: MinigameType = 'slither';
  private started = false;
  private renderHandle: number | null = null;
  private inputTimeout: number | null = null;
  private blockRepeatHandle: number | null = null;
  private lastInputAt = 0;
  private lastSentVector: MovementVector = { x: 0, y: 0 };
  private pendingVector: MovementVector | null = null;
  private pointerTarget: Point | null = null;
  private pointerActive = false;
  private viewTransform: ViewTransform | null = null;
  private viewCenter: Point | null = null;
  private currentScale = 1;
  private keyboardInput: KeyboardInput = { up: false, down: false, left: false, right: false };
  private pacmanKeyHistory: Direction[] = [];
  private readonly spriteCache = new SpriteCache();
  private readonly particles = new ParticleSystem();
  private stateBuffer: Array<{ state: VoiceMinigameState; timestamp: number }> = [];
  private pelletCache: Map<string, VoiceMinigamePellet> | null = null; // Delta compression cache
  private pacmanMapCache: HTMLCanvasElement | null = null;
  private lastPacmanMapId: string | null = null;
  /** Logical (CSS pixel) viewport size; the backing store is scaled by `pixelRatio`. */
  private viewWidth = MIN_CANVAS_SIZE;
  private viewHeight = MIN_CANVAS_SIZE;
  private pixelRatio = 1;

  constructor(canvas: HTMLCanvasElement, options: MinigameEngineOptions) {
    this.canvas = canvas;
    this.options = options;
    this.ctx = canvas.getContext('2d', { alpha: false });
    if (this.ctx) {
      this.ctx.imageSmoothingEnabled = true;
    }

    const onPointer = (event: PointerEvent) => this.handlePointerMove(event);
    const onPointerLeave = () => this.handlePointerLeave();
    canvas.addEventListener('pointermove', onPointer);
    canvas.addEventListener('pointerdown', onPointer);
    canvas.addEventListener('pointerover', onPointer);
    canvas.addEventListener('pointerleave', onPointerLeave);
    this.disposers.push(() => {
      canvas.removeEventListener('pointermove', onPointer);
      canvas.removeEventListener('pointerdown', onPointer);
      canvas.removeEventListener('pointerover', onPointer);
      canvas.removeEventListener('pointerleave', onPointerLeave);
    });
  }

  // ------------------------------------------------------------------ public

  /**
   * Latest server state (already JSON); null clears the board and shows the
   * placeholder. Applies pellet deltas and buffers states for interpolation.
   */
  setState(state: VoiceMinigameState | null): void {
    const now = Date.now();

    // Process delta-compressed pellet data if present
    if (state && state.pelletData) {
      state = this.processPelletDelta(state);
    }

    // Detect deaths for particle effects (using the latest authoritative state)
    if (this.currentState && state && state.status === 'running') {
      const next = state;
      this.currentState.players.forEach((prev) => {
        const curr = next.players.find((p) => p.id === prev.id);
        if (prev.alive && curr && !curr.alive) {
          const head = prev.head ?? prev.segments?.[0];
          if (head) {
            this.particles.spawn(head.x, head.y, prev.color, 30, 1.5);
          }
        }
      });
    }

    const previousGameType = this.currentState?.type ?? null;
    const previousGameId = this.currentState?.gameId ?? null;

    if (state) {
      // A different game id means a fresh arena: never interpolate across games.
      if (previousGameId !== null && state.gameId !== previousGameId) {
        this.stateBuffer = [];
        this.pelletCache = null;
        this.particles.clear();
      }
      this.stateBuffer.push({ state, timestamp: now });
      // Keep buffer clean
      if (this.stateBuffer.length > STATE_BUFFER_LIMIT) {
        this.stateBuffer.shift();
      }
      this.lastGameType = state.type;
    } else {
      this.stateBuffer = [];
    }

    // currentState is updated immediately for input logic; rendering uses getRenderState()
    this.currentState = state;

    if (state && state.type !== 'slither') {
      this.pointerActive = false;
      this.pointerTarget = null;
    }
    if (state?.type === 'pacman') {
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

    this.requestRender();
  }

  /** Keyboard input; returns true when the event was consumed. */
  handleKeyDown(event: KeyboardEvent): boolean {
    if (!this.shouldCaptureKeyboard(event)) {
      return false;
    }
    return this.applyKeyboardState(event.code, true);
  }

  handleKeyUp(event: KeyboardEvent): boolean {
    if (!this.shouldCaptureKeyboard(event)) {
      return false;
    }
    return this.applyKeyboardState(event.code, false);
  }

  /**
   * Virtual d-pad for touch devices. Slither/pacman: press/release a movement
   * direction. Fighter: up = jump, left/right = move (down is a no-op).
   */
  setDirection(direction: Direction, pressed: boolean): void {
    if (!this.currentState || this.currentState.status !== 'running') {
      return;
    }

    if (this.currentState.type === 'fighter' && direction === 'up') {
      if (pressed) {
        this.sendAction('jump');
      }
      return;
    }

    if (this.keyboardInput[direction] === pressed) {
      return;
    }

    this.keyboardInput[direction] = pressed;
    this.updatePacmanKeyHistory(direction, pressed);
    this.queueInputVector(this.getKeyboardVector());
  }

  /** Fighter action buttons. Punch/kick fire on press; block repeats while held. */
  pressAction(action: FighterAction, pressed: boolean): void {
    if (action === 'block') {
      this.stopBlockRepeat();
      if (!pressed) {
        return;
      }
      if (!this.sendAction('block')) {
        return;
      }
      this.blockRepeatHandle = window.setInterval(() => {
        if (!this.sendAction('block')) {
          this.stopBlockRepeat();
        }
      }, BLOCK_REPEAT_INTERVAL_MS);
      return;
    }

    if (pressed) {
      this.sendAction(action);
    }
  }

  /** Recompute canvas size from its container (devicePixelRatio aware). */
  resize(): void {
    const parent = this.canvas.parentElement;
    const cssWidth = Math.max(this.canvas.clientWidth || parent?.clientWidth || 0, MIN_CANVAS_SIZE);
    const cssHeight = Math.max(this.canvas.clientHeight || parent?.clientHeight || cssWidth, MIN_CANVAS_SIZE);
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(cssWidth * ratio);
    const pixelHeight = Math.round(cssHeight * ratio);

    this.viewWidth = cssWidth;
    this.viewHeight = cssHeight;
    this.pixelRatio = ratio;

    if (pixelWidth > 0 && pixelHeight > 0 && (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight)) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }

    this.requestRender();
  }

  /** Start the render loop (animates while a round is running, otherwise draws a static frame). */
  start(): void {
    this.started = true;
    this.requestRender();
  }

  stop(): void {
    this.started = false;
    this.stopRenderLoop();
  }

  /** Stop everything and release listeners. */
  dispose(): void {
    this.stop();
    this.resetInputState();

    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // ignore listener teardown failures
      }
    }
  }

  /** Current interpolated state for the UI (scores etc.), or null. */
  getRenderState(): VoiceMinigameState | null {
    if (this.stateBuffer.length === 0) {
      return this.currentState;
    }

    const now = Date.now();
    const interpolationDelay = this.currentState?.type === 'pacman'
      ? PACMAN_INTERPOLATION_DELAY_MS
      : INTERPOLATION_DELAY_MS;
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
    const alpha = total > 0 ? Math.max(0, Math.min(1, elapsed / total)) : 1;

    return this.interpolateState(prev.state, next.state, alpha);
  }

  // ----------------------------------------------------------------- input

  private applyKeyboardState(code: string, pressed: boolean): boolean {
    if (!this.currentState || this.currentState.status !== 'running') {
      return false;
    }

    if (this.currentState.type === 'fighter' && pressed) {
      const action = FIGHTER_ACTION_KEYS[code];
      if (action) {
        this.sendAction(action);
        return true;
      }
      // W / ArrowUp double as jump in the side-view brawler (vector y is ignored by the server).
      if (code === 'KeyW' || code === 'ArrowUp') {
        this.sendAction('jump');
      }
    }

    const direction = KEY_DIRECTION[code];
    if (!direction) {
      return false;
    }

    this.keyboardInput[direction] = pressed;

    if (this.currentState.type === 'pacman') {
      this.updatePacmanKeyHistory(direction, pressed);
    }

    if (this.pointerActive && this.currentState.type === 'slither') {
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
      if (this.keyboardInput[direction]) {
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

  private directionToVector(direction: Direction): MovementVector {
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

  private updatePacmanKeyHistory(direction: Direction, pressed: boolean): void {
    this.pacmanKeyHistory = this.pacmanKeyHistory.filter((dir) => dir !== direction);
    if (pressed) {
      this.pacmanKeyHistory.push(direction);
    }
  }

  /** Sends a fighter action; returns false when no fighter round is running for the local player. */
  private sendAction(action: FighterInputAction): boolean {
    const state = this.currentState;
    if (!state || state.status !== 'running' || state.type !== 'fighter') {
      return false;
    }
    if (!this.getLocalPlayer(state)) {
      return false;
    }
    this.options.sendInput({ action });
    return true;
  }

  private stopBlockRepeat(): void {
    if (this.blockRepeatHandle !== null) {
      window.clearInterval(this.blockRepeatHandle);
      this.blockRepeatHandle = null;
    }
  }

  private handlePointerMove(event: PointerEvent): void {
    // Pointer steering is a slither-only input.
    if (this.currentState?.type !== 'slither') {
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
    if (!this.pointerActive && !this.pointerTarget) {
      return;
    }
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

    const player = this.getLocalPlayer(this.currentState);
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

    const player = this.getLocalPlayer(this.currentState);
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
    return cosAngle > 1 - INPUT_DEDUP_THRESHOLD;
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
    const safeVector: MovementVector = {
      x: Number.isFinite(vector.x) ? vector.x : 0,
      y: Number.isFinite(vector.y) ? vector.y : 0,
    };
    this.options.sendInput({ vector: safeVector });
    this.lastInputAt = now;
    this.lastSentVector = safeVector;
  }

  private resetInputState(): void {
    this.pointerActive = false;
    this.pointerTarget = null;
    this.keyboardInput = { up: false, down: false, left: false, right: false };
    this.pacmanKeyHistory = [];
    this.pendingVector = null;
    this.lastSentVector = { x: 0, y: 0 };
    this.stopBlockRepeat();
    if (this.inputTimeout !== null) {
      window.clearTimeout(this.inputTimeout);
      this.inputTimeout = null;
    }
  }

  // ----------------------------------------------------------------- state

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
      this.pelletCache = new Map(pellets.map((p) => [p.id, p]));
    } else if (!this.pelletCache) {
      // No cache yet; render nothing until the next full sync arrives
      pellets = [];
      this.pelletCache = new Map();
    } else {
      // Delta sync - apply changes to cached pellets
      if (pelletData.removed) {
        for (const id of pelletData.removed) {
          this.pelletCache.delete(id);
        }
      }
      if (pelletData.added) {
        for (const pellet of pelletData.added) {
          this.pelletCache.set(pellet.id, pellet);
        }
      }
      pellets = Array.from(this.pelletCache.values());
    }

    // Return state with reconstructed pellets array
    return {
      ...state,
      pellets,
    };
  }

  private interpolateState(prev: VoiceMinigameState, next: VoiceMinigameState, alpha: number): VoiceMinigameState {
    // Deep clone next state to avoid mutating buffer
    const interpolated: VoiceMinigameState = {
      ...next,
      players: next.players.map((p) => ({ ...p, segments: p.segments ? [...p.segments] : undefined })),
      pellets: next.pellets, // Pellets don't move usually, so no interpolation needed
    };

    interpolated.players.forEach((nextPlayer) => {
      const prevPlayer = prev.players.find((p) => p.id === nextPlayer.id);
      if (!prevPlayer || !prevPlayer.alive || !nextPlayer.alive) return;

      if (next.type === 'pacman') {
        // Linear interpolation for Pacman
        if (prevPlayer.x !== undefined && nextPlayer.x !== undefined) {
          nextPlayer.x = lerp(prevPlayer.x, nextPlayer.x, alpha);
        }
        if (prevPlayer.y !== undefined && nextPlayer.y !== undefined) {
          nextPlayer.y = lerp(prevPlayer.y, nextPlayer.y, alpha);
        }
        return;
      }

      // Interpolate Head
      const prevHead = prevPlayer.head ?? prevPlayer.segments?.[0];
      const nextHead = nextPlayer.head ?? nextPlayer.segments?.[0];

      if (prevHead && nextHead) {
        const ix = lerp(prevHead.x, nextHead.x, alpha);
        const iy = lerp(prevHead.y, nextHead.y, alpha);

        // Apply to head property if exists
        if (nextPlayer.head) {
          nextPlayer.head = { x: ix, y: iy };
        }

        // Shift the entire body by the delta of the head interpolation.
        // This prevents "accordion" effects when segment counts change.
        const dx = ix - nextHead.x;
        const dy = iy - nextHead.y;

        if (nextPlayer.segments) {
          nextPlayer.segments = nextPlayer.segments.map((s) => ({
            x: s.x + dx,
            y: s.y + dy,
          }));
        }
      }
    });

    return interpolated;
  }

  private getLocalPlayer(state: VoiceMinigameState | null): VoiceMinigamePlayerState | null {
    if (!state) {
      return null;
    }
    const localId = this.options.getLocalPlayerId();
    if (!localId) {
      return null;
    }
    return state.players.find((player) => player.id === localId) ?? null;
  }

  // ------------------------------------------------------------ render loop

  private requestRender(): void {
    if (!this.started) {
      return;
    }
    if (this.currentState?.status === 'running') {
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
      window.cancelAnimationFrame(this.renderHandle);
      this.renderHandle = null;
    }
  }

  // ---------------------------------------------------------------- camera

  private computeZoom(player: VoiceMinigamePlayerState | null): number {
    if (!player) {
      return 12;
    }

    const lengthFactor = Math.max(player.length ?? 10, 1) / 220;
    const damping = Math.log10(lengthFactor + 1);
    const zoom = 14 - damping * 6;
    return clamp(zoom, 8, 14);
  }

  private calculateViewTransform(state: VoiceMinigameState, canvasWidth: number, canvasHeight: number): ViewTransform {
    const { world } = state;
    const baseScale = Math.min(canvasWidth / world.width, canvasHeight / world.height) || 1;
    const localPlayer = this.getLocalPlayer(state);

    const playerHead = localPlayer?.head ?? localPlayer?.segments?.[0];
    const targetCenter = playerHead ?? { x: world.width / 2, y: world.height / 2 };
    if (!this.viewCenter) {
      this.viewCenter = { ...targetCenter };
    }

    const currentCenter = this.viewCenter;
    // Smoother camera lerp
    const centerLerp = localPlayer ? 0.1 : 0.05;
    this.viewCenter = {
      x: lerp(currentCenter.x, targetCenter.x, centerLerp),
      y: lerp(currentCenter.y, targetCenter.y, centerLerp),
    };

    const targetScale = baseScale * this.computeZoom(localPlayer);
    this.currentScale = lerp(this.currentScale || targetScale, targetScale, 0.1);
    const scale = this.currentScale || targetScale;

    const halfViewWidth = canvasWidth / (scale * 2);
    const halfViewHeight = canvasHeight / (scale * 2);

    const maxCenterX = world.width - halfViewWidth;
    const maxCenterY = world.height - halfViewHeight;

    const clampedCenterX = halfViewWidth > maxCenterX
      ? world.width / 2
      : clamp(this.viewCenter.x, halfViewWidth, maxCenterX);
    const clampedCenterY = halfViewHeight > maxCenterY
      ? world.height / 2
      : clamp(this.viewCenter.y, halfViewHeight, maxCenterY);

    this.viewCenter = { x: clampedCenterX, y: clampedCenterY };

    const offsetX = canvasWidth / 2 - clampedCenterX * scale;
    const offsetY = canvasHeight / 2 - clampedCenterY * scale;

    this.viewTransform = { scale, offsetX, offsetY };
    return this.viewTransform;
  }

  // --------------------------------------------------------------- drawing

  private drawState(): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }

    const width = this.viewWidth;
    const height = this.viewHeight;

    // Draw in CSS pixels; the backing store is scaled by devicePixelRatio.
    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 1;

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

    if (state.type === 'fighter') {
      this.drawFighter(ctx, state, width, height);
      return;
    }

    const transform = this.calculateViewTransform(state, width, height);
    const { scale, offsetX, offsetY } = transform;

    this.drawGrid(ctx, state.world, scale, offsetX, offsetY, width, height);
    this.drawShadows(ctx, state, scale, offsetX, offsetY);
    this.drawPellets(ctx, state, scale, offsetX, offsetY, width, height);
    this.drawPlayers(ctx, state, scale, offsetX, offsetY, width, height);
    this.particles.update();
    this.particles.draw(ctx, offsetX, offsetY, scale);
    this.drawMinimap(ctx, state, width, height);
  }

  private drawFighter(ctx: CanvasRenderingContext2D, state: VoiceMinigameState, width: number, height: number): void {
    const { world } = state;

    const scale = Math.min(width / world.width, height / world.height) * 0.9;
    const offsetX = (width - world.width * scale) / 2;
    const offsetY = (height - world.height * scale) / 2;

    this.viewTransform = { scale, offsetX, offsetY };

    // Draw Background
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    // Sky
    const gradient = ctx.createLinearGradient(0, 0, 0, world.height);
    gradient.addColorStop(0, '#1e293b');
    gradient.addColorStop(1, '#0f172a');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, world.width, world.height);

    // Ground (2.5D effect)
    const groundY = 500;
    ctx.fillStyle = '#334155';
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    ctx.lineTo(world.width, groundY);
    ctx.lineTo(world.width + 100, world.height); // Perspective flare
    ctx.lineTo(-100, world.height);
    ctx.fill();

    // Grid on ground
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    for (let i = 0; i < world.width; i += 100) {
      ctx.moveTo(i, groundY);
      ctx.lineTo(i + (i - world.width / 2) * 0.2, world.height);
    }
    ctx.stroke();

    // Draw Players
    state.players.forEach((player) => {
      if (!player.alive) return;

      const px = player.x;
      const py = player.y;

      if (px === undefined || py === undefined) return;

      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath();
      ctx.ellipse(px, groundY, 30, 10, 0, 0, Math.PI * 2);
      ctx.fill();

      // Character
      ctx.save();

      // Stun Shake
      let shakeX = 0;
      if (player.isStunned) {
        shakeX = (Math.random() - 0.5) * 10;
      }

      ctx.translate(px + shakeX, py);
      if (player.facing === 'left') ctx.scale(-1, 1);

      // Body
      ctx.fillStyle = player.isStunned ? '#94a3b8' : player.color;
      ctx.fillRect(-20, -60, 40, 60);

      // Head
      ctx.fillStyle = '#f1f5f9';
      ctx.beginPath();
      ctx.arc(0, -70, 15, 0, Math.PI * 2);
      ctx.fill();

      // Stun Stars
      if (player.isStunned) {
        ctx.save();
        ctx.fillStyle = '#facc15'; // Yellow
        const time = Date.now() / 200;
        for (let i = 0; i < 3; i++) {
          const angle = time + (i * Math.PI * 2) / 3;
          const sx = Math.cos(angle) * 25;
          const sy = -80 + Math.sin(angle) * 5;
          ctx.beginPath();
          ctx.arc(sx, sy, 4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // Limbs (Simple animation based on state)
      ctx.strokeStyle = player.color;
      ctx.lineWidth = 8;
      ctx.lineCap = 'round';

      // Arms
      if (player.isAttacking) {
        if (player.attackType === 'punch') {
          ctx.beginPath();
          ctx.moveTo(0, -50);
          ctx.lineTo(30, -50); // Punch out
          ctx.stroke();
        } else {
          // Kick
          ctx.beginPath();
          ctx.moveTo(0, -30);
          ctx.lineTo(30, -10);
          ctx.stroke();
        }
      } else if (player.isBlocking) {
        ctx.beginPath();
        ctx.moveTo(0, -50);
        ctx.lineTo(15, -60); // Guard up
        ctx.stroke();
      } else {
        // Idle
        ctx.beginPath();
        ctx.moveTo(0, -50);
        ctx.lineTo(10, -30);
        ctx.stroke();
      }

      // Legs
      ctx.beginPath();
      ctx.moveTo(-10, 0);
      ctx.lineTo(-10, 20); // Left leg
      ctx.moveTo(10, 0);
      ctx.lineTo(10, 20); // Right leg
      ctx.stroke();

      ctx.restore();

      // Health Bar
      ctx.fillStyle = 'red';
      ctx.fillRect(px - 25, py - 100, 50, 6);
      ctx.fillStyle = 'green';
      ctx.fillRect(px - 25, py - 100, 50 * ((player.health || 0) / 100), 6);

      // Name
      ctx.fillStyle = 'white';
      ctx.font = '12px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(player.name, px, py - 110);
    });

    ctx.restore();

    // UI Overlay
    if (state.fighterState) {
      ctx.fillStyle = 'white';
      ctx.font = 'bold 32px system-ui';
      ctx.textAlign = 'center';
      const timeLeft = Math.max(0, Math.ceil((state.fighterState.roundEndsAt - Date.now()) / 1000));
      ctx.fillText(`${timeLeft}`, width / 2, 50);

      ctx.font = '16px system-ui';
      ctx.fillText(`Round ${state.fighterState.round}`, width / 2, 80);
    }
  }

  private drawPacman(ctx: CanvasRenderingContext2D, state: VoiceMinigameState, width: number, height: number): void {
    const { world } = state;
    const scale = Math.min(width / world.width, height / world.height) * 0.9;
    const offsetX = (width - world.width * scale) / 2;
    const offsetY = (height - world.height * scale) / 2;

    this.viewTransform = { scale, offsetX, offsetY };

    // Draw Map (Cached)
    const map = world.map;
    if (map && map.length > 0) {
      const mapId = world.mapId || 'default';
      if (this.lastPacmanMapId !== mapId || !this.pacmanMapCache) {
        this.lastPacmanMapId = mapId;
        const cache = createOffscreenCanvas(world.width, world.height);
        const mCtx = cache.getContext('2d');
        if (mCtx) {
          const tileSize = world.width / map[0].length;
          mCtx.fillStyle = '#1a237e';
          for (let y = 0; y < map.length; y++) {
            for (let x = 0; x < map[y].length; x++) {
              if (map[y][x] === 1) {
                mCtx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
              }
            }
          }
        }
        this.pacmanMapCache = cache;
      }

      if (this.pacmanMapCache) {
        ctx.drawImage(
          this.pacmanMapCache,
          0,
          0,
          this.pacmanMapCache.width,
          this.pacmanMapCache.height,
          offsetX,
          offsetY,
          world.width * scale,
          world.height * scale
        );
      }
    }

    // Draw Pellets
    const pelletSprite = this.spriteCache.get('#ffb74d', 'pellet'); // Default color
    const powerSprite = this.spriteCache.get('#ffeb3b', 'pellet'); // Powerup color

    state.pellets.forEach((pellet) => {
      const px = offsetX + pellet.x * scale;
      const py = offsetY + pellet.y * scale;
      const radius = (pellet.radius ?? 3) * scale;
      const size = radius * 2.5;

      const sprite = pellet.isPowerup ? powerSprite : pelletSprite;
      ctx.drawImage(sprite, px - size / 2, py - size / 2, size, size);
    });

    // Draw Players
    state.players.forEach((player) => {
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

  private drawPacmanHud(ctx: CanvasRenderingContext2D, state: VoiceMinigameState, width: number): void {
    const pacState = state.pacmanState;
    const mapName = state.world.mapName ?? state.world.mapId ?? 'Pacman Grid';
    const pelletsRemaining = pacState?.pelletsRemaining ?? state.pellets.length;
    const initialPellets = pacState?.initialPellets ?? (pelletsRemaining || 1);
    const progress = clamp(1 - pelletsRemaining / Math.max(initialPellets, 1), 0, 1);
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

  private drawPlaceholder(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.fillStyle = '#0f1727';
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

    const gameType = this.lastGameType;
    const title = gameType === 'pacman' ? 'Pacman Chase' : gameType === 'fighter' ? 'Fighter Arena' : 'Slither Arena';
    const icon = gameType === 'pacman' ? '👻' : gameType === 'fighter' ? '🥊' : '🐍';

    ctx.fillText(`${icon} ${title}`, width / 2, height / 2 - 20);

    ctx.font = `500 ${Math.max(16, titleSize * 0.35)}px system-ui`;
    ctx.fillStyle = 'rgba(248, 250, 252, 0.75)';
    ctx.fillText('Waiting for game to start...', width / 2, height / 2 + 30);
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D,
    world: { width: number; height: number },
    scale: number,
    offsetX: number,
    offsetY: number,
    viewWidth: number,
    viewHeight: number
  ): void {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;

    const startX = Math.floor(-offsetX / scale / GRID_SPACING) * GRID_SPACING;
    const endX = Math.ceil((viewWidth - offsetX) / scale / GRID_SPACING) * GRID_SPACING;
    const startY = Math.floor(-offsetY / scale / GRID_SPACING) * GRID_SPACING;
    const endY = Math.ceil((viewHeight - offsetY) / scale / GRID_SPACING) * GRID_SPACING;

    ctx.beginPath();
    for (let x = startX; x <= endX; x += GRID_SPACING) {
      if (x < 0 || x > world.width) continue;
      const pos = offsetX + x * scale;
      ctx.moveTo(Math.round(pos) + 0.5, 0);
      ctx.lineTo(Math.round(pos) + 0.5, viewHeight);
    }
    ctx.stroke();

    ctx.beginPath();
    for (let y = startY; y <= endY; y += GRID_SPACING) {
      if (y < 0 || y > world.height) continue;
      const pos = offsetY + y * scale;
      ctx.moveTo(0, Math.round(pos) + 0.5);
      ctx.lineTo(viewWidth, Math.round(pos) + 0.5);
    }
    ctx.stroke();

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
    const shadowOffset = 8 * scale;
    const shadowSprite = this.spriteCache.get('black', 'shadow');

    state.players.forEach((player) => {
      if (!player.alive || !player.segments?.length) return;

      const radius = (player.thickness ?? 12) * scale * 0.5;
      const size = radius * 2;

      player.segments.forEach((point, i) => {
        if (i % 3 !== 0) return; // Optimization
        const px = offsetX + point.x * scale + shadowOffset;
        const py = offsetY + point.y * scale + shadowOffset;
        ctx.drawImage(shadowSprite, px - radius, py - radius, size, size);
      });
    });
  }

  private drawPellets(
    ctx: CanvasRenderingContext2D,
    state: VoiceMinigameState,
    scale: number,
    offsetX: number,
    offsetY: number,
    viewWidth: number,
    viewHeight: number
  ): void {
    const margin = 50;

    for (const pellet of state.pellets) {
      const radius = Math.max((pellet.radius ?? 3) * scale, 4);
      const x = offsetX + pellet.x * scale;
      const y = offsetY + pellet.y * scale;

      if (x < -margin || x > viewWidth + margin || y < -margin || y > viewHeight + margin) {
        continue;
      }

      const sprite = this.spriteCache.get(pellet.color, 'pellet');
      const size = radius * 2.5; // Glow is larger
      ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
    }
  }

  private getHeadDirection(points: Point[] | undefined): Point {
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

  private drawPlayers(
    ctx: CanvasRenderingContext2D,
    state: VoiceMinigameState,
    scale: number,
    offsetX: number,
    offsetY: number,
    viewWidth: number,
    viewHeight: number
  ): void {
    const localId = this.options.getLocalPlayerId();
    const margin = 100;

    // Local player drawn last (on top); otherwise shorter snakes first.
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

      let lastX = -9999;
      let lastY = -9999;
      const drawThreshold = radius * 0.4; // Overlap factor

      // Draw segments from tail to head
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
        if (px < -margin || px > viewWidth + margin || py < -margin || py > viewHeight + margin) {
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

      // Head sprite (same as body, slightly larger)
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
        const pupilX = ex + dirX * eyeRadius * 0.5;
        const pupilY = ey + dirY * eyeRadius * 0.5;
        ctx.beginPath();
        ctx.fillStyle = 'black';
        ctx.arc(pupilX, pupilY, eyeRadius * 0.5, 0, Math.PI * 2);
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

  private drawMinimap(ctx: CanvasRenderingContext2D, state: VoiceMinigameState, canvasWidth: number, canvasHeight: number): void {
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

    const localId = this.options.getLocalPlayerId();

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
