import { useEffect, useState } from 'preact/hooks';
import { Spinner } from '@/components';
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
    </div>
  );
};
