import { useEffect, useState } from 'preact/hooks';
import { Copy, Eye, EyeOff, RefreshCw } from 'lucide-preact';
import { Button, IconButton, Modal } from '@/components';
import { runtimeUrls } from '@/lib/runtimeConfig';
import { api } from '@/services/socket/api';
import { serverConfig } from '@/services/ServerConfigService';
import { channelsById } from '@/state/channels';
import { streamKeys } from '@/state/misc';
import { can } from '@/state/session';
import { closeModal, toast } from '@/state/ui';

const copy = async (value: string, label: string) => {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(label + ' copied');
  } catch {
    toast.error('Clipboard unavailable, copy it manually');
  }
};

const Row = ({ label, value, secret }: { label: string; value: string; secret?: boolean }) => {
  const [revealed, setRevealed] = useState(!secret);
  return (
    <div className="py-2">
      <p className="mb-1 text-xs font-semibold tracking-wide text-text-muted uppercase">{label}</p>
      <div className="flex items-center gap-1 rounded-sm bg-base px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-sm text-text-bright">{revealed ? value : '•'.repeat(Math.min(value.length, 32))}</code>
        {secret && (
          <IconButton label={revealed ? 'Hide' : 'Reveal'} size="sm" onClick={() => setRevealed((v) => !v)}>
            {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
          </IconButton>
        )}
        <IconButton label={'Copy ' + label.toLowerCase()} size="sm" onClick={() => void copy(value, label)}>
          <Copy size={16} />
        </IconButton>
      </div>
    </div>
  );
};

export const StreamKeyModal = ({ channelId }: { channelId: string }) => {
  const channel = channelsById.value.get(channelId);
  const key = streamKeys.value[channelId];
  const rtmpUrl = serverConfig.rtmpUrl() ?? runtimeUrls.rtmpServerUrl;

  useEffect(() => {
    api.requestStreamKey(channelId);
  }, [channelId]);

  if (!channel) return null;

  return (
    <Modal
      title={'Stream to #' + channel.name}
      subtitle="Paste these into OBS Studio under Settings → Stream → Service: Custom."
      onClose={closeModal}
      footer={
        <>
          {can('canRegenerateKeys') && (
            <Button
              variant="ghost"
              onClick={() =>
                openConfirm(() => api.regenerateStreamKey(channelId))
              }
            >
              <RefreshCw size={16} /> New key
            </Button>
          )}
          <span className="flex-1" />
          <Button onClick={closeModal}>Done</Button>
        </>
      }
    >
      <Row label="Server" value={rtmpUrl} />
      {key ? <Row label="Stream key" value={key.streamKey} secret /> : <p className="py-3 text-sm text-text-muted">Fetching your stream key…</p>}
      <div className="mt-3 rounded-md bg-base/60 p-3 text-sm text-text-muted">
        <p className="font-medium text-text">Tips</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>Use the whole key, including the part after <code className="font-mono">?key=</code>. It is what authorises your stream.</li>
          <li>2500 to 4000 kbps, keyframe interval 1 or 2 s, keeps latency low and the server bill small.</li>
          <li>Viewers watch at <code className="font-mono">/hls/{channel.name}</code>; the key never appears in their URLs.</li>
        </ul>
      </div>
    </Modal>
  );
};

const openConfirm = (onConfirm: () => void): void => {
  // Lazy import to avoid a circular import between ui state and this feature.
  void import('@/state/ui').then(({ openModal }) =>
    openModal({
      type: 'confirm',
      title: 'Generate a new stream key?',
      message: 'The current key stops working immediately. Anyone streaming with it is disconnected.',
      confirmLabel: 'Generate',
      danger: true,
      onConfirm,
    }),
  );
};
