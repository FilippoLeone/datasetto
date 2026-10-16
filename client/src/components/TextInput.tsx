import type { JSX } from 'preact';
import { cn } from '@/lib/cn';

const BASE =
  'w-full rounded-sm bg-base px-3 text-sm text-text-bright placeholder:text-text-faint outline-none transition-shadow focus:ring-2 focus:ring-brand disabled:opacity-50';

export const TextInput = ({ className, ...rest }: JSX.InputHTMLAttributes<HTMLInputElement>) => (
  <input className={cn(BASE, 'h-10', className as string)} {...rest} />
);

export const TextArea = ({ className, ...rest }: JSX.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea className={cn(BASE, 'min-h-[88px] resize-y py-2', className as string)} {...rest} />
);
