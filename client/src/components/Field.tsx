import type { ComponentChildren } from 'preact';

interface FieldProps {
  label: string;
  hint?: string;
  error?: string | null;
  children: ComponentChildren;
}

/** Label + control + hint/error, the standard form row. */
export const Field = ({ label, hint, error, children }: FieldProps) => (
  <label className="block py-2">
    <span className="mb-1.5 block text-xs font-semibold tracking-wide text-text-muted uppercase">{label}</span>
    {children}
    {error ? <span className="mt-1 block text-xs text-danger">{error}</span> : hint ? <span className="mt-1 block text-xs text-text-faint">{hint}</span> : null}
  </label>
);
