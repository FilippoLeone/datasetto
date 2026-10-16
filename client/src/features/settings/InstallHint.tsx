import { Share, Smartphone } from 'lucide-preact';
import { Button } from '@/components';
import { dismissInstallHint, installHint, promptInstall } from '@/services/installPrompt';

/**
 * "Install Datasetto" card at the bottom of the channel drawer: the browser's
 * install prompt on Android Chrome, the Share > Add to Home Screen steps on
 * iOS Safari. Gone once installed; "Not now" hides it for two weeks.
 */
export const InstallHint = () => {
  const hint = installHint.value;
  if (hint === 'none') return null;
  return (
    <div className="mx-2 mb-2 rounded-md bg-base/60 p-3 text-xs text-text-muted" role="note" aria-label="Install the app" data-install-hint>
      <p className="flex items-center gap-1.5 text-sm font-semibold text-text-bright">
        <Smartphone size={14} /> Install Datasetto
      </p>
      {hint === 'prompt' ? (
        <p className="mt-1">Full screen, an icon on your home screen and notifications for messages.</p>
      ) : (
        <p className="mt-1 flex items-start gap-1.5">
          <Share size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            Tap <strong className="text-text">Share</strong>, then <strong className="text-text">Add to Home Screen</strong> for full screen and notifications.
          </span>
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {hint === 'prompt' && (
          <Button size="sm" onClick={() => void promptInstall()}>
            Install
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={dismissInstallHint}>
          Not now
        </Button>
      </div>
    </div>
  );
};
