import { Avatar } from '@/components';
import { cn } from '@/lib/cn';
import { avatarOf } from '@/state/avatars';
import type { MentionCandidate } from '@/types/protocol';

interface MentionAutocompleteProps {
  /** Id of the listbox (the textarea points at it with aria-controls); options are `<id>-<index>`. */
  id: string;
  candidates: MentionCandidate[];
  activeIndex: number;
  onPick: (candidate: MentionCandidate) => void;
  onActivate: (index: number) => void;
}

export const optionId = (listId: string, index: number): string => listId + '-' + index;

/**
 * The list of people matching the @mention being typed, above the composer. The
 * textarea keeps the focus and drives it with the arrow keys, Enter and Tab;
 * a click picks too (the mousedown is swallowed so the textarea stays focused).
 */
export const MentionAutocomplete = ({ id, candidates, activeIndex, onPick, onActivate }: MentionAutocompleteProps) => (
  <div
    id={id}
    role="listbox"
    aria-label="People to mention"
    className="scrollbar-thin absolute bottom-full left-0 z-30 mb-2 max-h-64 w-80 max-w-full overflow-y-auto rounded-md bg-elevated p-1.5 shadow-pop animate-pop"
  >
    <p className="px-2 pt-1 pb-1 text-[11px] font-semibold tracking-wide text-text-muted uppercase">Members</p>
    {candidates.map((candidate, index) => {
      const active = index === activeIndex;
      return (
        <button
          key={candidate.accountId}
          type="button"
          role="option"
          id={optionId(id, index)}
          aria-selected={active}
          tabIndex={-1}
          className={cn(
            'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors pointer-coarse:py-2.5',
            active ? 'bg-brand text-white' : 'text-text hover:bg-hover',
          )}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onActivate(index)}
          onClick={() => onPick(candidate)}
        >
          <Avatar seed={candidate.accountId} name={candidate.displayName} src={avatarOf(candidate.accountId, candidate.avatarUrl)} size={24} />
          <span className="truncate font-medium">{candidate.displayName}</span>
          <span className={cn('ml-auto min-w-0 truncate text-xs', active ? 'text-white/80' : 'text-text-faint')}>{candidate.username}</span>
        </button>
      );
    })}
  </div>
);
