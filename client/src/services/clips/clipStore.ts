/**
 * Where saved clips live: IndexedDB in this browser (or app), one record per clip
 * plus its video and thumbnail blobs. Nothing leaves the device. The store is capped
 * (CLIP_STORAGE_CAP_BYTES); when a new clip does not fit, the oldest ones go first.
 */

export const CLIP_STORAGE_CAP_BYTES = 500 * 1024 * 1024;

const DB_NAME = 'datasetto-clips';
const DB_VERSION = 1;
const META_STORE = 'clips';
const BLOB_STORE = 'blobs';

export type ClipSourceKind = 'stream' | 'share';

export interface ClipRecord {
  id: string;
  createdAt: number;
  sourceKind: ClipSourceKind;
  /** Channel name for a stream, "<name>'s screen" or "Your screen" for a share. */
  sourceName: string;
  /** Real length of the clip. */
  durationMs: number;
  /** Size of the video blob. */
  bytes: number;
  mimeType: string;
  width: number;
  height: number;
  hasAudio: boolean;
  /** Whether the voice chat was mixed in. */
  includesVoice: boolean;
}

interface ClipBlobs {
  id: string;
  video: Blob;
  thumbnail: Blob | null;
}

export interface EvictionPlan {
  /** Clips to delete, oldest first. */
  remove: string[];
  /** Bytes in store after the removals and the new clip. */
  totalAfter: number;
  /** True when the new clip alone is bigger than the cap: it cannot be stored. */
  tooBig: boolean;
}

/**
 * Which clips have to go so that `incomingBytes` fits under `cap`: the oldest first.
 * Pure, so the rule is unit tested without a database.
 */
export const planEviction = (existing: ReadonlyArray<Pick<ClipRecord, 'id' | 'bytes' | 'createdAt'>>, incomingBytes: number, cap = CLIP_STORAGE_CAP_BYTES): EvictionPlan => {
  if (incomingBytes > cap) return { remove: [], totalAfter: existing.reduce((sum, clip) => sum + clip.bytes, 0), tooBig: true };
  const oldestFirst = [...existing].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  let total = oldestFirst.reduce((sum, clip) => sum + clip.bytes, 0) + incomingBytes;
  const remove: string[] = [];
  for (const clip of oldestFirst) {
    if (total <= cap) break;
    remove.push(clip.id);
    total -= clip.bytes;
  }
  return { remove, totalAfter: total, tooBig: false };
};

export const supportsClipStorage = (): boolean => typeof indexedDB !== 'undefined';

let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading the schema: let go and reopen next time.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('Could not open the clips database'));
    };
    request.onblocked = () => reject(new Error('The clips database is open in another tab'));
  });
  return dbPromise;
};

const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Database request failed'));
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Database transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Database transaction aborted'));
  });

/** Every saved clip, newest first. */
export const listClips = async (): Promise<ClipRecord[]> => {
  const db = await openDb();
  const records = await requestToPromise(db.transaction(META_STORE, 'readonly').objectStore(META_STORE).getAll() as IDBRequest<ClipRecord[]>);
  return records.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
};

export const getClipBlobs = async (id: string): Promise<{ video: Blob; thumbnail: Blob | null } | null> => {
  const db = await openDb();
  const record = (await requestToPromise(db.transaction(BLOB_STORE, 'readonly').objectStore(BLOB_STORE).get(id))) as ClipBlobs | undefined;
  return record ? { video: record.video, thumbnail: record.thumbnail ?? null } : null;
};

export interface SaveClipResult {
  record: ClipRecord;
  /** Clips removed to make room, oldest first. */
  evicted: ClipRecord[];
  totalBytes: number;
}

export class ClipTooBigError extends Error {
  constructor() {
    super('This clip is bigger than the whole clip storage');
  }
}

/** Store a clip, making room by removing the oldest ones when the cap would be exceeded. */
export const saveClip = async (record: ClipRecord, video: Blob, thumbnail: Blob | null): Promise<SaveClipResult> => {
  const db = await openDb();
  const existing = await listClips();
  const plan = planEviction(existing, video.size);
  if (plan.tooBig) throw new ClipTooBigError();
  const evicted = existing.filter((clip) => plan.remove.includes(clip.id));
  const transaction = db.transaction([META_STORE, BLOB_STORE], 'readwrite');
  const meta = transaction.objectStore(META_STORE);
  const blobs = transaction.objectStore(BLOB_STORE);
  for (const id of plan.remove) {
    meta.delete(id);
    blobs.delete(id);
  }
  meta.put(record);
  blobs.put({ id: record.id, video, thumbnail } satisfies ClipBlobs);
  await transactionDone(transaction);
  return { record, evicted, totalBytes: plan.totalAfter };
};

export const deleteClip = async (id: string): Promise<void> => {
  const db = await openDb();
  const transaction = db.transaction([META_STORE, BLOB_STORE], 'readwrite');
  transaction.objectStore(META_STORE).delete(id);
  transaction.objectStore(BLOB_STORE).delete(id);
  await transactionDone(transaction);
};

export const totalClipBytes = (clips: ReadonlyArray<Pick<ClipRecord, 'bytes'>>): number => clips.reduce((sum, clip) => sum + clip.bytes, 0);

/** Lower-case words joined by dashes, for a file name; "clip" when nothing usable is left. */
export const slugify = (value: string): string => {
  const slug = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'clip';
};

const pad = (value: number): string => String(value).padStart(2, '0');

/** `datasetto-clip-<source>-<date>.webm`, the date in local time so files sort by when they were taken. */
export const clipFileName = (sourceName: string, createdAt: number): string => {
  const date = new Date(createdAt);
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `datasetto-clip-${slugify(sourceName)}-${stamp}.webm`;
};

export const newClipId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
