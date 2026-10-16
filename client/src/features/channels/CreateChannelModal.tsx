import { useState } from 'preact/hooks';
import { Button, Field, Modal, Select, TextInput } from '@/components';
import { api } from '@/services/socket/api';
import { closeModal } from '@/state/ui';
import type { ChannelType } from '@/types/protocol';

const TYPE_OPTIONS: { value: ChannelType; label: string }[] = [
  { value: 'text', label: 'Text channel' },
  { value: 'voice', label: 'Voice channel' },
  { value: 'stream', label: 'Live stream (OBS)' },
  { value: 'screenshare', label: 'Screenshare room' },
];

const NAME_PATTERN = /^[a-zA-Z0-9_-]{2,32}$/;

export const CreateChannelModal = ({ channelType }: { channelType: ChannelType }) => {
  const [name, setName] = useState('');
  const [type, setType] = useState<ChannelType>(channelType);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: Event) => {
    event.preventDefault();
    const trimmed = name.trim().toLowerCase().replace(/\s+/g, '-');
    if (!NAME_PATTERN.test(trimmed)) {
      setError('2 to 32 characters: letters, numbers, hyphens and underscores.');
      return;
    }
    api.createChannel(trimmed, type);
    closeModal();
  };

  return (
    <Modal
      title="Create channel"
      onClose={closeModal}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={closeModal}>
            Cancel
          </Button>
          <Button type="submit" form="create-channel-form" disabled={!name.trim()}>
            Create
          </Button>
        </>
      }
    >
      <form id="create-channel-form" onSubmit={submit}>
        <Select label="Type" value={type} options={TYPE_OPTIONS} onChange={(value) => setType(value as ChannelType)} />
        <Field label="Name" error={error} hint="Lowercase, no spaces. Example: games-night">
          <TextInput value={name} maxLength={32} autoFocus onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="new-channel" />
        </Field>
      </form>
    </Modal>
  );
};
