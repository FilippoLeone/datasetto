/**
 * Account save slots (`arcade_saves`): Bellwick Party Tale progress, three slots per owner and game,
 * at most 4 KB each (platform.md §11.1, bellwick.md §6.1). A slot cannot be deleted while a
 * session runs from it (`in-use`).
 */
import type { DB } from '../db/index.js';
import type { Clock } from './clock.js';
import type { GameId } from './core/version.js';

export type SaveSlot = 0 | 1 | 2;

export interface SaveRow {
  slot: SaveSlot;
  version: number;
  data: Uint8Array;
  /** Account ids who played in it (at most 16). */
  members: readonly string[];
  updatedAt: number;
}

/** A game's summary of one save for the slot list (≤ 400 B for all rows together), e.g. `{slot, playSec, hearts}`. */
export type SaveSummary = Readonly<Record<string, string | number | boolean | null | readonly (string | number)[]>>;

export interface Saves {
  list(ownerId: string, game: GameId): readonly SaveRow[];
  get(ownerId: string, game: GameId, slot: SaveSlot): SaveRow | null;
  put(ownerId: string, game: GameId, slot: SaveSlot, version: number, data: Uint8Array, members: readonly string[]): void;
  remove(ownerId: string, game: GameId, slot: SaveSlot): 'ok' | 'in-use';
  inUse(ownerId: string, game: GameId, slot: SaveSlot): boolean;
}

export const SAVE_MAX_BYTES = 4096;
export const SAVE_MAX_MEMBERS = 16;

const isSlot = (slot: unknown): slot is SaveSlot => slot === 0 || slot === 1 || slot === 2;

type RawSave = { slot: SaveSlot; version: number; data: Buffer; members: string; updatedAt: number };

const toRow = (raw: RawSave): SaveRow => {
  let members: string[] = [];
  try {
    const parsed: unknown = JSON.parse(raw.members);
    if (Array.isArray(parsed)) members = parsed.filter((m): m is string => typeof m === 'string');
  } catch {
    members = [];
  }
  return { slot: raw.slot, version: raw.version, data: new Uint8Array(raw.data), members, updatedAt: raw.updatedAt };
};

/**
 * Save slots over `arcade_saves`. `put` throws on a bad slot or version and on data over 4,096 B;
 * members are de-duplicated and only the last 16 are kept. `remove` answers `in-use` while
 * `inUse(owner, game, slot)` says a session runs from that slot.
 */
export const createSaves = (db: DB, clock: Clock, inUse: (ownerId: string, game: GameId, slot: SaveSlot) => boolean): Saves => {
  const cols = 'slot, version, data, members, updated_at AS updatedAt';
  const list = db.prepare(`SELECT ${cols} FROM arcade_saves WHERE owner_id = ? AND game = ? ORDER BY slot`);
  const get = db.prepare(`SELECT ${cols} FROM arcade_saves WHERE owner_id = ? AND game = ? AND slot = ?`);
  const put = db.prepare(
    `INSERT INTO arcade_saves (owner_id, game, slot, version, data, members, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (owner_id, game, slot) DO UPDATE SET
       version = excluded.version, data = excluded.data, members = excluded.members, updated_at = excluded.updated_at`,
  );
  const remove = db.prepare('DELETE FROM arcade_saves WHERE owner_id = ? AND game = ? AND slot = ?');
  return {
    list: (ownerId, game) => (list.all(ownerId, game) as RawSave[]).map(toRow),
    get(ownerId, game, slot) {
      if (!isSlot(slot)) return null;
      const raw = get.get(ownerId, game, slot) as RawSave | undefined;
      return raw ? toRow(raw) : null;
    },
    put(ownerId, game, slot, version, data, members) {
      if (!isSlot(slot)) throw new RangeError('saves: slot must be 0, 1 or 2');
      if (!Number.isSafeInteger(version) || version < 0) throw new RangeError('saves: version must be a non-negative integer');
      if (!(data instanceof Uint8Array)) throw new TypeError('saves: data must be bytes');
      if (data.byteLength > SAVE_MAX_BYTES) throw new RangeError(`saves: ${data.byteLength} B is over the ${SAVE_MAX_BYTES} B limit`);
      const unique: string[] = [];
      for (let i = members.length - 1; i >= 0 && unique.length < SAVE_MAX_MEMBERS; i--) {
        const m = members[i];
        if (typeof m === 'string' && m !== '' && !unique.includes(m)) unique.unshift(m);
      }
      put.run(ownerId, game, slot, version, Buffer.from(data.buffer, data.byteOffset, data.byteLength), JSON.stringify(unique), clock.now());
    },
    remove(ownerId, game, slot) {
      if (inUse(ownerId, game, slot)) return 'in-use';
      remove.run(ownerId, game, slot);
      return 'ok';
    },
    inUse: (ownerId, game, slot) => inUse(ownerId, game, slot),
  };
};
