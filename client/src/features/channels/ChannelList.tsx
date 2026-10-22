import { ChevronDown, ChevronRight, Gamepad2, Key, Lock, MessageCircle, Plus, Trash2, Volume2, VolumeX, X } from 'lucide-preact';
import { Avatar, Menu, type MenuItem } from '@/components';
import { cn } from '@/lib/cn';
import { CHANNEL_ICONS } from '@/app/layout/MainArea';
import { api } from '@/services/socket/api';
import { peerAudioPref } from '@/state/peerAudio';
import { avatarOf } from '@/state/avatars';
import { channelsByType, collapsedGroups, mentions, selectedChannelId, toggleGroup, unread } from '@/state/channels';
import { usersInVoice } from '@/state/presence';
import { can } from '@/state/session';
import { localSpeaking, voiceChannelId, voicePeers } from '@/state/voice';
import { account } from '@/state/session';
import { openModal } from '@/state/ui';
import { closeConversation, selectChannel } from './channelActions';
import { arcadeActivity, arcadeBadge, arcadeHidden, gameHidden, openArcade } from '@/features/arcade/state';
import { PeerVolumePanel } from '@/features/voice/PeerVolumePanel';
import { voiceManager } from '@/features/voice/voiceManager';
import type { Channel, ChannelType, CreatableChannelType } from '@/types/protocol';

const GROUP_LABELS: Record<ChannelType, string> = {
  text: 'Text channels',
  voice: 'Voice channels',
  stream: 'Live streams',
  screenshare: 'Screenshare rooms',
  dm: 'Direct messages',
};

const ORDER: CreatableChannelType[] = ['text', 'voice', 'stream', 'screenshare'];

/**
 * Who is in a voice channel, under its row. A friend's row opens their menu: how loud they
 * play for me (state/peerAudio.ts) and a message shortcut.
 */
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
        const audio = isMe ? null : peerAudioPref(user.accountId);
        const items: MenuItem[] = isMe ? [] : [{ label: 'Message ' + user.displayName, icon: <MessageCircle size={14} />, onSelect: () => api.openDm(user.accountId) }];
        return (
          <li key={user.id}>
            <Menu items={items} className="block w-full" title={user.displayName} header={isMe ? undefined : <PeerVolumePanel accountId={user.accountId} name={user.displayName} />}>
              <div
                className={cn('flex items-center gap-2 rounded-sm px-1 py-0.5 text-sm text-text-muted', !isMe && 'cursor-pointer hover:bg-hover pointer-coarse:min-h-10')}
                data-voice-member={user.accountId}
              >
                <Avatar seed={user.accountId} name={user.displayName} src={user.avatarUrl} size={20} speaking={speaking} />
                <span className={cn('min-w-0 flex-1 truncate', speaking && 'text-text-bright')}>{user.displayName}</span>
                {audio?.muted && <VolumeX size={12} className="shrink-0 text-live" aria-label="Muted for you" title="Muted for you" data-muted-for-me />}
              </div>
            </Menu>
          </li>
        );
      })}
    </ul>
  );
};

/**
 * Unread badge of a sidebar row. Red with the count; once one of the unread
 * messages @-mentions us it turns brand-coloured and shows "@" with how many did.
 */
const UnreadBadge = ({ unreadCount, mentionCount }: { unreadCount: number; mentionCount: number }) => {
  if (unreadCount === 0) return null;
  const label = unreadCount + ' unread' + (mentionCount > 0 ? ', ' + mentionCount + (mentionCount === 1 ? ' mention' : ' mentions') : '');
  return (
    <span
      key={unreadCount + ':' + mentionCount}
      className={cn('rounded-full px-1.5 text-[10px] font-bold text-white animate-badge-pop', mentionCount > 0 ? 'bg-brand' : 'bg-live')}
      aria-label={label}
      title={label}
      data-mentions={mentionCount > 0 ? mentionCount : undefined}
    >
      {mentionCount > 0 ? '@' + mentionCount : unreadCount}
    </span>
  );
};

const ChannelRow = ({ channel }: { channel: Channel }) => {
  const Icon = CHANNEL_ICONS[channel.type];
  const active = selectedChannelId.value === channel.id;
  const unreadCount = unread.value[channel.id] ?? 0;
  const mentionCount = mentions.value[channel.id] ?? 0;
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
        <button
          type="button"
          onClick={onClick}
          title={channel.topic ? channel.name + ' — ' + channel.topic : undefined}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left pointer-coarse:py-3"
        >
          <Icon size={18} className={cn('shrink-0', inVoice && 'text-success')} />
          <span className={cn('truncate', unreadCount > 0 && 'font-semibold')}>{channel.name}</span>
          {channel.visibility === 'private' && <Lock size={12} className="shrink-0 text-text-faint" aria-label="Private channel" />}
          {channel.type === 'stream' && channel.isLive && <span className="live-dot ml-1 text-[10px] font-bold text-live uppercase">Live</span>}
          {channel.type === 'voice' && arcadeBadge(channel.id) && <Gamepad2 size={14} className="ml-1 shrink-0 text-warning" aria-label="Arcade game here" />}
          {channel.type === 'screenshare' && channel.screenshareHostName && <span className="ml-1 text-[10px] font-bold text-success uppercase">Sharing</span>}
        </button>
        {!active && <UnreadBadge unreadCount={unreadCount} mentionCount={mentionCount} />}
        {(channel.type === 'stream' || channel.type === 'screenshare') && channel.count > 0 && (
          <span className="text-[11px] text-text-faint tabular-nums" title="Watching">{channel.count}</span>
        )}
        {items.length > 0 && (
          <Menu items={items} align="right" title={'#' + channel.name}>
            <button type="button" aria-label="Channel options" className={ROW_CONTROL}>
              <ChevronDown size={14} />
            </button>
          </Menu>
        )}
      </div>
      {channel.type === 'voice' && <VoiceMembers channel={channel} />}
    </li>
  );
};

/** Hover-only control on a sidebar row (always shown on touch screens, at a 40 px target). */
const ROW_CONTROL = 'rounded-sm p-0.5 text-text-faint opacity-0 group-hover:opacity-100 hover:text-text-bright focus:opacity-100 pointer-coarse:p-[13px] pointer-coarse:opacity-100';

/**
 * One-to-one conversations: the other person's avatar and name, unread badge, latest
 * first. The × (or "Close conversation" in the row's menu, a sheet on phones) hides the
 * conversation until a message arrives in it or it is opened again from the member list.
 */
const DmRow = ({ channel }: { channel: Channel }) => {
  const active = selectedChannelId.value === channel.id;
  const unreadCount = unread.value[channel.id] ?? 0;
  const peer = channel.dm;
  const name = peer?.peerName ?? 'Direct message';
  const close = () => closeConversation(channel.id);
  const items: MenuItem[] = [{ label: 'Close conversation', icon: <X size={14} />, onSelect: close }];
  return (
    <li>
      <div
        className={cn(
          'group flex items-center gap-1 rounded-sm px-2 text-sm transition-colors duration-150 active:bg-active',
          active ? 'bg-active text-text-bright' : 'text-text-muted hover:bg-hover hover:text-text',
          unreadCount > 0 && !active && 'text-text-bright',
        )}
      >
        <button
          type="button"
          onClick={() => selectChannel(channel.id)}
          title={peer?.peerUsername}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left pointer-coarse:py-3"
        >
          <Avatar seed={peer?.peerId ?? channel.id} name={name} src={avatarOf(peer?.peerId, peer?.peerAvatarUrl)} size={24} />
          <span className={cn('min-w-0 flex-1 truncate', unreadCount > 0 && 'font-semibold')}>{name}</span>
        </button>
        {!active && <UnreadBadge unreadCount={unreadCount} mentionCount={0} />}
        <button type="button" aria-label={'Close conversation with ' + name} title="Close conversation" className={ROW_CONTROL} onClick={close}>
          <X size={14} />
        </button>
        <Menu items={items} align="right" title={name}>
          <button type="button" aria-label="Conversation options" className={ROW_CONTROL}>
            <ChevronDown size={14} />
          </button>
        </Menu>
      </div>
    </li>
  );
};

const DmGroup = () => {
  const list = channelsByType.value.dm;
  const collapsed = collapsedGroups.value.dm;
  if (list.length === 0) return null;
  return (
    <section className="mb-3">
      <div className="group flex items-center gap-1 px-1 text-[11px] font-semibold tracking-wide text-text-muted uppercase">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1 py-1 hover:text-text-bright pointer-coarse:py-3" onClick={() => toggleGroup('dm')} aria-expanded={!collapsed}>
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span className="truncate">{GROUP_LABELS.dm}</span>
        </button>
      </div>
      {!collapsed && (
        <ul className="flex flex-col gap-0.5">
          {list.map((channel) => (
            <DmRow key={channel.id} channel={channel} />
          ))}
        </ul>
      )}
    </section>
  );
};

const Group = ({ type }: { type: CreatableChannelType }) => {
  const list = channelsByType.value[type];
  const collapsed = collapsedGroups.value[type];
  const canCreate = can('canCreateChannels');
  return (
    <section className="mb-3">
      <div className="group flex items-center gap-1 px-1 text-[11px] font-semibold tracking-wide text-text-muted uppercase">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1 py-1 hover:text-text-bright pointer-coarse:py-3" onClick={() => toggleGroup(type)} aria-expanded={!collapsed}>
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span className="truncate">{GROUP_LABELS[type]}</span>
        </button>
        {canCreate && (
          <button
            type="button"
            aria-label={'Create ' + type + ' channel'}
            title={'Create ' + type + ' channel'}
            className="rounded-sm p-0.5 opacity-0 group-hover:opacity-100 hover:text-text-bright focus:opacity-100 pointer-coarse:p-[13px] pointer-coarse:opacity-100"
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

/**
 * The Arcade's place in the sidebar: a row like a channel that opens the Arcade for solo play on
 * this device. Games in a voice channel start from that channel's header; the count says how many
 * are running in channels you can see. Gone with "Hide Arcade".
 */
const ArcadeRow = () => {
  if (arcadeHidden.value?.hidden) return null;
  let running = 0;
  for (const entries of arcadeActivity.value.values()) {
    for (const entry of entries) if (!gameHidden(entry.g)) running += 1;
  }
  return (
    <section className="mb-3">
      <button
        type="button"
        aria-label="Arcade"
        title="Arcade: poker, slots, the bomb arena and the adventure"
        onClick={() => openArcade({ mode: 'local' })}
        className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-sm text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text active:bg-active pointer-coarse:py-3"
        data-arcade-row
      >
        <Gamepad2 size={18} className="shrink-0" />
        <span className="truncate">Arcade</span>
        {running > 0 && (
          <span className="ml-auto rounded-full bg-warning/20 px-1.5 text-[10px] font-bold text-warning tabular-nums" title="Games running in voice channels">
            {running}
          </span>
        )}
      </button>
    </section>
  );
};

export const ChannelList = () => (
  <nav aria-label="Channels">
    <DmGroup />
    {ORDER.map((type) => (
      <Group key={type} type={type} />
    ))}
    <ArcadeRow />
    <button
      type="button"
      onClick={() => openModal({ type: 'joinPrivateChannel' })}
      className="mt-1 flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-xs text-text-muted hover:bg-hover hover:text-text-bright pointer-coarse:py-3"
    >
      <Lock size={12} /> Join a private channel…
    </button>
    <p className="mt-2 flex items-center gap-1 px-2 text-[11px] text-text-faint">
      <Volume2 size={11} /> Click a voice channel to join it.
    </p>
    <p className="mt-1 flex items-center gap-1 px-2 text-[11px] text-text-faint">
      <MessageCircle size={11} /> Click a member to send a direct message.
    </p>
  </nav>
);
