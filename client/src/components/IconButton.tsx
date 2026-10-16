import type { ButtonHTMLAttributes, ComponentChildren } from 'preact';
import { cn } from '@/lib/cn';

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'size' | 'label'> {
  /** Accessible name, also used as the tooltip. */
  label: string;
  size?: 'sm' | 'md' | 'lg';
  tone?: 'default' | 'danger' | 'success' | 'brand';
  active?: boolean;
  children?: ComponentChildren;
}

// Larger hit areas where the primary pointer is a finger.
const SIZES = { sm: 'h-7 w-7 pointer-coarse:h-9 pointer-coarse:w-9', md: 'h-9 w-9 pointer-coarse:h-10 pointer-coarse:w-10', lg: 'h-11 w-11' };
const TONES = {
  default: 'text-text-muted hover:text-text-bright hover:bg-hover',
  danger: 'text-white bg-danger hover:bg-danger-hover',
  success: 'text-white bg-success hover:bg-[#1a8a49]',
  brand: 'text-white bg-brand hover:bg-brand-hover',
};

export const IconButton = ({ label, size = 'md', tone = 'default', active, className, children, type = 'button', ...rest }: IconButtonProps) => (
  <button
    type={type as 'button'}
    aria-label={label}
    title={label}
    aria-pressed={active}
    className={cn(
      'inline-flex shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40',
      SIZES[size],
      TONES[tone],
      active && tone === 'default' && 'bg-active text-text-bright',
      className as string,
    )}
    {...rest}
  >
    {children}
  </button>
);
