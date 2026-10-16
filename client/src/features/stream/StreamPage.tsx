import { Key, MessageSquare, MessageSquareOff, Radio } from 'lucide-preact';
import { Button, IconButton } from '@/components';
import { cn } from '@/lib/cn';
import { isLandscapePhone, isMobile, openModal, theaterMode } from '@/state/ui';
import { ChatView } from '@/features/chat/ChatView';
import { HlsPlayer } from './HlsPlayer';
import type { Channel } from '@/types/protocol';

/** Live stream channel: player with the channel's chat beside it (below it on a phone held upright). */
export const StreamPage = ({ channel }: { channel: Channel }) => {
  const mobile = isMobile.value;
  // A phone held sideways has no height to stack the chat under a 16:9 player: side by side, like desktop.
  const stacked = mobile && !isLandscapePhone.value;
  const live = Boolean(channel.isLive);
  const hideChat = theaterMode.value && !mobile;

  return (
    <div className={cn('flex min-h-0 flex-1', stacked ? 'flex-col' : 'flex-row')}>
      <div className={cn('flex min-h-0 flex-col bg-black', stacked ? 'aspect-video w-full shrink-0' : 'min-w-0 flex-1')}>
        {live ? (
          <HlsPlayer channelName={channel.name} live={live} className="min-h-0 flex-1" />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <Radio size={40} className="text-text-faint" />
            <p className="text-text-muted">Nobody is streaming to #{channel.name} right now.</p>
            <Button variant="secondary" size="sm" onClick={() => openModal({ type: 'streamKey', channelId: channel.id })}>
              <Key size={14} /> Stream here with OBS
            </Button>
          </div>
        )}
        <div className="flex items-center gap-2 bg-sidebar px-3 py-1.5 text-xs text-text-muted">
          {live && channel.liveDisplayName && <span>Streaming: {channel.liveDisplayName}</span>}
          <span>{channel.count} watching</span>
          <span className="flex-1" />
          <IconButton label="Stream key" size="sm" onClick={() => openModal({ type: 'streamKey', channelId: channel.id })}>
            <Key size={16} />
          </IconButton>
          {!mobile && (
            <IconButton label={hideChat ? 'Show chat' : 'Hide chat'} size="sm" onClick={() => (theaterMode.value = !theaterMode.value)}>
              {hideChat ? <MessageSquareOff size={16} /> : <MessageSquare size={16} />}
            </IconButton>
          )}
        </div>
      </div>
      {!hideChat && (
        <div className={cn('flex min-h-0 flex-col', stacked ? 'flex-1' : mobile ? 'w-72 shrink-0 border-l border-border' : 'w-80 shrink-0 border-l border-border')}>
          {!mobile && <div className="px-3 py-2 text-xs font-semibold tracking-wide text-text-muted uppercase">Live chat</div>}
          <ChatView channel={channel} compact />
        </div>
      )}
    </div>
  );
};
