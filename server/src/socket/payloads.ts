import type { AppContext } from '../context.js';
import type { AccessSubject } from '../services/channels.js';

/** `channels:update` body for one user: the channels they may view, plus the groups. */
export const channelsPayload = (ctx: AppContext, subject: AccessSubject) => ({
  channels: ctx.channels
    .list()
    .filter((channel) => ctx.channels.canAccess(channel, subject, 'view'))
    .map((channel) => ctx.presence.channelView(channel)),
  groups: ctx.channels.listGroups(),
});
