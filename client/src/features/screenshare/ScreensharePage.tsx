import { useEffect } from 'preact/hooks';
import { MonitorUp, MonitorX, Scissors } from 'lucide-preact';
import { Button, Select, Spinner, Toggle } from '@/components';
import { clipManager } from '@/services/clips/clipManager';
import { shareClipKey } from '@/features/clips/clipKeys';
import { tileClipControls } from '@/features/clips/tileClip';
import { cn } from '@/lib/cn';
import { canCaptureScreen } from '@/lib/device';
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
  // Clips: the presenter can always clip their own screen; viewers unless the presenter said no.
  const clipKey = shareClipKey(channel.id);
  const clipAllowed = role === 'host' || session?.allowClips !== false;
  const clipName = role === 'host' ? 'Your screen' : (session?.hostName ?? 'Presenter') + "'s screen";
  const clipsAllowedByMe = audioSettings.value.shareClipsAllowed;

  // Leaving the page ends our part in the room; a presenter going away for a moment (their socket
  // blipped, a deploy) does not: the service keeps the picture and waits for them.
  useEffect(() => {
    screenshareService.init();
    return () => screenshareService.leaveChannel(channel.id);
  }, [channel.id]);
  useEffect(() => {
    if (someoneElseSharing) screenshareService.watch(channel.id);
  }, [channel.id, someoneElseSharing]);
  // The picture of this room can be clipped while it is here and allowed.
  useEffect(() => {
    if (!stream || !clipAllowed) return;
    clipManager.register({ key: clipKey, kind: 'share', name: clipName }, () => stream);
    return () => clipManager.unregister(clipKey);
  }, [stream, clipAllowed, clipKey, clipName]);

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
            stats
            clip={clipAllowed ? tileClipControls(clipKey) : undefined}
            audioControls={
              hostKey
                ? {
                    muted: streamAudio.muted,
                    volume: streamAudio.volume,
                    max: 1,
                    onlyWithAudio: true,
                    onMutedChange: (muted) => setScreenAudioPref(hostKey, { muted }),
                    onVolumeChange: (volume) => setScreenAudioPref(hostKey, { volume }),
                  }
                : undefined
            }
            className="min-h-0 flex-1 rounded-none"
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            {someoneElseSharing ? <Spinner size={32} className="text-text-muted" /> : <MonitorUp size={40} className="text-text-faint" />}
            <p className="text-text-muted">
              {someoneElseSharing ? screenshareStatus.value || 'Connecting to ' + (session?.hostName ?? 'the presenter') + '…' : screenshareStatus.value || 'Nobody is sharing in #' + channel.name + '.'}
            </p>
            {!someoneElseSharing && canCaptureScreen() && (
              <>
                <Select
                  label="Quality"
                  className="w-72 text-left"
                  value={audioSettings.value.screenQuality}
                  options={SCREEN_QUALITY_OPTIONS}
                  onChange={(value) => updateAudioSettings({ screenQuality: value as ScreenQuality })}
                />
                <Toggle
                  label="Let viewers clip this share"
                  description="They can save the last seconds of your screen on their own device. Nothing is recorded on the server."
                  checked={clipsAllowedByMe}
                  onChange={(value) => updateAudioSettings({ shareClipsAllowed: value })}
                />
                <Button variant="success" onClick={() => void screenshareService.startHosting(channel.id)}>
                  <MonitorUp size={16} /> Share your screen
                </Button>
                <p className="max-w-md text-xs text-text-faint">
                  To stream a game with sound, pick <strong>Entire screen</strong> and tick <strong>Share audio</strong> in the picker (in the desktop app: <strong>Share system audio</strong>). Wear headphones so your friends are not echoed back.
                </p>
              </>
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
            <>
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={clipsAllowedByMe}
                title={clipsAllowedByMe ? 'Viewers may save clips of this share; click to stop that' : 'Viewers cannot clip this share; click to allow it'}
                onClick={() => updateAudioSettings({ shareClipsAllowed: !clipsAllowedByMe })}
                data-share-clips={clipsAllowedByMe ? 'allowed' : 'off'}
              >
                <Scissors size={14} /> {clipsAllowedByMe ? 'Clips allowed' : 'Clips off'}
              </Button>
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
