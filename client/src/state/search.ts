import { batch, signal } from '@preact/signals';
import type { SearchResult } from '@/types/protocol';

export type SearchStatus = 'idle' | 'loading' | 'ready' | 'error';
export type SearchScope = 'all' | 'channel';

/** The search panel is open (header dropdown on desktop, full screen on phones). */
export const searchOpen = signal(false);
export const searchQuery = signal('');
/** Search everywhere or only in the channel currently open. */
export const searchScope = signal<SearchScope>('all');
/** Restrict results to one author (set from a result's "more from" action). */
export const searchAuthor = signal<{ id: string; name: string } | null>(null);
export const searchStatus = signal<SearchStatus>('idle');
export const searchResults = signal<SearchResult[]>([]);
export const searchTotal = signal(0);
export const searchHasMore = signal(false);
export const searchLoadingMore = signal(false);
export const searchError = signal<string | null>(null);
/** Keyboard cursor over the flat result list; -1 when nothing is selected. */
export const searchActiveIndex = signal(-1);

export const resetSearchResults = (): void => {
  batch(() => {
    searchStatus.value = 'idle';
    searchResults.value = [];
    searchTotal.value = 0;
    searchHasMore.value = false;
    searchLoadingMore.value = false;
    searchError.value = null;
    searchActiveIndex.value = -1;
  });
};
