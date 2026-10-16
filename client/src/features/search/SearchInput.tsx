import { useEffect, useRef } from 'preact/hooks';
import { Search, X } from 'lucide-preact';
import { cn } from '@/lib/cn';
import { flattenGroups, groupResultsByChannel } from '@/lib/search';
import { searchActiveIndex, searchOpen, searchQuery, searchResults } from '@/state/search';
import { clearSearch, closeSearch, moveSearchCursor, openSearch, openSearchResult, registerSearchInput, runSearch, setSearchQuery } from './searchActions';

const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
/** Shortcut hint shown in the box; matches useGlobalShortcuts. */
export const SEARCH_SHORTCUT_LABEL = isMac ? '⌘K' : 'Ctrl K';

interface SearchInputProps {
  className?: string;
  /** Focus as soon as it mounts (the phone panel). */
  autoFocus?: boolean;
  /** Show the keyboard shortcut while the box is empty. */
  showShortcut?: boolean;
}

/**
 * The search box. There is one on screen at a time (header on desktop and
 * tablets, inside the full-screen panel on phones); it registers itself so
 * Ctrl+K and the open action can focus it. Arrow keys move through the results,
 * Enter opens the highlighted one, Escape closes the panel.
 */
export const SearchInput = ({ className, autoFocus, showShortcut }: SearchInputProps) => {
  const ref = useRef<HTMLInputElement>(null);
  const query = searchQuery.value;
  const open = searchOpen.value;
  const active = searchActiveIndex.value;

  useEffect(() => {
    registerSearchInput(ref.current);
    if (autoFocus) ref.current?.focus();
    return () => registerSearchInput(null);
  }, [autoFocus]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openSearch();
      moveSearchCursor(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const ordered = flattenGroups(groupResultsByChannel(searchResults.value));
      const result = active >= 0 ? ordered[active] : undefined;
      if (result) openSearchResult(result);
      else void runSearch();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (query && !open) clearSearch();
      else closeSearch();
    }
  };

  return (
    <div data-search-root className={cn('relative', className)}>
      <Search size={15} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-text-faint" aria-hidden="true" />
      <input
        ref={ref}
        type="text"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        spellcheck={false}
        value={query}
        placeholder="Search messages"
        aria-label="Search messages"
        role="combobox"
        aria-expanded={open}
        aria-controls="search-results"
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? 'search-result-' + active : undefined}
        className="h-8 w-full rounded-md bg-base pr-14 pl-8 text-sm text-text-bright placeholder:text-text-faint outline-none transition-shadow focus:ring-2 focus:ring-brand"
        onInput={(event) => setSearchQuery((event.target as HTMLInputElement).value)}
        onFocus={() => {
          if (!open) openSearch();
        }}
        onKeyDown={onKeyDown}
      />
      {query ? (
        <button
          type="button"
          aria-label="Clear search"
          title="Clear search"
          className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-sm p-1 text-text-muted hover:text-text-bright"
          onMouseDown={(event) => event.preventDefault()}
          onClick={clearSearch}
        >
          <X size={14} />
        </button>
      ) : (
        showShortcut && (
          <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded-sm border border-border-strong px-1 py-px font-sans text-[10px] text-text-faint" aria-hidden="true">
            {SEARCH_SHORTCUT_LABEL}
          </kbd>
        )
      )}
    </div>
  );
};
