import { useEffect, useRef } from 'preact/hooks';
import { Sheet } from '@/components';
import { cn } from '@/lib/cn';
import { isTouchPrimary } from '@/lib/device';
import { EMOJIS } from '@/lib/text';

interface EmojiPickerProps {
  onPick: (emoji: string) => void;
  onClose: () => void;
  /** Positioning classes of the pop-up; defaults to above-right of the parent. Ignored on touch screens. */
  className?: string;
  /** Heading of the touch sheet. */
  title?: string;
}

/**
 * The app's emoji set as a grid. A pop-up next to its button with a mouse
 * (closes on outside click or Escape); on touch screens a bottom sheet with
 * 48px cells, because the pop-up would be clipped by the message list and
 * its cells are too small for a finger.
 */
export const EmojiPicker = ({ onPick, onClose, className, title = 'Pick an emoji' }: EmojiPickerProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const touch = isTouchPrimary();
  useEffect(() => {
    if (touch) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose, touch]);

  if (touch) {
    return (
      <Sheet title={title} onClose={onClose}>
        <div className="grid grid-cols-6 gap-1 px-3 pb-2" role="listbox" aria-label={title}>
          {EMOJIS.map((emoji) => (
            <button key={emoji} type="button" role="option" aria-selected={false} className="h-12 rounded-md text-2xl active:bg-active" onClick={() => onPick(emoji)}>
              {emoji}
            </button>
          ))}
        </div>
      </Sheet>
    );
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Emoji"
      className={cn('z-30 grid w-72 grid-cols-8 gap-1 rounded-md bg-elevated p-2 shadow-pop animate-pop', className ?? 'absolute right-0 bottom-full mb-2')}
      onClick={(event) => event.stopPropagation()}
    >
      {EMOJIS.map((emoji) => (
        <button key={emoji} type="button" className="rounded-sm p-1 text-xl hover:bg-hover" onClick={() => onPick(emoji)}>
          {emoji}
        </button>
      ))}
    </div>
  );
};
