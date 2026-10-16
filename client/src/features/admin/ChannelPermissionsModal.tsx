import { useEffect, useState } from 'preact/hooks';
import { Lock, UserMinus, UserPlus } from 'lucide-preact';
import { Avatar, Button, Field, Modal, Select, TextInput } from '@/components';
import { formatFullDate } from '@/lib/format';
import { api } from '@/services/socket/api';
import { channelsById } from '@/state/channels';
import { adminAccounts, channelMembers, channelPermissions } from '@/state/misc';
import { can } from '@/state/session';
import { closeModal, toast } from '@/state/ui';
import { EMPTY_PERMISSIONS, PermissionsEditor } from './PermissionsEditor';
import type { Channel, ChannelPermissions, ChannelVisibility, CreatableChannelType } from '@/types/protocol';

/** Topic, visibility and join password. Saved separately from the permission matrix. */
const ChannelSettings = ({ channel }: { channel: Channel }) => {
  const [topic, setTopic] = useState(channel.topic ?? '');
  const [visibility, setVisibility] = useState<ChannelVisibility>(channel.visibility ?? 'public');
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    topic.trim() !== (channel.topic ?? '') || visibility !== (channel.visibility ?? 'public') || password.length > 0 || clearPassword;

  const save = () => {
    if (password && password.length < 4) {
      setError('The join password needs at least 4 characters.');
      return;
    }
    setError(null);
    api.updateChannel(channel.id, {
      topic: topic.trim() || null,
      visibility,
      ...(visibility === 'private' ? (password ? { password } : clearPassword ? { password: null } : {}) : {}),
    });
    setPassword('');
    setClearPassword(false);
  };

  return (
    <section className="rounded-md bg-base/60 p-3">
      <p className="text-sm font-semibold text-text-bright">Channel settings</p>
      <Field label="Topic" hint="Shown next to the channel name.">
        <TextInput value={topic} maxLength={200} onInput={(e) => setTopic((e.target as HTMLInputElement).value)} placeholder="What is this channel for?" />
      </Field>
      <Select
        label="Visibility"
        value={visibility}
        options={[
          { value: 'public', label: 'Public: listed for everyone' },
          { value: 'private', label: 'Private: hidden, members and admins only' },
        ]}
        onChange={(value) => setVisibility(value as ChannelVisibility)}
      />
      {visibility === 'private' && (
        <Field
          label="Join password"
          error={error}
          hint={
            channel.hasPassword && !clearPassword
              ? 'A password is set. Type a new one to replace it, or remove it so only admins can add members.'
              : 'Optional. Friends who know it can join from the channel list.'
          }
        >
          <div className="flex items-center gap-2">
            <TextInput
              type="password"
              autoComplete="off"
              value={password}
              maxLength={128}
              disabled={clearPassword}
              onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
              placeholder={channel.hasPassword ? '••••••••' : 'At least 4 characters'}
            />
            {channel.hasPassword && (
              <Button size="sm" variant={clearPassword ? 'secondary' : 'ghost'} onClick={() => setClearPassword((value) => !value)}>
                {clearPassword ? 'Keep' : 'Remove'}
              </Button>
            )}
          </div>
        </Field>
      )}
      {visibility === 'public' && channel.visibility === 'private' && (
        <p className="text-xs text-warning">Making the channel public removes its password and member list; everyone will see it.</p>
      )}
      <div className="mt-2 flex justify-end">
        <Button size="sm" disabled={!dirty} onClick={save}>
          Save settings
        </Button>
      </div>
    </section>
  );
};

/** Who belongs to a private channel; admins add and remove accounts here. */
const MembersSection = ({ channel }: { channel: Channel }) => {
  const members = channelMembers.value[channel.id] ?? [];
  const [candidate, setCandidate] = useState('');

  useEffect(() => {
    api.listChannelMembers(channel.id);
  }, [channel.id]);

  const memberIds = new Set(members.map((member) => member.accountId));
  const candidates = adminAccounts.value.filter((account) => !memberIds.has(account.id) && account.status !== 'disabled');

  return (
    <section className="rounded-md bg-base/60 p-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-text-bright">
        <Lock size={14} /> Members ({members.length})
      </p>
      <p className="mb-2 text-xs text-text-muted">Only these accounts (and admins) can see the channel. Members still need the roles below for each action.</p>
      <ul className="flex flex-col gap-1">
        {members.map((member) => (
          <li key={member.accountId} className="flex items-center gap-2 rounded-sm bg-sidebar px-2 py-1.5 text-sm">
            <Avatar seed={member.accountId} name={member.displayName} src={member.avatarUrl} size={24} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-text-bright">{member.displayName}</span>
              <span className="block truncate text-[11px] text-text-faint">
                {member.username ?? member.accountId} · joined {formatFullDate(member.joinedAt)}
              </span>
            </span>
            <Button size="sm" variant="ghost" aria-label={'Remove ' + member.displayName} onClick={() => api.removeChannelMember(channel.id, member.accountId)}>
              <UserMinus size={14} /> Remove
            </Button>
          </li>
        ))}
        {members.length === 0 && <li className="px-2 py-1 text-xs text-text-faint">No members yet.</li>}
      </ul>
      {candidates.length > 0 && (
        <div className="mt-2 flex items-end gap-2">
          <Select
            label="Add a member"
            className="flex-1"
            value={candidate}
            options={[{ value: '', label: 'Pick an account…' }, ...candidates.map((account) => ({ value: account.id, label: account.displayName + ' (' + account.username + ')' }))]}
            onChange={setCandidate}
          />
          <Button
            size="md"
            className="mb-2"
            disabled={!candidate}
            onClick={() => {
              api.addChannelMember(channel.id, candidate);
              setCandidate('');
            }}
          >
            <UserPlus size={14} /> Add
          </Button>
        </div>
      )}
    </section>
  );
};

export const ChannelPermissionsModal = ({ channelId }: { channelId: string }) => {
  const channel = channelsById.value.get(channelId);
  const loaded = channelPermissions.value[channelId];
  const [draft, setDraft] = useState<ChannelPermissions>(loaded ?? EMPTY_PERMISSIONS);
  const [touched, setTouched] = useState(false);
  const members = channelMembers.value[channelId] ?? [];

  useEffect(() => {
    api.getChannelPermissions(channelId);
    if (adminAccounts.value.length === 0) api.listAccounts();
  }, [channelId]);

  useEffect(() => {
    if (loaded && !touched) setDraft(loaded);
  }, [loaded, touched]);

  if (!channel) return null;

  const change = (next: ChannelPermissions) => {
    setTouched(true);
    setDraft(next);
  };

  const save = () => {
    api.updateChannelPermissions(channelId, draft);
    closeModal();
  };

  const saveAsTemplate = () => {
    if (channel.type === 'dm') return;
    api.updateSettings({ channelPermissionTemplates: { [channel.type as CreatableChannelType]: draft } });
    toast.info('New ' + channel.type + ' channels will start with these permissions');
  };

  return (
    <Modal
      title={'Permissions for #' + channel.name}
      subtitle="Who can see, chat, talk, stream and manage. Superusers always have every right."
      onClose={closeModal}
      size="lg"
      footer={
        <>
          {can('canManageChannelPermissions') && channel.type !== 'dm' && (
            <Button variant="ghost" onClick={saveAsTemplate} title={'Use these permissions as the default for new ' + channel.type + ' channels'}>
              Use as default for new {channel.type} channels
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="secondary" onClick={closeModal}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!touched}>
            Save permissions
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {can('canEditChannels') && <ChannelSettings key={channel.id + ':' + channel.visibility + ':' + channel.hasPassword + ':' + channel.topic} channel={channel} />}
        {channel.visibility === 'private' && <MembersSection channel={channel} />}
        <PermissionsEditor
          value={draft}
          onChange={change}
          channelType={channel.type}
          accounts={adminAccounts.value}
          visibility={channel.visibility ?? 'public'}
          memberIds={new Set(members.map((member) => member.accountId))}
        />
      </div>
    </Modal>
  );
};
