import { api } from '@/services/socket/api';
import { sounds } from '@/services/sounds';
import { channelsById, defaultChannelId, markRead, pendingChannelId, previousChannelId, rememberSelection, selectedChannelId } from '@/state/channels';
import { isAuthenticated } from '@/state/session';
import { closeDrawers } from '@/state/ui';

/** Open a channel in the main area and subscribe to it on the server. */
export const selectChannel = (channelId: string): void => {
  const channel = channelsById.value.get(channelId);
  if (!channel) return;
  const changed = selectedChannelId.value !== channelId;
  rememberSelection(channelId);
  markRead(channelId);
  closeDrawers();
  api.joinChannel(channelId);
  if (changed) sounds.play('click', 0.2);
};

/**
 * Take a conversation out of the sidebar. The server keeps its history and brings it
 * back when a message arrives in it or we open it again. When it is the channel on
 * screen, go back to the one open before it first (else the default), so the main
 * area never shows a channel that is about to leave the list.
 */
export const closeConversation = (channelId: string): void => {
  if (selectedChannelId.value === channelId) {
    const previous = previousChannelId.value;
    const next = previous && previous !== channelId && channelsById.value.has(previous) ? previous : defaultChannelId(channelId);
    if (next) selectChannel(next);
    else rememberSelection(null);
  }
  api.closeDm(channelId);
};

/**
 * Open a channel now when we are signed in and it is listed; otherwise remember it and
 * let the next `auth:success` open it (deep links, notification clicks before sign-in).
 */
export const openChannelWhenListed = (channelId: string): void => {
  if (isAuthenticated.value && channelsById.value.has(channelId)) {
    selectChannel(channelId);
    return;
  }
  pendingChannelId.value = channelId;
};
