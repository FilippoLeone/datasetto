import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Video, VideoOff } from 'lucide-preact';
import { Button, Select } from '@/components';
import { VideoTile } from '@/features/voice/VideoTile';
import { voiceManager } from '@/features/voice/voiceManager';
import { CameraError } from '@/services/voice/cameraCapture';
import { blurIsCostly, cameraBlurSupport } from '@/services/voice/cameraEffects';
import {
  describeBlurStats,
  type CameraBlurLevel,
  type CameraBlurStatus,
} from '@/services/voice/backgroundBlur';
import { cameraBlurStatus, cameraPreviewStream, localCameraStream } from '@/state/voice';
import { toast } from '@/state/ui';
import type { AudioSettings } from '@/types/protocol';

interface CameraSectionProps {
  draft: AudioSettings;
  patch: (changes: Partial<AudioSettings>) => void;
}

const LEVELS: Array<{ value: CameraBlurLevel; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'light', label: 'Light' },
  { value: 'strong', label: 'Strong' },
];

/** One line on what the blur does right now. */
export const describeBlurStatus = (status: CameraBlurStatus): string | null => {
  if (status.level === 'off' || status.state === 'off' || status.state === 'failed') return null;
  if (status.engine === 'system') return 'Blurred by your system’s camera effects.';
  if (status.state === 'starting' || !status.modelReady)
    return 'Loading the person finder… the whole picture is blurred until it is ready.';
  const light = status.tier?.level === 'light' && status.level === 'strong' ? ' (Light)' : '';
  return (
    'Blurred on this device' +
    light +
    (status.stats ? ' · ' + describeBlurStats(status.stats) : '') +
    '.'
  );
};

/**
 * Settings > Camera: background blur (Off, Light, Strong) with a live preview of what
 * friends see. In a call with the camera on, the preview is the call's camera and the
 * drafted level applies to it at once; Cancel puts the saved level back.
 */
export const CameraSection = ({ draft, patch }: CameraSectionProps) => {
  const support = useMemo(() => cameraBlurSupport(), []);
  const [previewing, setPreviewing] = useState(false);
  const [starting, setStarting] = useState(false);
  const previewingRef = useRef(false);
  const status = cameraBlurStatus.value;
  const previewStream = cameraPreviewStream.value ?? (previewing ? localCameraStream.value : null);
  const available = support.path !== 'none';

  useEffect(
    () => () => {
      if (previewingRef.current) voiceManager.stopCameraPreview();
    },
    []
  );

  // The drafted level shows in the preview right away.
  useEffect(() => {
    if (previewing) void voiceManager.setCameraPreviewBlur(draft.cameraBlur);
  }, [draft.cameraBlur, previewing]);

  const togglePreview = async () => {
    if (previewing) {
      previewingRef.current = false;
      setPreviewing(false);
      voiceManager.stopCameraPreview();
      return;
    }
    setStarting(true);
    try {
      previewingRef.current = true;
      await voiceManager.startCameraPreview(draft.cameraBlur);
      setPreviewing(true);
    } catch (error) {
      previewingRef.current = false;
      voiceManager.stopCameraPreview();
      toast.error(
        error instanceof CameraError ? error.message : 'Could not open the camera for the preview.'
      );
    } finally {
      setStarting(false);
    }
  };

  const line = describeBlurStatus(status);

  return (
    <section data-settings-camera>
      <h3 className="mt-3 mb-1 text-xs font-semibold tracking-wide text-text-muted uppercase">
        Camera
      </h3>
      <Select
        label="Background blur"
        value={available ? draft.cameraBlur : 'off'}
        options={available ? LEVELS : LEVELS.slice(0, 1)}
        disabled={!available}
        onChange={(value) => patch({ cameraBlur: value as CameraBlurLevel })}
      />
      <p className="text-xs text-text-muted">
        Friends see you sharp and the room behind you blurred. The blur is applied on your device
        before the video is sent; it uses your system’s camera effects when it has them, otherwise a
        small person-finding model that downloads once (about 14 MB). Light softens the room, Strong
        hides it.
      </p>
      {!available && (
        <p className="mt-1 text-xs text-warning" data-blur-unavailable>
          {support.reason}
        </p>
      )}
      {available && blurIsCostly() && draft.cameraBlur !== 'off' && (
        <p className="mt-1 text-xs text-warning">
          On a phone the blur uses noticeably more battery and warms the phone up.
        </p>
      )}
      <div className="flex items-center justify-between gap-2 py-2 text-sm">
        <span className="font-medium text-text-bright">Preview</span>
        <Button
          size="sm"
          variant={previewing ? 'danger' : 'secondary'}
          loading={starting}
          onClick={() => void togglePreview()}
          data-camera-preview-toggle
        >
          {previewing ? <VideoOff size={14} /> : <Video size={14} />}{' '}
          {previewing ? 'Stop preview' : 'Preview camera'}
        </Button>
      </div>
      {previewing && previewStream && (
        <VideoTile
          stream={previewStream}
          label="What friends see"
          mirror
          className="aspect-video w-full"
        />
      )}
      {line && (
        <p className="mt-1 text-xs text-text-muted" data-blur-status>
          {line}
        </p>
      )}
      {status.notice && (
        <p className="mt-1 text-xs text-warning" data-blur-notice>
          {status.notice}
        </p>
      )}
    </section>
  );
};
