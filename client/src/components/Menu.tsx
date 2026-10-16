import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cn } from '@/lib/cn';
import { isTouchPrimary } from '@/lib/device';
import { MOTION, usePresence } from '@/lib/motion';
import { Sheet, SheetItem } from './Sheet';

export interface MenuItem {
  label: string;
  icon?: ComponentChildren;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

interface MenuProps {
  items: MenuItem[];
  /** Element that opens the menu on click. */
  children: ComponentChildren;
  align?: 'left' | 'right';
  className?: string;
  /** Heading of the sheet on touch screens (who or what the actions are for). */
  title?: string;
}

/**
 * Click-to-open dropdown with a mouse; a bottom sheet on touch screens, where
 * a dropdown would be clipped by its scroll container and too small to hit.
 * Closes on outside click, Escape, the back button or selection.
 */
export const Menu = ({ items, children, align = 'left', className, title }: MenuProps) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const touch = isTouchPrimary();
  const sheet = usePresence(open && touch, MOTION.base);

  useEffect(() => {
    if (!open || touch) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, touch]);

  if (items.length === 0) return <>{children}</>;

  const close = () => setOpen(false);

  return (
    <div ref={ref} className={cn('relative inline-block', className)}>
      <div
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        {children}
      </div>
      {touch
        ? sheet.mounted && (
            <Sheet title={title ?? 'Actions'} showTitle={Boolean(title)} state={sheet.state} onClose={close}>
              <div role="menu" className="py-1">
                {items.map((item) => (
                  <SheetItem
                    key={item.label}
                    label={item.label}
                    icon={item.icon}
                    danger={item.danger}
                    disabled={item.disabled}
                    onSelect={() => {
                      close();
                      item.onSelect();
                    }}
                  />
                ))}
              </div>
            </Sheet>
          )
        : open && (
            <div role="menu" className={cn('absolute z-40 mt-1 min-w-44 rounded-md bg-base p-1.5 shadow-pop animate-pop', align === 'right' ? 'right-0' : 'left-0')}>
              {items.map((item) => (
                <button
                  key={item.label}
                  role="menuitem"
                  type="button"
                  disabled={item.disabled}
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpen(false);
                    item.onSelect();
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-sm transition-colors disabled:opacity-40',
                    item.danger ? 'text-[#fa777c] hover:bg-danger hover:text-white' : 'text-text hover:bg-brand hover:text-white',
                  )}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          )}
    </div>
  );
};
