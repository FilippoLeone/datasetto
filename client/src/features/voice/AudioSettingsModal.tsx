import { useEffect, useState } from 'preact/hooks';
import { Mic } from 'lucide-preact';
import { Button, Modal, Select, Slider, Toggle } from '@/components';
import { cn } from '@/lib/cn';
import { micLevel, voiceStatus } from '@/state/voice';
import { SCREEN_QUALITY_OPTIONS } from '@/services/screenCapture';
import { audioSettings, updateAudioSettings } from '@/state/settings';
import { closeModal, toast } from '@/state/ui';
import { voiceManager } from './voiceManager';
import type { AudioSettings, DeviceInfo, ScreenQuality } from '@/types/protocol';

const BITRATES = [
  { value: '32000', label: '32 kbps (data saver)' },
  { value: '48000', label: '48 kbps' },
  { value: '64000', label: '64 kbps (default)' },
  { value: '96000', label: '96 kbps' },
  { value: '128000', label: '128 kbps (music)' },
];

export const AudioSettingsModal = () => {
  const [draft, setDraft] = useState<AudioSettings>({ ...audioSettings.value });
  const [mics, setMics] = useState<DeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<DeviceInfo[]>([]);
  const [testing, setTesting] = useState(false);
  const [capturing, setCapturing] = useState(false);

  const patch = (changes: Partial<AudioSettings>) => setDraft((current) => ({ ...current, ...changes }));

  useEffect(() => {
    void voiceManager.getDevices().then((devices) => {
      setMics(devices.mics);
      setSpeakers(devices.speakers);
    });
    return () => voiceManager.stopMicTest();
  }, []);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      if (event.code === 'Escape') {
        setCapturing(false);
        return;
      }
      patch({ pttKey: event.code, pttEnable: true });
      setCapturing(false);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [capturing]);

  const toggleTest = async () => {
    if (testing) {
      voiceManager.stopMicTest();
      setTesting(false);
      return;
    }
    updateAudioSettings({ micDeviceId: draft.micDeviceId });
    await voiceManager.startMicTest();
    setTesting(true);
  };

  const save = () => {
    updateAudioSettings(draft);
    toast.success('Audio settings saved');
    closeModal();
  };

  const level = Math.min(1, micLevel.value * 3);

  return (
    <Modal
      title="Voice & audio"
      subtitle={voiceStatus.value === 'connected' ? 'Changes apply to your current call.' : undefined}
      onClose={closeModal}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={closeModal}>
            Cancel
          </Button>
          <Button onClick={save}>Save</Button>
        </>
      }
    >
      <div className="grid gap-x-8 md:grid-cols-2">
        <section>
          <h3 className="mb-1 text-xs font-semibold tracking-wide text-text-muted uppercase">Devices</h3>
          <Select
            label="Microphone"
            value={draft.micDeviceId ?? ''}
            options={[{ value: '', label: 'System default' }, ...mics.map((device) => ({ value: device.deviceId, label: device.label || 'Microphone' }))]}
            onChange={(value) => patch({ micDeviceId: value || undefined })}
          />
          {voiceManager.supportsOutputSelection() && (
            <Select
              label="Output"
              value={draft.spkDeviceId ?? ''}
              options={[{ value: '', label: 'System default' }, ...speakers.map((device) => ({ value: device.deviceId, label: device.label || 'Speaker' }))]}
              onChange={(value) => patch({ spkDeviceId: value || undefined })}
            />
          )}
          <div className="py-2">
            <div className="mb-1.5 flex items-center justify-between text-sm">
              <span className="font-medium text-text-bright">Mic test</span>
              <Button size="sm" variant={testing ? 'danger' : 'secondary'} onClick={() => void toggleTest()}>
                <Mic size={14} /> {testing ? 'Stop' : 'Test'}
              </Button>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-active">
              <div className={cn('h-full rounded-full transition-[width] duration-75', level > 0.7 ? 'bg-warning' : 'bg-success')} style={{ width: Math.round(level * 100) + '%' }} />
            </div>
          </div>
          <Slider label="Mic gain" value={draft.micGain} min={0} max={2} step={0.05} format={(v) => Math.round(v * 100) + '%'} onChange={(value) => patch({ micGain: value })} />
          <Slider label="Output volume" value={draft.outputVol} min={0} max={1} step={0.05} format={(v) => Math.round(v * 100) + '%'} onChange={(value) => patch({ outputVol: value })} />
        </section>

        <section>
          <h3 className="mb-1 text-xs font-semibold tracking-wide text-text-muted uppercase">Processing</h3>
          <Toggle label="Echo cancellation" checked={draft.echoCancel} onChange={(value) => patch({ echoCancel: value })} />
          <Toggle label="Noise suppression" checked={draft.noiseSuppression} onChange={(value) => patch({ noiseSuppression: value })} />
          <Slider
            label="Noise gate strength"
            value={draft.noiseReducerLevel}
            min={0}
            max={1}
            step={0.05}
            format={(v) => (v === 0 ? 'Off' : Math.round(v * 100) + '%')}
            onChange={(value) => patch({ noiseReducerLevel: value })}
          />
          <Toggle label="Automatic gain control" checked={draft.autoGain} onChange={(value) => patch({ autoGain: value })} />
          <Slider label="Voice activity threshold" value={draft.vadThreshold} min={0.01} max={0.3} step={0.01} format={(v) => v.toFixed(2)} onChange={(value) => patch({ vadThreshold: value })} />

          <h3 className="mt-3 mb-1 text-xs font-semibold tracking-wide text-text-muted uppercase">Transmission</h3>
          <Toggle label="Push to talk" description="Hold a key to transmit instead of voice activity." checked={draft.pttEnable} onChange={(value) => patch({ pttEnable: value })} />
          {draft.pttEnable && (
            <div className="flex items-center justify-between py-2 text-sm">
              <span className="text-text-bright">Key: {draft.pttKey ? <code className="rounded-sm bg-base px-1.5 py-0.5 font-mono">{draft.pttKey}</code> : <span className="text-text-muted">not set</span>}</span>
              <Button size="sm" variant="secondary" onClick={() => setCapturing(true)}>
                {capturing ? 'Press a key…' : 'Set key'}
              </Button>
            </div>
          )}
          <Select label="Bitrate" value={String(draft.voiceBitrate)} options={BITRATES} onChange={(value) => patch({ voiceBitrate: Number(value) })} />
          <Toggle label="Send silence efficiently (DTX)" description="Saves bandwidth when you are not talking." checked={draft.dtx} onChange={(value) => patch({ dtx: value })} />

          <h3 className="mt-3 mb-1 text-xs font-semibold tracking-wide text-text-muted uppercase">Screen share</h3>
          <Select label="Quality" value={draft.screenQuality} options={SCREEN_QUALITY_OPTIONS} onChange={(value) => patch({ screenQuality: value as ScreenQuality })} />
          <p className="text-xs text-text-muted">
            Applies to voice channels and screenshare rooms, also while you are sharing. Native presets keep your display's own resolution; 120 fps needs a 120 Hz display and a browser that allows it. Friends on a relayed (TURN) connection are limited to about 1.5 Mbit/s, so they get a softer picture at the higher presets.
          </p>
        </section>
      </div>
      <p className="mt-2 text-xs text-text-faint">Shortcuts: Ctrl+Shift+M mute, Ctrl+Shift+D deafen, Ctrl+Shift+, opens these settings.</p>
    </Modal>
  );
};
