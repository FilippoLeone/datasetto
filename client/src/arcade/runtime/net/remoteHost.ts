/**
 * Online hosts (docs/arcade/platform.md §4, §6.4, §9.4).
 *
 * `createRemoteMatchHost` wraps the action lane (laneClient.ts) and builds the views games read.
 * Games must consume a FRAME's whole event block and a KEYFRAME's whole body inside the callback:
 * anything left over, or a read past the end, sends RESYNC 1 (decode error) and brings a keyframe.
 * `onClosed` reports only final closes (the lane retries the rest itself). While the lane is open the
 * "chat first" guard runs: when it yields the host sends VIS 2, stops UP and tells `onYield`.
 *
 * `createRemoteTableHost` is the app socket (the table lane) with the game's listeners tracked, so
 * `close()` removes them all. Table games send their own away events; `setVisible` only records.
 */
import { effect, untracked } from '@preact/signals';
import { ByteReader } from '@arcade/core/bytes';
import { RESYNC, VIS, type FrameView, type KeyframeView, type PhaseView, type Welcome } from '@arcade/core/net/lane';
import type { ActionGameId, TableGameId } from '@arcade/core/version';
import { arcadeLobby } from '@/features/arcade/state';
import { socketClient } from '@/services/socket/client';
import { users } from '@/state/presence';
import { connectionStatus } from '@/state/session';
import { createChatFirstGuard, type ChatFirstGuard } from '../chatFirst';
import { linkConstrained } from '../p0';
import type { MatchHost, SeatInfo, TableHost } from '../types';
import { createLaneClient } from './laneClient';

export interface RemoteMatchHost extends MatchHost {
  /** "Chat first" (§6.4): true while the lane yields to chat and voice, false when it resumes. */
  onYield(cb: (yielding: boolean) => void): () => void;
}

export interface RemoteTableHost extends TableHost {
  readonly visible: boolean;
}

type Cb<T> = ((v: T) => void) | null;

const spent = (r: ByteReader): boolean => r.ok && r.remaining === 0;

const inflate = async (body: Uint8Array): Promise<Uint8Array> => {
  const stream = (new Response(body.slice()).body as ReadableStream<Uint8Array<ArrayBuffer>>).pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

export const createRemoteMatchHost = (a: { lobbyId: string; ticket: string; game: ActionGameId }): RemoteMatchHost => {
  let onWelcome: Cb<Welcome> = null;
  let onFrame: Cb<FrameView> = null;
  let onKeyframe: Cb<KeyframeView> = null;
  let onPhase: Cb<PhaseView> = null;
  let onHandover: ((body: Uint8Array, simVersion: number) => void) | null = null;
  let onClosed: ((code: number, reason: string) => void) | null = null;
  const yieldCbs = new Set<(yielding: boolean) => void>();
  const offs = new Set<() => void>();
  let guard: ChatFirstGuard | null = null;
  let handover: Promise<void> | null = null;
  let visible = true;
  let yielding = false;
  let closed = false;

  const sendVis = (): void => lane.setVis(yielding ? VIS.yield : visible ? VIS.live : VIS.away);
  const setYield = (y: boolean): void => {
    if (y === yielding) return;
    yielding = y;
    sendVis();
    yieldCbs.forEach((cb) => cb(y));
  };

  const lane = createLaneClient({
    game: a.game,
    ticket: a.ticket,
    getTicket: () =>
      socketClient.request<{ ok?: boolean; ticket?: string } | null>('arcade:ticket', { id: a.lobbyId }).then((r) => (r?.ok && typeof r.ticket === 'string' ? r.ticket : null)),
    on: {
      welcome(w) {
        guard ??= createChatFirstGuard({
          probe: () => {
            const t = performance.now();
            return socketClient.request('arcade:probe', {}, 3000).then(() => performance.now() - t);
          },
          onAck: (cb) => socketClient.onAck(cb),
          lastRequestAt: () => socketClient.lastRequestAt(),
          onYield: setYield,
        });
        onWelcome?.(w);
      },
      frame(m) {
        if (!onFrame) return;
        const events = m.events ? { count: m.events.count, r: new ByteReader(m.events.bytes), tick: m.tick } : null;
        const snapshot = m.snapshot ? new ByteReader(m.snapshot) : null;
        onFrame({ local: false, frameSeq: m.frameSeq, tick: m.tick, ackUp: m.ackUp, divisor: m.divisor, lagging: m.lagging, snapshot, events });
        if (events && !spent(events.r)) lane.resync(RESYNC.decode);
      },
      keyframe(m) {
        if (!onKeyframe) return;
        const body = new ByteReader(m.body);
        onKeyframe({ frameSeq: m.frameSeq, tick: m.tick, ackUp: m.ackUp, reason: m.reason, body });
        if (!spent(body)) lane.resync(RESYNC.decode);
      },
      phase(m) {
        onPhase?.({ phase: m.phase, reason: m.reason, body: new ByteReader(m.body) });
      },
      handover(m) {
        if (!onHandover || typeof DecompressionStream === 'undefined') return;
        handover = inflate(m.body).then(
          (body) => {
            if (!closed) onHandover?.(body, m.simVersion);
          },
          () => undefined,
        );
      },
      closed(code, reason, final) {
        guard?.dispose();
        guard = null;
        setYield(false);
        if (!final) return;
        // The handover the server sent just before closing reaches the game first.
        const report = (): void => {
          if (!closed) onClosed?.(code, reason);
        };
        if (handover) void handover.then(report);
        else report();
      },
    },
  });

  return {
    mode: 'remote',
    sendUp: (payload, upSeq) => lane.sendUp(payload, upSeq),
    sendEvent: (payload) => lane.sendEvent(payload),
    onWelcome(cb) {
      onWelcome = cb;
    },
    onFrame(cb) {
      onFrame = cb;
    },
    onKeyframe(cb) {
      onKeyframe = cb;
    },
    onPhase(cb) {
      onPhase = cb;
    },
    onHandover(cb) {
      onHandover = cb;
    },
    onSeats(cb) {
      let last: string | null = null;
      const dispose = effect(() => {
        const lobby = arcadeLobby.value;
        const names = new Map<string, string>();
        for (const u of users.value) names.set(u.accountId, u.displayName);
        const seats: SeatInfo[] =
          lobby?.id === a.lobbyId
            ? lobby.seats.map((s, i) => ({ slot: i, accountId: s.a, name: s.bot ? 'Bot ' + i : s.a ? (names.get(s.a) ?? 'Player') : '', bot: s.bot, joinOrder: i, extra: 0 }))
            : [];
        const key = seats.map((s) => s.accountId + '\u0001' + s.name + '\u0001' + s.bot).join('\u0002');
        if (key === last) return;
        last = key;
        untracked(() => cb(seats));
      });
      offs.add(dispose);
      return () => {
        dispose();
        offs.delete(dispose);
      };
    },
    onClosed(cb) {
      onClosed = cb;
    },
    onYield(cb) {
      yieldCbs.add(cb);
      return () => yieldCbs.delete(cb);
    },
    setVisible(v) {
      visible = v;
      sendVis();
    },
    rttMs: () => lane.rttMs,
    linkConstrained: () => linkConstrained.peek(),
    estServerTick: (nowMs) => lane.serverTickAt(nowMs),
    close() {
      if (closed) return;
      closed = true;
      guard?.dispose();
      guard = null;
      lane.close();
      offs.forEach((off) => off());
      offs.clear();
      yieldCbs.clear();
      onWelcome = onFrame = onKeyframe = onPhase = null;
      onHandover = onClosed = null;
    },
  };
};

export const createRemoteTableHost = (_game: TableGameId): RemoteTableHost => {
  const offs = new Set<() => void>();
  const track = (off: () => void): (() => void) => {
    offs.add(off);
    return () => {
      off();
      offs.delete(off);
    };
  };
  let visible = true;
  return {
    mode: 'remote',
    request: <T>(ev: string, data: unknown, opts?: { timeoutMs?: number }) => socketClient.request<T>(ev, data, opts?.timeoutMs ?? 8000),
    on: (ev, cb) => track(socketClient.on(ev, cb)),
    connected: () => socketClient.connected,
    onConnection(cb) {
      let last: boolean | null = null;
      return track(
        connectionStatus.subscribe((s) => {
          const up = s === 'connected';
          if (up !== last) {
            last = up;
            cb(up);
          }
        }),
      );
    },
    ackRttMs: () => socketClient.ackRtt(),
    get visible() {
      return visible;
    },
    setVisible(v) {
      visible = v;
    },
    close() {
      offs.forEach((off) => off());
      offs.clear();
    },
  };
};
