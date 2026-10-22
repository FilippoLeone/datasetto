/**
 * Bellwick's match runtime (`CoreMatch`, plan.md §2.6.2; bellwick.md §4.10). One engine for both modes:
 * the server wraps it for Party Tale, and the device steps it through the platform's local host for Solo
 * Tale. Each client owns its hero: UPs carry the hero's state and EVTs what it did; the runtime checks
 * them (online), applies them at the start of the next tick, steps the rooms that hold heroes, and
 * routes snapshots, keyframes and events per room.
 */
import { ByteWriter, utf8Encode } from '../bytes.js';
import { fnv1a32, fnvMix, FNV_OFFSET } from '../hash.js';
import type { CoreMatch, EventChunk, HostEvent, RecipientView, SeatCmd } from '../net/match.js';
import {
  CORRECT,
  ENT_MAX,
  entState,
  evCorrect,
  evHp,
  EVT,
  newEvtView,
  newHeroState,
  readEvt,
  readUp,
  writeHeroView,
  writeTiles,
  writeWelcomeCfg,
  type SaveHero,
  type SaveV1,
} from './codec.js';
import { content } from './content/parse.js';
import { HERO_RULES } from './rules.js';
import { blockX, blockY, enemyPose, px, ringAt } from './sim/room.js';
import {
  applyBlocked,
  applyBrew,
  applyBuy,
  applyDamage,
  applyEnter,
  applyGoToAlly,
  applyHitTarget,
  applyInteract,
  applyPush,
  applyRespawn,
  heroJoin,
  heroLeave,
  itemsByte,
  loadSave,
  newOutbox,
  partyMaxHp,
  stepWorld,
  toSave,
  writeRoster,
  type Outbox,
} from './sim/party.js';
import type { Block, Enemy, HeroRec, Room } from './sim/state.js';
import { newWorld, type World } from './sim/world.js';
import { Act, CAP, Kind, Status } from './types.js';

export interface BellwickOpts {
  seed: number;
  /** 'local': the device's own hero only (no move checks); 'server': Party Tale. */
  mode: 'local' | 'server';
  /** The tale: a validated save and its 32 flag bytes, or null for a new tale. */
  save: { data: SaveV1; flags: Uint8Array } | null;
  /** WELCOME's tale slot (0xFF new). */
  taleSlot: number;
  /** Save heroes from other accounts to keep (online; keyed by account). */
  keepHeroes?: Record<string, SaveHero>;
}

export interface BellwickMatch extends CoreMatch {
  readonly world: World;
  /** Seats a hero now (offline start, or a drop-in on the server). */
  join(slot: number, tunic: number, joinOrder: number): void;
  /** The SaveV1 now (heroes keyed `slot:<n>`). */
  save(): SaveV1;
  /** Ticks since any input from anyone (the 5-minute idle rule). */
  readonly quietTicks: number;
  hostSlot: number;
}

const EVQ = 64;

export const createBellwick = (o: BellwickOpts): BellwickMatch => {
  const w = newWorld(o.seed);
  const fresh = o.save === null;
  if (o.save) loadSave(w, o.save.data, o.save.flags);
  const out: Outbox = newOutbox();
  const hostEvents: HostEvent[] = [];
  const trusted = o.mode === 'local';

  // Queued input, applied at the start of the next step.
  const upPending = [false, false, false, false];
  const upBuf = [new Uint8Array(10), new Uint8Array(10), new Uint8Array(10), new Uint8Array(10)];
  const upSeqs = [0, 0, 0, 0];
  const acked = [0, 0, 0, 0];
  const evSlot = new Int8Array(EVQ);
  const evData: Uint8Array[] = [];
  for (let i = 0; i < EVQ; i += 1) evData.push(new Uint8Array(20));
  const evLen = new Uint8Array(EVQ);
  let evN = 0;
  const lag = [false, false, false, false];
  let quiet = 0;
  let hostSlot = 0;
  let joinCounter = 0;
  const hpWarn = [0, 0, 0, 0];

  // Per-recipient encoders (valid until the next step).
  const snapW = [new ByteWriter(128), new ByteWriter(128), new ByteWriter(128), new ByteWriter(128)];
  const keyW = [new ByteWriter(512), new ByteWriter(512), new ByteWriter(512), new ByteWriter(512)];
  const evW = [new ByteWriter(4096), new ByteWriter(4096), new ByteWriter(4096), new ByteWriter(4096)];
  const chunk: EventChunk = { bytes: new Uint8Array(0), count: 0 };
  /** The entry reason of a pending rekey (keyframes for anything else carry the party block). */
  const entry = [-1, -1, -1, -1];

  const up = newHeroState();
  const evt = newEvtView();

  const flushRekeys = (): void => {
    for (let s = 0; s < 4; s += 1) {
      const r = out.rekey[s] as number;
      if (r === 0) continue;
      out.rekey[s] = 0;
      entry[s] = r - 1;
      const h = w.heroes[s] as HeroRec;
      hostEvents.push({ t: 'rekey', slot: s, reason: 4, view: h.room });
    }
  };

  const persist = (): void => {
    w.saveNow = false;
    w.dirtyAt = -1;
    w.savedAt = w.tick;
    hostEvents.push({ t: 'persist', data: utf8Encode(JSON.stringify(toSave(w, o.keepHeroes ?? {}))) });
  };

  const correct = (h: HeroRec, reason: number): void => {
    const sw = out.self[h.slot] as ByteWriter;
    evCorrect(sw, h.room, h.x, h.y, reason);
    out.selfCount[h.slot] = (out.selfCount[h.slot] as number) + 1;
  };

  /** Moves are checked against the server's walls and speed (bellwick.md §3.5). */
  const applyUp = (s: number): void => {
    const h = w.heroes[s] as HeroRec;
    if (!h.present || !readUp(upBuf[s] as Uint8Array, up)) return;
    if (up.room !== h.room || h.status !== Status.Active) return;
    if (!trusted) {
      const dt = Math.max(1, ((up.heroTick - h.heroTick) & 0xffff) || 1);
      const lim = HERO_RULES.speed * dt + 32 + h.allow + (h.transitT > 0 ? 512 : 0);
      if (Math.abs(up.x - h.x) > lim || Math.abs(up.y - h.y) > lim) {
        h.corrects += 1;
        correct(h, CORRECT.move);
        return;
      }
    }
    if (up.x !== h.x || up.y !== h.y || up.act !== h.act) h.idleT = 0;
    h.x = up.x;
    h.y = up.y;
    h.facing = up.facing;
    h.act = up.act === Act.Downed ? h.act : up.act;
    h.actT = up.actT;
    h.moving = up.moving;
    h.charged = up.charged;
    h.heroTick = up.heroTick;
    h.allow = Math.max(0, h.allow - HERO_RULES.speed * 4);
    if (up.hp !== h.hp && w.tick - (hpWarn[s] as number) > 15) {
      hpWarn[s] = w.tick;
      const room = w.rooms[h.room];
      if (room) {
        evHp(room.ev, s, h.hp);
        room.evCount += 1;
      }
    }
  };

  const fromBox = new Int32Array(2);

  const applyEvt = (s: number, p: Uint8Array): void => {
    const h = w.heroes[s] as HeroRec;
    if (!h.present || !readEvt(p, evt)) return;
    switch (evt.kind) {
      case EVT.HitClaim: {
        if (h.status !== Status.Active) return;
        const room = w.rooms[h.room];
        if (!room) return;
        for (let i = 0; i < evt.n; i += 1) {
          const t = evt.targets[i] as number;
          if (!trusted && t < 128) {
            // The target must have been where the hero saw it (16-tick ring, 4 px slack is in the box).
            const seen = (w.tick & ~0xffff) | evt.seenTick;
            if (!ringAt(room, t, seen, fromBox) && !ringAt(room, t, w.tick, fromBox)) continue;
          }
          applyHitTarget(w, h, room, evt.attack, t, h.x, h.y - 64);
        }
        return;
      }
      case EVT.DamageTaken:
        applyDamage(w, h, evt.a, evt.b);
        return;
      case EVT.Blocked:
        applyBlocked(w, h, evt.a);
        return;
      case EVT.Interact:
        applyInteract(w, h, evt.a, out);
        return;
      case EVT.Push:
        applyPush(w, h, evt.a, evt.b, out);
        return;
      case EVT.EnterRoom:
        applyEnter(w, h, evt.a, evt.b, out);
        return;
      case EVT.Buy:
        applyBuy(w, h, evt.a, out);
        return;
      case EVT.UseBrew:
        applyBrew(w, h);
        return;
      case EVT.Respawn:
        applyRespawn(w, h, out);
        return;
      case EVT.GoToAlly:
        applyGoToAlly(w, h, evt.a, out);
        return;
      default:
    }
  };

  const resetEvents = (): void => {
    for (let id = 0; id < w.rooms.length; id += 1) {
      const room = w.rooms[id];
      if (room) {
        room.ev.reset();
        room.evCount = 0;
      }
    }
    w.party.ev.reset();
    w.party.evCount = 0;
    for (let s = 0; s < 4; s += 1) {
      (out.self[s] as ByteWriter).reset();
      out.selfCount[s] = 0;
    }
  };

  const anyAwake = (): boolean => {
    for (let i = 0; i < 4; i += 1) {
      const h = w.heroes[i] as HeroRec;
      if (h.present && (h.status === Status.Active || h.status === Status.Downed)) return true;
    }
    return false;
  };

  const heroOf = (r: RecipientView): HeroRec | null => (r.slot < 4 ? (w.heroes[r.slot] as HeroRec) : null);

  const writeEntities = (wr: ByteWriter, room: Room, withKind: boolean): number => {
    let n = 0;
    for (let i = 0; i < CAP.enemies && n < ENT_MAX; i += 1) {
      const e = room.en[i] as Enemy;
      if (e.kind === 0) continue;
      wr.u8(e.id);
      if (withKind) wr.u8(e.kind);
      wr.u8(Math.max(0, Math.min(191, px(e.x))))
        .u8(Math.max(0, Math.min(143, px(e.y))))
        .u8(entState(enemyPose(room, e), e.facing, e.hurt > 0, e.stun > 0 || (e.kind === Kind.Snapjaw && e.ai === 2)))
        .u8(Math.max(0, Math.min(255, e.hp)));
      n += 1;
    }
    for (let i = 0; i < CAP.blocks && n < ENT_MAX; i += 1) {
      const b = room.bl[i] as Block;
      if (b.on === 0 || b.moveT === 0) continue;
      wr.u8(b.id);
      if (withKind) wr.u8(Kind.Block);
      wr.u8(px(blockX(b))).u8(px(blockY(b))).u8(entState(b.moveT & 15, b.dir, false, false)).u8(0);
      n += 1;
    }
    return n;
  };

  const countEntities = (room: Room): number => {
    let n = 0;
    for (let i = 0; i < CAP.enemies; i += 1) if ((room.en[i] as Enemy).kind !== 0) n += 1;
    for (let i = 0; i < CAP.blocks; i += 1) if ((room.bl[i] as Block).on !== 0 && (room.bl[i] as Block).moveT !== 0) n += 1;
    return Math.min(ENT_MAX, n);
  };

  const writeOthers = (wr: ByteWriter, room: number, self: number): void => {
    let n = 0;
    for (let i = 0; i < 4; i += 1) {
      const h = w.heroes[i] as HeroRec;
      if (i !== self && h.present && h.room === room && h.status !== Status.Resting) n += 1;
    }
    wr.u8(n);
    for (let i = 0; i < 4; i += 1) {
      const h = w.heroes[i] as HeroRec;
      if (i === self || !h.present || h.room !== room || h.status === Status.Resting) continue;
      const status = h.transitT > 0 && h.status === Status.Active ? Status.Transit : h.status;
      writeHeroView(wr, i, status, h.facing, h.iframes > 0, h.moving, px(h.x), px(h.y), h.act, h.charged, h.actT, h.hp);
    }
  };

  const ticking = (room: number): boolean => {
    for (let i = 0; i < 4; i += 1) {
      const h = w.heroes[i] as HeroRec;
      if (h.present && h.room === room && (h.status === Status.Downed || (h.status === Status.Active && h.transitT === 0))) return true;
    }
    return false;
  };

  const match: BellwickMatch = {
    world: w,
    get hostSlot() {
      return hostSlot;
    },
    set hostSlot(v: number) {
      hostSlot = v;
    },
    get idle() {
      return !anyAwake() && evN === 0;
    },
    get tick() {
      return w.tick;
    },
    get quietTicks() {
      return quiet;
    },
    join(slot, tunic, joinOrder) {
      if (slot < 0 || slot > 3) return;
      heroJoin(w, slot, tunic, joinOrder >= 0 ? joinOrder : joinCounter, out, fresh && w.tick === 0 && !anyAwake());
      joinCounter = Math.max(joinCounter, joinOrder) + 1;
      flushRekeys();
      entry[slot] = -1;
    },
    save: () => toSave(w, o.keepHeroes ?? {}),
    step() {
      resetEvents();
      quiet += 1;
      for (let s = 0; s < 4; s += 1) {
        if (!upPending[s]) continue;
        upPending[s] = false;
        applyUp(s);
        acked[s] = upSeqs[s] as number;
      }
      for (let i = 0; i < evN; i += 1) applyEvt(evSlot[i] as number, (evData[i] as Uint8Array).subarray(0, evLen[i] as number));
      evN = 0;
      if (!anyAwake()) {
        flushRekeys();
        return;
      }
      stepWorld(w, out);
      w.rosterT += 1;
      if (w.rosterT >= 30) {
        w.rosterT = 0;
        writeRoster(w, hostSlot, lag);
      }
      if (w.saveNow || (w.dirtyAt >= 0 && w.tick - w.dirtyAt >= 60 && w.tick - w.savedAt >= 60)) persist();
      flushRekeys();
    },
    onUp(slot, payload, upSeq) {
      if (slot < 0 || slot > 3 || payload.length !== 10) return;
      (upBuf[slot] as Uint8Array).set(payload);
      upPending[slot] = true;
      upSeqs[slot] = upSeq;
      quiet = 0;
    },
    onEvent(slot, payload) {
      if (slot < 0 || slot > 3 || payload.length < 1 || payload.length > 20 || evN >= EVQ) return;
      evSlot[evN] = slot;
      (evData[evN] as Uint8Array).set(payload);
      evLen[evN] = payload.length;
      evN += 1;
      quiet = 0;
    },
    ackUp: (slot) => acked[slot] ?? 0,
    setSeat(slot, cmd: SeatCmd) {
      if (slot < 0 || slot > 3) return;
      const h = w.heroes[slot] as HeroRec;
      if (cmd === 'left') {
        if (h.present) heroLeave(w, slot);
        hostEvents.push({ t: 'seat', slot, state: 'left' });
      } else if (cmd === 'ghost') {
        if (h.present && h.status !== Status.Downed) h.status = Status.Resting;
        hostEvents.push({ t: 'seat', slot, state: 'ghost' });
      } else if (cmd === 'live' || cmd === 'reclaim') {
        if (!h.present) match.join(slot, h.tunic, joinCounter);
        else if (h.status === Status.Resting) {
          h.status = Status.Active;
          h.iframes = HERO_RULES.iframes;
        }
        hostEvents.push({ t: 'seat', slot, state: 'live' });
      }
    },
    setRtt(slot, rttMs) {
      if (slot >= 0 && slot < 4) lag[slot] = rttMs > 500;
    },
    welcomeCfg() {
      const seats: { slot: number; tunic: number; joinOrder: number }[] = [];
      for (let i = 0; i < 4; i += 1) {
        const h = w.heroes[i] as HeroRec;
        if (h.present) seats.push({ slot: i, tunic: h.tunic, joinOrder: h.joinOrder });
      }
      return writeWelcomeCfg(o.taleSlot, contentHash(), seats);
    },
    snapshotFor(r) {
      const h = heroOf(r);
      if (!h || !h.present) return null;
      const room = w.rooms[h.room];
      if (!room || !ticking(h.room)) return null;
      const wr = (snapW[r.slot] as ByteWriter).reset();
      wr.u8(room.id);
      writeOthers(wr, room.id, r.slot);
      const n = countEntities(room);
      wr.u8(n);
      writeEntities(wr, room, false);
      return wr.view();
    },
    keyframeFor(r) {
      const h = heroOf(r);
      const wr = (keyW[r.slot < 4 ? r.slot : 0] as ByteWriter).reset();
      if (!h || !h.present) return wr.view();
      const room = w.rooms[h.room];
      const e = entry[r.slot] ?? -1;
      entry[r.slot] = -1;
      const reason = e >= 0 ? e : 4;
      wr.u8(h.room).u8(reason).u16(h.x).u16(h.y).u8(h.hp).u8((h.status & 3) | ((h.facing & 3) << 2) | (h.brew ? 16 : 0));
      if (!room) return wr.view();
      writeTiles(wr, room.tiles);
      wr.u8(0).u8((w.party.cleared & (1 << Math.max(0, room.id - 32))) !== 0 && room.def.dungeon ? 1 : 0);
      writeOthers(wr, room.id, r.slot);
      wr.u8(countEntities(room));
      writeEntities(wr, room, true);
      let np = 0;
      for (let i = 0; i < CAP.pickups; i += 1) if (room.pk[i]!.on !== 0) np += 1;
      wr.u8(np);
      for (let i = 0; i < CAP.pickups; i += 1) {
        const k = room.pk[i]!;
        if (k.on === 0) continue;
        wr.u8(k.id).u8((k.kind & 15) | ((k.ttl < 0 ? 0 : Math.max(1, Math.min(15, Math.ceil(k.ttl / 20)))) << 4)).u8(px(k.x)).u8(px(k.y));
      }
      let npr = 0;
      for (let i = 0; i < CAP.projectiles; i += 1) if (room.pr[i]!.on !== 0) npr += 1;
      wr.u8(npr);
      for (let i = 0; i < CAP.projectiles; i += 1) {
        const p = room.pr[i]!;
        if (p.on === 0) continue;
        wr.u8(p.id).u8((p.kind & 15) | ((p.dir & 15) << 4)).u8(px(p.x0)).u8(px(p.y0)).u16(p.t0 & 0xffff);
      }
      let nsh = 0;
      for (let i = 0; i < CAP.shocks; i += 1) if (room.sh[i]!.on !== 0) nsh += 1;
      wr.u8(nsh);
      for (let i = 0; i < CAP.shocks; i += 1) {
        const s = room.sh[i]!;
        if (s.on !== 0) wr.u8(px(s.x)).u8(px(s.y)).u16(s.t0 & 0xffff);
      }
      if (room.boss) wr.u8(room.boss.phase).u8(room.boss.laps).u8(Math.min(255, Math.max(0, room.boss.timer))).u8(room.boss.clapperT);
      if (reason === 3 || reason === 4) {
        wr.bytes(w.party.flags).u16(w.party.purse).u8(w.party.keys).u8(itemsByte(w.party)).u8(w.party.shards).u8(w.party.vessels).u8(w.party.lantern).u8(partyMaxHp(w.party));
        wr.u16(w.party.cleared);
      }
      return wr.view();
    },
    takeEvents(r) {
      const h = heroOf(r);
      if (!h || !h.present) return null;
      const wr = (evW[r.slot] as ByteWriter).reset();
      let count = 0;
      const room = w.rooms[h.room];
      // A hero rekeyed this tick gets the new room in its keyframe, not as events.
      if (room && entry[r.slot] === -1 && room.evCount > 0) {
        wr.bytes(room.ev.view());
        count += room.evCount;
      }
      if (w.party.evCount > 0) {
        wr.bytes(w.party.ev.view());
        count += w.party.evCount;
      }
      const sc = out.selfCount[r.slot] as number;
      if (sc > 0) {
        wr.bytes((out.self[r.slot] as ByteWriter).view());
        count += sc;
      }
      if (count === 0) return null;
      chunk.bytes = wr.view();
      chunk.count = count;
      return { bytes: chunk.bytes, count };
    },
    takeHostEvents() {
      if (hostEvents.length === 0) return EMPTY;
      return hostEvents.splice(0, hostEvents.length);
    },
    dump() {
      return dumpWorld(w);
    },
  };
  return match;
};

const EMPTY: readonly HostEvent[] = [];

/** A canonical byte dump of the world (hashes, replays). */
export const dumpWorld = (w: World): Uint8Array => {
  const wr = new ByteWriter(64 * 1024);
  wr.u32(w.tick >>> 0).u32(w.seed >>> 0);
  const p = w.party;
  wr.bytes(p.flags).u16(p.purse).u8(p.keys).u8(itemsByte(p)).u8(p.shards).u8(p.vessels).u8(p.lantern).u32(p.playTicks >>> 0).u16(p.cleared);
  for (let i = 0; i < 4; i += 1) {
    const h = w.heroes[i] as HeroRec;
    wr.u8(h.present ? 1 : 0).u8(h.status).u8(h.room).u16(h.x & 0xffff).u16(h.y & 0xffff).u8(h.hp).u8(h.facing).u8(h.act).u8(h.iframes & 255).u8(h.transitT & 255);
  }
  for (let id = 0; id < w.rooms.length; id += 1) {
    const room = w.rooms[id];
    if (!room) continue;
    wr.u8(id).u32(room.rng >>> 0).bytes(room.tiles);
    for (let i = 0; i < CAP.enemies; i += 1) {
      const e = room.en[i] as Enemy;
      if (e.kind === 0) continue;
      wr.u8(e.id).u8(e.kind).u16(e.x & 0xffff).u16(e.y & 0xffff).u8(e.hp & 255).u8(e.ai).u16(e.aiT & 0xffff);
    }
    for (let i = 0; i < CAP.projectiles; i += 1) {
      const q = room.pr[i]!;
      if (q.on !== 0) wr.u8(q.id).u8(q.kind).u16(q.x0).u16(q.y0).u8(q.dir).u32(q.t0 >>> 0);
    }
    for (let i = 0; i < CAP.pickups; i += 1) {
      const k = room.pk[i]!;
      if (k.on !== 0) wr.u8(k.id).u8(k.kind).u16(k.x).u16(k.y);
    }
    for (let i = 0; i < CAP.blocks; i += 1) {
      const b = room.bl[i] as Block;
      if (b.on !== 0) wr.u8(b.id).u8(b.tile).u8(b.moveT);
    }
    if (room.boss) wr.u8(room.boss.phase).u8(room.boss.mode).u16(room.boss.timer & 0xffff);
  }
  return wr.copy();
};

export const hashWorld = (w: World): number => fnv1a32(dumpWorld(w));

let cachedHash = -1;

/** The hash of the static content (WELCOME's contentHash). */
export const contentHash = (): number => {
  if (cachedHash >= 0) return cachedHash;
  let h = FNV_OFFSET;
  const c = content();
  for (const d of c.screens) {
    if (!d) continue;
    h = fnvMix(h, d.id);
    h = fnv1a32(d.tiles, h);
  }
  cachedHash = h >>> 0;
  return cachedHash;
};

