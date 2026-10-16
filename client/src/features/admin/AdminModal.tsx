import { useEffect, useState } from 'preact/hooks';
import { Ban, KeyRound, ShieldCheck, Trash2, UserCheck, UserX } from 'lucide-preact';
import { Avatar, Button, Modal, RoleBadge } from '@/components';
import { cn } from '@/lib/cn';
import { formatFullDate, ROLE_LABELS, ROLE_ORDER } from '@/lib/format';
import { api } from '@/services/socket/api';
import { channels } from '@/state/channels';
import { adminAccounts, adminBans } from '@/state/misc';
import { account, can, isSuperuser } from '@/state/session';
import { closeModal, openModal } from '@/state/ui';
import { CHANNEL_ICONS } from '@/app/layout/MainArea';
import type { Account, RoleName } from '@/types/protocol';

type Tab = 'users' | 'channels' | 'bans';

const ASSIGNABLE: RoleName[] = ['admin', 'moderator', 'streamer', 'user'];

const UserRow = ({ user }: { user: Account }) => {
  const [editing, setEditing] = useState(false);
  const [roles, setRoles] = useState<RoleName[]>(user.roles);
  const me = account.value;
  const isMe = user.id === me?.id;
  const disabled = user.status === 'disabled';
  const assignable = isSuperuser.value ? ['superuser', ...ASSIGNABLE] : ASSIGNABLE;

  const toggleRole = (role: RoleName) => {
    setRoles((current) => (current.includes(role) ? current.filter((entry) => entry !== role) : [...current, role]));
  };

  return (
    <li className={cn('rounded-md bg-base/60 p-3', disabled && 'opacity-60')}>
      <div className="flex items-center gap-3">
        <Avatar seed={user.id} name={user.displayName} src={user.avatarUrl} size={36} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate text-sm font-semibold text-text-bright">
            {user.displayName}
            {isMe && <span className="text-xs font-normal text-text-muted">(you)</span>}
            {disabled && <span className="rounded-sm bg-danger/20 px-1.5 text-[10px] font-bold text-[#fa777c] uppercase">Disabled</span>}
          </p>
          <p className="truncate text-xs text-text-muted">{user.username}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {user.roles.map((role) => (
            <RoleBadge key={role} roles={[role]} hideMember={false} />
          ))}
        </div>
      </div>
      {!isMe && (
        <div className="mt-2 flex flex-wrap gap-2">
          {can('canAssignRoles') && (
            <Button size="sm" variant="secondary" onClick={() => setEditing((value) => !value)}>
              <ShieldCheck size={14} /> Roles
            </Button>
          )}
          {can('canDisableAccounts') &&
            (disabled ? (
              <Button size="sm" variant="secondary" onClick={() => api.enableAccount(user.id)}>
                <UserCheck size={14} /> Enable
              </Button>
            ) : (
              <Button size="sm" variant="danger" onClick={() => api.disableAccount(user.id, 'Disabled by ' + (me?.displayName ?? 'admin'))}>
                <UserX size={14} /> Disable
              </Button>
            ))}
        </div>
      )}
      {editing && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-sm bg-sidebar p-2">
          {assignable.map((role) => (
            <label key={role} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={roles.includes(role as RoleName)} onChange={() => toggleRole(role as RoleName)} />
              {ROLE_LABELS[role as RoleName]}
            </label>
          ))}
          <span className="flex-1" />
          <Button
            size="sm"
            disabled={roles.length === 0}
            onClick={() => {
              api.updateRoles(user.id, ROLE_ORDER.filter((role) => roles.includes(role)));
              setEditing(false);
            }}
          >
            Save
          </Button>
        </div>
      )}
    </li>
  );
};

const UsersTab = () => (
  <ul className="flex flex-col gap-2">
    {adminAccounts.value.map((user) => (
      <UserRow key={user.id} user={user} />
    ))}
    {adminAccounts.value.length === 0 && <p className="text-sm text-text-muted">Loading accounts…</p>}
  </ul>
);

const ChannelsTab = () => (
  <ul className="flex flex-col gap-1">
    {channels.value.map((channel) => {
      const Icon = CHANNEL_ICONS[channel.type];
      return (
        <li key={channel.id} className="flex items-center gap-2 rounded-md bg-base/60 px-3 py-2">
          <Icon size={16} className="text-text-muted" />
          <span className="min-w-0 flex-1 truncate text-sm text-text-bright">{channel.name}</span>
          <span className="text-xs text-text-faint">{channel.type}</span>
          {can('canManageChannelPermissions') && (
            <Button size="sm" variant="secondary" onClick={() => openModal({ type: 'channelPermissions', channelId: channel.id })}>
              <KeyRound size={14} /> Permissions
            </Button>
          )}
          {can('canDeleteChannels') && (
            <Button
              size="sm"
              variant="danger"
              onClick={() =>
                openModal({
                  type: 'confirm',
                  title: 'Delete #' + channel.name + '?',
                  message: 'All messages in this channel are deleted. This cannot be undone.',
                  confirmLabel: 'Delete',
                  danger: true,
                  onConfirm: () => api.deleteChannel(channel.id),
                })
              }
            >
              <Trash2 size={14} />
            </Button>
          )}
        </li>
      );
    })}
  </ul>
);

const BansTab = () => {
  const accounts = adminAccounts.value;
  return (
    <ul className="flex flex-col gap-2">
      {adminBans.value.map((ban) => {
        const user = accounts.find((entry) => entry.id === ban.accountId);
        return (
          <li key={ban.accountId} className="flex items-center gap-3 rounded-md bg-base/60 px-3 py-2">
            <Ban size={16} className="text-live" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-text-bright">{user?.displayName ?? ban.accountId}</p>
              <p className="truncate text-xs text-text-muted">
                {ban.reason ?? 'No reason'} · by {ban.bannedBy ?? 'unknown'} · {formatFullDate(ban.bannedAt)}
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => api.unbanAccount(ban.accountId)}>
              Unban
            </Button>
          </li>
        );
      })}
      {adminBans.value.length === 0 && <p className="text-sm text-text-muted">No active bans.</p>}
    </ul>
  );
};

export const AdminModal = ({ initialTab }: { initialTab: Tab }) => {
  const [tab, setTab] = useState<Tab>(initialTab);

  useEffect(() => {
    api.listAccounts();
    if (can('canBanUsers')) api.listBans();
  }, []);

  const tabs: Array<{ id: Tab; label: string; show: boolean }> = [
    { id: 'users', label: 'Members', show: can('canManageUsers') },
    { id: 'channels', label: 'Channels', show: can('canManageChannelPermissions') || can('canDeleteChannels') },
    { id: 'bans', label: 'Bans', show: can('canBanUsers') },
  ];

  return (
    <Modal title="Server admin" onClose={closeModal} size="lg">
      <div className="mb-4 flex gap-1 rounded-md bg-base p-1" role="tablist">
        {tabs
          .filter((entry) => entry.show)
          .map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              onClick={() => setTab(entry.id)}
              className={cn('flex-1 rounded-sm py-1.5 text-sm font-medium', tab === entry.id ? 'bg-active text-text-bright' : 'text-text-muted hover:text-text')}
            >
              {entry.label}
            </button>
          ))}
      </div>
      {tab === 'users' && <UsersTab />}
      {tab === 'channels' && <ChannelsTab />}
      {tab === 'bans' && <BansTab />}
    </Modal>
  );
};
