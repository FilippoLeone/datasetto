import { useEffect, useState } from 'preact/hooks';
import { Spinner } from '@/components';
import { loadShell } from './ArcadeHost';

/** A lazy chunk, loaded once `wanted` holds; null until it has loaded (or when it cannot load). */
export const useLazy = <T,>(load: () => Promise<T>, wanted = true): T | null => {
  const [loaded, setLoaded] = useState<T | null>(null);
  useEffect(() => {
    if (!wanted || loaded) return;
    let alive = true;
    load().then(
      (mod) => alive && setLoaded(() => mod),
      () => undefined,
    );
    return () => {
      alive = false;
    };
    // `load` is a stable import thunk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, loaded]);
  return loaded;
};

/** The online stage (GameStage, in the shell chunk) in place of the voice page's video grid. */
export const StageSlot = () => {
  const shell = useLazy(loadShell);
  return shell ? (
    <shell.GameStage />
  ) : (
    <div className="flex flex-1 items-center justify-center">
      <Spinner size={28} />
    </div>
  );
};
