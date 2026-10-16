import { useEffect, useState } from 'preact/hooks';
import { Headphones, HeadphoneOff, Mic, MicOff, MonitorUp, PhoneOff, Signal, Video, VideoOff } from 'lucide-preact';
import { IconButton } from '@/components';
import { cn } from '@/lib/cn';
import { formatDuration } from '@/lib/format';
import { MOTION, usePresence } from '@/lib/motion';
import { channelsById } from '@/state/channels';
import {
  localCameraStream,
  localDeafened,
  localMuted,
  localScreenStream,
  overallQuality,
  participantCount,
  pttPressed,
  voiceChannelId,
  voiceStartedAt,
  voiceStatus,
} from '@/state/voice';
import { audioSettings } from '@/state/settings';
import { selectChannel } from '@/features/channels/channelActions';
import { voiceManager } from './voiceManager';

const QUALITY_COLOR = {
  excellent: 'text-success',
  good: 'text-success',
  fair: 'text-warning',
  poor: 'text-live',
  unknown: 'text-text-faint',
};

export const useVoiceTimer = (): string => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const started = voiceStartedAt.value;
  return started ? formatDuration(now - started) : '00:00';
};

/** Sidebar footer shown while connecting to or connected in voice. */
export const VoiceDock = () => {
  const status = voiceStatus.value;
  const elapsed = useVoiceTimer();
  // Slides up when a call starts and back down when it ends (lib/motion.ts).
  const presence = usePresence(status !== 'idle', MOTION.base);
  if (!presence.mounted) return null;
  const channel = voiceChannelId.value ? channelsById.value.get(voiceChannelId.value) : null;
  const muted = localMuted.value || (audioSettings.value.pttEnable && !pttPressed.value);
  const cameraOn = localCameraStream.value !== null;
  const screenOn = localScreenStream.value !== null;

  return (
    <div data-state={presence.state} className="motion-dock border-t border-border bg-base/40 px-2 py-2">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-sm px-1 py-1 text-left hover:bg-hover"
        onClick={() => channel && selectChannel(channel.id)}
      >
        <Signal size={16} className={cn(QUALITY_COLOR[overallQuality.value])} />
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-xs font-semibold', status === 'connected' ? 'text-success' : 'text-warning')}>
            {status === 'connected' ? 'Voice connected' : status === 'reconnecting' ? 'Reconnecting voice…' : 'Connecting…'}
          </span>
          <span className="block truncate text-xs text-text-muted">
            {channel?.name ?? 'voice'} · {participantCount.value} {participantCount.value === 1 ? 'person' : 'people'} · {elapsed}
          </span>
        </span>
      </button>
      <div className="mt-1 flex items-center justify-between gap-1">
        <IconButton label={muted ? 'Unmute' : 'Mute'} size="sm" tone={localMuted.value ? 'danger' : 'default'} onClick={() => void voiceManager.toggleMute()}>
          <span key={muted ? 'muted' : 'live'} className="inline-flex animate-icon-swap">
            {muted ? <MicOff size={18} /> : <Mic size={18} />}
          </span>
        </IconButton>
        <IconButton label={localDeafened.value ? 'Undeafen' : 'Deafen'} size="sm" tone={localDeafened.value ? 'danger' : 'default'} onClick={() => void voiceManager.toggleDeafen()}>
          <span key={localDeafened.value ? 'deaf' : 'hearing'} className="inline-flex animate-icon-swap">
            {localDeafened.value ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
          </span>
        </IconButton>
        <IconButton label={cameraOn ? 'Turn camera off' : 'Turn camera on'} size="sm" active={cameraOn} onClick={() => void voiceManager.toggleCamera()}>
          <span key={cameraOn ? 'on' : 'off'} className="inline-flex animate-icon-swap">
            {cameraOn ? <Video size={18} /> : <VideoOff size={18} />}
          </span>
        </IconButton>
        <IconButton label={screenOn ? 'Stop sharing screen' : 'Share screen'} size="sm" active={screenOn} onClick={() => void voiceManager.toggleScreenShare()}>
          <MonitorUp size={18} />
        </IconButton>
        <IconButton label="Leave voice" size="sm" tone="danger" onClick={() => void voiceManager.leave()}>
          <PhoneOff size={18} />
        </IconButton>
      </div>
    </div>
  );
};
