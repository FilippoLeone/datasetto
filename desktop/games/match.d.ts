/** Types for match.js (CommonJS); the client's unit tests load the module through createRequire. */

export interface GameCatalogue {
  version?: number;
  /** Lower-cased executable name to display title. */
  games: Record<string, string>;
  /** Lower-cased executable names of launchers and stores: never reported as a game. */
  launchers: string[];
}

export interface CustomGame {
  exe: string;
  title: string;
}

export interface GameMatch {
  title: string;
  exe: string;
  source: 'custom' | 'catalogue';
}

export const LINUX_COMM_LENGTH: number;
export const MAX_CUSTOM_GAMES: number;
export const MAX_EXECUTABLE_LENGTH: number;
export const MAX_TITLE_LENGTH: number;
export const SYSTEM_PROCESSES: Set<string>;

export function normalizeExecutable(value: unknown): string | null;
export function normalizeTitle(value: unknown): string | null;
export function uniqueNames(names: unknown): string[];
export function parseTasklist(output: unknown): string[];
export function parseProcessNames(output: unknown): string[];
export function parsePs(output: unknown): string[];
export function normalizeCatalogue(raw: unknown): { games: Record<string, string>; launchers: Set<string> };
export function sanitizeCustomGames(entries: unknown): CustomGame[];
export function matchGame(processNames: unknown, catalogue: unknown, customGames?: unknown): GameMatch | null;
export function pickerProcesses(processNames: unknown, catalogue: unknown, ownExecutables?: unknown): string[];
