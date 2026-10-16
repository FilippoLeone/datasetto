import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact';
import { useEffect } from 'preact/hooks';
import { cn } from '@/lib/cn';
import { useBackClose } from '@/lib/backStack';
import type { PresenceState } from '@/lib/motion';

interface SheetProps {
  /** Accessible name and, when shown, the heading. */
  title?: string;
  showTitle?: boolean;
  onClose: () => void;
  children: ComponentChildren;
  /** From usePresence: 'closed' plays the leave animation. */
  state?: PresenceState;
  className?: string;
}

/**
 * Bottom sheet for touch screens: the phone's answer to dropdown menus and
 * pop-up pickers, which get clipped by scroll containers and are hard to hit.
 * Rendered into <body> so no ancestor can clip it; a tap outside, Escape or
 * the back button closes it (lib/backStack.ts).
 */
export const Sheet = ({ title, showTitle = true, onClose, children, state = 'open', className }: SheetProps) => {
  useBackClose(state === 'open', onClose);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div data-state={state} data-sheet className="sheet-root fixed inset-0 z-[70] flex flex-col justify-end" role="presentation">
      <button type="button" aria-label="Close" className="sheet-backdrop absolute inset-0 bg-overlay" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title ?? 'Menu'}
        className={cn('sheet-card relative flex max-h-[85dvh] flex-col rounded-t-2xl bg-sidebar shadow-modal safe-x', className)}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border-strong" aria-hidden="true" />
        {title && showTitle && <p className="shrink-0 truncate px-5 pt-3 pb-1 text-sm font-semibold text-text-bright">{title}</p>}
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]">{children}</div>
      </div>
    </div>,
    document.body,
  );
};

interface SheetItemProps {
  label: string;
  icon?: ComponentChildren;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** One full-width row of a sheet: 48px tall, icon and label. */
export const SheetItem = ({ label, icon, danger, disabled, onSelect }: SheetItemProps) => (
  <button
    type="button"
    role="menuitem"
    disabled={disabled}
    onClick={onSelect}
    className={cn(
      'flex h-12 w-full items-center gap-3 px-5 text-left text-[15px] transition-colors active:bg-active disabled:opacity-40',
      danger ? 'text-[#fa777c]' : 'text-text',
    )}
  >
    {icon && <span className="flex w-5 shrink-0 justify-center">{icon}</span>}
    <span className="min-w-0 flex-1 truncate">{label}</span>
  </button>
);
