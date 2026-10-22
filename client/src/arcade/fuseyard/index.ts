/**
 * Fuseyard's lazy chunk (fuseyard.md §8): the GameModule the shell mounts and the offline core it
 * steps for "Solo vs bots". One code path for both: the module only talks to its MatchHost.
 *
 * Offline the device has authority: one input per sim tick goes to the local host as the host
 * delivers each tick's FRAME, with no prediction. Online the module samples input at 30 Hz itself,
 * sends an UP every 2 ticks while anything is held (plus one after release), predicts its own
 * fighter and interpolates the others by server tick.
 */
import { buildDanger, dFrom, type DangerInput } from '@arcade/core/fuseyard/danger';
import { decodeCfg, decodeKeyframe, decodeResult, encodeUp, type WireConfig } from '@arcade/core/fuseyard/codec';
import { restoreMatch } from '@arcade/core/fuseyard/replay';
import { CORE_EVENT, createFuseyardCore } from '@arcade/core/fuseyard/runtime';
import { ARENA_IDS, BotLevel, CELLS, EV, MAX_BOMBS, Phase, REMOTE, Seat, cellAt, closeStart, roundLimit, type ArenaId, type Match, type MatchConfig } from '@arcade/core/fuseyard/rules';
import { takeOverOffline } from '@arcade/core/fuseyard/sim';
import { VERSION } from '@arcade/core/fuseyard/version';
import { NO_END, applyFrame, createWorld, type WBomb, type World } from '@arcade/core/fuseyard/view';
import { PEV } from '@arcade/core/net/events';
import { CLOSE, PHASE, TICK_MS, type Divisor } from '@arcade/core/net/lane';
import { createTickRing, interpDelayMs } from '@arcade/core/net/interp';
import { createGameAudio } from '@/arcade/runtime/audio';
import { createStageCanvas } from '@/arcade/runtime/canvas';
import { createInput } from '@/arcade/runtime/input';
import { createLoop } from '@/arcade/runtime/loop';
import { createLocalMatchHost } from '@/arcade/runtime/net/localHost';
import { readGamePref, writeGamePref } from '@/arcade/runtime/prefs';
import { bakeAtlas, type Atlas } from '@/arcade/runtime/sprites';
import { readLocal, writeLocal } from '@/arcade/runtime/store';
import type { GameChunk, GameHandle, GameModule, MatchHost, MountOpts, SeatInfo } from '@/arcade/runtime/types';
import { uiPalette, uiSheets, wickPalettes, wickSheets } from './art';
import { KEYMAP, createSteering, layoutFor, touchLayout } from './controls';
import { createMenus, type MenuSettings, type Standing } from './menus';
import { createPredictor } from './predict';
import { LOGICAL_H, LOGICAL_W, WICK_NAMES, createRenderer, fontSafe, type DrawState, type Renderer } from './render';
import { RECIPES, createSfx, musicFor } from './sound';

export const STATS_KEY = 'datasetto.arcade.fuseyard.stats.v1';

export interface LocalStats {
  matches: number;
  wins: number;
  roundWins: number;
  bestStreak: number;
  streak: number;
}

const parseStats = (v: unknown): LocalStats | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const n = (k: string): number => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? Math.max(0, Math.floor(o[k] as number)) : 0);
  return { matches: n('matches'), wins: n('wins'), roundWins: n('roundWins'), bestStreak: n('bestStreak'), streak: n('streak') };
};

/** Offline stats live on this device only (fuseyard.md §6). Storage failures fall back to memory. */
let memoryStats: LocalStats | null = null;
export const loadStats = (): LocalStats => readLocal(STATS_KEY, parseStats) ?? memoryStats ?? { matches: 0, wins: 0, roundWins: 0, bestStreak: 0, streak: 0 };
const saveStats = (s: LocalStats): void => {
  memoryStats = s;
  writeLocal(STATS_KEY, s);
};

interface GamePrefs {
  lanes: boolean;
  music: boolean | null;
}
const parseGamePrefs = (v: unknown): GamePrefs | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return { lanes: o.lanes !== false, music: typeof o.music === 'boolean' ? o.music : null };
};

const pixelatedSupported = (): boolean => {
  try {
    return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('image-rendering', 'pixelated');
  } catch {
    return false;
  }
};

const LEVELS: Record<string, number> = { sprout: BotLevel.Sprout, scrapper: BotLevel.Scrapper, menace: BotLevel.Menace };

/** The offline match configuration from the options form's values. */
export const localConfig = (mode: string, cfg: unknown, seed: number, fighters: number): MatchConfig => {
  const c = (cfg ?? {}) as Record<string, unknown>;
  const arena = typeof c.arena === 'string' && (ARENA_IDS as readonly string[]).includes(c.arena) ? (c.arena as ArenaId) : 'rotation';
  const wins = c.wins === 2 || c.wins === 5 ? c.wins : 3;
  const n = Math.max(2, Math.min(4, Math.round(Number(c.fighters ?? fighters) || fighters)));
  return {
    mode: mode === 'quickfire' ? 'quickfire' : 'brawl',
    arena,
    fighters: n as 2 | 3 | 4,
    winsNeeded: wins as 2 | 3 | 5,
    botLevel: (LEVELS[String(c.bots)] ?? BotLevel.Scrapper) as MatchConfig['botLevel'],
    seed: seed >>> 0,
  };
};

const randomSeed = (): number => {
  const b = new Uint32Array(1);
  try {
    crypto.getRandomValues(b);
  } catch {
    b[0] = (Math.random() * 0xffffffff) >>> 0;
  }
  return b[0] as number;
};

// ------------------------------------------------------------------ the module

const mount = (el: HTMLElement, firstHost: MatchHost, opts: MountOpts): GameHandle => {
  // The host changes at most once: after a server restart the match can go on here, offline.
  let host: MatchHost = firstHost;
  let local = host.mode === 'local';
  /** This module made the current host (a restart continued offline), so it shows and hides it too. */
  let ownHost = false;
  /** A continued match: it does not count toward this device's stats. */
  let voided = false;
  /** The restored match from a HANDOVER, while the restart panel offers to continue it. */
  let handover: Match | null = null;
  let restartOffer = false;
  const root = document.createElement('div');
  root.className = 'fuseyard relative h-full w-full overflow-hidden bg-[#0b0b12] outline-none select-none';
  root.dataset.fuseyard = '';
  root.setAttribute('aria-label', 'Fuseyard');
  root.style.touchAction = 'none';
  el.append(root);
  const boardBox = document.createElement('div');
  boardBox.style.cssText = 'position:absolute;z-index:1;display:flex;align-items:center;justify-content:center';
  root.append(boardBox);
  const legend = document.createElement('div');
  legend.className = 'pointer-events-none absolute right-0 bottom-1 left-0 text-center text-xs text-text-muted';
  legend.textContent = 'Move: WASD or arrows · Bomb: Space or J · Detonate: K or Shift · Pause: Esc or P';
  root.append(legend);
  const hint = document.createElement('div');
  hint.className = 'pointer-events-none absolute top-2 left-1/2 z-30 hidden -translate-x-1/2 rounded-md bg-black/70 px-3 py-1.5 text-xs text-white';
  hint.textContent = 'Turn your phone sideways for a bigger board';
  root.append(hint);
  const notice = document.createElement('div');
  notice.className = 'pointer-events-none absolute top-2 left-1/2 z-30 hidden -translate-x-1/2 rounded-md bg-black/70 px-3 py-1.5 text-xs text-white';
  root.append(notice);

  const stage = createStageCanvas(boardBox, { logicalW: LOGICAL_W, logicalH: LOGICAL_H, mode: pixelatedSupported() ? 'pixelated' : 'blit', dprCap: 3 });
  stage.canvas.setAttribute('aria-hidden', 'true');
  const input = createInput(root, { keys: KEYMAP, ptt: opts.ptt, reserved: opts.reserved, touch: opts.coarse ? touchLayout(opts.prefs) : null, gamepad: true });
  input.setButtonVisible('b', false);
  const touchRoot = root.querySelector<HTMLElement>('[data-arcade-touch]');
  const steering = createSteering();
  const audio = createGameAudio({ master: opts.prefs.volume });
  const sfx = createSfx(audio, () => performance.now());
  const predictor = createPredictor();

  const gp = readGamePref('fuseyard', parseGamePrefs) ?? { lanes: opts.coarse, music: null };
  const settings: MenuSettings = { lanes: gp.lanes && (opts.coarse || gp.lanes), music: gp.music ?? (local ? true : opts.prefs.music) };

  let disposed = false;
  let visible = true;
  const showAtlas = import.meta.env.DEV && typeof location !== 'undefined' && location.search.includes('fuseyard-atlas');
  let ui: Atlas | null = null;
  let wickAtlas: Atlas | null = null;
  let renderer: Renderer | null = null;
  let cfg: WireConfig = { mode: 'brawl', arena: 'rotation', fighters: 4, winsNeeded: 3, botLevel: 1 };
  let me = opts.me.slot ?? 0;
  let world: World = createWorld(4);
  let names: string[] = ['', '', '', ''];
  let divisor: Divisor | 1 = local ? 1 : 2;
  let lagging = false;
  let shake = 0;
  let playStartTick = 0;
  let ghostBomb = -1;
  let ghostUntil = 0;
  let closingHeard = false;
  let lastCountdown = -1;
  let ended = false;
  let audioReady = false;
  let musicArena = -1;
  // Smoothing between ticks: the previous and current snapshot positions.
  const prevX = new Float64Array(4);
  const prevY = new Float64Array(4);
  const curX = new Float64Array(4);
  const curY = new Float64Array(4);
  const drawX = new Float64Array(4);
  const drawY = new Float64Array(4);
  // Online: positions by server tick for the others.
  const ring = createTickRing(32);
  const ringX = new Float64Array(32 * 4);
  const ringY = new Float64Array(32 * 4);

  // ---------------------------------------------------------------- blast lanes
  const lanes = new Uint8Array(CELLS);
  const laneFlame = new Uint8Array(CELLS);
  const laneWarn = new Uint8Array(CELLS);
  const laneBombAt = new Int8Array(CELLS);
  const laneBombs = Array.from({ length: MAX_BOMBS }, () => ({ x: 0, y: 0, fuse: 0, range: 0, owner: 0, slideDir: 0 }));
  const dangerIn: DangerInput = { cells: world.cells, items: world.items, flame: laneFlame, warn: laneWarn, bombCount: 0, bombs: laneBombs };
  let lanesOn = false;
  const computeLanes = (): void => {
    lanesOn = settings.lanes && world.bombCount > 0;
    if (!lanesOn) return;
    const R = world.roundTick;
    for (let c = 0; c < CELLS; c += 1) {
      const fl = (world.flameEnd[c] as number) - R;
      laneFlame[c] = fl > 0 ? Math.min(255, fl) : 0;
      const wn = (world.warnEnd[c] as number) - R;
      laneWarn[c] = wn > 0 ? Math.min(255, wn) : 0;
    }
    laneBombAt.fill(-1);
    for (let i = 0; i < world.bombCount; i += 1) {
      const b = world.bombs[i] as WBomb;
      const d = laneBombs[i]!;
      d.x = b.x;
      d.y = b.y;
      d.fuse = b.fuseEnd === NO_END ? REMOTE : Math.max(0, b.fuseEnd - R);
      d.range = b.range;
      d.owner = b.owner;
      d.slideDir = b.slideDir;
      laneBombAt[cellAt(b.x, b.y)] = i;
    }
    dangerIn.cells = world.cells;
    dangerIn.items = world.items;
    dangerIn.bombCount = world.bombCount;
    buildDanger(dangerIn, laneBombAt);
    for (let c = 0; c < CELLS; c += 1) lanes[c] = (dFrom[c] as number) <= 30 ? 1 : 0;
  };

  // ---------------------------------------------------------------- layout
  let rotateHinted = false;
  let hintTimer: ReturnType<typeof setTimeout> | null = null;
  const layout = (): void => {
    const w = root.clientWidth;
    const h = root.clientHeight;
    const box = layoutFor(w, h, opts.coarse);
    boardBox.style.left = box.left + 'px';
    boardBox.style.top = box.top + 'px';
    boardBox.style.width = box.width + 'px';
    boardBox.style.height = box.height + 'px';
    legend.style.display = box.orientation === 'desktop' ? '' : 'none';
    if (touchRoot) {
      // Narrow side margins: the controls go over the board, faintly.
      touchRoot.style.zIndex = box.overlay ? '2' : '0';
      touchRoot.style.opacity = box.overlay ? '0.35' : '';
    }
    if (opts.coarse && !rotateHinted && box.orientation === 'portrait' && stage.metrics.scale > 0 && stage.metrics.scale * 16 < 18) {
      rotateHinted = true;
      hint.classList.remove('hidden');
      hintTimer = setTimeout(() => {
        hintTimer = null;
        hint.classList.add('hidden');
      }, 4000);
    }
  };
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => layout());
    observer.observe(root);
  }
  layout();
  const offResize = stage.onResize(() => layout());

  // ---------------------------------------------------------------- audio
  const unlockAudio = (): void => {
    if (disposed) return;
    void audio.unlock().then(() => {
      if (disposed || audioReady) return;
      audioReady = true;
      void audio.prerender(RECIPES);
      syncMusic();
    });
  };
  const syncMusic = (): void => {
    if (!audioReady || disposed) return;
    if (!settings.music) {
      if (musicArena !== -1) audio.music(null);
      musicArena = -1;
      return;
    }
    if (world.ready && world.arena !== musicArena) {
      musicArena = world.arena;
      audio.music(musicFor(world.arena));
    }
  };
  const gesture = (): void => {
    unlockAudio();
    if (document.activeElement !== root && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
  };
  root.addEventListener('pointerdown', gesture);
  root.addEventListener('keydown', gesture);

  // ---------------------------------------------------------------- menus
  const menuKeys = (e: KeyboardEvent): void => {
    if (e.code !== 'Escape' && e.code !== 'KeyP') return;
    if (menus.pauseOpen) {
      e.preventDefault();
      e.stopPropagation();
      resumePlay();
    }
  };
  const openPause = (): void => {
    if (menus.endOpen || menus.pauseOpen) return;
    menus.showPause(true);
    if (local) host.setVisible(false);
    root.addEventListener('keydown', menuKeys, true);
    padPoll();
    menus.focus();
    loop.markDirty();
    syncWake();
  };
  const resumePlay = (): void => {
    if (!menus.pauseOpen) return;
    menus.showPause(false);
    root.removeEventListener('keydown', menuKeys, true);
    steering.reset();
    if (local && visible) host.setVisible(true);
    root.focus({ preventScroll: true });
    loop.markDirty();
    syncWake();
  };
  const menus = createMenus(
    root,
    {
      resume: resumePlay,
      leave: () => opts.shell.leave(),
      rematch: () => {
        if (restartOffer) {
          continueOffline();
          return;
        }
        if (!local) {
          opts.shell.leave();
          return;
        }
        const seed = randomSeed();
        host.sendEvent(new Uint8Array([CORE_EVENT.rematch, seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255, seed >>> 24]));
      },
      settings: (s) => {
        settings.lanes = s.lanes;
        settings.music = s.music;
        writeGamePref('fuseyard', { lanes: s.lanes, music: s.music });
        if (!s.lanes) lanes.fill(0);
        syncMusic();
        loop.markDirty();
      },
    },
    { coarse: opts.coarse },
  );
  menus.setSettings(settings);

  // Gamepad on static screens (pause, match end): a 10 Hz poll for Start and A, only while a pad is
  // connected and the game is visible (fuseyard.md §8.4). The running game reads the pad per tick.
  let padTimer: ReturnType<typeof setTimeout> | null = null;
  let padWas = 0;
  const padPoll = (): void => {
    if (padTimer !== null || disposed) return;
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? Array.from(navigator.getGamepads() ?? []) : [];
    if (!visible || !(menus.pauseOpen || menus.endOpen) || !pads.some((p) => p && p.connected !== false)) return;
    padTimer = setTimeout(() => {
      padTimer = null;
      let bits = 0;
      for (const p of navigator.getGamepads() ?? []) {
        if (!p) continue;
        if (p.buttons[9]?.pressed) bits |= 1;
        if (p.buttons[0]?.pressed) bits |= 2;
      }
      const down = bits & ~padWas;
      padWas = bits;
      if (down & 1 && menus.pauseOpen) resumePlay();
      else if (down & 2) (document.activeElement as HTMLElement | null)?.click?.();
      padPoll();
    }, 100);
  };

  // ---------------------------------------------------------------- frames from the host
  let inputSeq = 0;
  const upBatch = new Uint8Array(6);
  let upCount = 0;
  let upActive = false;
  let tickAcc = 0;
  let lastNow = 0;

  const sendLocalInput = (): void => {
    const s = input.sample();
    const { byte, menu } = steering.sample(s);
    if (menu) {
      openPause();
      return;
    }
    if (byte & 0x40) {
      const f = world.fight[me];
      if (f && f.alive) sfx.play('place');
    }
    inputSeq = (inputSeq + 1) & 0xffff;
    upBatch[0] = byte;
    host.sendUp(encodeUp(upBatch.subarray(0, 1), 1), inputSeq);
  };

  /** Online: one input per 30 Hz tick; an UP every 2 ticks (4 at the bottom of the ladder). */
  const remoteTick = (nowMs: number): void => {
    const s = input.sample();
    const { byte, menu } = steering.sample(s);
    if (menu) openPause();
    if (me < 0) return;
    inputSeq = (inputSeq + 1) & 0xffff;
    if (byte & 0x40) {
      const f = world.fight[me];
      if (f && f.alive && f.seat === Seat.Live) {
        ghostBomb = cellAt(predictor.x | 0, predictor.y | 0);
        ghostUntil = nowMs + host.rttMs() + 200;
        sfx.play('place');
      }
    }
    // Only inputs that go out in an UP enter the batch and the predictor: idle ticks are not sent
    // (the server repeats the last direction for them), so they must not be replayed either. The
    // batch is always a run of consecutive ticks, as UP's numbering requires.
    if (byte !== 0 || upActive) {
      if (byte !== 0) upActive = true;
      if (upCount === 6) upBatch.copyWithin(0, 1);
      else upCount += 1;
      upBatch[upCount - 1] = byte;
      predictor.sent(inputSeq, byte);
    }
    const every = divisor === 6 ? 4 : 2;
    if (inputSeq % every === 0 && upCount > 0) {
      host.sendUp(encodeUp(upBatch.subarray(0, upCount), upCount), inputSeq);
      // One more UP after a release; then nothing while idle.
      let any = false;
      for (let i = 0; i < upCount; i += 1) if (upBatch[i]) any = true;
      upActive = any;
      upCount = 0;
    }
  };

  const fx = (): void => {
    const w = world;
    for (let i = 0; i < w.fxLen; i += 1) {
      const o = i * 4;
      const kind = w.fx[o] as number;
      const a = w.fx[o + 1] as number;
      const b = w.fx[o + 2] as number;
      if (!audioReady && kind !== EV.Round && kind !== EV.Stats) continue;
      switch (kind) {
        case EV.BombPlaced:
          if (a === me && b === ghostBomb) ghostBomb = -1;
          else if (a !== me || !local) sfx.play('place', { gain: 0.6 });
          break;
        case EV.Explode:
          sfx.explode(b);
          if (!opts.reducedMotion) shake = 6;
          break;
        case EV.BlockBroken:
          sfx.play('crumble', { gain: 0.5 });
          break;
        case EV.ItemTaken:
          sfx.play('pickup', { gain: a === me ? 1 : 0.4 });
          break;
        case EV.BombKicked:
          sfx.play('kick');
          break;
        case EV.Teleport:
          sfx.play('teleport', { gain: 0.6 });
          break;
        case EV.Died:
          sfx.play('death', { gain: a === me ? 1 : 0.6 });
          break;
        case EV.SteelWarn:
          if (!closingHeard) {
            closingHeard = true;
            sfx.play('closing');
          }
          break;
        case EV.Round:
          if (a === Phase.Countdown) {
            closingHeard = false;
            lastCountdown = -1;
          } else if (a === Phase.Playing) {
            playStartTick = w.fx[o + 3] as number;
            if (audioReady) sfx.play('go');
          } else if (a === Phase.RoundEnd && b === me && audioReady) sfx.play('win');
          break;
        case PEV.SeatState:
          if (a === me && (b & 0xff) === Seat.Live && b >> 8 === Seat.Ghost) sfx.play('shield');
          break;
        default:
          break;
      }
    }
  };

  const afterWorldChange = (): void => {
    const f = world.fight[me];
    input.setButtonVisible('b', Boolean(f && f.alive && f.clicker));
    if (world.phase === Phase.MatchEnd || ended) loop.animate(false);
    else loop.animate(true);
    computeLanes();
    syncMusic();
    syncWake();
    loop.markDirty();
  };

  const snapPositions = (): void => {
    for (let s = 0; s < 4; s += 1) {
      const f = world.fight[s]!;
      prevX[s] = curX[s] = f.x;
      prevY[s] = curY[s] = f.y;
    }
  };

  let offSeats: () => void = () => undefined;
  const bindHost = (h: MatchHost): void => {
    h.onWelcome((w) => {
      const c = decodeCfg(w.cfg);
      if (c) cfg = c;
      me = w.slot === 0xff ? -1 : w.slot;
      world = createWorld(cfg.fighters);
      dangerIn.cells = world.cells;
      divisor = local ? 1 : w.divisor;
      renderer?.invalidate();
      if (w.queued) {
        notice.textContent = 'You are watching until the next round';
        notice.classList.remove('hidden');
      } else notice.classList.add('hidden');
      opts.shell.status('live');
    });

    h.onKeyframe((k) => {
      if (!decodeKeyframe(k.body, k.tick, world)) return;
      snapPositions();
      ring.clear();
      predictor.reset();
      if (!local && me >= 0) predictor.reconcile(world, me, k.ackUp);
      ghostBomb = -1;
      menus.hideEnd();
      renderer?.invalidate();
      if (world.phase === Phase.Playing) playStartTick = k.tick - 999;
      afterWorldChange();
    });

    h.onFrame((f) => {
      if (!world.ready) return;
      if (f.divisor !== divisor && !local) divisor = f.divisor;
      lagging = f.lagging;
      for (let s = 0; s < 4; s += 1) {
        prevX[s] = curX[s] as number;
        prevY[s] = curY[s] as number;
      }
      applyFrame(world, f.tick, f.events, f.snapshot);
      for (let s = 0; s < 4; s += 1) {
        const ft = world.fight[s]!;
        curX[s] = ft.x;
        curY[s] = ft.y;
        // A jump (pad, steel, new round) is not smoothed.
        if (Math.abs((curX[s] as number) - (prevX[s] as number)) > 40 || Math.abs((curY[s] as number) - (prevY[s] as number)) > 40) {
          prevX[s] = curX[s] as number;
          prevY[s] = curY[s] as number;
        }
      }
      if (!local) {
        const slot = ring.push(f.tick);
        if (slot >= 0) {
          for (let s = 0; s < 4; s += 1) {
            ringX[slot * 4 + s] = curX[s] as number;
            ringY[slot * 4 + s] = curY[s] as number;
          }
        }
        if (me >= 0) predictor.reconcile(world, me, f.ackUp);
      }
      fx();
      // A finished match only redraws when something still happens (offline the host keeps ticking).
      if (world.fxLen > 0 || world.phase !== Phase.MatchEnd) afterWorldChange();
      if (local && world.phase !== Phase.MatchEnd && !menus.pauseOpen) sendLocalInput();
    });

    h.onPhase((p) => {
      if (p.phase === PHASE.running) {
        ended = false;
        menus.hideEnd();
        return;
      }
      if (p.phase !== PHASE.ending) return;
      const res = decodeResult(p.body);
      if (!res) return;
      const rows: Standing[] = [];
      for (let s = 0; s < cfg.fighters; s += 1) {
        const r = res[s]!;
        let better = 0;
        for (let o = 0; o < cfg.fighters; o += 1) if (res[o]!.roundWins > r.roundWins) better += 1;
        rows.push({ slot: s, wick: WICK_NAMES[s] as string, name: names[s] ?? '', roundWins: r.roundWins, kills: r.kills, blocks: r.blocks, place: better + 1 });
      }
      rows.sort((a, b) => a.place - b.place || a.slot - b.slot);
      let note = '';
      if (local && me >= 0 && !voided) {
        const mine = rows.find((r) => r.slot === me);
        const st = loadStats();
        const won = Boolean(mine && mine.place === 1 && mine.roundWins > 0);
        const streak = won ? st.streak + 1 : 0;
        saveStats({ matches: st.matches + 1, wins: st.wins + (won ? 1 : 0), roundWins: st.roundWins + (mine?.roundWins ?? 0), streak, bestStreak: Math.max(st.bestStreak, streak) });
        const now = loadStats();
        note = `On this device: ${now.wins} wins in ${now.matches} matches · best streak ${now.bestStreak}`;
      } else if (voided) note = 'A match continued after a restart does not count toward your stats.';
      else if (!local) note = 'Rematch from the lobby: the host starts the next one.';
      menus.showEnd(rows, { canRematch: local, note });
      menus.focus();
      padPoll();
      loop.markDirty();
    });

    h.onHandover((body, simVersion) => {
      // Only a dump of this exact sim can go on here (fuseyard.md §5).
      handover = simVersion === VERSION.sim ? restoreMatch(body) : null;
    });

    h.onClosed((code) => {
      if (h !== host) return;
      ended = true;
      opts.shell.status('ended');
      loop.animate(false);
      loop.markDirty();
      syncWake();
      if (!local && code === CLOSE.restart) showRestart();
    });

    offSeats = h.onSeats((seats: readonly SeatInfo[]) => {
      names = ['', '', '', ''];
      for (const s of seats) if (s.slot >= 0 && s.slot < 4) names[s.slot] = s.bot ? 'Bot' : s.name;
    });
  };
  bindHost(host);

  /** After a restart: offer to play the match on here against bots, when its dump came through. */
  const showRestart = (): void => {
    restartOffer = handover !== null && me >= 0;
    if (menus.pauseOpen) {
      menus.showPause(false);
      root.removeEventListener('keydown', menuKeys, true);
    }
    menus.showEnd([], {
      canRematch: restartOffer,
      title: 'The server restarted',
      again: 'Continue vs bots',
      note: restartOffer
        ? 'Play this match on here, with bots in the other seats. Results will not count.'
        : 'This match could not be saved. Leave, and start a new one when the server is back.',
    });
    menus.focus();
    padPoll();
    loop.markDirty();
  };

  /** Swap the closed lane for a local host running the restored match (other humans become bots). */
  const continueOffline = (): void => {
    const m = handover;
    restartOffer = false;
    handover = null;
    if (!m || me < 0 || disposed) return;
    takeOverOffline(m, me);
    const core = createFuseyardCore({ config: m.config, seats: [], offline: true, match: m });
    const seats: SeatInfo[] = [];
    for (let s = 0; s < m.config.fighters; s += 1) seats.push({ slot: s, accountId: null, name: s === me ? (names[me] ?? '') : 'Bot', bot: s !== me, joinOrder: s, extra: 0 });
    offSeats();
    host.close();
    host = createLocalMatchHost(core, { selfSlot: me, seats });
    local = true;
    ownHost = true;
    voided = true;
    ended = false;
    divisor = 1;
    upCount = 0;
    upActive = false;
    ghostBomb = -1;
    predictor.reset();
    ring.clear();
    menus.hideEnd();
    bindHost(host);
    if (!visible) host.setVisible(false);
    opts.shell.status('live');
    loop.animate(true);
    loop.markDirty();
    root.focus({ preventScroll: true });
  };

  // ---------------------------------------------------------------- drawing
  const draw: DrawState = {
    w: world,
    me,
    nowMs: 0,
    px: drawX,
    py: drawY,
    tick: 0,
    roundTick: 0,
    ghostBomb: -1,
    lanes: null,
    playTicks: 999,
    lag: false,
    names,
    reducedMotion: opts.reducedMotion,
    shake: 0,
    clockSeconds: null,
    closing: false,
    waitingFor: null,
    holdSeconds: null,
  };

  const loop = createLoop({
    maxFps: 60,
    draw(now) {
      if (disposed) return;
      const dt = lastNow ? Math.min(250, now - lastNow) : 0;
      lastNow = now;
      if (!local && world.ready && !menus.pauseOpen) {
        tickAcc += dt;
        for (let n = 0; n < 4 && tickAcc >= TICK_MS; n += 1) {
          remoteTick(now);
          tickAcc -= TICK_MS;
        }
        if (tickAcc >= TICK_MS) tickAcc = 0;
      }
      if (!renderer) return;
      const w = world;
      const est = host.estServerTick(now);
      let frac = est - w.tick;
      if (!(frac >= 0)) frac = 0;
      if (frac > 1) frac = 1;
      if (local || me < 0) {
        for (let s = 0; s < 4; s += 1) {
          drawX[s] = (prevX[s] as number) + ((curX[s] as number) - (prevX[s] as number)) * frac;
          drawY[s] = (prevY[s] as number) + ((curY[s] as number) - (prevY[s] as number)) * frac;
        }
      } else {
        const delayTicks = interpDelayMs(divisor, 0) / TICK_MS;
        const br = ring.bracket(est - delayTicks);
        for (let s = 0; s < 4; s += 1) {
          if (br) {
            const ax = ringX[br.a * 4 + s] as number;
            const bx = ringX[br.b * 4 + s] as number;
            const ay = ringY[br.a * 4 + s] as number;
            const by = ringY[br.b * 4 + s] as number;
            drawX[s] = ax + (bx - ax) * br.t;
            drawY[s] = ay + (by - ay) * br.t;
          } else {
            drawX[s] = curX[s] as number;
            drawY[s] = curY[s] as number;
          }
        }
        predictor.frame();
        const mf = w.fight[me];
        if (mf && mf.alive) {
          drawX[me] = predictor.x;
          drawY[me] = predictor.y;
        }
        if (ghostBomb >= 0 && now > ghostUntil) ghostBomb = -1;
      }
      const R = w.roundTick + (w.phase === Phase.Playing ? frac : 0);
      draw.w = w;
      draw.me = me;
      draw.nowMs = now;
      draw.tick = w.tick + frac;
      draw.roundTick = R;
      draw.ghostBomb = ghostBomb;
      draw.lanes = lanesOn ? lanes : null;
      draw.playTicks = w.phase === Phase.Playing ? w.tick - playStartTick : 999;
      draw.lag = lagging || (!local && host.rttMs() > 500);
      draw.names = names;
      draw.shake = shake;
      if (shake > 0) shake -= 1;
      const limit = roundLimit(cfg.mode);
      draw.clockSeconds = w.phase === Phase.Countdown ? limit / 30 : (limit - R) / 30;
      draw.closing = w.roundTick >= closeStart(cfg.mode);
      let waiting = -1;
      if (w.phase === Phase.Frozen) for (let i = 0; i < w.fighters && waiting < 0; i += 1) if (w.fight[i]!.alive && w.fight[i]!.seat === Seat.Ghost) waiting = i;
      draw.waitingFor = waiting >= 0 ? fontSafe(names[waiting] ?? '', 20) || WICK_NAMES[waiting] || null : null;
      draw.holdSeconds = w.phase === Phase.Frozen && w.holdWinner >= 0 ? (150 - (w.tick - w.holdStart)) / 30 : null;
      // Countdown blips.
      if ((w.phase === Phase.Countdown || w.phase === Phase.Resuming) && audioReady) {
        const n = Math.ceil((w.phaseEnd - (w.tick + frac)) / 30);
        if (n !== lastCountdown && n >= 1 && n <= 3) sfx.play('tick');
        lastCountdown = n;
      }
      if (showAtlas && ui && wickAtlas) {
        // Dev only (?fuseyard-atlas): the two baked atlases instead of the game.
        stage.ctx.fillStyle = '#202030';
        stage.ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
        stage.ctx.drawImage(ui.image, 0, 0);
        stage.ctx.drawImage(wickAtlas.image, 120, 0);
        return;
      }
      renderer.draw(draw);
    },
  });

  // Atlases bake asynchronously (ImageBitmap); the first frames show a loading line until then.
  void Promise.all([bakeAtlas(uiSheets, [uiPalette]), bakeAtlas(wickSheets, wickPalettes)]).then(
    ([a, b]) => {
      if (disposed) {
        a.dispose();
        b.dispose();
        return;
      }
      ui = a;
      wickAtlas = b;
      renderer = createRenderer(stage.ctx, a, b);
      loop.markDirty();
    },
    () => undefined,
  );

  // ---------------------------------------------------------------- wake lock and visibility
  let wakeOn = false;
  const syncWake = (): void => {
    const want = visible && !disposed && !ended && world.ready && world.phase === Phase.Playing && !(local && menus.pauseOpen);
    if (want !== wakeOn) {
      wakeOn = want;
      opts.shell.wakeLock(want);
    }
  };

  root.focus({ preventScroll: true });

  return {
    pause() {
      if (disposed) return;
      visible = false;
      loop.setVisible(false);
      audio.suspend();
      steering.reset();
      if (ownHost) host.setVisible(false);
      // Offline, hiding pauses the match: come back to the pause menu, not to a running round.
      if (local && world.ready && world.phase !== Phase.MatchEnd && !ended && !menus.pauseOpen) {
        menus.showPause(true);
        root.addEventListener('keydown', menuKeys, true);
      }
      syncWake();
    },
    resume() {
      if (disposed) return;
      visible = true;
      loop.setVisible(true);
      audio.resume();
      lastNow = 0;
      tickAcc = 0;
      if (local && menus.pauseOpen) host.setVisible(false);
      else if (ownHost) host.setVisible(true);
      // Coming back from "Back to call" the stage was out of the page and focus fell to the body:
      // take it back so the keys work again, unless something else (the chat box) has it.
      const active = document.activeElement;
      if (!active || active === document.body) {
        if (menus.pauseOpen || menus.endOpen) menus.focus();
        else root.focus({ preventScroll: true });
      }
      loop.markDirty();
      padPoll();
      syncWake();
    },
    back() {
      if (disposed) return false;
      if (menus.pauseOpen || menus.endOpen) return false;
      openPause();
      return true;
    },
    unmount() {
      if (disposed) return;
      disposed = true;
      if (wakeOn) opts.shell.wakeLock(false);
      wakeOn = false;
      loop.dispose();
      input.dispose();
      offSeats();
      if (ownHost) host.close();
      offResize();
      observer?.disconnect();
      observer = null;
      if (padTimer !== null) clearTimeout(padTimer);
      padTimer = null;
      if (hintTimer !== null) clearTimeout(hintTimer);
      hintTimer = null;
      root.removeEventListener('pointerdown', gesture);
      root.removeEventListener('keydown', gesture);
      root.removeEventListener('keydown', menuKeys, true);
      menus.dispose();
      renderer?.dispose();
      ui?.dispose();
      wickAtlas?.dispose();
      void audio.close();
      stage.dispose();
      root.remove();
    },
  };
};

const fuseyardModule: GameModule<MatchHost> = { mount };

const chunk: GameChunk = {
  module: fuseyardModule,
  local({ mode, cfg, seed, seats }) {
    const config = localConfig(mode, cfg, seed[0] ?? randomSeed(), seats.length);
    return createFuseyardCore({
      config,
      seats: seats.filter((s) => s.slot < config.fighters).map((s) => ({ slot: s.slot, human: !s.bot, botLevel: config.botLevel })),
      offline: true,
    });
  },
};

export default chunk;
export { fuseyardModule as module };
