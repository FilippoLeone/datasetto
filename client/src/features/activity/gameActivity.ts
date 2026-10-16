/**
 * "Playing <game>" on the client side: the user's own game entries, what may be sent to
 * the server and the pacing of those reports. Pure, so it is unit tested;
 * desktopActivity.ts wires it to the Electron bridge and the socket. The desktop shell
 * (desktop/games/match.js) applies the same rules again to whatever it receives.
 */

export const MAX_TITLE_LENGTH = 64;
export const MAX_EXECUTABLE_LENGTH = 128;
export const MAX_CUSTOM_GAMES = 50;
/** The server accepts one report per socket per 10 s; the margin covers timer and network jitter. */
export const REPORT_INTERVAL_MS = 11_000;

export interface CustomGame {
  /** Lower-cased executable name, as the process list shows it (`notepad.exe`). */
  exe: string;
  /** Shown as "Playing <title>". */
  title: string;
}

export interface GameActivitySettings {
  /** Off by default: nothing is scanned and nothing is sent. */
  enabled: boolean;
  custom: CustomGame[];
}

export const DEFAULT_GAME_ACTIVITY_SETTINGS: GameActivitySettings = { enabled: false, custom: [] };

/** Lower-cased file name of a program (no directory, no quotes); null for garbage. */
export const normalizeExecutable = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  let name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  name = name.replace(/^"+|"+$/g, '').trim();
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (slash >= 0) name = name.slice(slash + 1);
  name = name.trim().toLowerCase();
  if (!name || name.length > MAX_EXECUTABLE_LENGTH) return null;
  return name;
};

/** A display title: one line, trimmed, at most MAX_TITLE_LENGTH characters; null when empty. */
export const normalizeTitle = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const title = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) return null;
  return title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH).trimEnd() : title;
};

/** Clean a list of entries: valid, unique by executable (first wins), capped. */
export const normalizeCustomGames = (value: unknown): CustomGame[] => {
  const result: CustomGame[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(value) ? value : []) {
    const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
    const exe = normalizeExecutable(record?.exe);
    const title = normalizeTitle(record?.title);
    if (!exe || !title || seen.has(exe)) continue;
    seen.add(exe);
    result.push({ exe, title });
    if (result.length >= MAX_CUSTOM_GAMES) break;
  }
  return result;
};

/** Stored settings over the defaults; anything unknown or malformed falls back. */
export const normalizeGameActivitySettings = (stored: unknown): GameActivitySettings => {
  const record = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  return {
    enabled: record.enabled === true,
    custom: normalizeCustomGames(record.custom),
  };
};

export type AddGameResult = { ok: true; custom: CustomGame[]; replaced: boolean } | { ok: false; error: string };

/** Add (or retitle) an entry; the list keeps its order, a retitled entry stays where it was. */
export const addCustomGame = (custom: CustomGame[], exeInput: unknown, titleInput: unknown): AddGameResult => {
  const exe = normalizeExecutable(exeInput);
  if (!exe) return { ok: false, error: 'Pick the program the game runs as.' };
  const title = normalizeTitle(titleInput);
  if (!title) return { ok: false, error: 'Give the game a name to show.' };
  const existing = custom.findIndex((entry) => entry.exe === exe);
  if (existing >= 0) {
    const next = custom.slice();
    next[existing] = { exe, title };
    return { ok: true, custom: next, replaced: true };
  }
  if (custom.length >= MAX_CUSTOM_GAMES) return { ok: false, error: 'You can keep up to ' + MAX_CUSTOM_GAMES + ' games of your own; remove one first.' };
  return { ok: true, custom: [...custom, { exe, title }], replaced: false };
};

export const removeCustomGame = (custom: CustomGame[], exe: string): CustomGame[] => custom.filter((entry) => entry.exe !== exe);

/** What may go to the server: a clean title of at most MAX_TITLE_LENGTH characters, or null. */
export const activityTitle = (value: unknown): string | null => normalizeTitle(value);

export interface ActivityReporterOptions {
  /** Deliver one report (gate it on the socket being signed in). */
  send: (title: string | null) => void;
  intervalMs?: number;
  now?: () => number;
}

export interface ActivityReporter {
  /** The title to show from now on; sent when it differs from the last report, at most one per interval. */
  update(title: string | null): void;
  /** A new socket (sign-in, reconnect) starts at null on the server: repeat the current title now. */
  resync(): void;
  /** Forget everything (sign-out); the next resync starts afresh. */
  stop(): void;
  /** A report is waiting for the interval to pass. */
  readonly pending: boolean;
}

/**
 * Sends only changes and never faster than the server accepts: a change inside the
 * interval waits for it to pass, and a change that goes back to what was sent cancels
 * the wait. The latest value always wins.
 */
export const createActivityReporter = ({ send, intervalMs = REPORT_INTERVAL_MS, now = Date.now }: ActivityReporterOptions): ActivityReporter => {
  let wanted: string | null = null;
  let sent: string | null = null;
  let sentAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const deliver = () => {
    clear();
    sent = wanted;
    sentAt = now();
    send(wanted);
  };

  const schedule = () => {
    if (wanted === sent) {
      clear();
      return;
    }
    const wait = sentAt + intervalMs - now();
    if (wait <= 0) {
      deliver();
      return;
    }
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        schedule();
      }, wait);
    }
  };

  return {
    update(title) {
      wanted = title;
      schedule();
    },
    resync() {
      clear();
      sent = null;
      sentAt = Number.NEGATIVE_INFINITY;
      if (wanted !== null) deliver();
    },
    stop() {
      clear();
      wanted = null;
      sent = null;
      sentAt = Number.NEGATIVE_INFINITY;
    },
    get pending() {
      return timer !== null;
    },
  };
};
