import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activityTitle,
  addCustomGame,
  createActivityReporter,
  DEFAULT_GAME_ACTIVITY_SETTINGS,
  MAX_CUSTOM_GAMES,
  MAX_TITLE_LENGTH,
  normalizeCustomGames,
  normalizeExecutable,
  normalizeGameActivitySettings,
  normalizeTitle,
  removeCustomGame,
  REPORT_INTERVAL_MS,
  type CustomGame,
} from './gameActivity';

describe('executable and title normalisation', () => {
  it('keeps the lower-cased file name only', () => {
    expect(normalizeExecutable('Notepad.exe')).toBe('notepad.exe');
    expect(normalizeExecutable('  "C:\\Games\\Elden Ring\\eldenring.exe"  ')).toBe('eldenring.exe');
    expect(normalizeExecutable('/Applications/Steam.app/Contents/MacOS/steam_osx')).toBe('steam_osx');
    expect(normalizeExecutable('League of Legends.exe')).toBe('league of legends.exe');
    expect(normalizeExecutable('bad\u0000name.exe')).toBe('badname.exe');
  });

  it('rejects garbage', () => {
    expect(normalizeExecutable('')).toBeNull();
    expect(normalizeExecutable('   ')).toBeNull();
    expect(normalizeExecutable('C:\\only\\a\\folder\\')).toBeNull();
    expect(normalizeExecutable(42)).toBeNull();
    expect(normalizeExecutable(null)).toBeNull();
    expect(normalizeExecutable('x'.repeat(129))).toBeNull();
    expect(normalizeExecutable('x'.repeat(128))).toHaveLength(128);
  });

  it('cleans titles to one trimmed line of at most 64 characters', () => {
    expect(normalizeTitle('  Elden   Ring\n\tNightreign ')).toBe('Elden Ring Nightreign');
    expect(normalizeTitle('x'.repeat(MAX_TITLE_LENGTH + 10))).toHaveLength(MAX_TITLE_LENGTH);
    expect(normalizeTitle('a'.repeat(63) + ' b')).toBe('a'.repeat(63));
    expect(normalizeTitle('')).toBeNull();
    expect(normalizeTitle('\u0000\u001f')).toBeNull();
    expect(normalizeTitle(undefined)).toBeNull();
    expect(activityTitle('  Hades  ')).toBe('Hades');
    expect(activityTitle(null)).toBeNull();
  });
});

describe('settings and custom entries', () => {
  it('falls back to the defaults for anything malformed and is off by default', () => {
    expect(DEFAULT_GAME_ACTIVITY_SETTINGS).toEqual({ enabled: false, custom: [] });
    expect(normalizeGameActivitySettings(null)).toEqual({ enabled: false, custom: [] });
    expect(normalizeGameActivitySettings('nope')).toEqual({ enabled: false, custom: [] });
    expect(normalizeGameActivitySettings({ enabled: 'yes', custom: 'all' })).toEqual({ enabled: false, custom: [] });
    expect(normalizeGameActivitySettings({ enabled: true })).toEqual({ enabled: true, custom: [] });
  });

  it('cleans, de-duplicates (first wins) and caps the custom list', () => {
    const cleaned = normalizeCustomGames([
      { exe: 'Notepad.EXE', title: ' Notepad ' },
      { exe: 'notepad.exe', title: 'Duplicate' },
      { exe: '', title: 'No program' },
      { exe: 'javaw.exe', title: '   ' },
      null,
      'string',
      { exe: 'C:\\Games\\game.exe', title: 'x'.repeat(100) },
    ]);
    expect(cleaned).toEqual([
      { exe: 'notepad.exe', title: 'Notepad' },
      { exe: 'game.exe', title: 'x'.repeat(MAX_TITLE_LENGTH) },
    ]);
    const many = Array.from({ length: MAX_CUSTOM_GAMES + 5 }, (_, index) => ({ exe: 'game' + index + '.exe', title: 'Game ' + index }));
    expect(normalizeCustomGames(many)).toHaveLength(MAX_CUSTOM_GAMES);
  });

  it('adds, retitles in place, refuses bad input and a full list, and removes', () => {
    const empty: CustomGame[] = [];
    expect(addCustomGame(empty, '', 'Notepad')).toEqual({ ok: false, error: expect.stringMatching(/program/i) });
    expect(addCustomGame(empty, 'notepad.exe', '  ')).toEqual({ ok: false, error: expect.stringMatching(/name/i) });

    const added = addCustomGame(empty, 'Notepad.exe', ' Notepad ');
    expect(added).toEqual({ ok: true, custom: [{ exe: 'notepad.exe', title: 'Notepad' }], replaced: false });
    if (!added.ok) throw new Error('unreachable');
    const two = addCustomGame(added.custom, 'javaw.exe', 'Minecraft');
    if (!two.ok) throw new Error('unreachable');
    expect(two.custom.map((entry) => entry.exe)).toEqual(['notepad.exe', 'javaw.exe']);

    const retitled = addCustomGame(two.custom, 'NOTEPAD.EXE', 'Notes');
    expect(retitled).toEqual({ ok: true, custom: [{ exe: 'notepad.exe', title: 'Notes' }, { exe: 'javaw.exe', title: 'Minecraft' }], replaced: true });
    // The original list is untouched.
    expect(two.custom[0].title).toBe('Notepad');

    const full = Array.from({ length: MAX_CUSTOM_GAMES }, (_, index) => ({ exe: 'game' + index + '.exe', title: 'Game ' + index }));
    expect(addCustomGame(full, 'one-more.exe', 'One more')).toEqual({ ok: false, error: expect.stringMatching(/remove one/i) });
    // Retitling an existing entry still works on a full list.
    expect(addCustomGame(full, 'game0.exe', 'Renamed').ok).toBe(true);

    expect(removeCustomGame(two.custom, 'notepad.exe')).toEqual([{ exe: 'javaw.exe', title: 'Minecraft' }]);
    expect(removeCustomGame(two.custom, 'missing.exe')).toEqual(two.custom);
  });
});

describe('activity reporter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends changes at once, paces the next one to the interval and drops reverted changes', () => {
    const send = vi.fn();
    const reporter = createActivityReporter({ send, intervalMs: 1000 });

    reporter.update(null);
    expect(send).not.toHaveBeenCalled();

    reporter.update('Hades');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith('Hades');

    // Within the window: queued, the latest value wins.
    vi.advanceTimersByTime(300);
    reporter.update('Celeste');
    reporter.update(null);
    expect(reporter.pending).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(699);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(null);
    expect(reporter.pending).toBe(false);

    // Back to what was sent before the window passes: nothing goes out.
    reporter.update('Hades');
    expect(reporter.pending).toBe(true);
    reporter.update(null);
    expect(reporter.pending).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(send).toHaveBeenCalledTimes(2);

    // Well after the window: immediate again.
    reporter.update('Elden Ring');
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith('Elden Ring');
  });

  it('repeats the current title on resync (a new socket starts at null) and forgets on stop', () => {
    const send = vi.fn();
    const reporter = createActivityReporter({ send });

    reporter.resync();
    expect(send).not.toHaveBeenCalled();

    reporter.update('Hades');
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(REPORT_INTERVAL_MS * 2);
    reporter.resync();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('Hades');

    // A change right after the resync waits for the interval, measured from the resync.
    reporter.update('Celeste');
    expect(send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(REPORT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith('Celeste');

    // A pending report is replaced by the resync's immediate one.
    reporter.update('Hades');
    expect(reporter.pending).toBe(true);
    reporter.resync();
    expect(reporter.pending).toBe(false);
    expect(send).toHaveBeenCalledTimes(4);
    expect(send).toHaveBeenLastCalledWith('Hades');

    reporter.stop();
    vi.advanceTimersByTime(REPORT_INTERVAL_MS * 2);
    reporter.resync();
    expect(send).toHaveBeenCalledTimes(4);
    reporter.update(null);
    expect(send).toHaveBeenCalledTimes(4);
  });
});
