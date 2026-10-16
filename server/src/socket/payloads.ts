import type { AppContext } from '../context.js';

/** `channels:update` body: live channel views plus their groups. */
export const channelsPayload = (ctx: AppContext) => ({
  channels: ctx.channels.list().map((channel) => ctx.presence.channelView(channel)),
  groups: ctx.channels.listGroups(),
});
