import { api } from '@/services/socket/api';
import { sounds } from '@/services/sounds';
import { channelsById, markRead, rememberSelection, selectedChannelId } from '@/state/channels';
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
