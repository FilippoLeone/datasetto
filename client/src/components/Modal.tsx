import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { X } from 'lucide-preact';
import { cn } from '@/lib/cn';
import { useBackClose } from '@/lib/backStack';
import { isTouchPrimary } from '@/lib/device';
import { IconButton } from './IconButton';

interface ModalProps {
  title: string;
  subtitle?: string;
  /** Shown above the title, e.g. the name and logo on the sign-in screen. */
  header?: ComponentChildren;
  /** Omit to make the dialog non-dismissable (e.g. the sign-in screen). */
  onClose?: () => void;
  size?: 'sm' | 'md' | 'lg';
  footer?: ComponentChildren;
  children: ComponentChildren;
}

const SIZES = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl' };

const noop = () => undefined;

export const Modal = ({ title, subtitle, header, onClose, size = 'md', footer, children }: ModalProps) => {
  const cardRef = useRef<HTMLDivElement>(null);
  // Android back / the browser's back button on touch screens closes a dismissable dialog.
  useBackClose(Boolean(onClose), onClose ?? noop);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onClose) onClose();
    };
    document.addEventListener('keydown', onKey);
    // With a keyboard, start in the first field. On a touch screen that would pop the
    // on-screen keyboard and shove the dialog around before it is even read: focus the card instead.
    if (isTouchPrimary()) cardRef.current?.focus();
    else cardRef.current?.querySelector<HTMLElement>('input, textarea, select, button:not([data-close])')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="dialog-overlay fixed inset-0 z-50 flex items-center justify-center bg-overlay p-safe"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && onClose) onClose();
      }}
      role="presentation"
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          // The desktop app's title bar (--titlebar-height, 0 elsewhere) comes off the height too.
          'dialog-card flex max-h-[90vh] w-full flex-col overflow-hidden rounded-lg bg-sidebar shadow-modal outline-none supports-[height:100dvh]:max-h-[calc(100dvh-2rem-var(--titlebar-height,0px))]',
          SIZES[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
          <div className="min-w-0">
            {header}
            <h2 className="text-lg font-semibold text-text-bright">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-text-muted">{subtitle}</p>}
          </div>
          {onClose && (
            <IconButton label="Close" size="sm" onClick={onClose} data-close>
              <X size={18} />
            </IconButton>
          )}
        </div>
        <div className="scrollbar-thin flex-1 overflow-y-auto px-5 pb-5">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 bg-base/60 px-5 py-4">{footer}</div>}
      </div>
    </div>
  );
};
