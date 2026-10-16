import type { AppContext } from '../context.js';
import type { AccessSubject } from '../services/channels.js';
import type { ChannelView } from '../types.js';

/** A channel as one user sees it: live counters plus, for a DM, who the other person is. */
export const channelViewFor = (ctx: AppContext, channelId: string, subject: AccessSubject): ChannelView | null => {
  const channel = ctx.channels.get(channelId);
  if (!channel) return null;
  const view = ctx.presence.channelView(channel, ctx.channels.memberCount(channel.id));
  if (channel.type !== 'dm') return view;
  const peerId = ctx.channels.listMemberIds(channel.id).find((id) => id !== subject.accountId) ?? null;
  const peer = peerId ? ctx.accounts.getById(peerId) : null;
  return {
    ...view,
    dm: peer
      ? { peerId: peer.id, peerName: peer.displayName, peerUsername: peer.username, peerAvatarUrl: peer.avatarUrl }
      : { peerId: peerId ?? '', peerName: 'Deleted user', peerUsername: '', peerAvatarUrl: null },
  };
};

/** `channels:update` body for one user: the channels they may view, plus the groups. */
export const channelsPayload = (ctx: AppContext, subject: AccessSubject) => ({
  channels: ctx.channels
    .list()
    .filter((channel) => ctx.channels.canAccess(channel, subject, 'view'))
    .map((channel) => channelViewFor(ctx, channel.id, subject))
    .filter((view): view is ChannelView => view !== null),
  groups: ctx.channels.listGroups(),
});
