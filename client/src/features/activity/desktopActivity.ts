/**
 * "Playing <game>" through the Electron bridge. The shell scans the process list (names
 * only, with the operating system's own tool) while the setting is on and reports the
 * matched title; this module keeps the shell configured, mirrors the detection into the
 * store and tells the server, paced to its rate limit. Everything feature-detects the
 * bridge: a browser, a phone or an older desktop shell has no game activity at all.
 */
import { effect } from '@preact/signals';
import { api } from '@/services/socket/api';
import { socketClient } from '@/services/socket/client';
import { catalogueSize, detectedGame, gameActivitySettings } from '@/state/activity';
import { isAuthenticated } from '@/state/session';
import { activityTitle, createActivityReporter } from './gameActivity';

const bridge = () => (typeof window !== 'undefined' ? window.desktopAPI : undefined);

export const supportsGameActivity = (): boolean => typeof bridge()?.configureGameActivity === 'function' && typeof bridge()?.onGameActivity === 'function';

const reporter = createActivityReporter({
  send: (title) => {
    if (socketClient.connected && isAuthenticated.value) api.setActivity(title);
  },
});

let installed = false;

/** Wire the settings and the detection to the shell and the server. Idempotent, no-op without the bridge. */
export const installDesktopActivity = (): void => {
  if (installed) return;
  installed = true;
  const shell = bridge();
  if (!shell?.configureGameActivity || !shell.onGameActivity) return;
  const configure = shell.configureGameActivity;

  shell.onGameActivity((event) => {
    detectedGame.value = gameActivitySettings.value.enabled ? activityTitle(event?.title) : null;
  });

  // The shell forgets the settings on every page load, so send them now and on each change.
  let generation = 0;
  effect(() => {
    const { enabled, custom } = gameActivitySettings.value;
    const myGeneration = ++generation;
    configure({ enabled, custom: custom.map((entry) => ({ exe: entry.exe, title: entry.title })) })
      .then((status) => {
        if (myGeneration !== generation) return;
        catalogueSize.value = Number.isFinite(status?.catalogueSize) ? status.catalogueSize : 0;
        detectedGame.value = enabled ? activityTitle(status?.title) : null;
      })
      .catch(() => {
        if (myGeneration === generation) detectedGame.value = null;
      });
  });

  effect(() => {
    reporter.update(gameActivitySettings.value.enabled ? detectedGame.value : null);
  });
};

/** After every `auth:success`: the server starts each socket at null, so repeat the current title. */
export const resyncGameActivity = (): void => reporter.resync();

/** Names of the running programs for the "add a game" picker; read on this machine, shown here only. */
export const listRunningProcesses = async (): Promise<string[] | null> => {
  const shell = bridge();
  if (!shell?.listProcesses) return null;
  try {
    const result = await shell.listProcesses();
    if (!result || result.error || !Array.isArray(result.processes)) return null;
    return result.processes.filter((name): name is string => typeof name === 'string' && name.length > 0);
  } catch {
    return null;
  }
};
