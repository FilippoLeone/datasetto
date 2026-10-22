import { useState } from 'preact/hooks';
import { Check, Globe, Hash, Lock, MonitorUp, Radio, Volume2 } from 'lucide-preact';
import { Button, Field, Modal, TextInput } from '@/components';
import { cn } from '@/lib/cn';
import { api } from '@/services/socket/api';
import { closeModal } from '@/state/ui';
import type { ChannelVisibility, CreatableChannelType } from '@/types/protocol';

const TYPES: Array<{ value: CreatableChannelType; label: string; hint: string; icon: typeof Hash }> = [
  { value: 'text', label: 'Text channel', hint: 'Messages, links and emoji. Everyone can read back.', icon: Hash },
  { value: 'voice', label: 'Voice channel', hint: 'Talk, show your camera or your screen, play Arcade games together.', icon: Volume2 },
  { value: 'stream', label: 'Live stream', hint: 'Broadcast from OBS with a stream key; friends watch in the app.', icon: Radio },
  { value: 'screenshare', label: 'Screenshare room', hint: 'One presenter shares a screen, the others watch and chat.', icon: MonitorUp },
];

const VISIBILITIES: Array<{ value: ChannelVisibility; label: string; hint: string; icon: typeof Globe }> = [
  { value: 'public', label: 'Public', hint: 'Listed for everyone on the server.', icon: Globe },
  { value: 'private', label: 'Private', hint: 'Hidden. Only members and admins see it. Admins add members, or friends join with the password.', icon: Lock },
];

const NAME_PATTERN = /^[a-zA-Z0-9_-]{2,32}$/;

/** `Games Night!` -> `games-night` */
export const slugifyChannelName = (raw: string): string =>
  raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '');

type Step = 'type' | 'details';

export const CreateChannelModal = ({ channelType }: { channelType: CreatableChannelType }) => {
  const [step, setStep] = useState<Step>('type');
  const [type, setType] = useState<CreatableChannelType>(channelType);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [visibility, setVisibility] = useState<ChannelVisibility>('public');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const slug = slugifyChannelName(name);
  const nameValid = NAME_PATTERN.test(slug);

  const submit = (event: Event) => {
    event.preventDefault();
    if (!nameValid) {
      setError('2 to 32 characters: letters, numbers, hyphens and underscores.');
      return;
    }
    if (visibility === 'private' && password && password.length < 4) {
      setError('The join password needs at least 4 characters.');
      return;
    }
    api.createChannel({
      name: slug,
      type,
      topic: topic.trim() || null,
      visibility,
      password: visibility === 'private' && password ? password : null,
    });
    closeModal();
  };

  const typeStep = (
    <div className="grid gap-2" role="radiogroup" aria-label="Channel type">
      {TYPES.map((option) => {
        const Icon = option.icon;
        const selected = type === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setType(option.value)}
            onDblClick={() => setStep('details')}
            className={cn(
              'flex items-start gap-3 rounded-md border p-3 text-left transition-colors',
              selected ? 'border-brand bg-brand-soft' : 'border-border bg-base/60 hover:bg-hover',
            )}
          >
            <Icon size={20} className={cn('mt-0.5 shrink-0', selected ? 'text-text-bright' : 'text-text-muted')} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-text-bright">{option.label}</span>
              <span className="block text-xs text-text-muted">{option.hint}</span>
            </span>
            {selected && <Check size={16} className="mt-1 shrink-0 text-brand" />}
          </button>
        );
      })}
    </div>
  );

  const detailsStep = (
    <form id="create-channel-form" onSubmit={submit} className="flex flex-col">
      <Field label="Name" error={error} hint={slug && slug !== name.trim() ? 'Will be created as #' + slug : 'Lowercase, no spaces. Example: games-night'}>
        <TextInput value={name} maxLength={32} autoFocus onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="new-channel" />
      </Field>
      <Field label="Topic" hint="Optional. Shown next to the channel name.">
        <TextInput value={topic} maxLength={200} onInput={(e) => setTopic((e.target as HTMLInputElement).value)} placeholder="What is this channel for?" />
      </Field>
      <p className="mt-2 mb-1.5 text-xs font-semibold tracking-wide text-text-muted uppercase">Visibility</p>
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Visibility">
        {VISIBILITIES.map((option) => {
          const Icon = option.icon;
          const selected = visibility === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setVisibility(option.value)}
              className={cn(
                'flex items-start gap-2 rounded-md border p-3 text-left transition-colors',
                selected ? 'border-brand bg-brand-soft' : 'border-border bg-base/60 hover:bg-hover',
              )}
            >
              <Icon size={16} className={cn('mt-0.5 shrink-0', selected ? 'text-text-bright' : 'text-text-muted')} />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-text-bright">{option.label}</span>
                <span className="block text-xs text-text-muted">{option.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
      {visibility === 'private' && (
        <Field label="Join password" hint="Optional. Friends who know it can join from the channel list. Leave empty to let only admins add members.">
          <TextInput
            type="password"
            autoComplete="off"
            value={password}
            minLength={4}
            maxLength={128}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            placeholder="At least 4 characters"
          />
        </Field>
      )}
    </form>
  );

  const typeLabel = TYPES.find((option) => option.value === type)?.label ?? 'Channel';

  return (
    <Modal
      title="Create channel"
      subtitle={step === 'type' ? 'Step 1 of 2: what kind of channel?' : 'Step 2 of 2: ' + typeLabel.toLowerCase()}
      onClose={closeModal}
      size="md"
      footer={
        step === 'type' ? (
          <>
            <Button variant="secondary" onClick={closeModal}>
              Cancel
            </Button>
            <Button onClick={() => setStep('details')}>Next</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setStep('type')}>
              Back
            </Button>
            <span className="flex-1" />
            <Button variant="secondary" onClick={closeModal}>
              Cancel
            </Button>
            <Button type="submit" form="create-channel-form" disabled={!slug}>
              {visibility === 'private' ? 'Create private channel' : 'Create channel'}
            </Button>
          </>
        )
      }
    >
      {step === 'type' ? typeStep : detailsStep}
    </Modal>
  );
};
