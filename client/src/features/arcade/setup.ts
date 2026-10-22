/**
 * Game setups from the catalogue's fields (platform.md §10.6): which fields a mode shows here, the
 * cfg it sends, the summary line on the game cards, and the setup remembered per place
 * (`datasetto.arcade.setup.v1`: solo and call setups apart, so solo bots never turn on bots online).
 * Remembered only when Play or Start succeeds, so a card always plays what its options screen shows.
 * Storage goes through `lib/storage` (never throws), not the runtime's store: this module is in the
 * shell chunk, and importing the runtime would load the whole runtime chunk with the sheet.
 *
 * The cfg's shape is the servers' (lamplight `parseCfg`, fuseyard's strict `cfgSchema`, bellwick's
 * `bellwickCfgSchema`): only fields of the mode and place, hidden fields with their default.
 */
import { defaultOptions, type GameMeta, type OptionField, type Where } from '@/arcade/catalog';
import { Storage } from '@/lib/storage';

export interface Setup {
  mode: string;
  values: Record<string, unknown>;
}

/** One `arcade:saves` slot as the setup reads it. */
export interface SlotInfo {
  slot: number;
  updatedAt: number;
  inUse: boolean;
}

export const SETUP_KEY = 'datasetto.arcade.setup.v1';
/** Account save slots per game (Bellwick: Slot 1–3). */
export const SLOT_COUNT = 3;

/** The modes offered here. */
export const modesFor = (meta: GameMeta, where: Where): GameMeta['modes'] => meta.modes.filter((m) => (where === 'online' ? m.online : m.offline));

/** The fields this mode sends from this place, in catalogue order. */
export const cfgFields = (meta: GameMeta, where: Where, mode: string): OptionField[] =>
  meta.options.filter((f) => (!f.when?.mode || f.when.mode.includes(mode)) && (!f.when?.where || f.when.where === where));

const isSlot = (v: unknown): v is number | 'new' => v === 'new' || (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < SLOT_COUNT);

const defaultOf = (field: OptionField): unknown => (field.kind === 'saveSlot' ? 'new' : field.default);

/** A field's value, or its default when it is missing or not one of its choices. */
export const valueOf = (field: OptionField, values: Record<string, unknown>): unknown => {
  const v = values[field.key];
  if (field.kind === 'choice') return field.choices.some((c) => c.value === v) ? v : field.default;
  if (field.kind === 'toggle') return typeof v === 'boolean' ? v : field.default;
  return isSlot(v) ? v : 'new';
};

/** Is each field shown: the field it depends on is shown and sends one of the listed values. */
const visibility = (fields: readonly OptionField[], values: Record<string, unknown>): ((field: OptionField) => boolean) => {
  const memo = new Map<OptionField, boolean>();
  const shown = (field: OptionField, depth: number): boolean => {
    const known = memo.get(field);
    if (known !== undefined) return known;
    const dep = field.when?.field;
    let ok = true;
    if (dep) {
      const parent = fields.find((f) => f.key === dep.key && f !== field);
      ok = Boolean(parent) && depth < 8 && dep.in.includes(sent(parent as OptionField, depth + 1));
    }
    memo.set(field, ok);
    return ok;
  };
  const sent = (field: OptionField, depth: number): unknown => (shown(field, depth) ? valueOf(field, values) : defaultOf(field));
  return (field) => shown(field, 0);
};

export interface Fields {
  /** Every visible field, in catalogue order. */
  all: OptionField[];
  /** On the setup screen. */
  main: OptionField[];
  /** Under "More options". */
  more: OptionField[];
}

/** The fields a save slot fills by itself (Bellwick's "new tale in"). */
const companions = (fields: readonly OptionField[]): Set<string> => new Set(fields.flatMap((f) => (f.kind === 'saveSlot' && f.into ? [f.into] : [])));

/**
 * The visible fields, split into main and "More options". `editable: 'lobby'` keeps what a forming
 * lobby can change: never the seat count (`setConfig` does not resize seats) nor the save slot.
 */
export const fieldsFor = (meta: GameMeta, where: Where, mode: string, values: Record<string, unknown>, editable: 'all' | 'lobby' = 'all'): Fields => {
  const fields = cfgFields(meta, where, mode);
  const shown = visibility(fields, values);
  const fixed = editable === 'lobby' ? companions(fields) : new Set<string>();
  const all = fields.filter((f) => shown(f) && !(editable === 'lobby' && (f.setsSeats || f.kind === 'saveSlot' || fixed.has(f.key))));
  const inMore = (f: OptionField) => f.more === true || f.more === where;
  return { all, main: all.filter((f) => !inMore(f)), more: all.filter(inMore) };
};

/** Is there anything to choose here (more than one mode, or a visible field)? Decides the Options button. */
export const hasOptions = (meta: GameMeta, where: Where, setup: Setup): boolean =>
  modesFor(meta, where).length > 1 || fieldsFor(meta, where, setup.mode, setup.values).all.length > 0;

/** The cfg sent: this mode's and place's keys only; hidden fields and unknown values send the default. */
export const cfgFor = (meta: GameMeta, where: Where, mode: string, values: Record<string, unknown>): Record<string, unknown> => {
  const fields = cfgFields(meta, where, mode);
  const shown = visibility(fields, values);
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field.key] = shown(field) ? valueOf(field, values) : defaultOf(field);
  return out;
};

/** "Regular bots", "first to 3", "Continue Slot 2"; null when it adds nothing (a toggle that is off, no slot chosen yet). */
export const fieldSummary = (field: OptionField, values: Record<string, unknown>): string | null => {
  const v = valueOf(field, values);
  let text: string | null;
  if (field.kind === 'choice') text = field.choices.find((c) => c.value === v)?.label ?? String(v);
  else if (field.kind === 'toggle') text = v === true ? field.label : null;
  else text = !isSlot(values[field.key]) ? null : v === 'new' ? 'New ' + field.label.toLowerCase() : 'Continue Slot ' + (Number(v) + 1);
  return text === null ? null : field.sum ? field.sum.replace('#', text) : text;
};

/** The labels of some fields, joined: "Pebble 5/10 · 6 seats". */
export const summaryOfFields = (fields: readonly OptionField[], values: Record<string, unknown>): string =>
  fields
    .map((f) => fieldSummary(f, values))
    .filter((s): s is string => Boolean(s))
    .join(' · ');

/**
 * "Cash table · Pebble 5/10": the mode, then each visible main field (every visible field with `all`;
 * `editable: 'lobby'` leaves out what was fixed at create).
 */
export const summaryOf = (meta: GameMeta, where: Where, mode: string, values: Record<string, unknown>, opts: { all?: boolean; editable?: 'all' | 'lobby' } = {}): string => {
  const fields = fieldsFor(meta, where, mode, values, opts.editable);
  const label = meta.modes.find((m) => m.id === mode)?.label ?? mode;
  const rest = summaryOfFields(opts.all ? fields.all : fields.main, values);
  return rest ? label + ' · ' + rest : label;
};

// Remembered setups --------------------------------------------------------------------------------

interface Stored {
  v: 1;
  offline: Record<string, Setup>;
  online: Record<string, Setup>;
}

/** Kept here when storage is blocked or full (the setup then lasts as long as the page). */
let memory: Stored | null = null;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const parsePlace = (v: unknown): Record<string, Setup> => {
  const out: Record<string, Setup> = {};
  if (!isRecord(v)) return out;
  for (const [game, entry] of Object.entries(v)) {
    if (isRecord(entry) && typeof entry.mode === 'string' && isRecord(entry.values)) out[game] = { mode: entry.mode, values: entry.values };
  }
  return out;
};

const readStored = (): Stored => {
  if (memory) return memory;
  const raw = Storage.get<unknown>(SETUP_KEY, null);
  if (isRecord(raw) && raw.v === 1) return { v: 1, offline: parsePlace(raw.offline), online: parsePlace(raw.online) };
  return { v: 1, offline: {}, online: {} };
};

/** What was last played here, as stored (no defaults): null the first time. */
export const storedSetup = (meta: GameMeta, where: Where): Setup | null => readStored()[where][meta.id] ?? null;

/**
 * The setup one tap plays: the remembered mode if it is still offered here (else the first), with
 * the remembered values laid over the defaults. Unknown keys go, values outside the choices fall
 * back to the default. A save slot has no default: without a remembered one it is left out, and
 * the shell picks one from the save list (`withSaveSlot`).
 */
export const resolveSetup = (meta: GameMeta, where: Where): Setup => {
  const modes = modesFor(meta, where);
  const stored = storedSetup(meta, where);
  const mode = stored && modes.some((m) => m.id === stored.mode) ? stored.mode : (modes[0]?.id ?? meta.modes[0]?.id ?? '');
  const values = defaultOptions(meta, mode, where);
  const placed = meta.options.filter((f) => !f.when?.where || f.when.where === where);
  const here = cfgFields(meta, where, mode);
  for (const field of here) if (field.kind === 'saveSlot') delete values[field.key];
  for (const [key, v] of Object.entries(stored?.values ?? {})) {
    const field = here.find((f) => f.key === key);
    if (field) {
      if (field.kind !== 'saveSlot') values[key] = valueOf(field, { [key]: v });
      else if (isSlot(v)) values[key] = v;
    } else if (placed.some((f) => f.key === key && f.kind !== 'saveSlot' && valueOf(f, { [key]: v }) === v)) {
      // Another mode's value (Stakes while the Cup is chosen): kept for when that mode comes back.
      values[key] = v;
    }
  }
  return { mode, values };
};

/** Remember a setup that just started (Play or Start succeeded). */
export const saveSetup = (meta: GameMeta, where: Where, setup: Setup): void => {
  const known = new Set(meta.options.map((f) => f.key));
  const values: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(setup.values)) if (known.has(key) && v !== undefined) values[key] = v;
  const next = readStored();
  next[where] = { ...next[where], [meta.id]: { mode: setup.mode, values } };
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify(next));
    memory = null;
  } catch {
    memory = next;
  }
};

// Save slots (Bellwick's Party Tale) ---------------------------------------------------------------

/** This setup's save-slot field, if any: a one-tap start reads the save list first. */
export const saveSlotField = (meta: GameMeta, where: Where, mode: string): Extract<OptionField, { kind: 'saveSlot' }> | null =>
  (cfgFields(meta, where, mode).find((f) => f.kind === 'saveSlot') as Extract<OptionField, { kind: 'saveSlot' }> | undefined) ?? null;

export const firstEmptySlot = (slots: readonly SlotInfo[]): number | null => {
  for (let k = 0; k < SLOT_COUNT; k += 1) if (!slots.some((s) => s.slot === k)) return k;
  return null;
};

/**
 * The tale one tap plays: continue the most recently played slot that is not in use, or start a new
 * tale in the first empty slot (always when the remembered choice is New). Nothing is overwritten:
 * null when no slot is free, and the shell opens the setup screen instead.
 */
export const pickSaveSlot = (slots: readonly SlotInfo[], remembered: unknown): { slot: number | 'new'; into: number | null } | null => {
  if (remembered !== 'new') {
    const free = slots.filter((s) => !s.inUse).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (free) return { slot: free.slot, into: null };
  }
  const empty = firstEmptySlot(slots);
  return empty === null ? null : { slot: 'new', into: empty };
};

/** The values with the save slot picked from the save list; null when nothing is safe to pick. */
export const withSaveSlot = (meta: GameMeta, where: Where, setup: Setup, slots: readonly SlotInfo[]): Record<string, unknown> | null => {
  const field = saveSlotField(meta, where, setup.mode);
  if (!field) return setup.values;
  const pick = pickSaveSlot(slots, setup.values[field.key]);
  if (!pick) return null;
  const out = { ...setup.values, [field.key]: pick.slot };
  if (field.into && pick.into !== null) out[field.into] = pick.into;
  return out;
};

/** A new tale chosen on the setup screen goes to the first empty slot (the "Replaces" field shows only when none is). */
export const fillNewTale = (meta: GameMeta, where: Where, setup: Setup, slots: readonly SlotInfo[] | undefined): Record<string, unknown> => {
  const field = saveSlotField(meta, where, setup.mode);
  const empty = slots ? firstEmptySlot(slots) : null;
  if (!field?.into || valueOf(field, setup.values) !== 'new' || empty === null) return setup.values;
  return { ...setup.values, [field.key]: 'new', [field.into]: empty };
};
