import { useEffect, useState } from 'preact/hooks';
import { Lock } from 'lucide-preact';
import { Button, Field, Modal, TextInput } from '@/components';
import { api } from '@/services/socket/api';
import { socketClient } from '@/services/socket/client';
import { closeModal } from '@/state/ui';
import type { ServerError } from '@/types/protocol';
import { slugifyChannelName } from './CreateChannelModal';

/** Join a hidden channel by typing its name and the password its owner shared. */
export const JoinPrivateChannelModal = () => {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The server answers on the generic error event; show join failures inline instead of as a toast only.
  useEffect(
    () =>
      socketClient.on<ServerError>('error', (payload) => {
        if (payload?.code === 'CHANNEL_JOIN_INVALID' || payload?.code === 'CHANNEL_JOIN_FAILED' || payload?.code === 'RATE_LIMITED') {
          setPending(false);
          setError(payload.message);
        }
      }),
    [],
  );

  const submit = (event: Event) => {
    event.preventDefault();
    const slug = slugifyChannelName(name);
    if (!slug) return setError('Enter the channel name');
    if (!password) return setError('Enter the password');
    setError(null);
    setPending(true);
    api.joinPrivateChannel(slug, password);
  };

  return (
    <Modal
      title="Join a private channel"
      subtitle="Private channels are hidden until you join. Ask the person who created it for the name and password."
      onClose={closeModal}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={closeModal}>
            Cancel
          </Button>
          <Button type="submit" form="join-private-form" loading={pending} disabled={!name.trim() || !password}>
            <Lock size={14} /> Join
          </Button>
        </>
      }
    >
      <form id="join-private-form" onSubmit={submit}>
        <Field label="Channel name">
          <TextInput value={name} maxLength={32} autoFocus spellcheck={false} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="secret-club" />
        </Field>
        <Field label="Password" error={error}>
          <TextInput type="password" autoComplete="off" value={password} maxLength={128} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
        </Field>
      </form>
    </Modal>
  );
};
