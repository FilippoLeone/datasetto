import { useEffect, useRef } from 'preact/hooks';
import { cn } from '@/lib/cn';
import { EMOJIS } from '@/lib/text';

interface EmojiPickerProps {
  onPick: (emoji: string) => void;
  onClose: () => void;
  /** Positioning classes; defaults to above-right of the parent. */
  className?: string;
}

/** The app's emoji set as a grid; closes on outside click or Escape. */
export const EmojiPicker = ({ onPick, onClose, className }: EmojiPickerProps) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
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
  }, [onClose]);
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
