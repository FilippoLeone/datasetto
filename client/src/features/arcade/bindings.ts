/**
 * The Arcade's table-lane pushes → the coarse signals in state.ts (platform.md §5.4, §9.2, §10.1).
 * The server coalesces every one of them (lobby ≤ 2 Hz, activity ≤ 1 per 2 s per channel, wallet
 * ≤ 1 per 2 s), so each push writes its signal at most once, and not at all when nothing changed.
 * Nothing here plays a sound, opens a toast or changes the view: someone else starting a game only
 * updates the passive chips and badges. In the main bundle; the shell chunk is loaded only when
 * the lobby you are in starts, ends, or must be left.
 */
import { effect, type Signal } from '@preact/signals';
import type { GameId, LobbyView } from '@/arcade/runtime/types';
import { socketClient } from '@/services/socket/client';
import { account, isAuthenticated } from '@/state/session';
import { voiceChannelId } from '@/state/voice';
import { loadShell } from './ArcadeHost';
import { arcadeActivity, arcadeConfig, arcadeHidden, arcadeInvites, arcadeLobby, arcadeStage, arcadeWallet, type ActivityEntry, type ArcadeHidden } from './state';

/** An InviteChip lasts this long (platform.md §9.2). */
export const INVITE_MS = 60_000;

type Role = 'player' | 'spectator';
type Raw = Record<string, unknown> | null | undefined;

const json = (v: unknown): string => JSON.stringify(v instanceof Map ? [...v] : v);

/** Write only when the value really changed (the server may repeat itself after a reconnect). */
const put = <T,>(sig: Signal<T>, next: T): void => {
  if (json(sig.peek()) !== json(next)) sig.value = next;
};

const withShell = (fn: (shell: Awaited<ReturnType<typeof loadShell>>) => void): void => {
  void loadShell().then(fn, () => undefined);
};

/** How you are in each lobby you created or joined (LobbyView does not list watchers). */
const roles = new Map<string, Role>();
/** Lobbies you left: their late, already coalesced updates are dropped. */
const left = new Set<string>();

export const lobbyRole = (lobby: LobbyView): Role => roles.get(lobby.id) ?? (lobby.seats.some((s) => s.a === account.peek()?.id) ? 'player' : 'spectator');

/** You are in this lobby now (a create or join ack). */
export const enterLobby = (view: LobbyView, role: Role): void => {
  roles.set(view.id, role);
  left.delete(view.id);
  dismissInvite(view.id);
  arcadeLobby.value = view;
};

/** You left a lobby, or it ended or dropped you: forget it. */
export const forgetLobby = (id: string): void => {
  roles.delete(id);
  left.add(id);
  if (arcadeLobby.peek()?.id === id) arcadeLobby.value = null;
};

const hiddenFor = (game: string): boolean => {
  const hidden = arcadeHidden.peek();
  return Boolean(hidden && (hidden.hidden || hidden.games[game as GameId] === false));
};

// Invites: at most three, each gone after 60 s ----------------------------------------------------

const timers = new Map<string, number>();
const unTime = (id: string): void => {
  window.clearTimeout(timers.get(id));
  timers.delete(id);
};

export const dismissInvite = (id: string): void => {
  unTime(id);
  const list = arcadeInvites.peek();
  if (list.some((invite) => invite.id === id)) arcadeInvites.value = list.filter((invite) => invite.id !== id);
};

const clearInvites = (): void => {
  timers.forEach((_, id) => unTime(id));
  put(arcadeInvites, []);
};

const onInvited = (p: Raw): void => {
  const id = p?.id;
  if (typeof id !== 'string' || typeof p?.from !== 'string' || typeof p.game !== 'string' || hiddenFor(p.game) || arcadeLobby.peek()?.id === id) return;
  unTime(id);
  timers.set(id, window.setTimeout(() => dismissInvite(id), INVITE_MS));
  const rest = arcadeInvites.peek().filter((invite) => invite.id !== id);
  const next = [...rest, { id, from: p.from, game: p.game as GameId, ...(typeof p.ch === 'string' ? { ch: p.ch } : {}), at: Date.now() }].slice(-3);
  for (const old of rest) if (!next.includes(old)) unTime(old.id);
  arcadeInvites.value = next;
};

// Lobby, activity, wallet, prefs, config ------------------------------------------------------------

const onLobby = (view: LobbyView | null): void => {
  if (typeof view?.id !== 'string' || !Array.isArray(view.seats) || left.has(view.id)) return;
  const current = arcadeLobby.peek();
  const stage = arcadeStage.peek();
  if (current && current.id !== view.id) return;
  if (view.st === 'ended') {
    forgetLobby(view.id);
    if (stage?.lobbyId === view.id) withShell((shell) => shell.lobbyEnded(view.id));
    return;
  }
  if (current && view.v <= current.v) return;
  const me = account.peek()?.id;
  const seated = view.seats.some((s) => s.a === me);
  // Only lobbies you are in (the server sends no others; after a reload, the ones you sit in).
  if (!current && !roles.has(view.id) && view.host !== me && !seated) return;
  // Dropped from a forming lobby (left the call, or the seat was released after a disconnect).
  if (view.st === 'open' && roles.get(view.id) === 'player' && view.host !== me && !seated) return forgetLobby(view.id);
  arcadeLobby.value = view;
  // The lobby you are in started: its game opens on your screen.
  if (view.st === 'live' && current?.st !== 'live' && stage?.lobbyId !== view.id) withShell((shell) => shell.lobbyLive(view));
};

const setActivity = (next: Map<string, readonly ActivityEntry[]>): void => {
  if (!arcadeHidden.peek()?.hidden) put(arcadeActivity, next);
};

const onActivity = (p: Raw): void => {
  if (typeof p?.ch !== 'string' || !Array.isArray(p.a)) return;
  const next = new Map(arcadeActivity.peek());
  if (p.a.length > 0) next.set(p.ch, p.a as ActivityEntry[]);
  else next.delete(p.ch);
  setActivity(next);
};

const onActivityAll = (p: Raw): void => {
  if (!Array.isArray(p?.chs)) return;
  setActivity(new Map((p.chs as { ch: string; a: ActivityEntry[] }[]).filter((e) => Array.isArray(e?.a) && e.a.length > 0).map((e) => [e.ch, e.a])));
};

const onWallet = (p: Raw): void => {
  if (typeof p?.bal === 'number') put(arcadeWallet, { bal: p.bal, esc: Number(p.esc) || 0, claim: p.claim === true });
};

/** "Hide Arcade" and the per-game switches (the `arcade:prefs` push, and the profile's own saves). */
export const applyPrefs = (raw: unknown): void => {
  const p = raw as Raw;
  if (typeof p?.hidden !== 'boolean') return;
  const games: ArcadeHidden['games'] = {};
  for (const [game, on] of Object.entries(p.games ?? {})) if (on === false) games[game as GameId] = false;
  put(arcadeHidden, { hidden: p.hidden, games, reenableAt: typeof p.reenableAt === 'number' ? p.reenableAt : null });
  if (p.hidden) {
    put(arcadeActivity, new Map());
    clearInvites();
  }
  // Hiding a game you are in ends your part in it.
  const game = arcadeStage.peek()?.game ?? arcadeLobby.peek()?.game;
  if (game && hiddenFor(game)) withShell((shell) => shell.leaveCurrent());
};

/** `arcade` from GET /api/config and auth:success, and the `arcade:config` push. Null (offline): everything on. */
export const setArcadeConfig = (raw: unknown): void => {
  const p = raw as Raw;
  put(arcadeConfig, typeof p?.enabled === 'boolean' && p.games && typeof p.games === 'object' ? (p as never) : null);
};

let installed = false;

/** Wire the Arcade's server pushes into state.ts. Called once by installSocketBindings. */
export const installArcadeBindings = (): void => {
  if (installed) return;
  installed = true;
  const on = <T,>(event: string, fn: (payload: T) => void) => socketClient.on<T>(event, fn);
  on('arcade:lobby', onLobby);
  on('arcade:activity', onActivity);
  on('arcade:activity:all', onActivityAll);
  on('arcade:wallet', onWallet);
  on('arcade:invited', onInvited);
  on('arcade:prefs', applyPrefs);
  on('arcade:config', setArcadeConfig);
  // Every (re)connect: the server sends the full activity next (only when there is any).
  on('auth:success', () => put(arcadeActivity, new Map()));
  // Signed out: nothing of the account's Arcade stays.
  effect(() => {
    if (isAuthenticated.value) return;
    if (arcadeStage.peek()) withShell((shell) => shell.stopStage());
    const lobby = arcadeLobby.peek();
    if (lobby) forgetLobby(lobby.id);
    clearInvites();
    put(arcadeActivity, new Map());
    put(arcadeWallet, null);
    put(arcadeHidden, null);
  });
  // Leaving the call leaves the stage, and a forming lobby's seat (the server drops that too).
  effect(() => {
    const ch = voiceChannelId.value;
    const lobby = arcadeLobby.peek();
    const stage = arcadeStage.peek();
    if (stage && stage.ch !== ch) withShell((shell) => shell.leaveCurrent());
    else if (lobby?.st === 'open' && lobby.ch !== ch && roles.get(lobby.id) !== 'spectator') forgetLobby(lobby.id);
  });
};
