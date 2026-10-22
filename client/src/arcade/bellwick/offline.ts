/**
 * Solo Tale on the device (bellwick.md §7): the same match runtime the server runs, stepped by the
 * platform's local host. `local()` hands the platform a stand-in `CoreMatch` that stays empty until the
 * title screen picks a tale; `mount()` takes the same object (through `takeLocalTale`) to start it, and
 * its persist events become device saves.
 */
import type { CoreMatch, HostEvent, RecipientView, SeatCmd } from '@arcade/core/net/match';
import { fromBase64, parseSave, type SaveV1 } from '@arcade/core/bellwick/codec';
import { createBellwick, type BellwickMatch } from '@arcade/core/bellwick/runtime';
import { utf8Decode } from '@arcade/core/bytes';
import { writeTale, type TaleSlot } from './localSaves';

export interface LocalTale extends CoreMatch {
  readonly match: BellwickMatch | null;
  /** The device slot the tale saves into. */
  slot: TaleSlot;
  /** Starts a tale (a new one when `save` is null). */
  start(slot: TaleSlot, save: SaveV1 | null): void;
  /** Called after each save with whether it reached storage. */
  onSaved: ((ok: boolean) => void) | null;
  /** Saves now (the game was hidden or closed). */
  flush(): void;
}

const EMPTY = new Uint8Array(0);
const NONE: readonly HostEvent[] = [];

export const createLocalTale = (seed: number): LocalTale => {
  let match: BellwickMatch | null = null;
  const store = (raw: unknown): boolean => {
    const save = parseSave(soloHeroes(raw));
    return save !== null && writeTale(tale.slot, save);
  };
  const tale: LocalTale = {
    get match() {
      return match;
    },
    slot: 0,
    onSaved: null,
    start(slot, save) {
      tale.slot = slot;
      const flags = save ? fromBase64(save.flags, 32) : null;
      match = createBellwick({
        seed: save ? save.seed : seed >>> 0,
        mode: 'local',
        save: save && flags ? { data: save, flags } : null,
        taleSlot: slot,
      });
      const hero = save?.heroes['solo'];
      match.join(0, 0, 0);
      if (hero?.brew) match.world.heroes[0]!.brew = true;
      if (hero) {
        match.world.heroes[0]!.downs = hero.downs;
        match.world.heroes[0]!.foes = hero.defeats;
      }
    },
    get idle() {
      return match ? match.idle : true;
    },
    get tick() {
      return match ? match.tick : 0;
    },
    step: () => match?.step(),
    onUp: (slot, payload, upSeq) => match?.onUp(slot, payload, upSeq),
    onEvent: (slot, payload) => match?.onEvent(slot, payload),
    ackUp: (slot) => (match ? match.ackUp(slot) : 0),
    setSeat: (slot: number, cmd: SeatCmd) => match?.setSeat(slot, cmd),
    setRtt: () => undefined,
    welcomeCfg: () => (match ? match.welcomeCfg() : EMPTY),
    snapshotFor: (r: RecipientView) => (match ? match.snapshotFor(r) : null),
    keyframeFor: (r: RecipientView) => (match ? match.keyframeFor(r) : EMPTY),
    takeEvents: (r: RecipientView) => (match ? match.takeEvents(r) : null),
    takeHostEvents() {
      if (!match) return NONE;
      const events = match.takeHostEvents();
      if (events.length === 0) return events;
      const keep: HostEvent[] = [];
      for (const e of events) {
        if (e.t !== 'persist') {
          keep.push(e);
          continue;
        }
        let ok = false;
        try {
          ok = store(JSON.parse(utf8Decode(e.data)));
        } catch {
          ok = false;
        }
        tale.onSaved?.(ok);
      }
      return keep;
    },
    flush() {
      if (match && match.world.party.playTicks > 0) store(match.save());
    },
    dump: () => (match ? match.dump() : EMPTY),
  };
  return tale;
};

/** The runtime keys heroes `slot:<n>`; on the device the one hero is 'solo'. */
const soloHeroes = (raw: unknown): unknown => {
  if (!raw || typeof raw !== 'object') return raw;
  const o = raw as Record<string, unknown>;
  const heroes = o.heroes && typeof o.heroes === 'object' ? (o.heroes as Record<string, unknown>) : {};
  const solo = heroes['slot:0'] ?? heroes['solo'];
  return { ...o, heroes: solo ? { solo } : {} };
};

let pending: LocalTale | null = null;

/** `local()` leaves its tale here; `mount()` in local mode takes it. */
export const offerLocalTale = (t: LocalTale): void => {
  pending = t;
};

export const takeLocalTale = (): LocalTale | null => {
  const t = pending;
  pending = null;
  return t;
};
