import { useState } from 'preact/hooks';
import { LogOut } from 'lucide-preact';
import { Avatar, Button, Field, Modal, RoleBadge, TextArea, TextInput } from '@/components';
import { api } from '@/services/socket/api';
import { account } from '@/state/session';
import { closeModal, toast } from '@/state/ui';
import { voiceManager } from '@/features/voice/voiceManager';

export const ProfileModal = () => {
  const me = account.value;
  const [displayName, setDisplayName] = useState(me?.displayName ?? '');
  const [bio, setBio] = useState(me?.bio ?? '');
  const [avatarUrl, setAvatarUrl] = useState(me?.avatarUrl ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  if (!me) return null;

  const save = (event: Event) => {
    event.preventDefault();
    if (newPassword && newPassword !== confirm) {
      toast.error('New passwords do not match');
      return;
    }
    if (newPassword && !currentPassword) {
      toast.error('Enter your current password to change it');
      return;
    }
    api.updateAccount({
      displayName: displayName.trim() || me.displayName,
      bio: bio.trim() || null,
      avatarUrl: avatarUrl.trim() || null,
      ...(newPassword ? { currentPassword, newPassword } : {}),
    });
    closeModal();
  };

  const logout = async () => {
    await voiceManager.leave({ silent: true });
    api.logout();
    closeModal();
  };

  return (
    <Modal
      title="Your profile"
      onClose={closeModal}
      footer={
        <>
          <Button variant="ghost" onClick={logout}>
            <LogOut size={16} /> Sign out
          </Button>
          <span className="flex-1" />
          <Button variant="secondary" onClick={closeModal}>
            Cancel
          </Button>
          <Button type="submit" form="profile-form">
            Save
          </Button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-3">
        <Avatar seed={me.id} name={displayName || me.displayName} src={avatarUrl || null} size={56} />
        <div className="min-w-0">
          <p className="truncate font-semibold text-text-bright">{me.displayName}</p>
          <p className="truncate text-sm text-text-muted">{me.username}</p>
          <RoleBadge roles={me.roles} hideMember={false} className="mt-1" />
        </div>
      </div>
      <form id="profile-form" onSubmit={save}>
        <Field label="Display name">
          <TextInput value={displayName} maxLength={50} onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="About you" hint="Optional, up to 500 characters.">
          <TextArea value={bio} maxLength={500} onInput={(e) => setBio((e.target as HTMLTextAreaElement).value)} />
        </Field>
        <Field label="Avatar URL" hint="Leave empty for a generated avatar.">
          <TextInput type="url" value={avatarUrl} onInput={(e) => setAvatarUrl((e.target as HTMLInputElement).value)} placeholder="https://…" />
        </Field>
        <p className="mt-4 mb-1 text-xs font-semibold tracking-wide text-text-muted uppercase">Change password</p>
        <Field label="Current password">
          <TextInput type="password" autoComplete="current-password" value={currentPassword} onInput={(e) => setCurrentPassword((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="New password">
          <TextInput type="password" autoComplete="new-password" value={newPassword} onInput={(e) => setNewPassword((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Confirm new password">
          <TextInput type="password" autoComplete="new-password" value={confirm} onInput={(e) => setConfirm((e.target as HTMLInputElement).value)} />
        </Field>
      </form>
    </Modal>
  );
};
