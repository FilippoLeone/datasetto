import { useRef, useState } from 'preact/hooks';
import { Gamepad2 } from 'lucide-preact';
import { cn } from '@/lib/cn';
import { arcadeHidden } from './state';
import { loadShell } from './ArcadeHost';

type Shell = Awaited<ReturnType<typeof loadShell>>;

/**
 * The Arcade entry in the voice header (and the voice dock on phones): opens the Arcade sheet with
 * this channel's games, "Start a game" and "Solo vs bots". Hidden entirely with "Hide Arcade".
 */
export const ArcadeButton = ({ channelId, className, compact = false }: { channelId: string | null; className?: string; compact?: boolean }) => {
  const [shell, setShell] = useState<Shell | null>(null);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (arcadeHidden.value?.hidden) return null;
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    void loadShell().then((loaded) => {
      setShell(loaded);
      setOpen(true);
    });
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label="Arcade"
        aria-expanded={open}
        title="Arcade"
        onClick={toggle}
        className={cn('flex items-center gap-1 rounded-sm px-2 py-1 hover:bg-hover hover:text-text-bright pointer-coarse:py-2.5', open && 'text-text-bright', className)}
        data-arcade-button
      >
        <Gamepad2 size={14} /> {!compact && 'Arcade'}
      </button>
      {open && shell && <shell.ArcadeSheet channelId={channelId} anchor={anchor.current} onClose={() => setOpen(false)} />}
    </>
  );
};
