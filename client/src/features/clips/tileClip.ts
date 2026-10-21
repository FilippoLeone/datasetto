import { clipManager } from '@/services/clips/clipManager';
import { clipStatus, isClipsOn } from '@/state/clips';
import { audioSettings } from '@/state/settings';
import type { TileClipControls } from '@/features/voice/VideoTile';

/**
 * The Clip controls of a tile or player for one source key, read from the signals
 * (call it while rendering). Undefined when this engine cannot record clips.
 */
export const tileClipControls = (key: string): TileClipControls | undefined => {
  if (!clipManager.supported()) return undefined;
  const status = clipStatus(key);
  return {
    on: isClipsOn(key),
    recording: status.recording,
    availableMs: status.availableMs,
    saving: status.saving,
    error: status.error,
    seconds: audioSettings.value.clipSeconds,
    onToggle: () => clipManager.toggle(key),
    onClip: () => void clipManager.clip(key),
  };
};
