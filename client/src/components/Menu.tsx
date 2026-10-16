import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cn } from '@/lib/cn';

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
}

/** Click-to-open dropdown. Closes on outside click, Escape or selection. */
export const Menu = ({ items, children, align = 'left', className }: MenuProps) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (items.length === 0) return <>{children}</>;

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
      {open && (
        <div
          role="menu"
          className={cn(
            'absolute z-40 mt-1 min-w-44 rounded-md bg-base p-1.5 shadow-pop animate-pop',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
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
