import { Hash, Lock, Menu as MenuIcon, MonitorUp, Radio, Users, Volume2 } from 'lucide-preact';
import { IconButton } from '@/components';
import { selectedChannel } from '@/state/channels';
import { onlineCount } from '@/state/presence';
import { isMobile, isPhone, membersOpen, showMembers, sidebarOpen } from '@/state/ui';
import { ChatView } from '@/features/chat/ChatView';
import { StreamPage } from '@/features/stream/StreamPage';
import { VoicePage } from '@/features/voice/VoicePage';
import { ScreensharePage } from '@/features/screenshare/ScreensharePage';
import type { Channel, ChannelType } from '@/types/protocol';

export const CHANNEL_ICONS: Record<ChannelType, typeof Hash> = {
  text: Hash,
  voice: Volume2,
  stream: Radio,
  screenshare: MonitorUp,
};

const Header = ({ channel }: { channel: Channel | null }) => {
  const Icon = channel ? CHANNEL_ICONS[channel.type] : Hash;
  const mobile = isMobile.value;
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 shadow-sm">
      {isPhone.value && (
        <IconButton label="Open channels" size="sm" onClick={() => (sidebarOpen.value = true)}>
          <MenuIcon size={20} />
        </IconButton>
      )}
      <Icon size={20} className="shrink-0 text-text-muted" />
      <h2 className="truncate text-base font-semibold text-text-bright">{channel?.name ?? 'Datasetto'}</h2>
      {channel?.visibility === 'private' && <Lock size={14} className="shrink-0 text-text-muted" aria-label="Private channel" />}
      {channel?.type === 'stream' && channel.isLive && <span className="live-dot text-xs font-bold text-live uppercase">Live</span>}
      {channel?.topic && !mobile && (
        <>
          <span className="mx-1 h-5 w-px shrink-0 bg-border-strong" aria-hidden="true" />
          <p className="min-w-0 truncate text-sm text-text-muted" title={channel.topic}>
            {channel.topic}
          </p>
        </>
      )}
      <span className="flex-1" />
      <IconButton
        label={mobile ? 'Members' : showMembers.value ? 'Hide members' : 'Show members'}
        size="sm"
        active={!mobile && showMembers.value}
        onClick={() => {
          if (mobile) membersOpen.value = !membersOpen.value;
          else showMembers.value = !showMembers.value;
        }}
      >
        <Users size={20} />
        <span className="sr-only">{onlineCount.value}</span>
      </IconButton>
    </header>
  );
};

export const MainArea = () => {
  const channel = selectedChannel.value;
  return (
    <>
      <Header channel={channel} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        {!channel && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-text-muted">
            <Hash size={40} className="text-text-faint" />
            <p className="text-sm">Pick a channel to get started.</p>
          </div>
        )}
        {channel?.type === 'text' && <ChatView channel={channel} />}
        {channel?.type === 'stream' && <StreamPage channel={channel} />}
        {channel?.type === 'voice' && <VoicePage channel={channel} />}
        {channel?.type === 'screenshare' && <ScreensharePage channel={channel} />}
      </div>
    </>
  );
};
