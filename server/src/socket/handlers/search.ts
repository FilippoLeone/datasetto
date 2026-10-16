import { z } from 'zod';
import { optionalIdSchema } from '../../core/validation.js';
import { forbidden, notFound } from '../../errors.js';
import { MAX_SEARCH_QUERY_LENGTH, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, SEARCH_MAX_OFFSET } from '../../services/search.js';
import type { ChannelRecord, ChannelType } from '../../types.js';
import { handle, requireUser, type SocketContext } from '../context.js';

/** Channel kinds that carry chat history. */
const SEARCHABLE_TYPES: ReadonlySet<ChannelType> = new Set<ChannelType>(['text', 'stream', 'dm']);

const searchSchema = z.object({
  query: z.string().max(MAX_SEARCH_QUERY_LENGTH, `Search text must be ${MAX_SEARCH_QUERY_LENGTH} characters or less`),
  channelId: optionalIdSchema.optional(),
  authorId: optionalIdSchema.optional(),
  limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).optional().nullable(),
  offset: z.number().int().min(0).max(SEARCH_MAX_OFFSET).optional().nullable(),
});

export const registerSearchHandlers = (sctx: SocketContext): void => {
  const { app, socket } = sctx;

  /**
   * `search {query, channelId?, authorId?, limit?, offset?}`: full-text search over
   * the channels the caller may view (public ones, private ones they belong to,
   * their own conversations). Answers through the acknowledgement when one is
   * given, else with `search:results`.
   */
  handle(sctx, 'search', { schema: searchSchema, code: 'SEARCH_FAILED', limiter: 'search' }, (payload, ack) => {
    const user = requireUser(sctx);
    const viewable = app.channels.list().filter((channel) => SEARCHABLE_TYPES.has(channel.type) && app.channels.canAccess(channel, user, 'view'));

    let scope: ChannelRecord[] = viewable;
    if (payload.channelId) {
      const channel = app.channels.get(payload.channelId);
      if (!channel) throw notFound('Channel');
      if (!viewable.some((entry) => entry.id === channel.id)) throw forbidden('No permission to access this channel');
      scope = [channel];
    }

    const limit = payload.limit ?? SEARCH_DEFAULT_LIMIT;
    const offset = payload.offset ?? 0;
    const page = app.search.search({
      query: payload.query,
      channelIds: scope.map((channel) => channel.id),
      authorId: payload.authorId ?? null,
      limit,
      offset,
    });
    const byId = new Map(scope.map((channel) => [channel.id, channel]));
    const response = {
      success: true as const,
      query: payload.query,
      results: page.results.map((hit) => {
        const channel = byId.get(hit.channelId);
        return { ...hit, channelName: channel?.name ?? '', channelType: channel?.type ?? 'text' };
      }),
      total: page.total,
      hasMore: page.hasMore,
      limit,
      offset,
    };
    if (ack) ack(response);
    else socket.emit('search:results', response);
  });
};
