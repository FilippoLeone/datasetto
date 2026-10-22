/**
 * The Arcade's table lane on the main socket (platform.md §4.2, §5.4).
 *
 * - Every event goes through handle() with a zod schema, the `arcade` limiter family and quiet
 *   refusals: acks are `{ok: true, …}` or `{ok: false, code}` and nothing is emitted on `error`.
 * - The paced emitter gives each socket a 3 KB/s token bucket with a 6 KB depth for Arcade pushes,
 *   with per-game queues (overflow policy, newest-wins coalescing, send-time stamping, queue-wait
 *   reports, optional sub-buckets). While the socket's engine.io writeBuffer holds anything (chat,
 *   signalling) Arcade pushes wait in 50 ms steps, so chat always goes first. Acks are never delayed
 *   but count against the bucket. Pushes go per socket, never through io.to().
 */
import { z } from 'zod';
import type { Server, Socket } from 'socket.io';
import type { AppContext } from '../context.js';
import { handle, requirePermission, type LimiterKind, type SocketContext } from '../socket/context.js';
import type { Clock } from './clock.js';
import { GAME_IDS, type GameId } from './core/version.js';
import { OVERHEAD } from './core/net/budget.js';
import type { CallerCtx, EmitOpts, QueuePolicy, TableApi } from './tables/types.js';

export const TABLE_BUCKET = { rateBps: 3000, depth: 6000 } as const;
export const WRITEBUFFER_DEFER_MS = 50;

const idSchema = z.string().min(1).max(64);
export const gameSchema = z.enum(GAME_IDS as [GameId, ...GameId[]]);

// ------------------------------------------------------------------ paced emitter

interface QueueItem {
  ev: string;
  data: unknown;
  opts: EmitOpts;
  at: number;
}

interface Bucket {
  tokens: number;
  last: number;
  rate: number;
  depth: number;
}

interface PacedSocket {
  socket: Socket;
  main: Bucket;
  subs: Map<string, Bucket>;
  queues: Map<'lamplight' | 'glimmer', QueueItem[]>;
  timer: unknown;
  rr: number;
}

export interface PacedEmitter {
  emit(socketId: string, ev: string, data: unknown, opts: EmitOpts): void;
  /** Count an ack's bytes against the socket's bucket (acks are never delayed). */
  chargeAck(socketId: string, data: unknown): void;
  policy(queue: 'lamplight' | 'glimmer', p: QueuePolicy): void;
  forget(socketId: string): void;
  /** Bytes queued for a socket (tests, diagnostics). */
  queued(socketId: string): number;
  stop(): void;
}

const sizeOf = (ev: string, data: unknown): number => {
  let json = '';
  try {
    json = JSON.stringify(data) ?? '';
  } catch {
    json = '';
  }
  return ev.length + json.length + OVERHEAD.tableDown;
};

const refill = (b: Bucket, now: number): void => {
  if (now > b.last) {
    b.tokens = Math.min(b.depth, b.tokens + ((now - b.last) * b.rate) / 1000);
    b.last = now;
  }
};

export const createPacedEmitter = (o: { io: Server; clock: Clock; onEgress(bytes: number): void; busy?(socket: Socket): boolean }): PacedEmitter => {
  const { clock } = o;
  const sockets = new Map<string, PacedSocket>();
  const policies = new Map<string, QueuePolicy>();

  const entry = (socketId: string): PacedSocket | null => {
    let s = sockets.get(socketId);
    if (s) return s;
    const socket = o.io.sockets.sockets.get(socketId);
    if (!socket) return null;
    s = { socket, main: { tokens: TABLE_BUCKET.depth, last: clock.now(), rate: TABLE_BUCKET.rateBps, depth: TABLE_BUCKET.depth }, subs: new Map(), queues: new Map(), timer: null, rr: 0 };
    sockets.set(socketId, s);
    return s;
  };

  const schedule = (s: PacedSocket, ms: number): void => {
    if (s.timer !== null) return;
    s.timer = clock.setTimeout(() => {
      s.timer = null;
      pump(s);
    }, Math.max(1, Math.ceil(ms)));
  };

  const writeBufferBusy = (socket: Socket): boolean => {
    if (o.busy) return o.busy(socket);
    const conn = socket.conn as unknown as { writeBuffer?: unknown[] };
    return Array.isArray(conn.writeBuffer) && conn.writeBuffer.length > 0;
  };

  const pump = (s: PacedSocket): void => {
    if (!s.socket.connected) {
      forget(s.socket.id);
      return;
    }
    const names = [...s.queues.keys()].filter((name) => (s.queues.get(name)?.length ?? 0) > 0);
    if (names.length === 0) return;
    if (writeBufferBusy(s.socket)) {
      schedule(s, WRITEBUFFER_DEFER_MS);
      return;
    }
    const now = clock.now();
    refill(s.main, now);
    for (let guard = 0; guard < 64; guard += 1) {
      const live = [...s.queues.entries()].filter(([, q]) => q.length > 0);
      if (live.length === 0) return;
      const [name, queue] = live[s.rr++ % live.length] as [string, QueueItem[]];
      const item = queue[0] as QueueItem;
      // Sized before stamping (a stamp only rewrites a few numbers); stamped once, as it leaves.
      const size = sizeOf(item.ev, item.data);
      if (s.main.tokens < Math.min(size, s.main.depth)) {
        schedule(s, ((Math.min(size, s.main.depth) - s.main.tokens) * 1000) / s.main.rate);
        return;
      }
      if (item.opts.sub) {
        let sub = s.subs.get(name);
        if (!sub) {
          sub = { tokens: item.opts.sub.depth, last: now, rate: item.opts.sub.rateBps, depth: item.opts.sub.depth };
          s.subs.set(name, sub);
        }
        refill(sub, now);
        if (sub.tokens < Math.min(size, sub.depth)) {
          schedule(s, ((Math.min(size, sub.depth) - sub.tokens) * 1000) / sub.rate);
          return;
        }
        sub.tokens -= size;
      }
      queue.shift();
      s.main.tokens -= size;
      const stamped = item.opts.stamp ? item.opts.stamp(item.data, now) : item.data;
      s.socket.emit(item.ev, stamped);
      o.onEgress(size);
      item.opts.onSent?.(now - item.at);
      if (writeBufferBusy(s.socket)) {
        schedule(s, WRITEBUFFER_DEFER_MS);
        return;
      }
    }
    schedule(s, 10);
  };

  const forget = (socketId: string): void => {
    const s = sockets.get(socketId);
    if (!s) return;
    if (s.timer !== null) clock.clearTimeout(s.timer);
    sockets.delete(socketId);
  };

  return {
    emit(socketId, ev, data, opts) {
      const s = entry(socketId);
      if (!s) return;
      let queue = s.queues.get(opts.queue);
      if (!queue) {
        queue = [];
        s.queues.set(opts.queue, queue);
      }
      const now = clock.now();
      if (opts.coalesce) {
        const index = queue.findIndex((item) => item.opts.coalesce === opts.coalesce);
        if (index !== -1) queue.splice(index, 1);
      }
      queue.push({ ev, data, opts, at: now });
      const policy = policies.get(opts.queue);
      if (policy && (queue.length > policy.maxEvents || now - (queue[0] as QueueItem).at > policy.maxAgeMs)) {
        const replacement = policy.onOverflow(socketId);
        queue.length = 0;
        if (replacement) queue.push({ ev: replacement.ev, data: replacement.data, opts: { queue: opts.queue }, at: now });
      }
      pump(s);
    },
    chargeAck(socketId, data) {
      const s = entry(socketId);
      if (!s) return;
      refill(s.main, clock.now());
      const size = sizeOf('', data);
      s.main.tokens -= size;
      o.onEgress(size);
    },
    policy(queue, p) {
      policies.set(queue, p);
    },
    forget,
    queued(socketId) {
      const s = sockets.get(socketId);
      if (!s) return 0;
      let n = 0;
      for (const q of s.queues.values()) n += q.length;
      return n;
    },
    stop() {
      for (const id of [...sockets.keys()]) forget(id);
    },
  };
};

// ------------------------------------------------------------------ registration

/** A table-lane event a table game registered through `TableApi.on`. */
export interface TableEvent {
  event: string;
  game: 'lamplight' | 'glimmer';
  schema: z.ZodType<unknown>;
  limiter: 'arcade' | 'arcadeAct' | 'spin';
  acked: boolean;
  voiceMember: boolean;
  fn: (c: CallerCtx, payload: unknown) => unknown | Promise<unknown>;
}

/** The platform's own events, implemented by index.ts and registered here per socket. */
export interface PlatformEvents {
  [event: string]: { schema: z.ZodType<unknown>; limiter?: LimiterKind; admin?: true; fn: (sctx: SocketContext, payload: unknown) => unknown | Promise<unknown> };
}

export interface HandlerDeps {
  app: AppContext;
  emitter: PacedEmitter;
  tableEvents(): readonly TableEvent[];
  platform: PlatformEvents;
  /** Is the game switched on and not hidden for this account? Returns a refusal code or null. */
  refuse(accountId: string, game: GameId): string | null;
}

export const callerOf = (sctx: SocketContext): CallerCtx | null =>
  sctx.user ? { accountId: sctx.user.accountId, socketId: sctx.socket.id, voiceChannelId: sctx.voiceChannel } : null;

export const registerArcadeHandlers = (sctx: SocketContext, deps: HandlerDeps): void => {
  const { emitter } = deps;
  const reply = (ack: ((r: unknown) => void) | null, value: unknown): void => {
    const body = value === undefined ? { ok: true } : value;
    if (ack) {
      emitter.chargeAck(sctx.socket.id, body);
      ack(body);
    }
  };

  for (const [event, spec] of Object.entries(deps.platform)) {
    handle(sctx, event, { schema: spec.schema, code: 'ARCADE', limiter: spec.limiter ?? 'arcade', refusal: 'arcade' }, async (payload, ack) => {
      if (spec.admin) requirePermission(sctx, 'canManageChannelPermissions', 'No permission to change Arcade settings');
      reply(ack, await spec.fn(sctx, payload));
    });
  }

  for (const t of deps.tableEvents()) {
    handle(sctx, t.event, { schema: t.schema, code: 'ARCADE', limiter: t.limiter, refusal: 'arcade' }, async (payload, ack) => {
      const c = callerOf(sctx);
      if (!c) {
        reply(ack, { ok: false, code: 'auth' });
        return;
      }
      const refused = deps.refuse(c.accountId, t.game);
      if (refused) {
        if (t.acked) reply(ack, { ok: false, code: refused });
        return;
      }
      if (t.voiceMember && !c.voiceChannelId) {
        if (t.acked) reply(ack, { ok: false, code: 'not-in-voice' });
        return;
      }
      const result = await t.fn(c, payload);
      if (t.acked) reply(ack, result);
    });
  }
};

/** Builds the `TableApi.on` registrar for one table game. */
export const tableRegistrar = (game: 'lamplight' | 'glimmer', into: TableEvent[]): TableApi['on'] => (event, opts, fn) => {
  if (!event.startsWith(game + ':')) throw new Error('arcade: ' + game + ' may only register ' + game + ':* events, not ' + event);
  into.push({ event, game, schema: opts.schema as z.ZodType<unknown>, limiter: opts.limiter, acked: opts.acked, voiceMember: opts.voiceMember ?? false, fn: fn as TableEvent['fn'] });
};

export { idSchema };
