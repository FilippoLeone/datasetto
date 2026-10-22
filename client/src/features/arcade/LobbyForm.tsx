import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Check, ChevronDown, Minus, Plus } from 'lucide-preact';
import { Toggle } from '@/components';
import { cn } from '@/lib/cn';
import type { Choice, GameMeta, OptionField, Where } from '@/arcade/catalog';
import { fieldsFor, firstEmptySlot, modesFor, saveSlotField, summaryOfFields, valueOf, type SlotInfo } from './setup';

/**
 * The generic setup form (platform.md §10.6), drawn from a game's catalogue entry so no game code
 * enters the shell: mode cards, at most two main fields, then "More options". The caller adds the
 * one filled button under it (Play in solo, Start in a call), sticky at the bottom.
 */
export interface SetupFormProps {
  meta: GameMeta;
  where: Where;
  mode: string;
  values: Record<string, unknown>;
  onMode(mode: string): void;
  onChange(key: string, value: unknown): void;
  /** Save slots for `saveSlot` fields (online, from `arcade:saves`); undefined while they load. */
  slots?: readonly SlotInfo[];
  /** No mode cards (the lobby panel: the mode was fixed at create). */
  lockMode?: boolean;
  /** 'lobby' leaves out what a forming lobby cannot change (seats, the save slot) and shows every field at once. */
  editable?: 'all' | 'lobby';
}

export const Pills = ({ label, choices, value, onPick }: { label: string; choices: readonly { value: string | number; label: string }[]; value: unknown; onPick(v: string | number): void }) => (
  <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
    {choices.map((choice) => (
      <button
        key={String(choice.value)}
        type="button"
        role="radio"
        aria-checked={value === choice.value}
        onClick={() => onPick(choice.value)}
        className={cn('min-h-11 rounded-md px-3 text-sm font-medium transition-colors', value === choice.value ? 'bg-brand text-white' : 'bg-input text-text hover:bg-hover')}
      >
        {choice.label}
      </button>
    ))}
  </div>
);

/** A full-width radio card: the mode cards and the save slots. */
const RadioCard = ({ checked, disabled, label, detail, onPick, data }: { checked: boolean; disabled?: boolean; label: string; detail?: string | null; onPick(): void; data?: Record<string, string> }) => (
  <button
    type="button"
    role="radio"
    aria-checked={checked}
    disabled={disabled}
    onClick={onPick}
    className={cn(
      'flex min-h-16 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
      checked ? 'bg-brand-soft ring-2 ring-brand' : 'bg-sidebar ring-1 ring-border-strong enabled:hover:bg-hover',
    )}
    {...data}
  >
    <span className="min-w-0 flex-1">
      <span className="block text-sm font-semibold text-text-bright">{label}</span>
      {detail && <span className="block text-xs text-text-muted">{detail}</span>}
    </span>
    <Check size={18} className={cn('shrink-0 text-text-bright', !checked && 'invisible')} aria-hidden="true" />
  </button>
);

/** Choices with a hint: a grid of small cards, 2 columns (Stakes) or 3 for three choices (Bot level). */
const HintCards = ({ label, choices, value, onPick }: { label: string; choices: readonly Choice[]; value: unknown; onPick(v: string | number): void }) => (
  <div role="radiogroup" aria-label={label} className={cn('grid gap-2', choices.length === 3 ? 'grid-cols-3' : 'grid-cols-2')}>
    {choices.map((choice) => (
      <button
        key={String(choice.value)}
        type="button"
        role="radio"
        aria-checked={value === choice.value}
        onClick={() => onPick(choice.value)}
        className={cn(
          'flex min-h-14 flex-col justify-center rounded-lg px-3 py-1.5 text-left transition-colors',
          value === choice.value ? 'bg-brand-soft ring-2 ring-brand' : 'bg-sidebar ring-1 ring-border-strong hover:bg-hover',
        )}
      >
        <span className="text-sm font-semibold text-text-bright">{choice.label}</span>
        {choice.hint && <span className="text-xs text-text-muted">{choice.hint}</span>}
      </button>
    ))}
  </div>
);

const STEP = 'flex h-11 w-11 items-center justify-center rounded-md bg-input text-text-bright transition-colors hover:bg-hover disabled:opacity-40';

/** − value + over numeric choices (Seats, Fighters). */
const Stepper = ({ label, choices, value, onPick }: { label: string; choices: readonly Choice[]; value: unknown; onPick(v: string | number): void }) => {
  const i = Math.max(0, choices.findIndex((c) => c.value === value));
  const name = label.toLowerCase();
  return (
    <div role="group" aria-label={label} className="flex items-center gap-3">
      <button type="button" className={STEP} aria-label={'Fewer ' + name} disabled={i <= 0} onClick={() => onPick(choices[i - 1]!.value)}>
        <Minus size={18} />
      </button>
      <output className="min-w-8 text-center text-base font-semibold text-text-bright tabular-nums">{choices[i]?.label}</output>
      <button type="button" className={STEP} aria-label={'More ' + name} disabled={i >= choices.length - 1} onClick={() => onPick(choices[i + 1]!.value)}>
        <Plus size={18} />
      </button>
    </div>
  );
};

/** A native select for long lists (Arena). */
const SelectControl = ({ label, choices, value, onPick }: { label: string; choices: readonly Choice[]; value: unknown; onPick(v: string | number): void }) => (
  <span className="relative block">
    <select
      aria-label={label}
      value={String(Math.max(0, choices.findIndex((c) => c.value === value)))}
      onChange={(event) => onPick(choices[Number((event.target as HTMLSelectElement).value)]!.value)}
      className="h-11 w-full appearance-none rounded-md bg-input pr-9 pl-3 text-sm text-text-bright outline-none focus:ring-2 focus:ring-brand"
    >
      {choices.map((choice, i) => (
        <option key={String(choice.value)} value={String(i)}>
          {choice.label}
        </option>
      ))}
    </select>
    <ChevronDown size={16} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-text-muted" />
  </span>
);

const slotDate = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

const Labelled = ({ field, warn, children }: { field: OptionField; warn?: boolean; children: ComponentChildren }) => (
  <div className="flex flex-col gap-1.5" data-arcade-field={field.key}>
    <span className="flex flex-col">
      <span className="text-xs font-semibold tracking-wide text-text-muted uppercase">{field.label}</span>
      {field.hint && <span className={cn('text-xs', warn ? 'text-[#ffd38a]' : 'text-text-muted')}>{field.hint}</span>}
    </span>
    {children}
  </div>
);

export const SetupForm = ({ meta, where, mode, values, onMode, onChange, slots, lockMode, editable = 'all' }: SetupFormProps) => {
  const [moreOpen, setMoreOpen] = useState(false);
  const modes = modesFor(meta, where);
  const fields = fieldsFor(meta, where, mode, values, editable);
  const slotField = saveSlotField(meta, where, mode);
  const empty = slots ? firstEmptySlot(slots) : null;
  // A new tale goes to the first empty slot by itself: "Replaces" only shows when every slot is used.
  const auto = (field: OptionField) => slotField?.into === field.key && empty !== null;
  const main = fields.main.filter((f) => !auto(f));
  const more = fields.more.filter((f) => !auto(f));

  const render = (field: OptionField) => {
    const value = valueOf(field, values);
    if (field.kind === 'toggle') {
      return (
        <div key={field.key + field.kind} data-arcade-field={field.key}>
          <Toggle label={field.label} description={field.hint} checked={value === true} onChange={(v) => onChange(field.key, v)} />
        </div>
      );
    }
    if (field.kind === 'saveSlot') {
      const picked = values[field.key];
      return (
        <Labelled key={field.key} field={field}>
          <div role="radiogroup" aria-label={field.label} className="flex flex-col gap-2">
            {slots === undefined && <p className="text-sm text-text-muted">Looking up your tales…</p>}
            {[...(slots ?? [])]
              .sort((a, b) => a.slot - b.slot)
              .map((s) => (
                <RadioCard
                  key={s.slot}
                  checked={picked === s.slot}
                  disabled={s.inUse}
                  label={'Continue Slot ' + (s.slot + 1) + ' · ' + slotDate(s.updatedAt) + (s.inUse ? ' (in use)' : '')}
                  onPick={() => onChange(field.key, s.slot)}
                  data={{ 'data-arcade-slot': String(s.slot) }}
                />
              ))}
            <RadioCard
              checked={picked === 'new'}
              label={'Start a new ' + field.label.toLowerCase()}
              detail={picked === 'new' && empty !== null ? 'It will be saved in Slot ' + (empty + 1) : null}
              onPick={() => onChange(field.key, 'new')}
              data={{ 'data-arcade-slot': 'new' }}
            />
          </div>
        </Labelled>
      );
    }
    const pick = (v: string | number) => onChange(field.key, v);
    const control = field.control ?? 'pills';
    return (
      <Labelled key={field.key + field.kind} field={field} warn={slotField?.into === field.key}>
        {control === 'stepper' ? (
          <Stepper label={field.label} choices={field.choices} value={value} onPick={pick} />
        ) : control === 'select' ? (
          <SelectControl label={field.label} choices={field.choices} value={value} onPick={pick} />
        ) : field.choices.some((c) => c.hint) && field.choices.length <= 4 ? (
          <HintCards label={field.label} choices={field.choices} value={value} onPick={pick} />
        ) : (
          <Pills label={field.label} choices={field.choices.map((c) => ({ value: c.value, label: c.hint ? c.label + ' · ' + c.hint : c.label }))} value={value} onPick={pick} />
        )}
      </Labelled>
    );
  };

  const moreSummary = summaryOfFields(more, values);
  return (
    <div className="flex flex-col gap-5" data-arcade-form={meta.id}>
      {!lockMode && modes.length > 1 && (
        <div role="radiogroup" aria-label="Mode" className="flex flex-col gap-2">
          {modes.map((m) => (
            <RadioCard key={m.id} checked={m.id === mode} label={m.label} detail={m.blurb} onPick={() => onMode(m.id)} data={{ 'data-arcade-mode': m.id }} />
          ))}
        </div>
      )}
      {editable === 'lobby' ? (
        fields.all.filter((f) => !auto(f)).map(render)
      ) : (
        <>
          {main.map(render)}
          {more.length > 0 && (
            <div className="flex flex-col gap-4">
              <button
                type="button"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((open) => !open)}
                className="-mx-2 flex min-h-11 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-hover"
                data-arcade-more
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-text-bright">More options</span>
                  {moreSummary && <span className="text-text-muted">{' · ' + moreSummary}</span>}
                </span>
                <ChevronDown size={18} className={cn('shrink-0 text-text-muted transition-transform', moreOpen && 'rotate-180')} />
              </button>
              {moreOpen && more.map(render)}
            </div>
          )}
        </>
      )}
    </div>
  );
};
