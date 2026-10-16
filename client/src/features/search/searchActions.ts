import { batch } from '@preact/signals';
import { jumpToMessage } from '@/features/chat/history';
import { MIN_SEARCH_CHARS, searchableLength } from '@/lib/search';
import { api } from '@/services/socket/api';
import { sounds } from '@/services/sounds';
import { selectedChannel } from '@/state/channels';
import {
  resetSearchResults,
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
  type SearchScope,
} from '@/state/search';
import type { SearchResult } from '@/types/protocol';

const PAGE_SIZE = 25;
const DEBOUNCE_MS = 250;

let debounce: number | null = null;
/** Sequence number of the newest request; answers to older ones are dropped. */
let requestSeq = 0;
/** The input currently on screen (header box or the phone panel), for Ctrl+K and openSearch. */
let inputNode: HTMLInputElement | null = null;

export const registerSearchInput = (node: HTMLInputElement | null): void => {
  inputNode = node;
};

export const focusSearchInput = (): void => {
  const focus = () => {
    inputNode?.focus();
    inputNode?.select();
  };
  if (inputNode?.isConnected) {
    focus();
    return;
  }
  // The phone panel's box only mounts with the panel: wait for that render.
  // (A timeout rather than an animation frame: frames do not run in a background tab.)
  window.setTimeout(focus, 0);
};

export const openSearch = (): void => {
  searchOpen.value = true;
  focusSearchInput();
};

export const closeSearch = (): void => {
  if (!searchOpen.value) return;
  searchOpen.value = false;
  searchActiveIndex.value = -1;
  inputNode?.blur();
};

export const toggleSearch = (): void => {
  if (searchOpen.value) closeSearch();
  else openSearch();
};

const cancelPending = () => {
  if (debounce !== null) window.clearTimeout(debounce);
  debounce = null;
};

/** Channels the "this channel" scope can apply to. */
export const scopeChannelAvailable = (): boolean => {
  const channel = selectedChannel.value;
  return Boolean(channel && (channel.type === 'text' || channel.type === 'dm' || channel.type === 'stream'));
};

/**
 * Run (or re-run) the search with the current query and filters. `append`
 * fetches the next page and adds it to the list.
 */
export const runSearch = async (append = false): Promise<void> => {
  cancelPending();
  const query = searchQuery.value.trim();
  if (searchableLength(query) < MIN_SEARCH_CHARS) {
    requestSeq += 1;
    resetSearchResults();
    return;
  }
  const seq = (requestSeq += 1);
  const offset = append ? searchResults.value.length : 0;
  batch(() => {
    if (append) searchLoadingMore.value = true;
    else searchStatus.value = 'loading';
    searchError.value = null;
  });
  const channelId = searchScope.value === 'channel' && scopeChannelAvailable() ? (selectedChannel.value?.id ?? null) : null;
  try {
    const response = await api.search({ query, channelId, authorId: searchAuthor.value?.id ?? null, limit: PAGE_SIZE, offset });
    if (seq !== requestSeq) return;
    if (!response.success) {
      batch(() => {
        searchStatus.value = 'error';
        searchError.value = response.code === 'RATE_LIMITED' ? 'Too many searches in a row. Give it a moment.' : response.error || 'Search failed';
        if (!append) searchResults.value = [];
      });
      return;
    }
    const page = response.results ?? [];
    batch(() => {
      searchResults.value = append ? [...searchResults.value, ...page] : page;
      searchTotal.value = response.total ?? searchResults.value.length;
      searchHasMore.value = response.hasMore ?? false;
      searchStatus.value = 'ready';
      if (!append) searchActiveIndex.value = page.length > 0 ? 0 : -1;
    });
  } catch {
    if (seq !== requestSeq) return;
    batch(() => {
      searchStatus.value = 'error';
      searchError.value = 'Search is not available right now';
      if (!append) searchResults.value = [];
    });
  } finally {
    if (seq === requestSeq) searchLoadingMore.value = false;
  }
};

const schedule = () => {
  cancelPending();
  debounce = window.setTimeout(() => void runSearch(), DEBOUNCE_MS);
};

export const setSearchQuery = (value: string): void => {
  searchQuery.value = value;
  if (searchableLength(value) < MIN_SEARCH_CHARS) {
    cancelPending();
    requestSeq += 1;
    resetSearchResults();
    return;
  }
  schedule();
};

export const setSearchScope = (scope: SearchScope): void => {
  if (searchScope.value === scope) return;
  searchScope.value = scope;
  void runSearch();
};

export const setSearchAuthor = (author: { id: string; name: string } | null): void => {
  searchAuthor.value = author;
  void runSearch();
};

export const loadMoreResults = (): void => {
  if (searchLoadingMore.value || !searchHasMore.value) return;
  void runSearch(true);
};

export const clearSearch = (): void => {
  cancelPending();
  requestSeq += 1;
  batch(() => {
    searchQuery.value = '';
    searchAuthor.value = null;
    resetSearchResults();
  });
  focusSearchInput();
};

/** Open the channel of a result at that message. */
export const openSearchResult = (result: SearchResult): void => {
  closeSearch();
  sounds.play('click', 0.2);
  void jumpToMessage(result.channelId, result.id);
};

/** Move the keyboard cursor; wraps around the list. */
export const moveSearchCursor = (delta: number): void => {
  const count = searchResults.value.length;
  if (count === 0) return;
  const current = searchActiveIndex.value;
  const next = current < 0 ? (delta > 0 ? 0 : count - 1) : (current + delta + count) % count;
  searchActiveIndex.value = next;
};
