import { Download, RefreshCw, X } from 'lucide-preact';
import { Button } from './Button';
import { cn } from '@/lib/cn';
import { MOTION, usePresence } from '@/lib/motion';
import { openExternal } from '@/services/native/desktop';
import { isPhone } from '@/state/ui';
import { dismissUpdateNotice, visibleUpdateNotice } from '@/state/updates';

const restartToUpdate = (): void => {
  void window.desktopAPI?.installUpdate?.();
};

/**
 * A small card in the bottom corner when a newer version exists: "restart to
 * update" in the desktop app, or a link to the download elsewhere. It never
 * blocks the app and can be closed; it comes back only for a newer version.
 */
export const UpdateNotice = () => {
  const notice = visibleUpdateNotice.value;
  const presence = usePresence(notice !== null, MOTION.fast);
  if (!presence.mounted || !notice) return null;
  const ready = notice.kind === 'ready';
  return (
    <div
      role="status"
      data-state={presence.state}
      data-testid="update-notice"
      data-version={notice.version}
      className={cn(
        // Same layer as the toasts: usable above the sign-in dialog and the settings dialog.
        'motion-toast fixed right-3 z-[60] flex w-80 max-w-[calc(100vw-24px)] items-start gap-3 rounded-md border-l-2 border-brand bg-elevated px-3 py-2.5 text-sm shadow-pop',
        isPhone.value ? 'bottom-[calc(3.5rem+env(safe-area-inset-bottom,0px)+12px)]' : 'bottom-3 safe-bottom',
      )}
    >
      <span className="mt-px shrink-0 text-link">{ready ? <RefreshCw size={18} /> : <Download size={18} />}</span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-text-bright">{ready ? `Version ${notice.version} is ready` : `Version ${notice.version} is available`}</p>
        <p className="mt-0.5 text-xs text-text-muted">
          {ready ? 'Restart Datasetto to finish the update.' : notice.reload ? 'Reload to get the latest web app, or download the desktop app.' : 'Download the new version to update.'}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {ready ? (
            <Button size="sm" onClick={restartToUpdate}>
              Restart now
            </Button>
          ) : (
            <>
              {notice.reload && (
                <Button size="sm" onClick={() => window.location.reload()}>
                  Reload
                </Button>
              )}
              {notice.url && (
                <Button size="sm" variant={notice.reload ? 'secondary' : 'primary'} onClick={() => openExternal(notice.url as string)}>
                  <Download size={14} /> Download
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        className="-m-2 shrink-0 p-2 text-text-muted transition-colors duration-150 hover:text-text-bright"
        onClick={dismissUpdateNotice}
      >
        <X size={16} />
      </button>
    </div>
  );
};
