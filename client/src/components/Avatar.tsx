import { useMemo } from 'preact/hooks';
import { cn } from '@/lib/cn';
import { generateIdenticonDataUri } from '@/lib/avatar';

interface AvatarProps {
  /** Stable seed for the generated avatar (account id). */
  seed: string;
  name: string;
  src?: string | null;
  size?: number;
  status?: 'online' | 'idle' | 'offline' | null;
  speaking?: boolean;
  className?: string;
}

export const Avatar = ({ seed, name, src, size = 32, status = null, speaking, className }: AvatarProps) => {
  const fallback = useMemo(() => generateIdenticonDataUri(seed || name), [seed, name]);
  const dot = Math.max(8, Math.round(size * 0.3));
  return (
    <span className={cn('relative inline-block shrink-0', className)} style={{ width: size, height: size }}>
      <img
        src={src || fallback}
        alt=""
        width={size}
        height={size}
        className={cn('block rounded-full object-cover transition-shadow', speaking && 'speaking-ring')}
        style={{ width: size, height: size }}
        draggable={false}
      />
      {status && (
        <span
          className={cn(
            'absolute right-0 bottom-0 rounded-full border-2 border-sidebar',
            status === 'online' && 'bg-online',
            status === 'idle' && 'bg-idle',
            status === 'offline' && 'bg-text-faint',
          )}
          style={{ width: dot, height: dot }}
        />
      )}
    </span>
  );
};
