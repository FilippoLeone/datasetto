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

export interface UpdateNoticeProps {
  /**
   * `sidebar`: a card in the sidebar's flow, above the voice dock (the app with a static sidebar), so
   * it never covers the composer or the member list. `floating`: a card in the bottom corner (the
   * sign-in screen, and phones, where the sidebar is a drawer).
   */
  placement?: 'floating' | 'sidebar';
}

/**
 * Tells about a newer version: "restart to update" in the desktop app, or reload and download
 * elsewhere. It never blocks the app and can be closed; it comes back only for a newer version.
 */
export const UpdateNotice = ({ placement = 'floating' }: UpdateNoticeProps) => {
  const notice = visibleUpdateNotice.value;
  const presence = usePresence(notice !== null, MOTION.fast);
  if (!presence.mounted || !notice) return null;
  const ready = notice.kind === 'ready';
  const sidebar = placement === 'sidebar';
  // A short title fits the sidebar's width on one line; the version goes in the detail.
  const title = ready ? 'Update ready' : 'Update available';
  const detail =
    `Version ${notice.version}. ` +
    (ready
      ? 'Restart Datasetto to finish the update.'
      : notice.reload
        ? 'Reload to get the latest web app, or download the desktop app.'
        : 'Download the new version to update.');
  return (
    <div
      role="status"
      data-state={presence.state}
      data-testid="update-notice"
      data-placement={placement}
      data-version={notice.version}
      className={cn(
        'rounded-md border-l-2 border-brand text-sm',
        sidebar
          ? 'mx-2 mb-2 bg-base/60 p-3'
          : cn(
              // Same layer as the toasts: usable above the sign-in dialog and the settings dialog.
              'motion-toast fixed z-[60] bg-elevated px-4 py-3.5 shadow-pop',
              isPhone.value
                ? // Phones: full width just under the header, clear of the composer and the bottom toolbar.
                  'inset-x-[max(0.75rem,env(safe-area-inset-left,0px))] top-[calc(env(safe-area-inset-top,0px)+3.5rem)]'
                : 'right-[max(0.75rem,env(safe-area-inset-right,0px))] bottom-4 w-80 max-w-[calc(100vw-24px)] safe-bottom',
            ),
      )}
    >
      {/* Icon, title and close on one row; the text and the buttons below get the card's full width. */}
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-link">{ready ? <RefreshCw size={16} /> : <Download size={16} />}</span>
        <p className="min-w-0 flex-1 truncate font-semibold text-text-bright">{title}</p>
        <button
          type="button"
          aria-label="Dismiss"
          className="-my-1 -mr-1 shrink-0 rounded-sm p-1 text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text-bright pointer-coarse:-my-2 pointer-coarse:p-2.5"
          onClick={dismissUpdateNotice}
        >
          <X size={16} />
        </button>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-text-muted">{detail}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {ready ? (
          <Button size="sm" onClick={restartToUpdate}>
            <RefreshCw size={14} /> Restart now
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
  );
};
