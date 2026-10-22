/**
 * Solo Tale saves on this device (bellwick.md §6.3): `datasetto.arcade.bellwick.saves.v1` holds three
 * slots plus the "Party copy" a restarted server hands over. Each is a SaveV1 of at most 4 KB, validated
 * on read. Every access goes through the runtime store (try/catch with an in-memory fallback).
 */
import { parseSave, type SaveV1 } from '@arcade/core/bellwick/codec';
import { readLocal, removeLocal, storageAvailable, writeLocal } from '@/arcade/runtime/store';

export const SAVES_KEY = 'datasetto.arcade.bellwick.saves.v1';

/** Slots 0–2, and 3 for the Party copy. */
export type TaleSlot = 0 | 1 | 2 | 3;
export const PARTY_COPY: TaleSlot = 3;

export interface LocalTales {
  slots: (SaveV1 | null)[];
}

const parse = (raw: unknown): LocalTales | null => {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || !Array.isArray(o.slots)) return null;
  const slots: (SaveV1 | null)[] = [];
  for (let i = 0; i < 4; i += 1) slots.push(o.slots[i] ? parseSave(o.slots[i]) : null);
  return { slots };
};

export const loadTales = (): LocalTales => readLocal(SAVES_KEY, parse) ?? { slots: [null, null, null, null] };

/** Stores a tale; false when it stays in memory only (no storage in this window) or is too big. */
export const writeTale = (slot: TaleSlot, save: SaveV1): boolean => {
  if (JSON.stringify(save).length > 4096) return false;
  const tales = loadTales();
  tales.slots[slot] = save;
  return writeLocal(SAVES_KEY, { v: 1, slots: tales.slots });
};

export const eraseTale = (slot: TaleSlot): void => {
  const tales = loadTales();
  tales.slots[slot] = null;
  if (tales.slots.every((s) => s === null)) removeLocal(SAVES_KEY);
  else writeLocal(SAVES_KEY, { v: 1, slots: tales.slots });
};

export const savesAvailable = (): boolean => storageAvailable();
