/**
 * The world: party, heroes and the rooms in memory (bellwick.md §2.2). A room ticks while it holds an
 * active or downed hero; a room that empties is frozen for 5 s (kept, not stepped), then freed so only
 * the party flags remember it. Shared by the server runtime and the offline runtime.
 */
import { fnvMix, FNV_OFFSET } from '../../hash.js';
import { newHero, newParty, type HeroRec, type Party, type Room } from './state.js';

export interface World {
  seed: number;
  tick: number;
  party: Party;
  heroes: HeroRec[];
  /** Rooms in memory, by room id. */
  rooms: (Room | null)[];
  /** How often each room has been activated (seeds its RNG). */
  activations: Int32Array;
  /** Tick of the last change to shared progress not yet saved, or −1. */
  dirtyAt: number;
  /** Tick of the last save. */
  savedAt: number;
  /** A save was asked for at once (lantern, victory). */
  saveNow: boolean;
  /** Ticks since everyone not resting went down (−1: not a wipe). */
  wipeT: number;
  /** The boss is down this session (Victory sent). */
  victory: boolean;
  /** Roster cadence. */
  rosterT: number;
}

export const newWorld = (seed: number): World => {
  const heroes: HeroRec[] = [];
  for (let i = 0; i < 4; i += 1) heroes.push(newHero(i));
  const rooms: (Room | null)[] = [];
  for (let i = 0; i < 64; i += 1) rooms.push(null);
  return {
    seed: seed >>> 0,
    tick: 0,
    party: newParty(),
    heroes,
    rooms,
    activations: new Int32Array(64),
    dirtyAt: -1,
    savedAt: 0,
    saveNow: false,
    wipeT: -1,
    victory: false,
    rosterT: 0,
  };
};

/** The room RNG seed: fnv(partySeed, roomId, activation), never 0. */
export const roomSeed = (seed: number, room: number, activation: number): number => {
  const h = fnvMix(fnvMix(fnvMix(FNV_OFFSET, seed), room), activation);
  return h === 0 ? 1 : h;
};

/** Marks shared progress as changed (autosave 2 s later). */
export const touchProgress = (w: World): void => {
  if (w.dirtyAt < 0) w.dirtyAt = w.tick;
};
