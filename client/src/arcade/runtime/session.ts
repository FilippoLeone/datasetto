/**
 * Starting and stopping a game session: load the game's chunk, build its host, the shell bridge
 * and the visibility watcher, mount the module, and on stop release every one of them (the
 * zero-cost-when-closed rule, platform.md §10.2). Loaded lazily with the runtime; the Preact shell
 * only calls into it.
 */
import type { CoreMatch } from '@arcade/core/net/match';
import type { GameMeta } from '@/arcade/catalog';
import { arcadeSession, type ArcadeSessionState } from '@/features/arcade/state';
import { parseShortcut } from '@/lib/shortcut';
import { socketClient } from '@/services/socket/client';
import { users } from '@/state/presence';
import { account } from '@/state/session';
import { audioSettings } from '@/state/settings';
import { createAttention } from './attention';
import { createLocalMatchHost, createLocalTableHost } from './net/localHost';
import { createRemoteMatchHost, createRemoteTableHost } from './net/remoteHost';
import { practiceWallet } from './practiceWallet';
import { loadPrefs } from './prefs';
import type { ActionGameId, AnyHost, GameChunk, GameHandle, LobbyView, LocalTableServer, MountOpts, SeatInfo, SessionStatus, ShellBridge, TableGameId } from './types';
import { watchStageVisibility } from './visibility';
import { createWakeLock } from './wakeLock';

export interface SessionHandle {
  /** Unmount the game and release everything. */
  stop(): void;
  /** Android back / Esc: the game's own handler, else minimize. Always consumed. */
  back(): boolean;
}

const media = (query: string): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;

const patchSession = (patch: Partial<ArcadeSessionState>): void => {
  const current = arcadeSession.peek();
  if (!current) return;
  let changed = false;
  for (const [key, value] of Object.entries(patch)) if (current[key as keyof ArcadeSessionState] !== value) changed = true;
  if (changed) arcadeSession.value = { ...current, ...patch };
};

/** Offline seats: you in slot 0, bots in the rest. */
export const localSeats = (meta: GameMeta, cfg: Record<string, unknown>, me: { accountId: string | null; name: string }): SeatInfo[] => {
  const [min, max] = meta.seats;
  const wanted = Number(cfg.players ?? cfg.fighters ?? (meta.lane === 'action' ? max : min));
  const count = Math.max(min, Math.min(max, Number.isFinite(wanted) ? Math.round(wanted) : min));
  const seats: SeatInfo[] = [{ slot: 0, accountId: me.accountId, name: me.name, bot: false, joinOrder: 0, extra: 0 }];
  for (let slot = 1; slot < count; slot += 1) seats.push({ slot, accountId: null, name: 'Bot ' + slot, bot: true, joinOrder: slot, extra: 0 });
  return seats;
};

/**
 * Stage visibility (watchStageVisibility) merged with the table games' idle-away rule: after `ms`
 * without input on the stage while visible, the game counts as hidden until the next input.
 */
export const createStageGate = (stage: HTMLElement, apply: (visible: boolean) => void) => {
  let stageVisible = true;
  let idle = false;
  let idleMs: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: boolean | null = null;
  let listening = false;
  const emit = (): void => {
    const visible = stageVisible && !idle;
    if (visible === last) return;
    last = visible;
    apply(visible);
  };
  const clear = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const arm = (): void => {
    clear();
    if (idleMs === null || !stageVisible || idle) return;
    timer = setTimeout(() => {
      timer = null;
      idle = true;
      emit();
    }, idleMs);
  };
  const onInput = (): void => {
    if (idle) {
      idle = false;
      emit();
    }
    arm();
  };
  const INPUT = ['pointerdown', 'keydown', 'wheel'] as const;
  const listen = (on: boolean): void => {
    if (on === listening) return;
    listening = on;
    for (const type of INPUT) {
      if (on) stage.addEventListener(type, onInput, { capture: true, passive: true });
      else stage.removeEventListener(type, onInput, { capture: true });
    }
  };
  const stopStage = watchStageVisibility(stage, (visible) => {
    stageVisible = visible;
    arm();
    emit();
  });
  return {
    get visible() {
      return last ?? true;
    },
    idleAway(ms: number | null) {
      idleMs = ms !== null && ms > 0 ? ms : null;
      listen(idleMs !== null);
      if (idleMs === null) idle = false;
      arm();
      emit();
    },
    dispose() {
      stopStage();
      listen(false);
      clear();
    },
  };
};

export const createShellBridge = (o: { onMinimize(): void; onLeave(): void; idleAway?(ms: number | null): void }): ShellBridge & { dispose(): void } => {
  const attention = createAttention();
  const wake = createWakeLock();
  let disposed = false;
  return {
    status(s: SessionStatus) {
      if (!disposed) patchSession({ status: s });
    },
    attention(on) {
      if (disposed) return;
      attention.set(on);
      patchSession({ attention: on });
    },
    wakeLock(on) {
      if (!disposed) wake.set(on);
    },
    minimize() {
      if (disposed) return;
      patchSession({ minimized: true });
      o.onMinimize();
    },
    leave() {
      if (!disposed) o.onLeave();
    },
    idleAway(ms) {
      if (!disposed) o.idleAway?.(ms);
    },
    names(accountIds) {
      const byAccount = new Map<string, string>();
      for (const user of users.peek()) byAccount.set(user.accountId, user.displayName);
      return accountIds.map((id) => byAccount.get(id) ?? 'Player');
    },
    practice: practiceWallet,
    dispose() {
      disposed = true;
      attention.dispose();
      wake.dispose();
    },
  };
};

const mountOpts = (o: { mode: 'local' | 'remote'; lobby: LobbyView | null; slot: number | null; shell: ShellBridge }): MountOpts => ({
  mode: o.mode,
  lobby: o.lobby,
  me: { accountId: account.peek()?.id ?? null, slot: o.slot },
  prefs: loadPrefs(),
  ptt: parseShortcut(audioSettings.peek().pttKey),
  reserved: [parseShortcut(audioSettings.peek().clipShortcut)].filter((key): key is NonNullable<typeof key> => key !== null),
  reducedMotion: media('(prefers-reduced-motion: reduce)'),
  coarse: media('(pointer: coarse)'),
  shell: o.shell,
});

/** A single-use action-lane ticket for this lobby's match (`arcade:ticket`). */
type TicketAck = { ok?: boolean; ticket?: unknown; code?: string } | null;

const ticketFor = async (lobbyId: string): Promise<string> => {
  const answer = await socketClient.request<TicketAck>('arcade:ticket', { id: lobbyId }).catch(() => {
    throw new Error('Not connected to the server right now.');
  });
  if (answer?.ok && typeof answer.ticket === 'string') return answer.ticket;
  throw new Error(answer?.code === 'gone' ? 'That game has ended.' : 'The server did not let this device into the game.');
};

/**
 * Join a lobby's running game online: an action game over the action lane (a ticket from the join
 * ack or `arcade:ticket`), a table game over the app socket. Same shape as `startLocalSession`;
 * `arcadeSession` is the lobby's, in mode 'remote'. While the "chat first" guard holds an action
 * game back, the status reads 'paused' and `yielding` is set (the stage shows why).
 */
export const startRemoteSession = async (o: {
  meta: GameMeta;
  lobby: LobbyView;
  role: 'player' | 'spectator';
  ticket?: string;
  el: HTMLElement;
  onLeave(): void;
  onMinimize(): void;
}): Promise<SessionHandle> => {
  const { meta, lobby } = o;
  arcadeSession.value = { game: meta.id, id: lobby.id, role: o.role, mode: 'remote', status: 'connecting', attention: false, minimized: false, yielding: false };
  const fail = (error: unknown): never => {
    if (arcadeSession.peek()?.id === lobby.id) arcadeSession.value = null;
    throw error;
  };

  let chunk: GameChunk;
  let host: AnyHost;
  let offYield: () => void = () => undefined;
  let gameStatus: SessionStatus = 'connecting';
  let yielding = false;
  let disposed = false;
  const showStatus = (): void => {
    if (!disposed) patchSession(yielding ? { status: 'paused', yielding: true } : { status: gameStatus, yielding: false });
  };
  try {
    chunk = await o.meta.load();
    if (meta.lane === 'action') {
      const remote = createRemoteMatchHost({ lobbyId: lobby.id, ticket: o.ticket ?? (await ticketFor(lobby.id)), game: meta.id as ActionGameId });
      offYield = remote.onYield((on) => {
        yielding = on;
        showStatus();
      });
      host = remote;
    } else {
      host = createRemoteTableHost(meta.id as TableGameId);
    }
  } catch (error) {
    return fail(error);
  }

  let handle: GameHandle | null = null;
  const gate = createStageGate(o.el, (visible) => {
    host.setVisible(visible);
    if (!handle) return;
    if (visible) handle.resume();
    else handle.pause();
  });
  const bridge = createShellBridge({ onLeave: o.onLeave, onMinimize: o.onMinimize, idleAway: (ms) => gate.idleAway(ms) });
  // The game's own status, shown unless the chat-first guard is holding the game back.
  const shell: ShellBridge = {
    ...bridge,
    status(s) {
      gameStatus = s;
      showStatus();
    },
  };
  const me = account.peek()?.id ?? null;
  const seat = o.role === 'player' && me ? lobby.seats.findIndex((s) => s.a === me) : -1;
  const release = (): void => {
    disposed = true;
    offYield();
    host.close();
    bridge.dispose();
  };

  let mounted: GameHandle;
  try {
    mounted = chunk.module.mount(o.el, host, mountOpts({ mode: 'remote', lobby, slot: seat >= 0 ? seat : null, shell }));
  } catch (error) {
    gate.dispose();
    release();
    return fail(error);
  }
  handle = mounted;
  if (!gate.visible) mounted.pause();

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      gate.dispose();
      try {
        mounted.unmount();
      } finally {
        release();
        if (arcadeSession.peek()?.id === lobby.id) arcadeSession.value = null;
      }
    },
    back() {
      if (stopped) return false;
      if (mounted.back?.()) return true;
      bridge.minimize();
      return true;
    },
  };
};

/** Mount a game offline against bots (practice chips; results stay on this device). */
export const startLocalSession = async (o: {
  meta: GameMeta;
  mode: string;
  cfg: Record<string, unknown>;
  el: HTMLElement;
  onLeave(): void;
  onMinimize(): void;
}): Promise<SessionHandle> => {
  const chunk = await o.meta.load();
  const me = account.peek();
  const seats = localSeats(o.meta, o.cfg, { accountId: me?.id ?? null, name: me?.displayName ?? 'You' });
  const seed = new Uint32Array(4);
  crypto.getRandomValues(seed);
  const local = chunk.local({ mode: o.mode, cfg: o.cfg, seed, seats });
  const host: AnyHost = o.meta.lane === 'action' ? createLocalMatchHost(local as CoreMatch, { selfSlot: 0, seats }) : createLocalTableHost(local as LocalTableServer);

  arcadeSession.value = { game: o.meta.id, id: 'local', role: 'player', mode: 'local', status: 'connecting', attention: false, minimized: false };
  let handle: GameHandle | null = null;
  const gate = createStageGate(o.el, (visible) => {
    host.setVisible(visible);
    if (!handle) return;
    if (visible) handle.resume();
    else handle.pause();
  });
  const bridge = createShellBridge({ onLeave: o.onLeave, onMinimize: o.onMinimize, idleAway: (ms) => gate.idleAway(ms) });
  const opts = mountOpts({ mode: 'local', lobby: null, slot: 0, shell: bridge });

  let mounted: GameHandle;
  try {
    mounted = chunk.module.mount(o.el, host, opts);
  } catch (error) {
    gate.dispose();
    host.close();
    bridge.dispose();
    arcadeSession.value = null;
    throw error;
  }
  handle = mounted;
  if (!gate.visible) mounted.pause();

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      gate.dispose();
      try {
        mounted.unmount();
      } finally {
        host.close();
        bridge.dispose();
        arcadeSession.value = null;
      }
    },
    back() {
      if (stopped) return false;
      if (mounted.back?.()) return true;
      bridge.minimize();
      return true;
    },
  };
};
