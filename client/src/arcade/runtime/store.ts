/**
 * Device storage for the Arcade. Every access is wrapped in try/catch with an in-memory fallback:
 * private windows, blocked site data and full quotas must never break a game. Keys are
 * `datasetto.arcade.<owner>.v<n>` (plan.md §2.5): the platform owns `prefs.v1` and `practice.v1`,
 * each game its own.
 */

const memory = new Map<string, string>();

/** Read and validate a stored value; `parse` returns null for anything it does not accept. */
export const readLocal = <T>(key: string, parse: (v: unknown) => T | null): T | null => {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    raw = null;
  }
  if (raw === null) raw = memory.get(key) ?? null;
  if (raw === null) return null;
  try {
    return parse(JSON.parse(raw));
  } catch {
    return null;
  }
};

/** Store a value; true when it reached localStorage, false when it is kept in memory only. */
export const writeLocal = (key: string, value: unknown): boolean => {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return false;
  }
  memory.set(key, text);
  try {
    localStorage.setItem(key, text);
    return true;
  } catch {
    return false;
  }
};

export const removeLocal = (key: string): void => {
  memory.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
};

/** Is localStorage usable here? (Bellwick shows "Saves aren't available in this window" when not.) */
export const storageAvailable = (): boolean => {
  try {
    const probe = 'datasetto.arcade.probe';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
};
