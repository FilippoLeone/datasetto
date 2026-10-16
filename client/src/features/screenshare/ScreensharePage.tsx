import { useEffect } from 'preact/hooks';
import { MonitorUp, MonitorX } from 'lucide-preact';
import { Button, Select } from '@/components';
import { cn } from '@/lib/cn';
import { SCREEN_QUALITY_OPTIONS } from '@/services/screenCapture';
import { screenshareSessions } from '@/state/misc';
import { screenAudioPref, screenHostKey, setScreenAudioPref } from '@/state/screenAudio';
import { socketId } from '@/state/session';
import { audioSettings, updateAudioSettings } from '@/state/settings';
import { isMobile } from '@/state/ui';
import { ChatView } from '@/features/chat/ChatView';
import { VideoTile } from '@/features/voice/VideoTile';
import { screenshareChannel, screenshareRole, screenshareService, screenshareStatus, screenshareStream } from './screenshareService';
import type { Channel, ScreenQuality } from '@/types/protocol';

/** Screenshare room: one presenter, many viewers, chat on the side. */
export const ScreensharePage = ({ channel }: { channel: Channel }) => {
  const session = screenshareSessions.value[channel.id];
  const role = screenshareChannel.value === channel.id ? screenshareRole.value : 'idle';
  const stream = role !== 'idle' ? screenshareStream.value : null;
  const someoneElseSharing = Boolean(session?.active && session.hostId && session.hostId !== socketId.value);
  const mobile = isMobile.value;
  // How loud this presenter plays for me, remembered per presenter account.
  const hostKey = role === 'viewer' ? screenHostKey(session?.hostId, session?.hostName) : null;
  const streamAudio = screenAudioPref(hostKey);

  useEffect(() => {
    screenshareService.init();
    if (someoneElseSharing) screenshareService.watch(channel.id);
    return () => screenshareService.leaveChannel(channel.id);
  }, [channel.id, someoneElseSharing]);

  return (
    <div className={cn('flex min-h-0 flex-1', mobile ? 'flex-col' : 'flex-row')}>
      <div className={cn('flex min-h-0 flex-col bg-black', mobile ? 'aspect-video w-full shrink-0' : 'min-w-0 flex-1')}>
        {stream ? (
          <VideoTile
            stream={stream}
            label={role === 'host' ? 'Your screen' : (session?.hostName ?? 'Presenter') + "'s screen"}
            muted={role === 'host' || streamAudio.muted}
            volume={streamAudio.volume * audioSettings.value.outputVol}
            sinkId={audioSettings.value.spkDeviceId}
            audioIndicator
            audioControls={
              hostKey
                ? {
                    muted: streamAudio.muted,
                    volume: streamAudio.volume,
                    onMutedChange: (muted) => setScreenAudioPref(hostKey, { muted }),
                    onVolumeChange: (volume) => setScreenAudioPref(hostKey, { volume }),
                  }
                : undefined
            }
            className="min-h-0 flex-1 rounded-none"
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <MonitorUp size={40} className="text-text-faint" />
            <p className="text-text-muted">
              {someoneElseSharing ? screenshareStatus.value || 'Connecting to ' + (session?.hostName ?? 'the presenter') + '…' : screenshareStatus.value || 'Nobody is sharing in #' + channel.name + '.'}
            </p>
            {!someoneElseSharing && (
              <>
                <Select
                  label="Quality"
                  className="w-72 text-left"
                  value={audioSettings.value.screenQuality}
                  options={SCREEN_QUALITY_OPTIONS}
                  onChange={(value) => updateAudioSettings({ screenQuality: value as ScreenQuality })}
                />
                <Button variant="success" onClick={() => void screenshareService.startHosting(channel.id)}>
                  <MonitorUp size={16} /> Share your screen
                </Button>
                <p className="max-w-md text-xs text-text-faint">
                  To stream a game with sound, pick <strong>Entire screen</strong> and tick <strong>Share audio</strong> in the picker (in the desktop app: <strong>Share system audio</strong>). Wear headphones so your friends are not echoed back.
                </p>
              </>
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
            <>
              <select
                aria-label="Share quality"
                value={audioSettings.value.screenQuality}
                onChange={(event) => updateAudioSettings({ screenQuality: (event.target as HTMLSelectElement).value as ScreenQuality })}
                className="h-7 rounded-sm bg-base px-2 text-xs text-text-bright outline-none focus:ring-2 focus:ring-brand"
              >
                {SCREEN_QUALITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="danger" onClick={() => screenshareService.stopHosting()}>
                <MonitorX size={14} /> Stop sharing
              </Button>
            </>
          )}
        </div>
      </div>
      <div className={cn('flex min-h-0 flex-col', mobile ? 'flex-1' : 'w-80 shrink-0 border-l border-border')}>
        <ChatView channel={channel} compact />
      </div>
    </div>
  );
};
