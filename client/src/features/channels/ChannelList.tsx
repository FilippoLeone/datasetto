import { ChevronDown, ChevronRight, Gamepad2, Key, Plus, Trash2, Volume2 } from 'lucide-preact';
import { Avatar, Menu, type MenuItem } from '@/components';
import { cn } from '@/lib/cn';
import { CHANNEL_ICONS } from '@/app/layout/MainArea';
import { api } from '@/services/socket/api';
import { channelsByType, collapsedGroups, selectedChannelId, toggleGroup, unread } from '@/state/channels';
import { usersInVoice } from '@/state/presence';
import { can } from '@/state/session';
import { localSpeaking, voiceChannelId, voicePeers } from '@/state/voice';
import { account } from '@/state/session';
import { openModal } from '@/state/ui';
import { selectChannel } from './channelActions';
import { voiceManager } from '@/features/voice/voiceManager';
import type { Channel, ChannelType } from '@/types/protocol';

const GROUP_LABELS: Record<ChannelType, string> = {
  text: 'Text channels',
  voice: 'Voice channels',
  stream: 'Live streams',
  screenshare: 'Screenshare rooms',
};

const ORDER: ChannelType[] = ['text', 'voice', 'stream', 'screenshare'];

const VoiceMembers = ({ channel }: { channel: Channel }) => {
  const members = usersInVoice(channel.id);
  if (members.length === 0) return null;
  const me = account.value;
  return (
    <ul className="mb-1 ml-6 flex flex-col gap-0.5 border-l border-border pl-2">
      {members.map((user) => {
        const isMe = user.accountId === me?.id;
        const peer = voicePeers.value[user.id];
        const speaking = isMe ? localSpeaking.value : (peer?.speaking ?? false);
        return (
          <li key={user.id} className="flex items-center gap-2 rounded-sm px-1 py-0.5 text-sm text-text-muted">
            <Avatar seed={user.accountId} name={user.displayName} src={user.avatarUrl} size={20} speaking={speaking} />
            <span className={cn('truncate', speaking && 'text-text-bright')}>{user.displayName}</span>
          </li>
        );
      })}
    </ul>
  );
};

const ChannelRow = ({ channel }: { channel: Channel }) => {
  const Icon = CHANNEL_ICONS[channel.type];
  const active = selectedChannelId.value === channel.id;
  const unreadCount = unread.value[channel.id] ?? 0;
  const inVoice = voiceChannelId.value === channel.id;

  const items: MenuItem[] = [];
  if (channel.type === 'stream') {
    items.push({ label: 'Stream key', icon: <Key size={14} />, onSelect: () => openModal({ type: 'streamKey', channelId: channel.id }) });
  }
  if (can('canManageChannelPermissions')) {
    items.push({ label: 'Permissions', icon: <Key size={14} />, onSelect: () => openModal({ type: 'channelPermissions', channelId: channel.id }) });
  }
  if (can('canDeleteChannels')) {
    items.push({
      label: 'Delete channel',
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: () =>
        openModal({
          type: 'confirm',
          title: 'Delete #' + channel.name + '?',
          message: 'All messages in this channel are deleted. This cannot be undone.',
          confirmLabel: 'Delete',
          danger: true,
          onConfirm: () => api.deleteChannel(channel.id),
        }),
    });
  }

  const onClick = () => {
    selectChannel(channel.id);
    if (channel.type === 'voice' && !inVoice) void voiceManager.join(channel.id);
  };

  return (
    <li>
      <div
        className={cn(
          'group flex items-center gap-1.5 rounded-sm px-2 text-sm transition-colors duration-150 active:bg-active',
          active ? 'bg-active text-text-bright' : 'text-text-muted hover:bg-hover hover:text-text',
          (unreadCount > 0 || inVoice) && !active && 'text-text-bright',
        )}
      >
        <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left pointer-coarse:py-2.5">
          <Icon size={18} className={cn('shrink-0', inVoice && 'text-success')} />
          <span className={cn('truncate', unreadCount > 0 && 'font-semibold')}>{channel.name}</span>
          {channel.type === 'stream' && channel.isLive && <span className="live-dot ml-1 text-[10px] font-bold text-live uppercase">Live</span>}
          {channel.type === 'voice' && channel.currentMinigame && <Gamepad2 size={14} className="ml-1 shrink-0 text-warning" />}
          {channel.type === 'screenshare' && channel.screenshareHostName && <span className="ml-1 text-[10px] font-bold text-success uppercase">Sharing</span>}
        </button>
        {unreadCount > 0 && !active && (
          <span key={unreadCount} className="rounded-full bg-live px-1.5 text-[10px] font-bold text-white animate-badge-pop">
            {unreadCount}
          </span>
        )}
        {(channel.type === 'stream' || channel.type === 'screenshare') && channel.count > 0 && (
          <span className="text-[11px] text-text-faint tabular-nums" title="Watching">{channel.count}</span>
        )}
        {items.length > 0 && (
          <Menu items={items} align="right">
            <button type="button" aria-label="Channel options" className="rounded-sm p-0.5 text-text-faint opacity-0 group-hover:opacity-100 hover:text-text-bright focus:opacity-100 pointer-coarse:p-1.5 pointer-coarse:opacity-100">
              <ChevronDown size={14} />
            </button>
          </Menu>
        )}
      </div>
      {channel.type === 'voice' && <VoiceMembers channel={channel} />}
    </li>
  );
};

const Group = ({ type }: { type: ChannelType }) => {
  const list = channelsByType.value[type];
  const collapsed = collapsedGroups.value[type];
  const canCreate = can('canCreateChannels');
  return (
    <section className="mb-3">
      <div className="group flex items-center gap-1 px-1 text-[11px] font-semibold tracking-wide text-text-muted uppercase">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1 py-1 hover:text-text-bright pointer-coarse:py-2" onClick={() => toggleGroup(type)} aria-expanded={!collapsed}>
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span className="truncate">{GROUP_LABELS[type]}</span>
        </button>
        {canCreate && (
          <button
            type="button"
            aria-label={'Create ' + type + ' channel'}
            title={'Create ' + type + ' channel'}
            className="rounded-sm p-0.5 opacity-0 group-hover:opacity-100 hover:text-text-bright focus:opacity-100 pointer-coarse:p-2 pointer-coarse:opacity-100"
            onClick={() => openModal({ type: 'createChannel', channelType: type })}
          >
            <Plus size={14} />
          </button>
        )}
      </div>
      {!collapsed && (
        <ul className="flex flex-col gap-0.5">
          {list.map((channel) => (
            <ChannelRow key={channel.id} channel={channel} />
          ))}
          {list.length === 0 && <li className="px-2 py-1 text-xs text-text-faint">None yet</li>}
        </ul>
      )}
    </section>
  );
};

export const ChannelList = () => (
  <nav aria-label="Channels">
    {ORDER.map((type) => (
      <Group key={type} type={type} />
    ))}
    <p className="mt-2 flex items-center gap-1 px-2 text-[11px] text-text-faint">
      <Volume2 size={11} /> Click a voice channel to join it.
    </p>
  </nav>
);
