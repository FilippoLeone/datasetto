import { Toggle } from '@/components';
import { cn } from '@/lib/cn';
import type { GameMeta, OptionField } from '@/arcade/catalog';

/**
 * The generic lobby options form (plan.md §1.3 #23), drawn from a game's catalogue entry so no
 * game code enters the shell. Used for "Start a game" online and "Solo vs bots" offline.
 */
export interface LobbyFormProps {
  meta: GameMeta;
  /** Offline lists only offline modes. */
  where: 'online' | 'offline';
  mode: string;
  values: Record<string, unknown>;
  onMode(mode: string): void;
  onChange(key: string, value: unknown): void;
  /** Save slots for `saveSlot` fields (online, from `arcade:saves`). */
  slots?: readonly { slot: number; label: string }[];
}

const Pills = ({ label, choices, value, onPick }: { label: string; choices: readonly { value: string | number; label: string }[]; value: unknown; onPick(v: string | number): void }) => (
  <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
    {choices.map((choice) => (
      <button
        key={String(choice.value)}
        type="button"
        role="radio"
        aria-checked={value === choice.value}
        onClick={() => onPick(choice.value)}
        className={cn(
          'min-h-11 rounded-md px-3 text-sm font-medium transition-colors',
          value === choice.value ? 'bg-brand text-white' : 'bg-input text-text hover:bg-hover',
        )}
      >
        {choice.label}
      </button>
    ))}
  </div>
);

const fieldShown = (field: OptionField, mode: string): boolean => !field.when || field.when.mode.includes(mode);

export const LobbyForm = ({ meta, where, mode, values, onMode, onChange, slots }: LobbyFormProps) => {
  const modes = meta.modes.filter((m) => (where === 'online' ? m.online : m.offline));
  return (
    <div className="flex flex-col gap-4">
      {modes.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold tracking-wide text-text-muted uppercase">Mode</span>
          <Pills label="Mode" choices={modes.map((m) => ({ value: m.id, label: m.label }))} value={mode} onPick={(v) => onMode(String(v))} />
        </div>
      )}
      {meta.options
        .filter((field) => fieldShown(field, mode))
        .map((field) => {
          if (field.kind === 'toggle') {
            return <Toggle key={field.key} label={field.label} checked={Boolean(values[field.key] ?? field.default)} onChange={(v) => onChange(field.key, v)} />;
          }
          const choices =
            field.kind === 'choice' ? field.choices : [{ value: 'new', label: 'New' }, ...(slots ?? []).map((s) => ({ value: s.slot, label: s.label }))];
          return (
            <div key={field.key} className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold tracking-wide text-text-muted uppercase">{field.label}</span>
              <Pills label={field.label} choices={choices} value={values[field.key] ?? (field.kind === 'choice' ? field.default : 'new')} onPick={(v) => onChange(field.key, v)} />
            </div>
          );
        })}
    </div>
  );
};
