/**
 * A Bellwick lane client for the live test server. Next to the harness's lane (which can announce
 * Bellwick's codec too), this one keeps a client mirror (the core's `ClientWorld`) up to date from
 * WELCOME, KEYFRAME and FRAME, ACKs every frame, and can step its hero with buttons the way the device does.
 */
import WebSocket from 'ws';
import { ByteReader } from '../../../src/arcade/core/bytes.js';
import { createClientWorld, onFrame, onKeyframe, onWelcome, stepOwn, type ClientWorld } from '../../../src/arcade/core/bellwick/client.js';
import type { EventBlock } from '../../../src/arcade/core/net/lane.js';
import { readServer, S2C, writeAck, writeEvt, writeUp, writeVis, type ServerMsg } from '../../../src/arcade/core/net/lane.js';
import { CODEC, PROTO } from '../../../src/arcade/core/version.js';

const TYPE: Record<ServerMsg['t'], number> = {
  welcome: S2C.WELCOME,
  frame: S2C.FRAME,
  keyframe: S2C.KEYFRAME,
  beat: S2C.BEAT,
  pong: S2C.PONG,
  phase: S2C.PHASE,
  handover: S2C.HANDOVER,
  bye: S2C.BYE,
};

export interface BwLane {
  readonly ws: WebSocket;
  readonly received: readonly ServerMsg[];
  readonly mirror: ClientWorld;
  welcome: Extract<ServerMsg, { t: 'welcome' }> | null;
  next(type: number, timeoutMs?: number): Promise<ServerMsg>;
  closed(timeoutMs?: number): Promise<number>;
  sendEvt(p: Uint8Array): void;
  sendVis(state: number): void;
  /** One device tick of the own hero with these buttons (UPs and EVTs go out as it decides). */
  press(buttons: number): void;
  close(code?: number): void;
}

export const bwLane = (url: string, claim: string, o: { resume?: boolean; slot?: number } = {}): Promise<BwLane> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace('http', 'ws') + '/arcade/ws');
    ws.binaryType = 'nodebuffer';
    const received: ServerMsg[] = [];
    const consumed = new Set<ServerMsg>();
    const waiters: { type: number; resolve(m: ServerMsg): void }[] = [];
    const closeWaiters: ((code: number) => void)[] = [];
    let closeCode: number | null = null;
    let evSeq = 0;
    let upSeq = 0;
    let mirror = createClientWorld(o.slot ?? 0);
    const block: EventBlock = { count: 0, r: new ByteReader(new Uint8Array(0)), tick: 0 };
    const send = {
      up: (p: Uint8Array) => ws.readyState === WebSocket.OPEN && ws.send(writeUp((upSeq = (upSeq + 1) & 0xffff), 0, 0, p)),
      evt: (p: Uint8Array) => ws.readyState === WebSocket.OPEN && ws.send(writeEvt((evSeq = (evSeq + 1) & 0xffff), p)),
    };
    const lane: BwLane = {
      ws,
      received,
      get mirror() {
        return mirror;
      },
      welcome: null,
      next(type, timeoutMs = 3000) {
        const already = received.find((m) => !consumed.has(m) && TYPE[m.t] === type);
        if (already) {
          consumed.add(already);
          return Promise.resolve(already);
        }
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('timeout waiting for lane message ' + type)), timeoutMs);
          waiters.push({
            type,
            resolve: (m) => {
              clearTimeout(timer);
              consumed.add(m);
              res(m);
            },
          });
        });
      },
      closed: (timeoutMs = 3000) =>
        closeCode !== null
          ? Promise.resolve(closeCode)
          : new Promise((res, rej) => {
              const timer = setTimeout(() => rej(new Error('lane did not close')), timeoutMs);
              closeWaiters.push((code) => {
                clearTimeout(timer);
                res(code);
              });
            }),
      sendEvt: (p) => send.evt(p),
      sendVis: (state) => ws.readyState === WebSocket.OPEN && ws.send(writeVis(state)),
      press(buttons) {
        stepOwn(mirror, buttons, mirror.tick + 1, mirror.snapTick, send, 2);
      },
      close: (code = 1000) => ws.close(code),
    };
    ws.on('message', (data: Buffer) => {
      const msg = readServer(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
      if (!msg) return;
      received.push(msg);
      if (msg.t === 'welcome') {
        lane.welcome = msg;
        mirror = createClientWorld(msg.slot);
        onWelcome(mirror, msg.cfg);
      } else if (msg.t === 'keyframe') {
        onKeyframe(mirror, new ByteReader(msg.body), msg.tick);
        ws.send(writeAck(msg.frameSeq, 0));
      } else if (msg.t === 'frame') {
        let events: EventBlock | null = null;
        if (msg.events) {
          block.count = msg.events.count;
          block.r = new ByteReader(msg.events.bytes);
          block.tick = msg.tick;
          events = block;
        }
        onFrame(mirror, msg.tick, msg.snapshot ? new ByteReader(msg.snapshot) : null, events);
        ws.send(writeAck(msg.frameSeq, 0));
      }
      const i = waiters.findIndex((w) => w.type === TYPE[msg.t]);
      if (i !== -1) (waiters.splice(i, 1)[0] as { resolve(m: ServerMsg): void }).resolve(msg);
    });
    ws.on('close', (code: number) => {
      closeCode = code;
      for (const w of closeWaiters.splice(0)) w(code);
    });
    ws.on('error', () => undefined);
    ws.once('open', () => {
      ws.send(JSON.stringify({ t: 'hello', proto: PROTO, codec: { bellwick: CODEC.bellwick }, ...(o.resume ? { resume: claim } : { ticket: claim }) }));
      resolve(lane);
    });
    setTimeout(() => reject(new Error('lane did not open')), 3000);
  });
