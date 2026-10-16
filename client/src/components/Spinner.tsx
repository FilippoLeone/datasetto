import { Loader2 } from 'lucide-preact';
import { cn } from '@/lib/cn';

export const Spinner = ({ size = 18, className }: { size?: number; className?: string }) => (
  <Loader2 size={size} className={cn('animate-spin', className)} aria-hidden="true" />
);
