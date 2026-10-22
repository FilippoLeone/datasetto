/**
 * Lock-step play without a network (bellwick.md §13 tests 4 and 6): the runtime and one client mirror per
 * hero, wired the way the platform's local host wires them (UPs and EVTs in, then a step, then one FRAME
 * per tick and a KEYFRAME on each rekey). Buttons come from a log or from bots, so a run is a pure function
 * of the seed and the inputs: the golden replays hash it in Node and in jsdom.
 */
import { ByteReader } from '../bytes.js';
import type { EventBlock } from '../net/lane.js';
import { createClientWorld, onFrame, onKeyframe, onWelcome, stepOwn, type ClientHooks, type ClientSend, type ClientWorld } from './client.js';
import { createBellwick, hashWorld, type BellwickMatch } from './runtime.js';
import type { SaveV1 } from './codec.js';

export interface LocalRun {
  core: BellwickMatch;
  clients: ClientWorld[];
  /** One tick: each hero steps with its buttons, then the runtime steps and the clients hear about it. */
  step(buttons: readonly number[]): void;
  hash(): number;
  /** Persist events seen (SaveV1 JSON bytes). */
  saves: Uint8Array[];
}

export const createLocalRun = (o: {
  seed: number;
  heroes: number;
  save?: { data: SaveV1; flags: Uint8Array } | null;
  hooks?: (slot: number) => ClientHooks;
}): LocalRun => {
  const core = createBellwick({ seed: o.seed, mode: 'local', save: o.save ?? null, taleSlot: 0xff });
  const clients: ClientWorld[] = [];
  const sends: ClientSend[] = [];
  const saves: Uint8Array[] = [];
  for (let s = 0; s < o.heroes; s += 1) {
    clients.push(createClientWorld(s, o.hooks ? o.hooks(s) : {}));
    const slot = s;
    sends.push({ up: (p) => core.onUp(slot, p, 0), evt: (p) => core.onEvent(slot, p) });
  }
  for (let s = 0; s < o.heroes; s += 1) core.join(s, s, s);
  for (let s = 0; s < o.heroes; s += 1) {
    const c = clients[s] as ClientWorld;
    onWelcome(c, core.welcomeCfg());
    onKeyframe(c, new ByteReader(core.keyframeFor({ slot: s, view: 0 })), core.tick);
  }
  core.takeHostEvents();
  const block: EventBlock = { count: 0, r: new ByteReader(new Uint8Array(0)), tick: 0 };
  return {
    core,
    clients,
    saves,
    step(buttons) {
      const tick = core.tick + 1;
      for (let s = 0; s < clients.length; s += 1) stepOwn(clients[s] as ClientWorld, buttons[s] ?? 0, tick, core.tick, sends[s] as ClientSend, 1);
      core.step();
      const host = core.takeHostEvents();
      for (let s = 0; s < clients.length; s += 1) {
        const c = clients[s] as ClientWorld;
        const r = { slot: s, view: 0 };
        const snap = core.snapshotFor(r);
        const ev = core.takeEvents(r);
        let events: EventBlock | null = null;
        if (ev) {
          block.count = ev.count;
          block.r = new ByteReader(ev.bytes);
          block.tick = core.tick;
          events = block;
        }
        onFrame(c, core.tick, snap ? new ByteReader(snap) : null, events);
      }
      for (const e of host) {
        if (e.t === 'rekey' && e.slot < clients.length) onKeyframe(clients[e.slot] as ClientWorld, new ByteReader(core.keyframeFor({ slot: e.slot, view: e.view })), core.tick);
        else if (e.t === 'persist') saves.push(e.data);
      }
    },
    hash: () => hashWorld(core.world),
  };
};
