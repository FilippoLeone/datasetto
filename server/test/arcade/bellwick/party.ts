/**
 * Party Tale in lock step without the platform: the server-mode runtime (with all its checks) and one
 * client mirror per hero, with a fixed delay in ticks each way. A FRAME for server tick T reaches the
 * client at T + delay; what a client sends at T reaches the server at T + delay. Clients stamp their
 * state with the server tick they believe it is now and their claims with the tick of the entity
 * positions they saw, as the device does, so the server's checks see a lagged client.
 */
import { ByteReader, ByteWriter } from '../../../src/arcade/core/bytes.js';
import type { BotActions } from '../../../src/arcade/core/bellwick/bots/hero.js';
import { createClientWorld, onFrame, onKeyframe, onWelcome, sendInteract, stepOwn, type ClientSend, type ClientWorld } from '../../../src/arcade/core/bellwick/client.js';
import { EV, EVT, writeBuy, writeRespawn, writeUseBrew, type SaveV1 } from '../../../src/arcade/core/bellwick/codec.js';
import { T } from '../../../src/arcade/core/bellwick/content/legend.js';
import { createBellwick, type BellwickMatch } from '../../../src/arcade/core/bellwick/runtime.js';
import type { HostEvent } from '../../../src/arcade/core/net/match.js';
import type { EventBlock } from '../../../src/arcade/core/net/lane.js';

const INTERACT: ReadonlySet<number> = new Set([T.CHEST, T.LOCK, T.BOSSDOOR, T.LANTERN, T.LANTERN_LIT, T.NPC]);

interface DownMsg {
  at: number;
  slot: number;
  tick: number;
  snap: Uint8Array | null;
  ev: { bytes: Uint8Array; count: number } | null;
  key: Uint8Array | null;
}

interface UpMsg {
  at: number;
  slot: number;
  up: Uint8Array | null;
  evt: Uint8Array | null;
}

export interface PartyStats {
  corrects: number[];
  claims: number[];
  refusedClaims: number[];
  refused: number[];
  hpFixes: number[];
  keyframes: number[];
}

export interface PartyRun {
  core: BellwickMatch;
  clients: ClientWorld[];
  stats: PartyStats;
  /** Every host event the runtime produced (persist, rekey, seat). */
  host: HostEvent[];
  /** One tick: deliver what is due, each hero steps with its buttons, the server steps. */
  step(buttons: readonly number[]): void;
  /** Sends an EVT from a hero through the delayed link. */
  evt(slot: number, payload: Uint8Array): void;
  actions(slot: number): BotActions;
}

export const createPartyRun = (o: { seed: number; heroes: number; save?: { data: SaveV1; flags: Uint8Array } | null; delay?: number; upEvery?: number }): PartyRun => {
  const delay = o.delay ?? 0;
  const core = createBellwick({ seed: o.seed, mode: 'server', save: o.save ?? null, taleSlot: 0xff, matchId: 'party-test' });
  const stats: PartyStats = { corrects: [], claims: [], refusedClaims: [], refused: [], hpFixes: [], keyframes: [] };
  const host: HostEvent[] = [];
  const ups: UpMsg[] = [];
  const downs: DownMsg[] = [];
  const clients: ClientWorld[] = [];
  const sends: ClientSend[] = [];
  let upSeq = 0;
  for (let s = 0; s < o.heroes; s += 1) {
    const slot = s;
    stats.corrects.push(0);
    stats.claims.push(0);
    stats.refusedClaims.push(0);
    stats.refused.push(0);
    stats.hpFixes.push(0);
    stats.keyframes.push(0);
    const c = createClientWorld(slot, {
      event: (e) => {
        if (e.kind === EV.Correct) stats.corrects[slot] = (stats.corrects[slot] as number) + 1;
        if (e.kind === EV.Refused) {
          stats.refused[slot] = (stats.refused[slot] as number) + 1;
          if (e.a === EVT.HitClaim) stats.refusedClaims[slot] = (stats.refusedClaims[slot] as number) + 1;
        }
        if (e.kind === EV.Hp && e.a === slot) stats.hpFixes[slot] = (stats.hpFixes[slot] as number) + 1;
      },
      interact: (tile) => {
        if (INTERACT.has(c.tiles[tile] as number)) sendInteract(sends[slot] as ClientSend, tile);
      },
      keyframe: () => {
        stats.keyframes[slot] = (stats.keyframes[slot] as number) + 1;
      },
    });
    clients.push(c);
    sends.push({
      up: (p) => ups.push({ at: core.tick + delay, slot, up: p, evt: null }),
      evt: (p) => {
        if (p[0] === EVT.HitClaim) stats.claims[slot] = (stats.claims[slot] as number) + p.length - 6;
        ups.push({ at: core.tick + delay, slot, up: null, evt: p });
      },
    });
  }
  for (let s = 0; s < o.heroes; s += 1) core.setSeat(s, 'live');
  host.push(...core.takeHostEvents());
  for (let s = 0; s < o.heroes; s += 1) {
    const c = clients[s] as ClientWorld;
    onWelcome(c, core.welcomeCfg());
    onKeyframe(c, new ByteReader(core.keyframeFor({ slot: s, view: 0 })), core.tick);
  }
  const block: EventBlock = { count: 0, r: new ByteReader(new Uint8Array(0)), tick: 0 };
  const w = new ByteWriter(8);

  const deliverDown = (): void => {
    for (let i = 0; i < downs.length; ) {
      const m = downs[i] as DownMsg;
      if (m.at > core.tick) {
        i += 1;
        continue;
      }
      downs.splice(i, 1);
      const c = clients[m.slot] as ClientWorld;
      if (m.key) {
        onKeyframe(c, new ByteReader(m.key), m.tick);
        continue;
      }
      let events: EventBlock | null = null;
      if (m.ev) {
        block.count = m.ev.count;
        block.r = new ByteReader(m.ev.bytes);
        block.tick = m.tick;
        events = block;
      }
      onFrame(c, m.tick, m.snap ? new ByteReader(m.snap) : null, events);
    }
  };

  const run: PartyRun = {
    core,
    clients,
    stats,
    host,
    evt: (slot, payload) => (sends[slot] as ClientSend).evt(payload),
    actions: (slot) => ({
      buy: (i: number) => run.evt(slot, writeBuy(w.reset(), i).copy()),
      brew: () => run.evt(slot, writeUseBrew(w.reset()).copy()),
      respawn: () => run.evt(slot, writeRespawn(w.reset()).copy()),
    }),
    step(buttons) {
      // The server applies what has arrived, then steps.
      for (let i = 0; i < ups.length; ) {
        const m = ups[i] as UpMsg;
        if (m.at > core.tick) {
          i += 1;
          continue;
        }
        ups.splice(i, 1);
        if (m.up) core.onUp(m.slot, m.up, (upSeq += 1));
        if (m.evt) core.onEvent(m.slot, m.evt);
      }
      core.step();
      const st = core.tick;
      const events = core.takeHostEvents();
      host.push(...events);
      for (let s = 0; s < clients.length; s += 1) {
        const r = { slot: s, view: 0 };
        const rekeyed = events.some((e) => e.t === 'rekey' && e.slot === s);
        if (rekeyed) {
          downs.push({ at: st + delay, slot: s, tick: st, snap: null, ev: null, key: core.keyframeFor(r).slice() });
          continue;
        }
        const snap = core.snapshotFor(r);
        const ev = core.takeEvents(r);
        if (snap || ev) downs.push({ at: st + delay, slot: s, tick: st, snap: snap ? snap.slice() : null, ev: ev ? { bytes: ev.bytes.slice(), count: ev.count } : null, key: null });
      }
      // Each client hears what reached it, then steps its hero at the server tick it believes it is now.
      deliverDown();
      for (let s = 0; s < clients.length; s += 1) {
        const c = clients[s] as ClientWorld;
        stepOwn(c, buttons[s] ?? 0, st + 1, c.snapTick, sends[s] as ClientSend, o.upEvery ?? 2);
      }
    },
  };
  return run;
};

