import { useMemo } from 'preact/hooks';
import { cn } from '@/lib/cn';
import { generateIdenticonDataUri } from '@/lib/avatar';
import { resolveAvatarUrl } from '@/lib/avatarUrl';

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
    // The speaking ring sits on the wrapper: its pulse is a ::before layer the compositor animates (an <img> has no pseudo-elements).
    <span className={cn('relative inline-block shrink-0', speaking && 'speaking-ring', className)} style={{ width: `${size}px`, height: `${size}px` }}>
      <img
        src={resolveAvatarUrl(src) || fallback}
        alt=""
        width={size}
        height={size}
        className="block rounded-full object-cover transition-shadow"
        style={{ width: `${size}px`, height: `${size}px` }}
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
          style={{ width: `${dot}px`, height: `${dot}px` }}
        />
      )}
    </span>
  );
};
