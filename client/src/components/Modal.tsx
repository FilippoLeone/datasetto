import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { X } from 'lucide-preact';
import { cn } from '@/lib/cn';
import { IconButton } from './IconButton';

interface ModalProps {
  title: string;
  subtitle?: string;
  /** Omit to make the dialog non-dismissable (e.g. the sign-in screen). */
  onClose?: () => void;
  size?: 'sm' | 'md' | 'lg';
  footer?: ComponentChildren;
  children: ComponentChildren;
}

const SIZES = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl' };

export const Modal = ({ title, subtitle, onClose, size = 'md', footer, children }: ModalProps) => {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onClose) onClose();
    };
    document.addEventListener('keydown', onKey);
    const first = cardRef.current?.querySelector<HTMLElement>('input, textarea, select, button:not([data-close])');
    first?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 animate-fade-in"
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
        className={cn('flex max-h-[90vh] w-full flex-col overflow-hidden rounded-lg bg-sidebar shadow-modal animate-pop', SIZES[size])}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
          <div className="min-w-0">
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
