import { Hash, Settings, Users } from 'lucide-preact';
import { cn } from '@/lib/cn';
import { totalMentions, totalUnread } from '@/state/channels';
import { membersOpen, openModal, sidebarOpen } from '@/state/ui';

interface ItemProps {
  label: string;
  icon: preact.ComponentChildren;
  active?: boolean;
  onClick: () => void;
  badge?: number;
  /** The badge counts @mentions of us (brand-coloured, "@" in front) rather than unread messages. */
  mention?: boolean;
}

const Item = ({ label, icon, active, onClick, badge, mention }: ItemProps) => (
  <button
    type="button"
    aria-label={label}
    aria-pressed={active}
    onClick={onClick}
    className={cn('relative flex h-14 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium transition-colors duration-150 active:bg-hover', active ? 'text-text-bright' : 'text-text-muted')}
  >
    {icon}
    <span aria-hidden="true">{label}</span>
    {/* Keyed on the count so every change pops the badge. */}
    {badge ? (
      <span
        key={(mention ? '@' : '') + badge}
        className={cn('absolute top-1 right-[calc(50%-18px)] rounded-full px-1.5 text-[10px] font-bold text-white animate-badge-pop', mention ? 'bg-brand' : 'bg-live')}
        aria-label={badge + (mention ? (badge === 1 ? ' mention' : ' mentions') : ' unread')}
      >
        {mention ? '@' + badge : badge}
      </span>
    ) : null}
  </button>
);

/**
 * Bottom navigation on phones held upright. App.tsx leaves it out while the
 * keyboard is up (the composer needs the room) and in landscape (the header
 * buttons do the same job and the height is short).
 */
export const MobileToolbar = () => {
  const mentionCount = totalMentions.value;
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-border bg-base safe-bottom safe-x" aria-label="Navigation">
      {/* One drawer at a time: opening one closes the other. */}
      <Item
        label="Channels"
        icon={<Hash size={20} />}
        active={sidebarOpen.value}
        badge={mentionCount > 0 ? mentionCount : totalUnread.value}
        mention={mentionCount > 0}
        onClick={() => {
          membersOpen.value = false;
          sidebarOpen.value = !sidebarOpen.value;
        }}
      />
      <Item
        label="Members"
        icon={<Users size={20} />}
        active={membersOpen.value}
        onClick={() => {
          sidebarOpen.value = false;
          membersOpen.value = !membersOpen.value;
        }}
      />
      <Item label="Settings" icon={<Settings size={20} />} onClick={() => openModal({ type: 'audioSettings' })} />
    </nav>
  );
};
