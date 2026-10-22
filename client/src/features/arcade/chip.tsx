import type { ComponentChildren } from 'preact';
import { Gamepad2 } from 'lucide-preact';
import { cn } from '@/lib/cn';
import { loadShell } from './ArcadeHost';

type Shell = Awaited<ReturnType<typeof loadShell>>;

/** Run a shell action (the chunk loads on the first click). */
export const withShell = (fn: (shell: Shell) => void): void => {
  void loadShell().then(fn, () => undefined);
};

/** Chip look: ≥ 44 px touch targets, no fixed width (it truncates instead). */
export const CHIP = 'flex min-h-11 max-w-full items-center gap-1 rounded-full bg-elevated pl-3 text-xs text-text';
export const CHIP_ACTION = 'flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full px-3 text-xs font-semibold text-text-bright hover:bg-hover active:bg-active';

export const Chip = ({ label, badge, children, ring, data }: { label: string; badge?: ComponentChildren; children?: ComponentChildren; ring?: boolean; data?: Record<string, string> }) => (
  <div className={cn(CHIP, !children && 'pr-3', ring && 'ring-2 ring-warning')} {...data}>
    <Gamepad2 size={14} className="shrink-0 text-text-muted" />
    <span className="min-w-0 truncate">{label}</span>
    {badge}
    {children}
  </div>
);

export const ChipAction = ({ label, onClick, children }: { label: string; onClick(): void; children?: ComponentChildren }) => (
  <button type="button" className={CHIP_ACTION} onClick={onClick} aria-label={children ? label : undefined} title={children ? label : undefined}>
    {children ?? label}
  </button>
);
