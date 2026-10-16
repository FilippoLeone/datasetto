import { Ban, Headphones, MessageCircle, MicOff, Radio, ShieldCheck, Volume2 } from 'lucide-preact';
import { Avatar, Menu, RoleBadge, type MenuItem } from '@/components';
import { channelsById } from '@/state/channels';
import { onlineCount, sortedUsers } from '@/state/presence';
import { account, can } from '@/state/session';
import { openModal } from '@/state/ui';
import { api } from '@/services/socket/api';
import { primaryRole, ROLE_ORDER } from '@/lib/format';
import type { User } from '@/types/protocol';

const statusFor = (user: User): { text: string; icon: typeof Volume2 | null } => {
  if (user.voiceChannel) {
    const name = channelsById.value.get(user.voiceChannel)?.name ?? 'voice';
    return { text: 'In ' + name, icon: Volume2 };
  }
  if (user.currentChannel) {
    const channel = channelsById.value.get(user.currentChannel);
    if (channel?.type === 'stream') return { text: 'Watching ' + channel.name, icon: Radio };
  }
  return { text: 'Online', icon: null };
};

const canModerate = (target: User): boolean => {
  const me = account.value;
  if (!me || target.accountId === me.id) return false;
  if (target.isSuperuser) return false;
  if (me.roles.includes('superuser')) return true;
  return ROLE_ORDER.indexOf(primaryRole(me.roles)) < ROLE_ORDER.indexOf(primaryRole(target.roles));
};

const MemberRow = ({ user }: { user: User }) => {
  const status = statusFor(user);
  const Icon = status.icon;
  const items: MenuItem[] = [];
  if (user.accountId !== account.value?.id) {
    items.push({ label: 'Message ' + user.displayName, icon: <MessageCircle size={14} />, onSelect: () => api.openDm(user.accountId) });
  }
  if (canModerate(user)) {
    if (can('canBanUsers')) {
      items.push({
        label: 'Ban ' + user.displayName,
        icon: <Ban size={14} />,
        danger: true,
        onSelect: () =>
          openModal({
            type: 'confirm',
            title: 'Ban ' + user.displayName + '?',
            message: 'They will be disconnected and cannot sign in again until an admin lifts the ban.',
            confirmLabel: 'Ban',
            danger: true,
            onConfirm: () => api.banUser(user.id, user.displayName, 'Banned by ' + (account.value?.displayName ?? 'moderator')),
          }),
      });
    }
    if (can('canAssignRoles')) {
      items.push({ label: 'Manage roles', icon: <ShieldCheck size={14} />, onSelect: () => openModal({ type: 'admin', tab: 'users' }) });
    }
  }

  return (
    <Menu items={items} className="block w-full" title={user.displayName}>
      <div className="flex cursor-default items-center gap-2.5 rounded-sm px-2 py-1.5 transition-colors duration-150 hover:bg-hover">
        <Avatar seed={user.accountId} name={user.displayName} src={user.avatarUrl} size={32} status="online" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-text">{user.displayName}</span>
            <RoleBadge roles={user.roles} />
          </span>
          <span className="flex items-center gap-1 text-xs text-text-muted">
            {Icon && <Icon size={12} />}
            <span className="truncate">{status.text}</span>
          </span>
        </span>
      </div>
    </Menu>
  );
};

export const MemberList = () => (
  <>
    <header className="flex h-12 shrink-0 items-center px-4 text-xs font-semibold tracking-wide text-text-muted uppercase">
      Online — {onlineCount.value}
    </header>
    <div className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-4">
      {sortedUsers.value.map((user) => (
        <MemberRow key={user.id} user={user} />
      ))}
      {sortedUsers.value.length === 0 && <p className="px-2 text-sm text-text-faint">Nobody is online.</p>}
    </div>
    <div className="hidden items-center gap-1 px-3 pb-2 text-[11px] text-text-faint">
      <MicOff size={11} /> <Headphones size={11} />
    </div>
  </>
);
