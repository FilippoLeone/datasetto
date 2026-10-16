import { cn } from '@/lib/cn';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}

export const Toggle = ({ checked, onChange, label, description, disabled }: ToggleProps) => (
  <label className={cn('flex cursor-pointer items-center justify-between gap-4 py-2', disabled && 'cursor-not-allowed opacity-50')}>
    <span className="min-w-0">
      <span className="block text-sm font-medium text-text-bright">{label}</span>
      {description && <span className="block text-xs text-text-muted">{description}</span>}
    </span>
    <span
      role="switch"
      aria-checked={checked}
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && onChange(!checked)}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          onChange(!checked);
        }
      }}
      className={cn('relative h-6 w-10 shrink-0 rounded-full transition-colors', checked ? 'bg-success' : 'bg-active')}
    >
      <span className={cn('absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-all', checked ? 'left-5' : 'left-1')} />
    </span>
  </label>
);
