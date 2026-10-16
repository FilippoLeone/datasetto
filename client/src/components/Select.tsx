import { ChevronDown } from 'lucide-preact';
import { cn } from '@/lib/cn';

interface Option {
  value: string;
  label: string;
}

interface SelectProps {
  label?: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

export const Select = ({ label, value, options, onChange, disabled, className }: SelectProps) => (
  <label className={cn('block py-2', className)}>
    {label && <span className="mb-1.5 block text-sm font-medium text-text-bright">{label}</span>}
    <span className="relative block">
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange((event.target as HTMLSelectElement).value)}
        className="h-10 w-full appearance-none rounded-sm bg-base pr-9 pl-3 text-sm text-text-bright outline-none focus:ring-2 focus:ring-brand disabled:opacity-50"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown size={16} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-text-muted" />
    </span>
  </label>
);
