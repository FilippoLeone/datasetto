import { Volume1, Volume2, VolumeX } from 'lucide-preact';
import { Button, Toggle, VolumeSlider } from '@/components';
import { cn } from '@/lib/cn';
import { isTouchPrimary } from '@/lib/device';
import { supportsPlaybackBoost } from '@/services/voice/PeerAudioManager';
import { DEFAULT_PEER_AUDIO, PEER_VOLUME_STEP_PERCENT, peerAudioPref, resetPeerAudioPref, setPeerAudioPref, volumePercent } from '@/state/peerAudio';

interface PeerVolumePanelProps {
  /** Whose volume: the setting is remembered per account. */
  accountId: string;
  name: string;
}

/**
 * How loud one person plays for me: a 0..200 % slider, "Mute for me" and "Reset to 100 %".
 * Rendered as the header of that person's menu (a dropdown with a mouse, a bottom sheet on
 * a phone). Changes apply at once through the voice service's gain node for that person.
 * Where voices play through a plain media element (Safari, Firefox) the slider stops at 100 %,
 * which is as loud as that path goes.
 */
export const PeerVolumePanel = ({ accountId, name }: PeerVolumePanelProps) => {
  const pref = peerAudioPref(accountId);
  const boost = supportsPlaybackBoost();
  const percent = Math.min(boost ? 200 : 100, volumePercent(pref.volume));
  const atDefault = pref.volume === DEFAULT_PEER_AUDIO.volume && pref.muted === DEFAULT_PEER_AUDIO.muted;
  const roomy = isTouchPrimary();
  const Icon = pref.muted || percent === 0 ? VolumeX : percent < 100 ? Volume1 : Volume2;

  return (
    <div className={cn('flex flex-col', roomy ? 'gap-1 px-5 pt-1 pb-2' : 'w-64 gap-0.5 px-2 py-1')} data-peer-volume={accountId}>
      <div className={cn('flex items-center gap-1.5 pt-1 text-sm font-medium text-text-bright', roomy && 'text-[15px]')}>
        <Icon size={16} className={cn('shrink-0', pref.muted ? 'text-live' : 'text-text-muted')} />
        <span className="min-w-0 flex-1 truncate">Volume</span>
      </div>
      <VolumeSlider
        label={'Volume for ' + name}
        value={percent}
        max={boost ? 200 : 100}
        step={PEER_VOLUME_STEP_PERCENT}
        showValue
        className={cn('text-sm text-text-muted', roomy && 'py-1')}
        valueClassName="w-12"
        onChange={(value) => setPeerAudioPref(accountId, { volume: value / 100 })}
      />
      {!boost && (
        <p className="text-xs text-text-faint" data-no-boost>
          Louder than 100 % is not available in this browser.
        </p>
      )}
      <Toggle label="Mute for me" description="Silences them on your side only." checked={pref.muted} onChange={(muted) => setPeerAudioPref(accountId, { muted })} />
      <Button size="sm" variant="secondary" disabled={atDefault} className="self-start" onClick={() => resetPeerAudioPref(accountId)} data-peer-volume-reset>
        Reset to 100 %
      </Button>
    </div>
  );
};
