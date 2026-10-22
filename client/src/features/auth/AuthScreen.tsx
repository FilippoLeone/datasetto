import { useEffect, useState } from 'preact/hooks';
import { Gamepad2 } from 'lucide-preact';
import { Spinner } from '@/components';
import { openArcade } from '@/features/arcade/state';
import { AuthModal } from './AuthModal';

const RESUME_GRACE_MS = 8000;

/** Full-screen gate shown until the user is signed in. */
export const AuthScreen = ({ resuming }: { resuming: boolean }) => {
  // If restoring the saved session takes too long (server down, token stale),
  // show the form so the user can act; a late auth:success still signs them in.
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!resuming) return;
    const timer = window.setTimeout(() => setStalled(true), RESUME_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [resuming]);

  return (
    <div className="flex h-full w-full items-center justify-center bg-base p-safe">
      {resuming && !stalled ? (
        <div className="flex flex-col items-center gap-3 text-text-muted">
          <Spinner size={28} />
          <p className="text-sm">Signing you in…</p>
        </div>
      ) : (
        <AuthModal initialMode="login" dismissable={false} />
      )}
      {/* The Arcade plays against bots on this device: no account, no server (docs/arcade/platform.md §12). */}
      <button
        type="button"
        onClick={() => openArcade({ mode: 'local' })}
        className="fixed bottom-[calc(env(safe-area-inset-bottom,0px)+1rem)] left-1/2 z-[51] flex min-h-11 -translate-x-1/2 items-center gap-2 rounded-full bg-sidebar px-4 text-sm font-semibold text-text-muted shadow-pop hover:bg-hover hover:text-text-bright"
        data-play-offline
      >
        <Gamepad2 size={16} /> Play offline
      </button>
    </div>
  );
};
