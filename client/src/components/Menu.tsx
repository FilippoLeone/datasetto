import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
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
  /**
   * Controls shown above the items, in the dropdown and in the sheet alike (a volume panel,
   * say). Using them keeps the menu open; it closes on an item, outside click, Escape or back.
   */
  header?: ComponentChildren;
}

/** Space between the trigger and the dropdown, and the least distance kept from the viewport edge. */
const GAP = 4;
const MARGIN = 8;

interface Position {
  top: number;
  left: number;
}

/**
 * Click-to-open dropdown with a mouse; a bottom sheet on touch screens, where
 * a dropdown would be clipped by its scroll container and too small to hit.
 * The dropdown is rendered into <body> at a fixed position next to its trigger
 * (opening upwards when the viewport has no room below), so a scroll container
 * or an `overflow: hidden` tile cannot clip it either.
 * Closes on outside click, Escape, the back button, a scroll or selection.
 */
export const Menu = ({ items, children, align = 'left', className, title, header }: MenuProps) => {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const touch = isTouchPrimary();
  const sheet = usePresence(open && touch, MOTION.base);

  // Place the dropdown once it has a size: below the trigger, or above it when that is the
  // only side with room, and always inside the viewport.
  useLayoutEffect(() => {
    if (!open || touch) {
      setPosition(null);
      return;
    }
    const trigger = ref.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const rect = trigger.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    let top = rect.bottom + GAP;
    if (top + height > viewportHeight - MARGIN && rect.top - GAP - height >= MARGIN) top = rect.top - GAP - height;
    top = Math.max(MARGIN, Math.min(top, viewportHeight - MARGIN - height));
    let left = align === 'right' ? rect.right - width : rect.left;
    left = Math.max(MARGIN, Math.min(left, viewportWidth - MARGIN - width));
    setPosition({ top, left });
  }, [open, touch, align]);

  useEffect(() => {
    if (!open || touch) return;
    const close = () => setOpen(false);
    const inside = (target: EventTarget | null) => {
      const node = target as Node | null;
      return Boolean(node && (ref.current?.contains(node) || panelRef.current?.contains(node)));
    };
    const onDown = (event: PointerEvent) => {
      if (!inside(event.target)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    // The dropdown sits at a fixed spot: when the page behind it scrolls or the window resizes it closes
    // rather than drifting away from its trigger.
    const onScroll = (event: Event) => {
      if (!inside(event.target)) close();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open, touch]);

  if (items.length === 0 && !header) return <>{children}</>;

  const close = () => setOpen(false);

  return (
    <div ref={ref} className={cn('relative inline-block', className)}>
      <div
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        {children}
      </div>
      {touch
        ? sheet.mounted && (
            <Sheet title={title ?? 'Actions'} showTitle={Boolean(title)} state={sheet.state} onClose={close}>
              {header && <div className={cn(items.length > 0 && 'mb-1 border-b border-border pb-2')}>{header}</div>}
              {items.length > 0 && (
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
              )}
            </Sheet>
          )
        : open &&
          createPortal(
            <div
              ref={panelRef}
              role="menu"
              aria-label={title}
              data-menu
              className="fixed z-[65] min-w-44 rounded-md bg-base p-1.5 shadow-pop animate-pop"
              style={{ top: (position?.top ?? 0) + 'px', left: (position?.left ?? 0) + 'px', visibility: position ? 'visible' : 'hidden' }}
              onClick={(event) => event.stopPropagation()}
            >
              {header && <div className={cn(items.length > 0 && 'mb-1 border-b border-border pb-1.5')}>{header}</div>}
              {items.map((item) => (
                <button
                  key={item.label}
                  role="menuitem"
                  type="button"
                  aria-label={item.label}
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
            </div>,
            document.body,
          )}
    </div>
  );
};
