import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { ArrowLeft, Filter, Hash, MessageCircle, Radio, Search, SearchX, X } from 'lucide-preact';
import { Avatar, Button, IconButton } from '@/components';
import { cn } from '@/lib/cn';
import { formatFullDate, formatRelative } from '@/lib/format';
import { MOTION, usePresence } from '@/lib/motion';
import { MIN_SEARCH_CHARS, flattenGroups, groupResultsByChannel, searchableLength } from '@/lib/search';
import { channelLabel, channelsById, selectedChannel, selectedChannelId } from '@/state/channels';
import {
  searchActiveIndex,
  searchAuthor,
  searchError,
  searchHasMore,
  searchLoadingMore,
  searchOpen,
  searchQuery,
  searchResults,
  searchScope,
  searchStatus,
  searchTotal,
} from '@/state/search';
import { isPhone } from '@/state/ui';
import type { ChannelType, SearchResult } from '@/types/protocol';
import { SearchInput } from './SearchInput';
import { closeSearch, loadMoreResults, openSearchResult, runSearch, scopeChannelAvailable, setSearchAuthor, setSearchScope } from './searchActions';

const GROUP_ICONS: Partial<Record<ChannelType, typeof Hash>> = { text: Hash, stream: Radio, dm: MessageCircle };

const Chip = ({ active, onClick, children, removable, label }: { active?: boolean; onClick: () => void; children: ComponentChildren; removable?: boolean; label?: string }) => (
  <button
    type="button"
    aria-pressed={removable ? undefined : active}
    aria-label={label}
    onClick={onClick}
    className={cn(
      'flex h-6 max-w-48 items-center gap-1 rounded-full border px-2 text-xs transition-colors',
      active ? 'border-brand bg-brand-soft text-text-bright' : 'border-border text-text-muted hover:border-border-strong hover:text-text',
    )}
  >
    <span className="truncate">{children}</span>
    {removable && <X size={12} className="shrink-0" aria-hidden="true" />}
  </button>
);

const Filters = () => {
  const channel = selectedChannel.value;
  const channelScope = scopeChannelAvailable() && channel;
  const scope = searchScope.value;
  const author = searchAuthor.value;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2.5 pb-1.5">
      <Chip active={scope === 'all' || !channelScope} onClick={() => setSearchScope('all')}>
        Everywhere
      </Chip>
      {channelScope && (
        <Chip active={scope === 'channel'} onClick={() => setSearchScope('channel')}>
          {(channel.type === 'dm' ? '@' : '#') + channelLabel(channel)}
        </Chip>
      )}
      {author && (
        <Chip active removable label={'Only messages from ' + author.name + '; press to remove this filter'} onClick={() => setSearchAuthor(null)}>
          From {author.name}
        </Chip>
      )}
    </div>
  );
};

const Snippet = ({ parts }: { parts: SearchResult['snippet'] }) => (
  <span className="search-snippet line-clamp-2 text-sm break-words text-text">
    {parts.map((part, index) => (part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>))}
  </span>
);

const ResultRow = ({ result, index }: { result: SearchResult; index: number }) => {
  const active = searchActiveIndex.value === index;
  return (
    <div
      id={'search-result-' + index}
      role="option"
      aria-selected={active}
      data-search-index={index}
      className={cn('group flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5', active ? 'bg-active' : 'hover:bg-hover')}
      onClick={() => openSearchResult(result)}
      onMouseEnter={() => {
        searchActiveIndex.value = index;
      }}
    >
      <Avatar seed={result.authorId ?? result.authorName} name={result.authorName} src={result.authorAvatarUrl} size={28} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-sm font-semibold text-text-bright">{result.authorName}</span>
          <time className="shrink-0 text-[11px] text-text-faint" dateTime={new Date(result.ts).toISOString()} title={formatFullDate(result.ts)}>
            {formatRelative(result.ts)}
          </time>
        </span>
        <Snippet parts={result.snippet} />
      </span>
      {result.authorId && (
        <button
          type="button"
          aria-label={'Only messages from ' + result.authorName}
          title={'Only messages from ' + result.authorName}
          className={cn('shrink-0 rounded-sm p-1 text-text-faint hover:text-text-bright focus:opacity-100 pointer-coarse:opacity-100', active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
          onClick={(event) => {
            event.stopPropagation();
            setSearchAuthor({ id: result.authorId!, name: result.authorName });
          }}
        >
          <Filter size={14} />
        </button>
      )}
    </div>
  );
};

const Hint = ({ icon, title, children }: { icon: ComponentChildren; title: string; children?: ComponentChildren }) => (
  <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
    <span className="text-text-faint">{icon}</span>
    <p className="text-sm font-semibold text-text-bright">{title}</p>
    {children && <p className="text-xs text-text-muted">{children}</p>}
  </div>
);

const Skeleton = () => (
  <div className="flex flex-col gap-3 px-3 py-3" aria-busy="true" aria-label="Searching">
    {['80%', '55%', '70%'].map((width, index) => (
      <div key={index} className="flex gap-2.5">
        <span className="skeleton h-7 w-7 shrink-0" style={{ borderRadius: '9999px' }} />
        <span className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
          <span className="skeleton h-3 w-24" />
          <span className="skeleton h-3" style={{ width }} />
        </span>
      </div>
    ))}
  </div>
);

const Results = () => {
  const query = searchQuery.value;
  const status = searchStatus.value;
  const results = searchResults.value;
  const listRef = useRef<HTMLDivElement>(null);
  const active = searchActiveIndex.value;

  // Keep the keyboard cursor on screen.
  useEffect(() => {
    if (active < 0) return;
    listRef.current?.querySelector<HTMLElement>('[data-search-index="' + active + '"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (searchableLength(query) < MIN_SEARCH_CHARS) {
    return (
      <Hint icon={<Search size={28} />} title="Search your messages">
        Type at least {MIN_SEARCH_CHARS} characters. Put a phrase in quotes to match it exactly.
      </Hint>
    );
  }
  if (status === 'loading' && results.length === 0) return <Skeleton />;
  if (status === 'error' && results.length === 0) {
    return (
      <Hint icon={<SearchX size={28} />} title="Search did not go through">
        {searchError.value}
        <span className="mt-3 block">
          <Button size="sm" variant="secondary" onClick={() => void runSearch()}>
            Try again
          </Button>
        </span>
      </Hint>
    );
  }
  if (status === 'ready' && results.length === 0) {
    const filtered = searchAuthor.value || (searchScope.value === 'channel' && scopeChannelAvailable());
    return (
      <Hint icon={<SearchX size={28} />} title={'No messages match “' + query.trim() + '”'}>
        {filtered ? 'Try searching everywhere or without the author filter.' : 'Check the spelling, or try fewer words.'}
      </Hint>
    );
  }
  if (results.length === 0) return null;

  const groups = groupResultsByChannel(results);
  const ordered = flattenGroups(groups);
  const indexOf = new Map(ordered.map((result, index) => [result.id, index]));
  return (
    <div ref={listRef} id="search-results" role="listbox" aria-label="Search results" className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
      {groups.map((group) => {
        const channel = channelsById.value.get(group.channelId);
        const type = channel?.type ?? group.results[0].channelType;
        const Icon = GROUP_ICONS[type] ?? Hash;
        const name = channel ? channelLabel(channel) : group.results[0].channelName || 'Unknown channel';
        return (
          <section key={group.channelId} role="group" aria-label={name}>
            <h3 className="sticky top-0 z-10 flex items-center gap-1.5 bg-sidebar px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-text-muted uppercase">
              <Icon size={12} aria-hidden="true" />
              <span className="truncate">{name}</span>
              <span className="ml-auto text-text-faint tabular-nums">{group.results.length}</span>
            </h3>
            {group.results.map((result) => (
              <ResultRow key={result.id} result={result} index={indexOf.get(result.id) ?? 0} />
            ))}
          </section>
        );
      })}
      <div className="flex items-center justify-between gap-2 px-2 pt-2 text-xs text-text-faint">
        <span>
          {results.length} of {searchTotal.value} {searchTotal.value === 1 ? 'result' : 'results'}
        </span>
        {searchHasMore.value && (
          <Button size="sm" variant="ghost" loading={searchLoadingMore.value} onClick={loadMoreResults}>
            Load more
          </Button>
        )}
        {status === 'error' && <span className="text-live">{searchError.value}</span>}
      </div>
    </div>
  );
};

/**
 * Results of the message search. A dropdown under the header box on desktop
 * and tablets, a full-screen page with its own box on phones. Stays mounted
 * for its leave animation (lib/motion.ts) and respects reduced motion.
 */
export const SearchPanel = () => {
  const open = searchOpen.value;
  const phone = isPhone.value;
  const presence = usePresence(open, MOTION.fast);
  const currentChannelId = selectedChannelId.value;

  // Clicking anywhere else closes the dropdown (the phone page has its own back button).
  useEffect(() => {
    if (!open || phone) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-search-root]')) return;
      closeSearch();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, phone]);

  // "This channel" follows the channel that is open.
  useEffect(() => {
    if (open && searchScope.value === 'channel') void runSearch();
  }, [open, currentChannelId]);

  if (!presence.mounted) return null;

  if (phone) {
    return (
      <div
        data-search-root
        data-state={presence.state}
        role="dialog"
        aria-modal="true"
        aria-label="Search messages"
        className="motion-panel fixed inset-0 z-[45] flex flex-col bg-main safe-top safe-x safe-bottom"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2">
          <IconButton label="Back" size="sm" onClick={closeSearch}>
            <ArrowLeft size={20} />
          </IconButton>
          <SearchInput autoFocus className="flex-1" />
        </div>
        <Filters />
        <Results />
      </div>
    );
  }

  return (
    <div
      data-search-root
      data-state={presence.state}
      role="dialog"
      aria-label="Search results"
      className="motion-panel absolute top-full right-2 z-40 mt-1 flex max-h-[min(70vh,40rem)] w-[26rem] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-lg border border-border bg-sidebar shadow-modal"
    >
      <Filters />
      <Results />
    </div>
  );
};
