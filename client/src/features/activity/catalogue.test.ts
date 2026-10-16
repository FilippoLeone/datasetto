// @vitest-environment node
/// <reference types="node" />
/**
 * The desktop shell's catalogue and matcher (desktop/games), loaded as they ship: plain
 * CommonJS with no Electron in it, so Node's own require does the job here.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type * as Match from '../../../../desktop/games/match';

const load = createRequire(import.meta.url);
const match = load('../../../../desktop/games/match.js') as typeof Match;
const catalogue = load('../../../../desktop/games/catalogue.json') as Match.GameCatalogue;
const catalogueSource = readFileSync(new URL('../../../../desktop/games/catalogue.json', import.meta.url), 'utf8');

const TASKLIST = [
  '"System Idle Process","0","Services","0","8 K"',
  '"System","4","Services","0","148 K"',
  '"svchost.exe","1234","Services","0","20,000 K"',
  '"explorer.exe","5678","Console","1","80,000 K"',
  '"Steam.exe","2222","Console","1","90,000 K"',
  '"steamwebhelper.exe","2223","Console","1","90,000 K"',
  '"Notepad.exe","3333","Console","1","12,000 K"',
  '"eldenring.exe","4444","Console","1","2,000,000 K"',
  '"Datasetto.exe","5555","Console","1","300,000 K"',
  '"Datasetto.exe","5556","Console","1","100,000 K"',
  '',
].join('\r\n');

describe('the bundled catalogue', () => {
  it('has a few hundred games with lower-cased, unique executable names and short titles', () => {
    const games = Object.entries(catalogue.games);
    expect(games.length).toBeGreaterThan(300);
    for (const [exe, title] of games) {
      expect(exe, exe).toBe(exe.toLowerCase());
      expect(exe.trim(), exe).toBe(exe);
      expect(exe).not.toMatch(/[\\/"]/);
      expect(title.trim(), exe).toBe(title);
      expect(title.length, exe).toBeGreaterThan(0);
      expect(title.length, exe).toBeLessThanOrEqual(match.MAX_TITLE_LENGTH);
    }
    // JSON.parse keeps the last of duplicate keys, so check the text itself.
    const keys = [...catalogueSource.matchAll(/^ {4}"([^"]+)":/gm)].map((hit) => hit[1]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(games.length);
  });

  it('lists launchers that are never games', () => {
    expect(catalogue.launchers.length).toBeGreaterThan(20);
    for (const exe of catalogue.launchers) {
      expect(exe).toBe(exe.toLowerCase());
      expect(catalogue.games[exe], exe).toBeUndefined();
    }
    expect(catalogue.launchers).toContain('steam.exe');
    expect(catalogue.launchers).toContain('epicgameslauncher.exe');
    expect(catalogue.launchers).toContain('battle.net.exe');
  });

  it('knows the usual suspects', () => {
    expect(catalogue.games['cs2.exe']).toBe('Counter-Strike 2');
    expect(catalogue.games['eldenring.exe']).toBe('Elden Ring');
    expect(catalogue.games['fortniteclient-win64-shipping.exe']).toBe('Fortnite');
    expect(catalogue.games['league of legends.exe']).toBe('League of Legends');
    expect(catalogue.games['minecraft.windows.exe']).toBe('Minecraft');
  });
});

describe('process list parsing', () => {
  it('reads tasklist CSV into lower-cased, unique, sorted names', () => {
    expect(match.parseTasklist(TASKLIST)).toEqual([
      'datasetto.exe',
      'eldenring.exe',
      'explorer.exe',
      'notepad.exe',
      'steam.exe',
      'steamwebhelper.exe',
      'svchost.exe',
      'system',
      'system idle process',
    ]);
    expect(match.parseTasklist('INFO: No tasks are running.\r\n')).toEqual([]);
    expect(match.parseTasklist(undefined)).toEqual([]);
  });

  it('reads Get-Process names (adding .exe) and ps output (file names only)', () => {
    expect(match.parseProcessNames('Notepad\r\nBeamNG.drive.x64\r\n\r\nsvchost\r\n')).toEqual(['beamng.drive.x64.exe', 'notepad.exe', 'svchost.exe']);
    expect(match.parsePs(['/Applications/Steam.app/Contents/MacOS/steam_osx', '/usr/bin/Notepad', 'eldenring.exe', 'FortniteClient-', ''].join('\n'))).toEqual([
      'eldenring.exe',
      'fortniteclient-',
      'notepad',
      'steam_osx',
    ]);
  });
});

describe('matching', () => {
  const names = match.parseTasklist(TASKLIST);

  it('finds a catalogue game whatever the case of the process name', () => {
    expect(match.matchGame(names, catalogue)).toEqual({ title: 'Elden Ring', exe: 'eldenring.exe', source: 'catalogue' });
    expect(match.matchGame(['ELDENRING.EXE'], catalogue)).toEqual({ title: 'Elden Ring', exe: 'eldenring.exe', source: 'catalogue' });
    expect(match.matchGame(['C:\\Games\\eldenring.exe'], catalogue)?.title).toBe('Elden Ring');
  });

  it('returns null when nothing listed runs and never reports a launcher', () => {
    expect(match.matchGame(['notepad.exe', 'explorer.exe'], catalogue)).toBeNull();
    expect(match.matchGame(['steam.exe', 'steamwebhelper.exe', 'epicgameslauncher.exe'], catalogue)).toBeNull();
    expect(match.matchGame([], catalogue)).toBeNull();
    expect(match.matchGame(undefined, catalogue)).toBeNull();
    // A catalogue that (wrongly) lists a launcher as a game: the launcher list still wins.
    expect(match.matchGame(['steam.exe'], { games: { 'steam.exe': 'Steam' }, launchers: ['steam.exe'] })).toBeNull();
  });

  it('prefers the user\'s own entries, in their order, over the catalogue', () => {
    const custom = [
      { exe: 'Notepad.exe', title: ' Notepad ' },
      { exe: 'eldenring.exe', title: 'Ring' },
    ];
    expect(match.matchGame(names, catalogue, custom)).toEqual({ title: 'Notepad', exe: 'notepad.exe', source: 'custom' });
    expect(match.matchGame(names, catalogue, custom.slice().reverse())).toEqual({ title: 'Ring', exe: 'eldenring.exe', source: 'custom' });
    expect(match.matchGame(['notepad.exe'], catalogue, [{ exe: 'javaw.exe', title: 'Minecraft' }])).toBeNull();
    // A launcher may be an own entry if the user insists.
    expect(match.matchGame(['steam.exe'], catalogue, [{ exe: 'steam.exe', title: 'Browsing the store' }])?.title).toBe('Browsing the store');
  });

  it('is stable when several games run: alphabetical by executable', () => {
    const result = match.matchGame(['valorant-win64-shipping.exe', 'cs2.exe', 'eldenring.exe'], catalogue);
    expect(result?.exe).toBe('cs2.exe');
  });

  it('matches a Linux comm name cut to 15 characters as a prefix', () => {
    expect(match.LINUX_COMM_LENGTH).toBe(15);
    expect(match.matchGame(['fortniteclient-'], catalogue)?.title).toBe('Fortnite');
    expect(match.matchGame(['fortniteclient-'], catalogue, [{ exe: 'FortniteClient-Win64-Shipping.exe', title: 'Fortnite (mine)' }])?.title).toBe('Fortnite (mine)');
    // Shorter names are exact matches only.
    expect(match.matchGame(['eldenrin'], catalogue)).toBeNull();
  });

  it('cleans the custom entries the way the client does', () => {
    expect(match.sanitizeCustomGames([{ exe: ' "Notepad.exe" ', title: '  Notepad\n ' }, { exe: 'notepad.exe', title: 'twice' }, { exe: 'x.exe', title: '' }, 7])).toEqual([
      { exe: 'notepad.exe', title: 'Notepad' },
    ]);
    expect(match.sanitizeCustomGames(Array.from({ length: 80 }, (_, i) => ({ exe: 'g' + i + '.exe', title: 'G' })))).toHaveLength(match.MAX_CUSTOM_GAMES);
    expect(match.sanitizeCustomGames('nope')).toEqual([]);
  });
});

describe('picker list', () => {
  it('leaves out the app itself, launchers and Windows plumbing, keeps everything else', () => {
    const names = match.parseTasklist(TASKLIST);
    expect(match.pickerProcesses(names, catalogue, ['Datasetto.exe'])).toEqual(['eldenring.exe', 'notepad.exe']);
    expect(match.pickerProcesses(names, catalogue)).toContain('datasetto.exe');
    expect(match.SYSTEM_PROCESSES.has('svchost.exe')).toBe(true);
  });
});
