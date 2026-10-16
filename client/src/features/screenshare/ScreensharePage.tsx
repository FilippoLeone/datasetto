import { useEffect } from 'preact/hooks';
import { MonitorUp, MonitorX } from 'lucide-preact';
import { Button } from '@/components';
import { cn } from '@/lib/cn';
import { canCaptureScreen } from '@/lib/device';
import { screenshareSessions } from '@/state/misc';
import { socketId } from '@/state/session';
import { isMobile } from '@/state/ui';
import { ChatView } from '@/features/chat/ChatView';
import { VideoTile } from '@/features/voice/VideoTile';
import { screenshareChannel, screenshareRole, screenshareService, screenshareStatus, screenshareStream } from './screenshareService';
import type { Channel } from '@/types/protocol';

/** Screenshare room: one presenter, many viewers, chat on the side. */
export const ScreensharePage = ({ channel }: { channel: Channel }) => {
  const session = screenshareSessions.value[channel.id];
  const role = screenshareChannel.value === channel.id ? screenshareRole.value : 'idle';
  const stream = role !== 'idle' ? screenshareStream.value : null;
  const someoneElseSharing = Boolean(session?.active && session.hostId && session.hostId !== socketId.value);
  const mobile = isMobile.value;

  useEffect(() => {
    screenshareService.init();
    if (someoneElseSharing) screenshareService.watch(channel.id);
    return () => screenshareService.leaveChannel(channel.id);
  }, [channel.id, someoneElseSharing]);

  return (
    <div className={cn('flex min-h-0 flex-1', mobile ? 'flex-col' : 'flex-row')}>
      <div className={cn('flex min-h-0 flex-col bg-black', mobile ? 'aspect-video w-full shrink-0' : 'min-w-0 flex-1')}>
        {stream ? (
          <VideoTile stream={stream} label={role === 'host' ? 'Your screen' : (session?.hostName ?? 'Presenter') + "'s screen"} muted={role === 'host'} className="min-h-0 flex-1 rounded-none" />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <MonitorUp size={40} className="text-text-faint" />
            <p className="text-text-muted">
              {someoneElseSharing ? screenshareStatus.value || 'Connecting to ' + (session?.hostName ?? 'the presenter') + '…' : screenshareStatus.value || 'Nobody is sharing in #' + channel.name + '.'}
            </p>
            {!someoneElseSharing && canCaptureScreen() && (
              <Button variant="success" onClick={() => void screenshareService.startHosting(channel.id)}>
                <MonitorUp size={16} /> Share your screen
              </Button>
            )}
            {!someoneElseSharing && !canCaptureScreen() && (
              <p className="max-w-xs text-xs text-text-faint">Sharing a screen needs the desktop app or a desktop browser. You can still watch from here.</p>
            )}
          </div>
        )}
        <div className="flex items-center gap-2 bg-sidebar px-3 py-1.5 text-xs text-text-muted">
          {session?.active && (
            <span>
              {session.hostName ?? 'Someone'} is sharing · {session.viewerCount} watching
            </span>
          )}
          <span className="flex-1" />
          {role === 'host' && (
            <Button size="sm" variant="danger" onClick={() => screenshareService.stopHosting()}>
              <MonitorX size={14} /> Stop sharing
            </Button>
          )}
        </div>
      </div>
      <div className={cn('flex min-h-0 flex-col', mobile ? 'flex-1' : 'w-80 shrink-0 border-l border-border')}>
        <ChatView channel={channel} compact />
      </div>
    </div>
  );
};
