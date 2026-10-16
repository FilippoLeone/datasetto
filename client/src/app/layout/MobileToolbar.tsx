import { Hash, Settings, Users } from 'lucide-preact';
import { cn } from '@/lib/cn';
import { totalUnread } from '@/state/channels';
import { membersOpen, openModal, sidebarOpen } from '@/state/ui';

const Item = ({ label, icon, active, onClick, badge }: { label: string; icon: preact.ComponentChildren; active?: boolean; onClick: () => void; badge?: number }) => (
  <button
    type="button"
    onClick={onClick}
    className={cn('relative flex h-14 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium', active ? 'text-text-bright' : 'text-text-muted')}
  >
    {icon}
    <span>{label}</span>
    {badge ? <span className="absolute top-1 right-[calc(50%-18px)] rounded-full bg-live px-1.5 text-[10px] font-bold text-white">{badge}</span> : null}
  </button>
);

/** Bottom navigation on phones. */
export const MobileToolbar = () => (
  <nav className="fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-border bg-base safe-bottom safe-x" aria-label="Navigation">
    <Item label="Channels" icon={<Hash size={20} />} active={sidebarOpen.value} badge={totalUnread.value} onClick={() => (sidebarOpen.value = !sidebarOpen.value)} />
    <Item label="Members" icon={<Users size={20} />} active={membersOpen.value} onClick={() => (membersOpen.value = !membersOpen.value)} />
    <Item label="Settings" icon={<Settings size={20} />} onClick={() => openModal({ type: 'audioSettings' })} />
  </nav>
);
