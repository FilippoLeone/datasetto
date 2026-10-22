/**
 * The Arcade's coarse Preact state (plan.md §2.6.7, platform.md §10.1). Each signal is written at
 * most about once per second, on lobby, seat or phase changes; games never write signals per tick,
 * so the voice page never re-renders on game traffic. In dev builds every write is counted and a
 * signal written more than twice in a second logs a warning.
 *
 * This module is in the main bundle and imports types only from the runtime.
 */
import { signal, type Signal } from '@preact/signals';
import type { GameId, LobbyView, SessionStatus } from '@/arcade/runtime/types';

/** One running or forming game in a voice channel (`arcade:activity`). */
export interface ActivityEntry {
  g: GameId;
  id: string;
  st: 'open' | 'lobby' | 'live' | 'dash';
  n: number;
  max: number;
  w: number;
  /** Optional label, ≤ 24 characters. */
  x?: string;
  /** For 60 s after a pot win. */
  j?: { amt: number };
}

export interface ArcadeSessionState {
  game: GameId;
  id: string;
  role: 'player' | 'spectator';
  mode: 'local' | 'remote';
  status: SessionStatus;
  attention: boolean;
  minimized: boolean;
}

export interface ArcadeWalletView {
  bal: number;
  esc: number;
  /** The daily claim is available. */
  claim: boolean;
}

/** `arcade` in GET /api/config and auth:success. Offline (null) everything is enabled. */
export interface ArcadePublicConfig {
  enabled: boolean;
  games: Record<GameId, boolean>;
  proto: { lamplight: number };
  defs: { glimmer: number };
}

/** Account-level "Hide Arcade" with per-game toggles (`arcade:prefs`). */
export interface ArcadeHidden {
  hidden: boolean;
  games: Partial<Record<GameId, boolean>>;
  /** When a pending un-hide takes effect (self-exclusion: 24 h). */
  reenableAt: number | null;
}

export const arcadeActivity: Signal<ReadonlyMap<string, readonly ActivityEntry[]>> = signal(new Map());
export const arcadeLobby: Signal<LobbyView | null> = signal(null);
export const arcadeSession: Signal<ArcadeSessionState | null> = signal(null);
export const arcadeWallet: Signal<ArcadeWalletView | null> = signal(null);

// Internal to the platform ------------------------------------------------------

export const arcadeConfig: Signal<ArcadePublicConfig | null> = signal(null);
export const arcadeHidden: Signal<ArcadeHidden | null> = signal(null);

/**
 * What the shell shows: the full-screen overlay for local play (from anywhere, signed in or not),
 * or the stage in the voice page for an online match. `game` null shows the catalogue.
 */
export interface ArcadeView {
  mode: 'local' | 'remote';
  game: GameId | null;
  channelId: string | null;
}
export const arcadeView: Signal<ArcadeView | null> = signal(null);

/** Open the Arcade: local play opens the overlay (catalogue, or straight to `game`); remote opens the stage. */
export const openArcade = (o: { game?: GameId; mode: 'local' | 'remote'; channelId?: string }): void => {
  const session = arcadeSession.peek();
  if (session?.minimized) {
    arcadeSession.value = { ...session, minimized: false };
    return;
  }
  arcadeView.value = { mode: o.mode, game: o.game ?? null, channelId: o.channelId ?? null };
};

export const closeArcade = (): void => {
  arcadeView.value = null;
};

/** Is this game hidden for the signed-in account (or the whole Arcade)? */
export const gameHidden = (game: GameId): boolean => {
  const hidden = arcadeHidden.value;
  if (!hidden) return false;
  return hidden.hidden || hidden.games[game] === false;
};

/** A voice channel has an Arcade game the viewer may see (the channel-list badge). */
export const arcadeBadge = (channelId: string): boolean => {
  if (arcadeHidden.value?.hidden) return false;
  return (arcadeActivity.value.get(channelId) ?? []).some((entry) => !gameHidden(entry.g));
};

/** Is the game switched on by the server (always, offline)? */
export const gameEnabled = (game: GameId): boolean => {
  const config = arcadeConfig.value;
  if (!config) return true;
  return config.enabled && config.games[game] !== false;
};

// Dev write counter -------------------------------------------------------------

export const arcadeSignalWrites: Record<string, number> = {};

if (import.meta.env.DEV) {
  const watched: Record<string, Signal<unknown>> = {
    arcadeActivity,
    arcadeLobby,
    arcadeSession,
    arcadeWallet,
  } as Record<string, Signal<unknown>>;
  for (const [name, sig] of Object.entries(watched)) {
    let first = true;
    let windowStart = 0;
    let inWindow = 0;
    arcadeSignalWrites[name] = 0;
    sig.subscribe(() => {
      if (first) {
        first = false;
        return;
      }
      arcadeSignalWrites[name] = (arcadeSignalWrites[name] ?? 0) + 1;
      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        inWindow = 0;
      }
      inWindow += 1;
      if (inWindow === 3) console.warn('[arcade] ' + name + ' written more than twice in a second');
    });
  }
}
