import { Film } from 'lucide-preact';
import { Button, Select, Toggle } from '@/components';
import { formatBytes } from '@/lib/format';
import { clipManager } from '@/services/clips/clipManager';
import { CLIP_STORAGE_CAP_BYTES, supportsClipStorage } from '@/services/clips/clipStore';
import { clipCount, clipLibraryBytes } from '@/state/clips';
import { CLIP_SECONDS } from '@/state/settings';
import { closeModal, openModal } from '@/state/ui';
import { ShortcutCapture } from '@/features/voice/ShortcutCapture';
import type { AudioSettings, ClipSeconds } from '@/types/protocol';

interface ClipsSectionProps {
  draft: AudioSettings;
  patch: (changes: Partial<AudioSettings>) => void;
}

const LENGTH_OPTIONS = CLIP_SECONDS.map((seconds) => ({ value: String(seconds), label: seconds + ' seconds' + (seconds === 30 ? ' (default)' : '') }));

/**
 * Settings > Clips: how long the rolling buffer is, whether the voice chat is mixed in,
 * the clip key, whether friends may clip your shares, and the way to the library.
 */
export const ClipsSection = ({ draft, patch }: ClipsSectionProps) => {
  const canRecord = clipManager.supported();
  const count = clipCount.value;
  const used = clipLibraryBytes.value;
  return (
    <section data-settings-clips>
      <h3 className="mt-3 mb-1 text-xs font-semibold tracking-wide text-text-muted uppercase md:mt-0">Clips</h3>
      <p className="text-xs text-text-muted">
        While <strong>Clips</strong> is on for a stream or a shared screen, the last seconds of it are kept in memory on your device so the Clip button (or the key below) can save them as a WebM video. It costs some CPU, so it is off until you turn it on per stream or share. Nothing is recorded on the server.
      </p>
      {!canRecord && <p className="mt-1 text-xs text-warning">This browser cannot record clips (no WebM MediaRecorder); the library below still opens.</p>}
      <Select label="Clip length" value={String(draft.clipSeconds)} options={LENGTH_OPTIONS} onChange={(value) => patch({ clipSeconds: Number(value) as ClipSeconds })} />
      <Toggle
        label="Include voice chat audio in clips"
        description="Mixes the friends you hear into clips of a share or stream. Off: only the picture's own sound."
        checked={draft.clipIncludeVoice}
        onChange={(value) => patch({ clipIncludeVoice: value })}
      />
      <Toggle
        label="Let friends clip my shares"
        description="Off: the Clip button disappears on their side for the screens you share, in voice channels and rooms."
        checked={draft.shareClipsAllowed}
        onChange={(value) => patch({ shareClipsAllowed: value })}
      />
      <ShortcutCapture label="Clip key" value={draft.clipShortcut} onChange={(clipShortcut) => patch({ clipShortcut })} inApp />
      {supportsClipStorage() && (
        <div className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
          <span className="text-text-muted">
            {count === 0 ? 'No clips saved yet.' : count + (count === 1 ? ' clip, ' : ' clips, ') + formatBytes(used) + ' of ' + formatBytes(CLIP_STORAGE_CAP_BYTES) + '.'} Oldest clips go first when the space is full.
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              closeModal();
              openModal({ type: 'clips' });
            }}
            title="Closes these settings without saving pending changes"
          >
            <Film size={14} /> Open clips library
          </Button>
        </div>
      )}
    </section>
  );
};
