'use strict';

/**
 * Pure helpers behind the "Playing <game>" presence: parse the output of the operating
 * system's own process-list tool and look the executable names up in the catalogue
 * (catalogue.json) and in the user's own entries. Nothing here touches Electron or
 * other processes, so the client's unit tests load this file as it is.
 */

const MAX_TITLE_LENGTH = 64;
const MAX_EXECUTABLE_LENGTH = 128;
const MAX_CUSTOM_GAMES = 50;
/** Linux `ps` reports `comm` cut to 15 characters; a name that long may be a prefix. */
const LINUX_COMM_LENGTH = 15;

/** Windows plumbing the picker in the settings dialog leaves out; none of it is a game. */
const SYSTEM_PROCESSES = new Set([
  'system', 'system idle process', 'idle', 'registry', 'memory compression', 'secure system',
  'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe', 'lsaiso.exe',
  'svchost.exe', 'fontdrvhost.exe', 'dwm.exe', 'explorer.exe', 'sihost.exe', 'taskhostw.exe',
  'ctfmon.exe', 'runtimebroker.exe', 'conhost.exe', 'dllhost.exe', 'wmiprvse.exe', 'spoolsv.exe',
  'audiodg.exe', 'searchhost.exe', 'searchindexer.exe', 'searchprotocolhost.exe', 'searchfilterhost.exe',
  'startmenuexperiencehost.exe', 'shellexperiencehost.exe', 'textinputhost.exe', 'applicationframehost.exe',
  'systemsettings.exe', 'securityhealthservice.exe', 'securityhealthsystray.exe', 'msmpeng.exe',
  'nissrv.exe', 'mpdefendercoreservice.exe', 'wudfhost.exe', 'dashost.exe', 'backgroundtaskhost.exe',
  'widgets.exe', 'widgetservice.exe', 'phoneexperiencehost.exe', 'crossdeviceservice.exe',
  'lockapp.exe', 'useroobebroker.exe', 'unsecapp.exe', 'wlanext.exe', 'taskmgr.exe', 'mmc.exe',
  'aggregatorhost.exe', 'msedgewebview2.exe', 'ngciso.exe', 'sgrmbroker.exe', 'wmiapsrv.exe',
  'cmd.exe', 'powershell.exe', 'pwsh.exe', 'tasklist.exe', 'ps', 'bash', 'sh', 'zsh', 'launchd',
  'kernel_task', 'windowserver', 'loginwindow', 'finder', 'dock', 'systemuiserver',
]);

/** Lower-cased file name of a process (no directory, no quotes); null for garbage. */
function normalizeExecutable(value) {
  if (typeof value !== 'string') return null;
  let name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  name = name.replace(/^"+|"+$/g, '').trim();
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (slash >= 0) name = name.slice(slash + 1);
  name = name.trim().toLowerCase();
  if (!name || name.length > MAX_EXECUTABLE_LENGTH) return null;
  return name;
}

/** A display title: one line, trimmed, at most MAX_TITLE_LENGTH characters; null when empty. */
function normalizeTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!title) return null;
  return title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH).trimEnd() : title;
}

/** Normalised, de-duplicated and sorted names. */
function uniqueNames(names) {
  const seen = new Set();
  for (const raw of Array.isArray(names) ? names : []) {
    const name = normalizeExecutable(raw);
    if (name) seen.add(name);
  }
  return Array.from(seen).sort();
}

/** `tasklist /FO CSV /NH` on Windows: the image name is the first quoted column of each line. */
function parseTasklist(output) {
  const names = [];
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = /^"([^"]*)"/.exec(line.trim());
    if (match && match[1]) names.push(match[1]);
  }
  return uniqueNames(names);
}

/** PowerShell `Get-Process | ForEach-Object ProcessName`: one name per line, without `.exe`. */
function parseProcessNames(output) {
  return uniqueNames(
    String(output ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((name) => name + '.exe'),
  );
}

/** `ps -axo comm=` on macOS and Linux: one command per line, a full path on macOS. */
function parsePs(output) {
  return uniqueNames(String(output ?? '').split(/\r?\n/));
}

/** Catalogue JSON with lower-cased keys and a launcher set; tolerant of a missing section. */
function normalizeCatalogue(raw) {
  const games = {};
  const source = raw && typeof raw.games === 'object' && raw.games ? raw.games : {};
  for (const [key, value] of Object.entries(source)) {
    const exe = normalizeExecutable(key);
    const title = normalizeTitle(value);
    if (exe && title) games[exe] = title;
  }
  const launchers = new Set(uniqueNames(raw && Array.isArray(raw.launchers) ? raw.launchers : []));
  return { games, launchers };
}

/** The user's own entries as the renderer sent them, cleaned: `{ exe, title }`, unique, capped. */
function sanitizeCustomGames(entries) {
  const result = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const exe = normalizeExecutable(entry ? entry.exe : null);
    const title = normalizeTitle(entry ? entry.title : null);
    if (!exe || !title || seen.has(exe)) continue;
    seen.add(exe);
    result.push({ exe, title });
    if (result.length >= MAX_CUSTOM_GAMES) break;
  }
  return result;
}

/**
 * The game to show for a process list, or null. The user's own entries win, in their
 * order; then the catalogue, by executable name, so the answer is stable when several
 * games run. Launchers are never games. A Linux `comm` cut to 15 characters matches
 * an executable it is a prefix of.
 */
function matchGame(processNames, catalogue, customGames = []) {
  const names = uniqueNames(processNames);
  const running = new Set(names);
  const truncated = names.filter((name) => name.length === LINUX_COMM_LENGTH);
  const isRunning = (exe) => running.has(exe) || truncated.some((name) => exe.startsWith(name));
  const { games, launchers } = normalizeCatalogue(catalogue);

  for (const entry of sanitizeCustomGames(customGames)) {
    if (isRunning(entry.exe)) return { title: entry.title, exe: entry.exe, source: 'custom' };
  }

  for (const name of names) {
    if (launchers.has(name)) continue;
    const title = games[name];
    if (title) return { title, exe: name, source: 'catalogue' };
  }
  if (truncated.length > 0) {
    for (const exe of Object.keys(games).sort()) {
      if (!launchers.has(exe) && truncated.some((name) => exe.startsWith(name))) {
        return { title: games[exe], exe, source: 'catalogue' };
      }
    }
  }
  return null;
}

/**
 * Process names worth offering in the "add a game" picker: everything running except the
 * app itself, launchers and Windows plumbing. Shown locally only.
 */
function pickerProcesses(processNames, catalogue, ownExecutables = []) {
  const { launchers } = normalizeCatalogue(catalogue);
  const own = new Set(uniqueNames(ownExecutables));
  return uniqueNames(processNames).filter((name) => !SYSTEM_PROCESSES.has(name) && !launchers.has(name) && !own.has(name));
}

module.exports = {
  LINUX_COMM_LENGTH,
  MAX_CUSTOM_GAMES,
  MAX_EXECUTABLE_LENGTH,
  MAX_TITLE_LENGTH,
  SYSTEM_PROCESSES,
  matchGame,
  normalizeCatalogue,
  normalizeExecutable,
  normalizeTitle,
  parsePs,
  parseProcessNames,
  parseTasklist,
  pickerProcesses,
  sanitizeCustomGames,
  uniqueNames,
};
