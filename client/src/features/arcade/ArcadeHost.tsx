import { useEffect, useState } from 'preact/hooks';
import { arcadeView } from './state';
import type * as ShellModule from './shell';

type Shell = typeof ShellModule;
let shellPromise: Promise<Shell> | null = null;

/** The shell chunk, loaded once. */
export const loadShell = (): Promise<Shell> => (shellPromise ??= import('./shell'));

/**
 * Mount point for local play, rendered by App outside the sign-in gate so "Play offline" works with
 * no account and no server. Renders nothing (and loads nothing) until the Arcade is opened.
 */
export const ArcadeHost = () => {
  const view = arcadeView.value;
  const wanted = view !== null && view.mode === 'local';
  const [shell, setShell] = useState<Shell | null>(null);
  useEffect(() => {
    if (!wanted || shell) return;
    let alive = true;
    void loadShell().then((loaded) => alive && setShell(loaded));
    return () => {
      alive = false;
    };
  }, [wanted, shell]);
  if (!wanted || !shell) return null;
  return <shell.ArcadeOverlay />;
};
