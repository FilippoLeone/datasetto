/**
 * Offline hosts (platform.md §12, plan.md §1.3 #3). The device simply has authority: the same pure
 * core the server runs is stepped here, so a game module has one code path online and offline.
 *
 * `createLocalMatchHost` steps a `CoreMatch` on the shared frame scheduler (at most 4 steps per frame,
 * the backlog dropped after a stall) and delivers one FRAME per tick with divisor 1 (interpolation
 * delay 0). Hidden means paused: `setVisible(false)` unsubscribes from frames. Host events are drained
 * after every step: phases go out after that tick's events, applied seat changes become SeatState
 * events, a rekey for this player sends a KEYFRAME for its new view, and `end` stops the match and
 * reports `onClosed(1000, reason)`. A chunk that wants `persist` (Bellwick saves) wraps its core's
 * `takeHostEvents` before handing it over.
 *
 * `createLocalTableHost` wraps a game's `LocalTableServer` (offline poker or slots) as a TableHost.
 */
import { ByteReader } from '@arcade/core/bytes';
import { PEV, SEAT_STATE } from '@arcade/core/net/events';
import { PROTO } from '@arcade/core/version';
import { KEY_REASON, RESUME_TOKEN_BYTES, TICK_HZ, TICK_MS, type EventBlock, type FrameView, type KeyframeView, type PhaseView, type Welcome } from '@arcade/core/net/lane';
import type { CoreMatch, HostEvent, RecipientView } from '@arcade/core/net/match';
import { frames } from '../p0';
import type { LocalTableServer, MatchHost, SeatInfo, TableHost } from '../types';

const MAX_STEPS = 4;

type Cb<T> = ((v: T) => void) | null;

export const createLocalMatchHost = (core: CoreMatch, a: { selfSlot: number; seats: readonly SeatInfo[] }): MatchHost => {
  const recipient: RecipientView = { slot: a.selfSlot, view: 0 };
  let onWelcome: Cb<Welcome> = null;
  let onFrame: Cb<FrameView> = null;
  let onKeyframe: Cb<KeyframeView> = null;
  let onPhase: Cb<PhaseView> = null;
  let onClosed: ((code: number, reason: string) => void) | null = null;
  const seatListeners = new Set<(seats: readonly SeatInfo[]) => void>();

  let started = false;
  let ended = false;
  let closed = false;
  let visible = true;
  let unsubscribe: (() => void) | null = null;
  let acc = 0;
  let frameSeq = 0;
  let upCounter = 0;

  const nextSeq = (): number => {
    frameSeq = (frameSeq + 1) & 0xffff;
    return frameSeq;
  };

  const sendKeyframe = (reason: number): void => {
    const body = core.keyframeFor(recipient);
    onKeyframe?.({ frameSeq: nextSeq(), tick: core.tick, ackUp: core.ackUp(a.selfSlot), reason, body: new ByteReader(body) });
  };

  const start = (): void => {
    started = true;
    onWelcome?.({
      proto: PROTO,
      game: 0,
      codec: 0,
      slot: a.selfSlot,
      queued: false,
      tick: core.tick,
      tickHz: TICK_HZ,
      divisor: 2,
      lastEvSeq: 0,
      resumeToken: new Uint8Array(RESUME_TOKEN_BYTES),
      cfg: core.welcomeCfg(),
    });
    sendKeyframe(KEY_REASON.join);
  };

  const seatCode = (state: 'live' | 'ghost' | 'bot' | 'left'): number => SEAT_STATE[state];

  const tick = (): void => {
    core.step();
    const chunk = core.takeEvents(recipient);
    const snapshot = core.snapshotFor(recipient);
    const hostEvents: readonly HostEvent[] = core.takeHostEvents();

    const seatEvents = hostEvents.filter((e): e is Extract<HostEvent, { t: 'seat' }> => e.t === 'seat');
    let events: EventBlock | null = null;
    const count = (chunk?.count ?? 0) + seatEvents.length;
    if (count > 0) {
      const gameBytes = chunk?.bytes ?? new Uint8Array(0);
      const bytes = new Uint8Array(gameBytes.length + seatEvents.length * 3);
      bytes.set(gameBytes, 0);
      let o = gameBytes.length;
      for (const e of seatEvents) {
        bytes[o++] = PEV.SeatState;
        bytes[o++] = e.slot;
        bytes[o++] = seatCode(e.state);
      }
      events = { count, r: new ByteReader(bytes), tick: core.tick };
    }
    onFrame?.({
      local: true,
      frameSeq: nextSeq(),
      tick: core.tick,
      ackUp: core.ackUp(a.selfSlot),
      divisor: 1,
      lagging: false,
      snapshot: snapshot ? new ByteReader(snapshot) : null,
      events,
    });

    for (const e of hostEvents) {
      if (e.t === 'phase') onPhase?.({ phase: e.phase, reason: e.reason, body: new ByteReader(e.body) });
      else if (e.t === 'rekey' && e.slot === a.selfSlot) {
        recipient.view = e.view;
        sendKeyframe(e.reason);
      } else if (e.t === 'end') {
        ended = true;
        stop();
        onClosed?.(1000, e.reason);
        return;
      }
    }
  };

  const onFrameTick = (_now: number, dt: number): void => {
    if (!started) {
      start();
      return;
    }
    acc += Math.min(dt, 250);
    let steps = 0;
    while (acc >= TICK_MS && steps < MAX_STEPS && !ended) {
      tick();
      acc -= TICK_MS;
      steps += 1;
    }
    if (acc >= TICK_MS) acc = 0;
  };

  const run = (): void => {
    if (closed || ended || !visible || unsubscribe) return;
    unsubscribe = frames.add(onFrameTick, { maxFps: 60, label: 'arcade-local-host' });
  };

  const stop = (): void => {
    unsubscribe?.();
    unsubscribe = null;
    acc = 0;
  };

  run();

  return {
    mode: 'local',
    sendUp(payload, upSeq) {
      if (closed) return;
      upCounter = upSeq !== undefined ? upSeq & 0xffff : (upCounter + 1) & 0xffff;
      // Applied on arrival, as the server does; the core queues inputs for its next step.
      core.onUp(a.selfSlot, payload.slice(), upCounter);
    },
    sendEvent(payload) {
      if (!closed) core.onEvent(a.selfSlot, payload.slice());
    },
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
    onHandover() {
      // Never: an offline match does not hand over.
    },
    onSeats(cb) {
      seatListeners.add(cb);
      cb(a.seats);
      return () => seatListeners.delete(cb);
    },
    onClosed(cb) {
      onClosed = cb;
    },
    setVisible(v) {
      visible = v;
      if (v) run();
      else stop();
    },
    rttMs: () => 0,
    linkConstrained: () => false,
    estServerTick: () => core.tick + acc / TICK_MS,
    close() {
      closed = true;
      stop();
      seatListeners.clear();
      onWelcome = onFrame = onKeyframe = onPhase = null;
      onClosed = null;
    },
  };
};

export const createLocalTableHost = (server: LocalTableServer): TableHost => {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  let closed = false;
  server.attach((ev, data) => {
    if (closed) return;
    const set = listeners.get(ev);
    if (!set) return;
    for (const cb of Array.from(set)) cb(data);
  });
  return {
    mode: 'local',
    request: <T>(ev: string, data: unknown) => (closed ? Promise.reject(new Error('closed')) : (server.request(ev, data) as Promise<T>)),
    on(ev, cb) {
      let set = listeners.get(ev);
      if (!set) {
        set = new Set();
        listeners.set(ev, set);
      }
      set.add(cb);
      return () => {
        set?.delete(cb);
      };
    },
    connected: () => !closed,
    onConnection: () => () => undefined,
    ackRttMs: () => 0,
    setVisible: (v) => server.setVisible(v),
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      server.dispose();
    },
  };
};
