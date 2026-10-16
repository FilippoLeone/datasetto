import { api } from '@/services/socket/api';
import { sounds } from '@/services/sounds';
import { channelsById, markRead, pendingChannelId, rememberSelection, selectedChannelId } from '@/state/channels';
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
