import type { ButtonHTMLAttributes, ComponentChildren } from 'preact';
import { cn } from '@/lib/cn';
import { Spinner } from './Spinner';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'size'> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  block?: boolean;
  children?: ComponentChildren;
}

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-hover',
  secondary: 'bg-active text-text-bright hover:bg-[#4e5058]',
  danger: 'bg-danger text-white hover:bg-danger-hover',
  success: 'bg-success text-white hover:bg-[#1a8a49]',
  ghost: 'bg-transparent text-text hover:bg-hover',
};

// Taller on touch screens so every text button is a 40px target.
const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm pointer-coarse:h-10',
  md: 'h-9 px-4 text-sm pointer-coarse:h-11',
  lg: 'h-11 px-5 text-base pointer-coarse:h-12',
};

export const Button = ({ variant = 'primary', size = 'md', loading, block, className, children, disabled, type = 'button', ...rest }: ButtonProps) => (
  <button
    type={type as 'button' | 'submit' | 'reset'}
    disabled={disabled || loading}
    className={cn(
      'inline-flex items-center justify-center gap-2 rounded-sm font-medium transition-[background-color,color,opacity,transform] duration-150 ease-out select-none enabled:active:scale-[0.98] motion-reduce:enabled:active:scale-100',
      'disabled:cursor-not-allowed disabled:opacity-50',
      VARIANTS[variant],
      SIZES[size],
      block && 'w-full',
      className as string,
    )}
    {...rest}
  >
    {loading && <Spinner size={14} />}
    {children}
  </button>
);
