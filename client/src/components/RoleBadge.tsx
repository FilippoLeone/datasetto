import { cn } from '@/lib/cn';
import { formatRole, primaryRole } from '@/lib/format';
import type { RoleName } from '@/types/protocol';

const STYLES: Record<RoleName, string> = {
  superuser: 'bg-[#f23f43]/20 text-[#ff8a8d]',
  admin: 'bg-brand/25 text-[#c9cdfb]',
  moderator: 'bg-success/20 text-[#7be39b]',
  streamer: 'bg-warning/20 text-[#ffd38a]',
  user: 'bg-active text-text-muted',
};

interface RoleBadgeProps {
  roles?: readonly string[] | null;
  /** Hide the badge for plain members. */
  hideMember?: boolean;
  className?: string;
}

export const RoleBadge = ({ roles, hideMember = true, className }: RoleBadgeProps) => {
  const role = primaryRole(roles);
  if (hideMember && role === 'user') return null;
  return (
    <span className={cn('inline-flex items-center rounded-sm px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide', STYLES[role], className)}>
      {formatRole(role)}
    </span>
  );
};
