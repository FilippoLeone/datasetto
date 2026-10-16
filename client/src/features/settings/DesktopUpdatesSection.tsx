import { useState } from 'preact/hooks';
import { Button, Toggle } from '@/components';
import { openExternal } from '@/services/native/desktop';
import { applyDesktopUpdateState, desktopUpdate } from '@/state/updates';
import { toast } from '@/state/ui';

const statusText = (state: DesktopUpdateState): string => {
  switch (state.status) {
    case 'checking':
      return 'Checking for updates…';
    case 'downloading':
      return `Downloading version ${state.version ?? ''}${state.percent !== null ? ` (${Math.round(state.percent)}%)` : ''}…`;
    case 'ready':
      return `Version ${state.version ?? ''} is ready. Restart to update.`;
    case 'available':
      return `Version ${state.version ?? ''} is available.`;
    case 'none':
      return 'Up to date.';
    case 'error':
      return 'Could not check for updates.';
    default:
      return state.mode === 'off' ? 'Updates are off in development runs.' : '';
  }
};

/**
 * Settings > Desktop app: the automatic-updates switch (applies at once, it is
 * a preference of the Electron shell) and the updater status with a manual check.
 * Rendered only in the desktop app; older shells without the bridge show nothing.
 */
export const DesktopUpdatesSection = () => {
  const bridge = typeof window !== 'undefined' ? window.desktopAPI : undefined;
  const state = desktopUpdate.value;
  const [busy, setBusy] = useState(false);
  if (!bridge?.getUpdateState || !bridge.setAutoUpdate || !bridge.checkForUpdates || !state) return null;

  const setAutoUpdate = async (enabled: boolean) => {
    try {
      applyDesktopUpdateState(await bridge.setAutoUpdate!(enabled));
    } catch {
      toast.error('Could not change the update setting');
    }
  };

  const checkNow = async () => {
    setBusy(true);
    try {
      applyDesktopUpdateState(await bridge.checkForUpdates!());
    } catch {
      toast.error('Could not check for updates');
    } finally {
      setBusy(false);
    }
  };

  const action = () => {
    if (state.status === 'ready') {
      return (
        <Button size="sm" onClick={() => void bridge.installUpdate?.()}>
          Restart now
        </Button>
      );
    }
    if (state.status === 'available' && state.url) {
      return (
        <Button size="sm" onClick={() => openExternal(state.url as string)}>
          Download
        </Button>
      );
    }
    return (
      <Button size="sm" variant="secondary" loading={busy || state.status === 'checking'} disabled={state.mode === 'off'} onClick={() => void checkNow()}>
        Check now
      </Button>
    );
  };

  return (
    <section className="mt-3" data-testid="desktop-updates">
      <h3 className="mb-1 text-xs font-semibold tracking-wide text-text-muted uppercase">Desktop app</h3>
      <Toggle
        label="Automatic updates"
        description={state.mode === 'notice' ? 'Tells you when a new version is out; this build cannot install it by itself.' : 'Downloads new versions in the background; a restart installs them.'}
        checked={state.autoUpdate}
        disabled={state.mode === 'off'}
        onChange={(value) => void setAutoUpdate(value)}
      />
      <div className="flex items-center justify-between gap-3 py-2 text-sm">
        <span className="min-w-0 text-text-muted">
          Version {state.currentVersion}
          {statusText(state) ? ` · ${statusText(state)}` : ''}
        </span>
        {action()}
      </div>
    </section>
  );
};
