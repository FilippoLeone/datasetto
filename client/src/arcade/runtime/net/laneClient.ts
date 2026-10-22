/**
 * The action lane's WebSocket client (docs/arcade/platform.md §4.1, §5.2, §6.2).
 *
 * - HELLO is the one text frame (ticket, or the resume token of the last WELCOME); everything after is
 *   binary. Ticks are extended to full ticks from WELCOME's u32 anchor before they are passed up.
 * - Frames: a KEYFRAME sets the expected frameSeq; a FRAME out of sequence sends RESYNC 0 and FRAMEs
 *   are dropped until the next KEYFRAME (also until the first one after a WELCOME).
 * - Cadence: 5 PINGs 200 ms apart, then one per 2 s. An ACK goes out when a frame arrived since the
 *   last ACK or UP and no UP went out in the last 250 ms (≈ 4 Hz while frames flow, none when they
 *   stop); while yielding (VIS 2) ACKs drop to 1 Hz and UPs stop. UP is newest-wins: skipped while
 *   more than 512 B wait in the socket. EVTs are kept (at most 64) and resent above WELCOME.lastEvSeq.
 * - Nothing received for 5 s (the server beats after 1 s of silence) closes and reconnects. Reconnects
 *   resume with the newest token; a 4401 on a resume falls back to a fresh ticket from `getTicket()`.
 *   Final: 1000, 1012, 4000, 4403, 4404, 4409, 4426, a 4401 on a ticket, and `getTicket()` → null.
 * - Timers exist only while the lane is open or reconnecting; `close()` sends VIS 3 and closes 1000.
 */
import { b64url, seqNewer } from '@arcade/core/bytes';
import { createTickClock } from '@arcade/core/net/clock';
import { CLOSE, RESYNC, VIS, extendTick, readServer, writeAck, writeEvt, writePing, writeResync, writeUp, writeVis, type ServerMsg, type Welcome } from '@arcade/core/net/lane';
import { CODEC, PROTO, type ActionGameId } from '@arcade/core/version';
import { runtimeUrls } from '@/lib/runtimeConfig';
import { createReconnectScheduler } from '@/services/socket/backoff';

type Msg<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;

export interface LaneEvents {
  welcome(w: Welcome): void;
  /** `tick` extended. Only in-sequence frames after a keyframe. */
  frame(m: Msg<'frame'>): void;
  /** `tick` extended. */
  keyframe(m: Msg<'keyframe'>): void;
  phase(m: Msg<'phase'>): void;
  handover(m: Msg<'handover'>): void;
  /** Every close; `reason` is the BYE text when one came. After a final one the lane is done. */
  closed(code: number, reason: string, final: boolean): void;
}

export interface LaneClient {
  sendUp(payload: Uint8Array, upSeq?: number): void;
  sendEvent(payload: Uint8Array): void;
  /** VIS state (0 live, 1 away, 2 yield); sent on change and again after every WELCOME. */
  setVis(state: number): void;
  /** Send RESYNC and drop FRAMEs until the next KEYFRAME. */
  resync(reason: number): void;
  readonly rttMs: number;
  serverTickAt(nowMs: number): number;
  close(): void;
}

const FINAL: readonly number[] = [CLOSE.left, CLOSE.restart, CLOSE.away, CLOSE.forbidden, CLOSE.gone, CLOSE.takenOver, CLOSE.update];
const DEAD_MS = 5000;
const MAX_EVENTS = 64;

/** `serverUrl` ('/' = this page's origin) as the lane's ws:// or wss:// URL. */
export const laneUrl = (serverUrl: string = runtimeUrls.serverUrl): string => {
  const u = new URL('/arcade/ws', serverUrl === '/' ? location.href : serverUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.href;
};

export const createLaneClient = (o: {
  game: ActionGameId;
  ticket: string;
  getTicket(): Promise<string | null>;
  on: LaneEvents;
  url?: string;
  now?(): number;
}): LaneClient => {
  const now = o.now ?? (() => performance.now());
  const clock = createTickClock();
  const events: { seq: number; msg: Uint8Array }[] = [];
  let ticket: string | null = o.ticket;
  let token: string | null = null;
  let ws: WebSocket | null = null;
  let viaTicket = false;
  let ready = false;
  let closed = false;
  let bye = '';
  let ref = 0;
  let expected = 0;
  let resyncing = true;
  let vis: number = VIS.live;
  let evSeq = 0;
  let upSeq = 0;
  let ackFrame = 0;
  let frameAt = 0;
  let ackPending = false;
  let lastAckAt = -Infinity;
  let lastUpAt = -Infinity;
  let lastRxAt = 0;
  let pings = 0;
  let pingTimer: ReturnType<typeof setTimeout> | undefined;
  let ackTimer: ReturnType<typeof setTimeout> | undefined;
  let deadTimer: ReturnType<typeof setTimeout> | undefined;

  const send = (b: Uint8Array): boolean => {
    if (!ready || !ws) return false;
    ws.send(b as Uint8Array<ArrayBuffer>);
    return true;
  };

  const teardown = (): void => {
    clearTimeout(pingTimer);
    clearTimeout(ackTimer);
    clearTimeout(deadTimer);
    pingTimer = ackTimer = deadTimer = undefined;
    if (ws) ws.onopen = ws.onmessage = ws.onclose = null;
    ws = null;
    ready = false;
    ackPending = false;
  };

  const dropped = (code: number, reason: string): void => {
    const usedTicket = viaTicket;
    teardown();
    if (closed) return;
    let final = FINAL.includes(code);
    if (code === CLOSE.ticket) {
      if (usedTicket) final = true;
      else token = null;
    }
    if (final) {
      closed = true;
      sched.stop();
    } else sched.schedule();
    o.on.closed(code, reason, final);
  };

  const armDead = (): void => {
    deadTimer = setTimeout(
      () => {
        if (now() - lastRxAt < DEAD_MS) return armDead();
        const s = ws;
        dropped(1006, 'no answer');
        // Not 1000: that would give up the seat.
        s?.close();
      },
      Math.max(0, lastRxAt + DEAD_MS - now()),
    );
  };

  const ping = (): void => {
    pingTimer = setTimeout(ping, ++pings < 5 ? 200 : 2000);
    send(writePing(now() >>> 0));
  };

  const maybeAck = (): void => {
    if (!ackPending || ackTimer !== undefined) return;
    const t = now();
    const due = Math.max(lastUpAt + 250, lastAckAt + (vis === VIS.yield ? 1000 : 250));
    if (t < due) {
      ackTimer = setTimeout(() => {
        ackTimer = undefined;
        maybeAck();
      }, due - t);
    } else if (send(writeAck(ackFrame, t - frameAt))) {
      lastAckAt = t;
      ackPending = false;
    }
  };

  const gotFrame = (m: Msg<'frame'> | Msg<'keyframe'>): void => {
    ackFrame = m.frameSeq;
    frameAt = now();
    ackPending = true;
    m.tick = ref = extendTick(m.tick, ref);
    maybeAck();
  };

  const resync = (reason: number): void => {
    if (resyncing) return;
    resyncing = true;
    send(writeResync(reason));
  };

  const onMessage = (data: unknown): void => {
    lastRxAt = now();
    if (typeof data === 'string') return;
    const m = readServer(new Uint8Array(data as ArrayBuffer));
    if (!m) return;
    switch (m.t) {
      case 'welcome': {
        ready = true;
        token = b64url(m.resumeToken);
        ref = m.tick;
        resyncing = true;
        sched.connected();
        for (let i = events.length - 1; i >= 0; i -= 1) if (!seqNewer((events[i] as { seq: number }).seq, m.lastEvSeq)) events.splice(i, 1);
        o.on.welcome(m);
        if (vis !== VIS.live) send(writeVis(vis));
        for (const e of events) send(e.msg);
        pings = 0;
        clearTimeout(pingTimer);
        ping();
        break;
      }
      case 'keyframe':
        gotFrame(m);
        expected = (m.frameSeq + 1) & 0xffff;
        resyncing = false;
        o.on.keyframe(m);
        break;
      case 'frame':
        gotFrame(m);
        if (resyncing) break;
        if (m.frameSeq !== expected) {
          resync(RESYNC.gap);
          break;
        }
        expected = (m.frameSeq + 1) & 0xffff;
        o.on.frame(m);
        break;
      case 'beat':
        ref = extendTick(m.tick, ref);
        break;
      case 'pong': {
        const t = now();
        clock.onPong(t - (((t >>> 0) - m.clientMs) >>> 0), t, m.serverTick, m.phaseUs);
        ref = m.serverTick;
        break;
      }
      case 'phase':
        o.on.phase(m);
        break;
      case 'handover':
        o.on.handover(m);
        break;
      case 'bye':
        bye = m.reason;
    }
  };

  const open = (hello: { ticket: string } | { resume: string }, usedTicket: boolean): void => {
    viaTicket = usedTicket;
    bye = '';
    const s = new WebSocket(o.url ?? laneUrl());
    ws = s;
    s.binaryType = 'arraybuffer';
    s.onopen = () => s.send(JSON.stringify({ t: 'hello', proto: PROTO, codec: { [o.game]: CODEC[o.game] }, ...hello }));
    s.onmessage = (e: MessageEvent) => onMessage(e.data);
    s.onclose = (e: CloseEvent) => dropped(e.code, bye || e.reason);
    lastRxAt = now();
    armDead();
  };

  const connect = (): void => {
    if (closed || ws) return;
    if (token) return open({ resume: token }, false);
    const t = ticket;
    ticket = null;
    if (t) return open({ ticket: t }, true);
    o.getTicket().then(
      (fresh) => {
        if (closed) return;
        if (fresh) open({ ticket: fresh }, true);
        else {
          closed = true;
          sched.stop();
          o.on.closed(CLOSE.ticket, 'no ticket', true);
        }
      },
      () => {
        if (!closed) sched.schedule();
      },
    );
  };

  const sched = createReconnectScheduler({ connect, backoff: { baseMs: 500, maxMs: 4000 } });
  connect();

  return {
    sendUp(payload, seq) {
      upSeq = seq !== undefined ? seq & 0xffff : (upSeq + 1) & 0xffff;
      if (!ws || vis === VIS.yield || ws.bufferedAmount > 512) return;
      const t = now();
      if (send(writeUp(upSeq, ackFrame, t - frameAt, payload))) {
        lastUpAt = t;
        ackPending = false;
      }
    },
    sendEvent(payload) {
      if (closed) return;
      evSeq = (evSeq % 0xffff) + 1;
      const msg = writeEvt(evSeq, payload);
      events.push({ seq: evSeq, msg });
      if (events.length > MAX_EVENTS) events.shift();
      send(msg);
    },
    setVis(state) {
      if (state === vis) return;
      vis = state;
      send(writeVis(state));
    },
    resync,
    get rttMs() {
      return clock.rttMs;
    },
    serverTickAt: (n) => (clock.ready ? clock.serverTickAt(n) : ref),
    close() {
      if (closed) return;
      closed = true;
      const s = ws;
      send(writeVis(VIS.leaving));
      teardown();
      s?.close(1000);
      sched.stop();
      events.length = 0;
    },
  };
};
