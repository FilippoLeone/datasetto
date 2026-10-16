import { useEffect, useState } from 'preact/hooks';
import { Button, Modal } from '@/components';
import { ROLE_LABELS } from '@/lib/format';
import { api } from '@/services/socket/api';
import { channelsById } from '@/state/channels';
import { adminAccounts, channelPermissions } from '@/state/misc';
import { closeModal } from '@/state/ui';
import type { ChannelPermissionAction, ChannelPermissions, RoleName } from '@/types/protocol';

const ACTIONS: Array<{ id: ChannelPermissionAction; label: string; hint: string }> = [
  { id: 'view', label: 'View', hint: 'See the channel and read messages' },
  { id: 'chat', label: 'Chat', hint: 'Send messages' },
  { id: 'voice', label: 'Voice', hint: 'Join the voice room' },
  { id: 'stream', label: 'Stream', hint: 'Get the stream key and publish, or share a screen' },
  { id: 'manage', label: 'Manage', hint: 'Edit channel settings' },
];

const ROLE_CHOICES: Array<{ id: string; label: string }> = [
  { id: '*', label: 'Everyone' },
  ...(['admin', 'moderator', 'streamer', 'user'] as RoleName[]).map((role) => ({ id: role, label: ROLE_LABELS[role] })),
];

const EMPTY: ChannelPermissions = {
  view: { roles: ['*'], accounts: [] },
  chat: { roles: ['*'], accounts: [] },
  voice: { roles: ['*'], accounts: [] },
  stream: { roles: ['*'], accounts: [] },
  manage: { roles: ['admin'], accounts: [] },
};

export const ChannelPermissionsModal = ({ channelId }: { channelId: string }) => {
  const channel = channelsById.value.get(channelId);
  const loaded = channelPermissions.value[channelId];
  const [draft, setDraft] = useState<ChannelPermissions>(loaded ?? EMPTY);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    api.getChannelPermissions(channelId);
    if (adminAccounts.value.length === 0) api.listAccounts();
  }, [channelId]);

  useEffect(() => {
    if (loaded && !touched) setDraft(loaded);
  }, [loaded, touched]);

  if (!channel) return null;

  const toggleRole = (action: ChannelPermissionAction, role: string) => {
    setTouched(true);
    setDraft((current) => {
      const roles = current[action].roles;
      let next: string[];
      if (role === '*') next = roles.includes('*') ? [] : ['*'];
      else {
        const without = roles.filter((entry) => entry !== '*');
        next = without.includes(role) ? without.filter((entry) => entry !== role) : [...without, role];
      }
      return { ...current, [action]: { ...current[action], roles: next } };
    });
  };

  const toggleAccount = (action: ChannelPermissionAction, accountId: string) => {
    setTouched(true);
    setDraft((current) => {
      const accounts = current[action].accounts;
      const next = accounts.includes(accountId) ? accounts.filter((entry) => entry !== accountId) : [...accounts, accountId];
      return { ...current, [action]: { ...current[action], accounts: next } };
    });
  };

  const save = () => {
    api.updateChannelPermissions(channelId, draft);
    closeModal();
  };

  return (
    <Modal
      title={'Permissions for #' + channel.name}
      subtitle="Superusers always have access. Pick roles, or grant individual members."
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
      <div className="flex flex-col gap-3">
        {ACTIONS.map((action) => {
          const entry = draft[action.id];
          const everyone = entry.roles.includes('*');
          return (
            <section key={action.id} className="rounded-md bg-base/60 p-3">
              <p className="text-sm font-semibold text-text-bright">{action.label}</p>
              <p className="mb-2 text-xs text-text-muted">{action.hint}</p>
              <div className="flex flex-wrap gap-2">
                {ROLE_CHOICES.map((choice) => (
                  <label key={choice.id} className="flex items-center gap-1.5 rounded-sm bg-sidebar px-2 py-1 text-sm">
                    <input
                      type="checkbox"
                      checked={choice.id === '*' ? everyone : !everyone && entry.roles.includes(choice.id)}
                      disabled={choice.id !== '*' && everyone}
                      onChange={() => toggleRole(action.id, choice.id)}
                    />
                    {choice.label}
                  </label>
                ))}
              </div>
              {!everyone && adminAccounts.value.length > 0 && (
                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer text-text-muted">Individual members ({entry.accounts.length})</summary>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {adminAccounts.value.map((user) => (
                      <label key={user.id} className="flex items-center gap-1.5 rounded-sm bg-sidebar px-2 py-1">
                        <input type="checkbox" checked={entry.accounts.includes(user.id)} onChange={() => toggleAccount(action.id, user.id)} />
                        {user.displayName}
                      </label>
                    ))}
                  </div>
                </details>
              )}
            </section>
          );
        })}
      </div>
    </Modal>
  );
};
