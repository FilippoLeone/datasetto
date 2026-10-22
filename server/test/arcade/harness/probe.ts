/**
 * The probe runtime (plan.md §2.6.5): a pure `CoreMatch` shaped like an action game, wrapped with
 * `wrapCore`, for the delta-base fuzz and the lossy-link simulator.
 *
 * - **Snapshot.** An absolute body of `snapshotBytes` per view, Fuseyard's layout: `u8 n, n × {u8 flags,
 *   u16 x, u16 y}, u8 m (0)`, padded to size (22 B with 4 fighters). Fighters walk in seeded bursts, so
 *   the snapshot sometimes stays unchanged. The buffer is shared and rewritten by every `step()`, as the
 *   CoreMatch contract allows.
 * - **Events.** About `eventBytesPerTick` bytes of game events per tick, kinds and lengths varying
 *   (kind byte included): Spawn 8 B, Despawn 3 B, Bump 2 B, Set 4 B, Move 7 B. The event buffer is shared
 *   per tick too.
 * - **Public world.** A u32 counter, the seat states and up to 40 entities. Every event changes it, so a
 *   client that applies a keyframe plus the events after it can be compared with `keyframeFor(view)`.
 *   It starts with 24 entities; the keyframe carries the world plus a fixed 96 B "arena" (≈ 300 B
 *   typical, ≤ 431 B).
 * - **Host events.** `rekey` (reason 5), `phase` and `seat` events at seeded random ticks when the
 *   options ask for them, or exactly when scripted with `script()`. `setSeat` applies at the next step.
 * - `step()` allocates nothing unless a host event is due. Everything is seeded (xorshift32).
 */
import { ByteReader, ByteWriter } from '../../../src/arcade/core/bytes.js';
import { forEachEvent } from '../../../src/arcade/core/net/events.js';
import type { EventChunk, HostEvent, RecipientView, SeatCmd } from '../../../src/arcade/core/net/match.js';
import { xorshift32 } from '../../../src/arcade/core/rng.js';
import type { MatchRuntime } from '../../../src/arcade/rooms/types.js';
import { wrapCore } from '../../../src/arcade/rooms/wrap.js';

export interface ProbeOptions {
  snapshotBytes: number;
  eventBytesPerTick: number;
  players: number;
  seed?: number;
  /** Mean ticks between scripted rekeys (reason 5, a random seat); 0 or absent: never. */
  rekeyEvery?: number;
  /** Mean ticks between phase changes (running ⇄ paused); 0 or absent: never. */
  phaseEvery?: number;
  /** Mean ticks between seat-state changes (live ⇄ ghost); 0 or absent: never. */
  seatEvery?: number;
}

export interface ProbeRuntime extends MatchRuntime {
  /** Emit `e` from the next `step()` (a `seat` event is also applied to the world then). */
  script(e: HostEvent): void;
  /** The public world as the server holds it. */
  world(): ProbeWorld;
}

export const PROBE_EV = { spawn: 0x01, despawn: 0x02, bump: 0x03, set: 0x04, move: 0x05 } as const;
const EV_SIZE = [0, 8, 3, 2, 4, 7] as const;
const MAX_ENT = 40;
const START_ENT = 24;
const ARENA = 96;
const SEAT_CODE = { live: 0, ghost: 1, bot: 2, left: 3 } as const;
const EMPTY: readonly HostEvent[] = [];

/** The public world: what a keyframe carries and what events change. */
export interface ProbeWorld {
  counter: number;
  seats: number[];
  /** id → [kind, x, y, v] */
  ents: Map<number, [number, number, number, number]>;
}

export const probeRuntime = (o: ProbeOptions): ProbeRuntime => {
  const players = Math.max(1, Math.min(4, o.players | 0));
  let rng = (o.seed ?? 1) >>> 0 || 1;
  const next = (): number => (rng = xorshift32(rng));
  const unit = (): number => next() / 0x100000000;

  // World.
  let counter = 0;
  const seats = new Uint8Array(players);
  const ids = new Uint16Array(MAX_ENT);
  const kinds = new Uint8Array(MAX_ENT);
  const xs = new Uint16Array(MAX_ENT);
  const ys = new Uint16Array(MAX_ENT);
  const vs = new Uint8Array(MAX_ENT);
  let nEnt = 0;
  let nextId = 1;
  const arena = new Uint8Array(ARENA);
  for (let i = 0; i < ARENA; i += 1) arena[i] = next() & 0xff;
  // Start with a populated world, so keyframes have their typical size (≈ 300 B) from the first one.
  for (; nEnt < START_ENT; nEnt += 1) {
    ids[nEnt] = nextId++;
    kinds[nEnt] = next() & 7;
    xs[nEnt] = next() & 0x3ff;
    ys[nEnt] = next() & 0x3ff;
  }

  // Fighters (snapshot only, not part of the public world).
  const fx = new Uint16Array(players);
  const fy = new Uint16Array(players);
  const fFacing = new Uint8Array(players);
  const fLeft = new Int16Array(players); // ticks left in the current burst, negative: paused
  for (let i = 0; i < players; i += 1) {
    fx[i] = 16 + i * 32;
    fy[i] = 16;
  }
  const ackUps = new Uint16Array(players);

  let tick = 0;
  let credit = 0;
  const snapCap = Math.max(2, o.snapshotBytes | 0);
  const snap = new Uint8Array(snapCap);
  const creditCap = Math.max(64, 4 * o.eventBytesPerTick);
  const evW = new ByteWriter(1024);
  let evCount = 0;
  const chunk: EventChunk = { bytes: new Uint8Array(0), count: 0 };
  const kfW = new ByteWriter(16 + players + MAX_ENT * 8 + ARENA);
  let host: HostEvent[] = [];
  const scripted: HostEvent[] = [];
  const seatCmds: { slot: number; state: 'live' | 'ghost' | 'bot' | 'left' }[] = [];
  let phase = 2;

  const due = (every: number | undefined): boolean => (every ?? 0) > 0 && unit() < 1 / (every as number);

  const applySeat = (slot: number, state: 'live' | 'ghost' | 'bot' | 'left'): void => {
    if (slot < 0 || slot >= players) return;
    seats[slot] = SEAT_CODE[state];
    host.push({ t: 'seat', slot, state });
  };

  // The next event's kind is drawn once and kept until the credit covers it, so large kinds are not
  // starved by small ones (the mix stays as drawn and the world does not drift empty).
  let drawn = 0;
  const writeEvent = (): number => {
    if (drawn === 0) {
      const r = next() % 100;
      drawn = r < 18 ? PROBE_EV.spawn : r < 36 ? PROBE_EV.despawn : r < 60 ? PROBE_EV.bump : r < 80 ? PROBE_EV.set : PROBE_EV.move;
    }
    let kind = drawn;
    if (kind === PROBE_EV.spawn && nEnt >= MAX_ENT) kind = PROBE_EV.despawn;
    if (nEnt === 0 && kind !== PROBE_EV.spawn && kind !== PROBE_EV.bump) kind = PROBE_EV.bump;
    const size = EV_SIZE[kind] as number;
    if (credit < size || evW.free < size) return 0;
    drawn = 0;
    const at = nEnt > 0 ? next() % nEnt : 0;
    evW.u8(kind);
    if (kind === PROBE_EV.spawn) {
      const id = nextId;
      nextId = nextId >= 0xfffe ? 1 : nextId + 1;
      const k = next() & 7;
      const x = next() & 0x3ff;
      const y = next() & 0x3ff;
      ids[nEnt] = id;
      kinds[nEnt] = k;
      xs[nEnt] = x;
      ys[nEnt] = y;
      vs[nEnt] = 0;
      nEnt += 1;
      evW.u16(id).u8(k).u16(x).u16(y);
    } else if (kind === PROBE_EV.despawn) {
      evW.u16(ids[at] as number);
      nEnt -= 1;
      ids[at] = ids[nEnt] as number;
      kinds[at] = kinds[nEnt] as number;
      xs[at] = xs[nEnt] as number;
      ys[at] = ys[nEnt] as number;
      vs[at] = vs[nEnt] as number;
    } else if (kind === PROBE_EV.bump) {
      const n = 1 + (next() % 9);
      counter = (counter + n) >>> 0;
      evW.u8(n);
    } else if (kind === PROBE_EV.set) {
      const v = next() & 0xff;
      vs[at] = v;
      evW.u16(ids[at] as number).u8(v);
    } else {
      const x = next() & 0x3ff;
      const y = next() & 0x3ff;
      xs[at] = x;
      ys[at] = y;
      evW.u16(ids[at] as number).u16(x).u16(y);
    }
    credit -= size;
    return 1;
  };

  // Written in place (no ByteWriter view), so step() allocates nothing; the padding stays 0.
  const writeSnapshot = (): void => {
    const n = Math.min(players, Math.floor((snapCap - 2) / 5));
    snap[0] = n;
    let at = 1;
    for (let i = 0; i < n; i += 1) {
      const moving = (fLeft[i] as number) > 0 ? 1 : 0;
      const x = fx[i] as number;
      const y = fy[i] as number;
      snap[at] = (i & 3) | ((fFacing[i] as number) << 2) | (moving << 5) | ((seats[i] === 0 ? 1 : 0) << 6);
      snap[at + 1] = x & 0xff;
      snap[at + 2] = x >>> 8;
      snap[at + 3] = y & 0xff;
      snap[at + 4] = y >>> 8;
      at += 5;
    }
    snap[at] = 0;
  };

  const core = {
    get idle() {
      return false;
    },
    get tick() {
      return tick;
    },
    step(): void {
      tick += 1;
      if (host.length > 0) host = [];
      // Fighters walk in bursts.
      for (let i = 0; i < players; i += 1) {
        const left = fLeft[i] as number;
        if (left > 0) {
          const dir = fFacing[i] as number;
          if (dir === 0) fx[i] = ((fx[i] as number) + 2) & 0x3ff;
          else if (dir === 1) fx[i] = ((fx[i] as number) - 2) & 0x3ff;
          else if (dir === 2) fy[i] = ((fy[i] as number) + 2) & 0x3ff;
          else fy[i] = ((fy[i] as number) - 2) & 0x3ff;
          fLeft[i] = left === 1 ? -(1 + (next() % 60)) : left - 1;
          if (next() % 8 === 0) fFacing[i] = next() & 3;
        } else if (left < 0) fLeft[i] = left + 1;
        else fLeft[i] = 10 + (next() % 80);
      }
      // Events: about `eventBytesPerTick` bytes per tick.
      evW.reset();
      evCount = 0;
      credit += o.eventBytesPerTick * (0.5 + unit());
      for (let i = 0; i < 64; i += 1) {
        const wrote = writeEvent();
        if (wrote === 0) break;
        evCount += 1;
      }
      if (credit > creditCap) credit = creditCap;
      writeSnapshot();
      // Host events: seat commands, scripted ones, then the seeded random ones.
      for (let i = 0; i < seatCmds.length; i += 1) {
        const c = seatCmds[i] as { slot: number; state: 'live' | 'ghost' | 'bot' | 'left' };
        applySeat(c.slot, c.state);
      }
      if (seatCmds.length > 0) seatCmds.length = 0;
      for (let i = 0; i < scripted.length; i += 1) {
        const e = scripted[i] as HostEvent;
        if (e.t === 'seat') applySeat(e.slot, e.state);
        else host.push(e);
      }
      if (scripted.length > 0) scripted.length = 0;
      if (due(o.seatEvery)) {
        const slot = next() % players;
        applySeat(slot, seats[slot] === 0 ? 'ghost' : 'live');
      }
      if (due(o.phaseEvery)) {
        phase = phase === 2 ? 3 : 2;
        host.push({ t: 'phase', phase, reason: 0, body: Uint8Array.of(phase, counter & 0xff) });
      }
      if (due(o.rekeyEvery)) host.push({ t: 'rekey', slot: next() % players, reason: 5, view: 0 });
    },
    onUp(slot: number, payload: Uint8Array, upSeq: number): void {
      if (slot < 0 || slot >= players || payload.length < 1) return;
      ackUps[slot] = upSeq & 0xffff;
    },
    onEvent(): void {},
    ackUp(slot: number): number {
      return slot >= 0 && slot < players ? (ackUps[slot] as number) : 0;
    },
    setSeat(slot: number, cmd: SeatCmd): void {
      seatCmds.push({ slot, state: cmd === 'reclaim' ? 'live' : cmd });
    },
    setRtt(): void {},
    welcomeCfg(): Uint8Array {
      return Uint8Array.of(players, snapCap);
    },
    snapshotFor(): Uint8Array | null {
      return snap;
    },
    keyframeFor(_r: RecipientView): Uint8Array {
      kfW.reset();
      kfW.u32(counter).u8(players);
      for (let i = 0; i < players; i += 1) kfW.u8(seats[i] as number);
      kfW.u8(nEnt);
      for (let i = 0; i < nEnt; i += 1) kfW.u16(ids[i] as number).u8(kinds[i] as number).u16(xs[i] as number).u16(ys[i] as number).u8(vs[i] as number);
      kfW.u8(ARENA).bytes(arena);
      return kfW.view();
    },
    takeEvents(_r: RecipientView): EventChunk | null {
      if (evCount === 0) return null;
      chunk.bytes = evW.view();
      chunk.count = evCount;
      return chunk;
    },
    takeHostEvents(): readonly HostEvent[] {
      if (host.length === 0) return EMPTY;
      const out = host;
      host = [];
      return out;
    },
    dump(): Uint8Array {
      return core.keyframeFor({ slot: 0, view: 0 }).slice();
    },
  };

  const runtime = wrapCore('fuseyard', 'probe', core, { handover: () => new Uint8Array(0), replay: () => new Uint8Array(0) });
  return Object.assign(runtime, {
    script(e: HostEvent) {
      scripted.push(e);
    },
    world: () => probeKeyframe(core.keyframeFor({ slot: 0, view: 0 })) as ProbeWorld,
  });
};

// ------------------------------------------------------------------ client side

/** Decode a probe keyframe body; null when malformed. */
export const probeKeyframe = (body: Uint8Array): ProbeWorld | null => {
  const r = new ByteReader(body);
  const counter = r.u32();
  const nSeats = r.u8();
  const seats: number[] = [];
  for (let i = 0; i < nSeats; i += 1) seats.push(r.u8());
  const n = r.u8();
  const ents = new Map<number, [number, number, number, number]>();
  for (let i = 0; i < n; i += 1) {
    const id = r.u16();
    ents.set(id, [r.u8(), r.u16(), r.u16(), r.u8()]);
  }
  r.skip(r.u8());
  return r.ok && r.remaining === 0 ? { counter, seats, ents } : null;
};

/** Apply one FRAME's event block to `w` in place; false on a malformed block or an event the world cannot take. */
export const probeApply = (w: ProbeWorld, count: number, bytes: Uint8Array, tick = 0): boolean => {
  let fine = true;
  const ok = forEachEvent(
    { count, r: new ByteReader(bytes), tick },
    (kind, r) => {
      if (kind === PROBE_EV.spawn) {
        const id = r.u16();
        const k = r.u8();
        const x = r.u16();
        const y = r.u16();
        if (w.ents.has(id)) fine = false;
        w.ents.set(id, [k, x, y, 0]);
      } else if (kind === PROBE_EV.despawn) {
        if (!w.ents.delete(r.u16())) fine = false;
      } else if (kind === PROBE_EV.bump) {
        w.counter = (w.counter + r.u8()) >>> 0;
      } else if (kind === PROBE_EV.set) {
        const e = w.ents.get(r.u16());
        const v = r.u8();
        if (e) e[3] = v;
        else fine = false;
      } else if (kind === PROBE_EV.move) {
        const e = w.ents.get(r.u16());
        const x = r.u16();
        const y = r.u16();
        if (e) {
          e[1] = x;
          e[2] = y;
        } else fine = false;
      } else return false;
      return r.ok;
    },
    (e) => {
      if (e.k === 'seat') {
        if (e.slot < w.seats.length) w.seats[e.slot] = e.state;
        else fine = false;
      }
    },
  );
  return ok && fine;
};

/**
 * `deltaFuzz`'s decoder for the probe: a keyframe body plus the event sections after it, each as on
 * the wire (`u8 count`, then the events). Throws on anything malformed.
 */
export const probeDecode = (k: Uint8Array, events: readonly Uint8Array[]): ProbeWorld => {
  const w = probeKeyframe(k);
  if (!w) throw new Error('probe keyframe does not decode (' + k.length + ' B)');
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i] as Uint8Array;
    if (!probeApply(w, e[0] ?? 0, e.subarray(1))) throw new Error('event block ' + i + ' after the keyframe does not apply (' + e.length + ' B)');
  }
  return w;
};

export const probeEqual = (a: unknown, b: unknown): boolean => {
  const x = a as ProbeWorld;
  const y = b as ProbeWorld;
  if (x.counter !== y.counter || x.seats.length !== y.seats.length || x.ents.size !== y.ents.size) return false;
  for (let i = 0; i < x.seats.length; i += 1) if (x.seats[i] !== y.seats[i]) return false;
  for (const [id, e] of x.ents) {
    const f = y.ents.get(id);
    if (!f || f[0] !== e[0] || f[1] !== e[1] || f[2] !== e[2] || f[3] !== e[3]) return false;
  }
  return true;
};

/** A one-line description of how two worlds differ, for failure messages. */
export const probeDiff = (client: ProbeWorld, server: ProbeWorld): string => {
  const parts: string[] = [];
  if (client.counter !== server.counter) parts.push(`counter ${client.counter} vs ${server.counter}`);
  if (client.seats.join() !== server.seats.join()) parts.push(`seats [${client.seats.join()}] vs [${server.seats.join()}]`);
  const missing = [...server.ents.keys()].filter((id) => !client.ents.has(id));
  const extra = [...client.ents.keys()].filter((id) => !server.ents.has(id));
  const changed = [...client.ents.keys()].filter((id) => server.ents.has(id) && client.ents.get(id)?.join() !== server.ents.get(id)?.join());
  if (missing.length) parts.push('missing ' + missing.join(','));
  if (extra.length) parts.push('extra ' + extra.join(','));
  if (changed.length) parts.push('changed ' + changed.join(','));
  return parts.join('; ') || 'equal';
};
