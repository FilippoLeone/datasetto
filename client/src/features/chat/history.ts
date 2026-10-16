import { effect } from '@preact/signals';
import { selectChannel } from '@/features/channels/channelActions';
import { api } from '@/services/socket/api';
import { channelsById, selectedChannelId } from '@/state/channels';
import {
  highlightedMessageId,
  historyExhausted,
  historyLoading,
  historyVersion,
  messages,
  prependMessages,
  scrollTarget,
  setHistoryExhausted,
  setHistoryLoading,
} from '@/state/chat';
import { closeDrawers, toast } from '@/state/ui';

/** Older messages fetched per request while the user scrolls up. */
const SCROLL_PAGE = 50;
/** Bigger pages while jumping to a message so old hits need few round trips. */
const JUMP_PAGE = 200;
/** A jump gives up after this many pages (the server keeps 2000 messages per channel by default). */
const MAX_JUMP_PAGES = 20;
const HISTORY_TIMEOUT_MS = 5000;

const inFlight = new Map<string, Promise<boolean>>();

/**
 * Fetch the page before the oldest loaded message and put it in front.
 * Resolves true when something was added. One request per channel at a time;
 * a second caller shares the pending one.
 */
export const loadOlderMessages = (channelId: string, limit = SCROLL_PAGE): Promise<boolean> => {
  const pending = inFlight.get(channelId);
  if (pending) return pending;
  const oldest = messages.value[channelId]?.[0];
  if (!oldest || historyExhausted.value[channelId]) return Promise.resolve(false);

  const run = (async () => {
    setHistoryLoading(channelId, true);
    try {
      const response = await api.loadOlderMessages(channelId, oldest.id, limit);
      if (!response.success) {
        if (response.code !== 'RATE_LIMITED') toast.error(response.error || 'Could not load older messages');
        return false;
      }
      const page = response.messages ?? [];
      prependMessages(channelId, page);
      if (!response.hasMore) setHistoryExhausted(channelId, true);
      return page.length > 0;
    } catch {
      toast.error('Could not load older messages');
      return false;
    } finally {
      setHistoryLoading(channelId, false);
      inFlight.delete(channelId);
    }
  })();
  inFlight.set(channelId, run);
  return run;
};

export const isLoadingOlder = (channelId: string): boolean => historyLoading.value[channelId] ?? false;

const FLASH_MS = 2500;
let flashTimer = 0;

/** Light a message up for a moment (after a jump). */
export const flashMessage = (messageId: string): void => {
  highlightedMessageId.value = messageId;
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    if (highlightedMessageId.value === messageId) highlightedMessageId.value = null;
  }, FLASH_MS);
};

/** Resolves once a new `chat:history` for the channel has replaced the list (or after a timeout). */
const waitForHistory = (channelId: string, previousVersion: number): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    let stop: (() => void) | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      stop?.();
      resolve();
    };
    const timer = window.setTimeout(finish, HISTORY_TIMEOUT_MS);
    stop = effect(() => {
      if ((historyVersion.value[channelId] ?? 0) !== previousVersion) finish();
    });
    if (done) stop();
  });

let jumpCounter = 0;

/**
 * Open a channel at one of its messages: select the channel, wait for its
 * history, load older pages until the message is there, then ask the list to
 * scroll to it (state/chat `scrollTarget`, consumed by MessageList). A newer
 * jump cancels an older one that is still loading.
 */
export const jumpToMessage = async (channelId: string, messageId: string): Promise<void> => {
  const token = (jumpCounter += 1);
  if (!channelsById.value.has(channelId)) {
    toast.error('That channel is not available any more');
    return;
  }
  scrollTarget.value = null;
  if (selectedChannelId.value !== channelId) {
    const version = historyVersion.value[channelId] ?? 0;
    selectChannel(channelId);
    await waitForHistory(channelId, version);
  } else {
    closeDrawers();
  }

  for (let page = 0; page <= MAX_JUMP_PAGES; page += 1) {
    if (token !== jumpCounter) return;
    if (messages.value[channelId]?.some((message) => message.id === messageId)) {
      scrollTarget.value = { channelId, messageId };
      return;
    }
    if (page === MAX_JUMP_PAGES || historyExhausted.value[channelId]) break;
    const loaded = await loadOlderMessages(channelId, JUMP_PAGE);
    if (!loaded) break;
  }
  if (token === jumpCounter) toast.info('That message is not available any more');
};
