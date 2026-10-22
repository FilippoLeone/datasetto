/**
 * Typed wrappers for the Arcade's table-lane requests (platform.md §5.4, §9.2, §11). Every ack is
 * `{ok: true, …}` or `{ok: false, code}` (lower-case codes, platform.md §20 #17); a request that
 * cannot be sent (offline, timed out) resolves as `{ok: false, code: 'offline'}`, so callers never
 * need a try/catch. Loaded with the shell, the profile's Arcade section and Admin › Arcade only.
 */
import type { GameId, LobbyView } from '@/arcade/runtime/types';
import { socketClient } from '@/services/socket/client';
import type { ArcadeHidden, ArcadeWalletView } from './state';

export type Refused = { ok: false; code: string };
export type Ack<T extends object = object> = ({ ok: true } & T) | Refused;

const request = async <T extends object>(event: string, payload: unknown = {}, timeoutMs?: number): Promise<Ack<T>> => {
  try {
    const answer = await socketClient.request<Ack<T> | null | undefined>(event, payload, timeoutMs);
    if (answer && typeof answer === 'object' && typeof answer.ok === 'boolean') return answer;
    return { ok: false, code: 'invalid' };
  } catch {
    return { ok: false, code: 'offline' };
  }
};

// Lobbies ---------------------------------------------------------------------------------------

export type JoinAs = 'player' | 'spectator';

export const createLobby = (o: { ch: string; game: GameId; mode: string; cfg: Record<string, unknown> }) =>
  request<{ lobby: LobbyView; ticket?: string }>('arcade:lobby:create', o);
export const joinLobby = (id: string, as: JoinAs) => request<{ lobby: LobbyView; ticket?: string }>('arcade:lobby:join', { id, as });
export const leaveLobby = (id: string) => request('arcade:lobby:leave', { id });
export const startLobby = (id: string) => request('arcade:lobby:start', { id });
export const setLobbyBots = (id: string, count: number, level: number) => request('arcade:lobby:bots', { id, count, level });
export const setLobbyConfig = (id: string, cfg: Record<string, unknown>) => request('arcade:lobby:config', { id, cfg });
export const fetchTicket = (id: string) => request<{ ticket: string; exp: number }>('arcade:ticket', { id });
export const inviteToLobby = (id: string, to: string) => request('arcade:invite', { id, to });

// Wallet, boards, saves, prefs --------------------------------------------------------------------

export const fetchWallet = () => request<ArcadeWalletView>('arcade:wallet');
export const claimDaily = () => request<{ bal: number; got: number }>('arcade:wallet:claim');

export interface BoardRow {
  /** Account id. */
  a: string;
  v: number;
  l?: string;
}
export const listBoards = (game: GameId) => request<{ boards: { id: string; label: string }[] }>('arcade:boards', { game });
export const fetchBoard = (game: GameId, board: string) => request<{ rows: BoardRow[] }>('arcade:board', { game, board });

export interface SaveSlotInfo {
  slot: number;
  updatedAt: number;
  members: number;
  inUse: boolean;
  [summary: string]: unknown;
}
export const listSaves = (game: GameId) => request<{ slots: SaveSlotInfo[] }>('arcade:saves', { game });
export const deleteSave = (game: GameId, slot: number) => request('arcade:saves:delete', { game, slot });

export const fetchPrefs = () => request<ArcadeHidden>('arcade:prefs');
export const savePrefs = (next: { hidden?: boolean; games?: Partial<Record<GameId, boolean>> }) => request<ArcadeHidden>('arcade:prefs:set', next);

// Admin › Arcade ----------------------------------------------------------------------------------

export interface ArcadeLimits {
  actionPerChannel: number;
  tablesPerChannel: number;
  hallsPerChannel: number;
  actionMatches: number;
  bellwickSessions: number;
  tables: number;
  pokerBots: number;
  spectatorsAction: number;
  spectatorsTable: number;
  lobbyIdleMs: number;
  egressKbps: number;
  lanePerIp: number;
  hallMembers: number;
  dashes: number;
}

/** `ArcadeSettings` (server/src/arcade/settings.ts). */
export interface ArcadeSettings {
  enabled: boolean;
  games: Record<GameId, boolean>;
  startChips: number;
  claimFloor: number;
  claimMin: number;
  serverBots: boolean;
  limits: ArcadeLimits;
  gameSettings: Partial<Record<'lamplight' | 'glimmer', unknown>>;
}

/** One of a table game's own admin settings (`SettingsField`). */
export type SettingsField = { key: string; label: string; help?: string } & (
  | { kind: 'number'; min: number; max: number; step?: number }
  | { kind: 'toggle' }
  | { kind: 'json' }
);

export interface ArcadeAdminView {
  settings: ArcadeSettings;
  fields: Partial<Record<'lamplight' | 'glimmer', SettingsField[]>>;
  available: Partial<Record<GameId, boolean>>;
  stats: { matches: number; lanes: number; level: number; loopP99Ms?: number; egressKbps?: number };
}

export interface LedgerRow {
  id: number;
  kind: string;
  ref: string | null;
  at: number;
  delta: number;
  after: number;
}

export const adminArcadeGet = () => request<ArcadeAdminView>('admin:arcade:get');
export const adminArcadeUpdate = (settings: Partial<Omit<ArcadeSettings, 'limits'>> & { limits?: Partial<ArcadeLimits> }) =>
  request<{ settings: ArcadeSettings }>('admin:arcade:update', { settings });
export const adminWalletReset = (accountId: string) => request<{ bal: number }>('admin:arcade:wallet:reset', { accountId });
export const adminLedger = (accountId: string) => request<{ rows: LedgerRow[] }>('admin:arcade:ledger', { accountId });
export const adminVoid = (id: string) => request('admin:arcade:void', { id });

// Refusal codes -----------------------------------------------------------------------------------

const REFUSALS: Record<string, string> = {
  offline: 'Not connected to the server right now.',
  busy: 'The server is busy. Try again in a moment.',
  disabled: 'This game is switched off on this server.',
  hidden: 'You hid this game in your profile.',
  'not-in-voice': 'Join the voice channel first.',
  'channel-limit': 'This channel already has as many games of this kind as it may.',
  'server-limit': 'The server is running as many games as it can.',
  already: 'You are already in a game of this kind.',
  invalid: 'Those options are not valid.',
  'in-use': 'That save is in use.',
  'no-lobby': 'This game cannot be started here.',
  gone: 'That game has ended.',
  full: 'That game is full.',
  forbidden: 'You cannot do that here.',
  'no-spectators': 'This game cannot be watched.',
  'not-host': 'Only the host can do that.',
  running: 'The game has already started.',
  empty: 'Nobody is seated yet.',
  players: 'At least two players are needed to start.',
  bots: "Bots can't join this table (only Pebble and Cobble cash tables and Cups, when the server allows bots).",
  auth: 'Sign in first.',
  'not-found': 'No such account.',
};

export const refusalText = (code: string): string => REFUSALS[code] ?? 'That did not work (' + code + ').';
