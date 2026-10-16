import { useRef, useState } from 'preact/hooks';
import { ImageUp, LogOut, Trash2 } from 'lucide-preact';
import { Avatar, Button, Field, Modal, RoleBadge, TextArea, TextInput } from '@/components';
import { api } from '@/services/socket/api';
import { deleteAvatar, uploadAvatar } from '@/services/avatarUpload';
import { account, updateAccount } from '@/state/session';
import { closeModal, toast } from '@/state/ui';
import { voiceManager } from '@/features/voice/voiceManager';
import { AvatarCropper } from './AvatarCropper';

const isUploadedAvatar = (url: string | null | undefined): boolean => Boolean(url && url.startsWith('/api/avatars/'));

export const ProfileModal = () => {
  const me = account.value;
  const [displayName, setDisplayName] = useState(me?.displayName ?? '');
  const [bio, setBio] = useState(me?.bio ?? '');
  const [avatarUrl, setAvatarUrl] = useState(me?.avatarUrl ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  if (!me) return null;

  const uploaded = isUploadedAvatar(avatarUrl);

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

  const onPicked = (event: Event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Pick an image file');
      return;
    }
    setCropFile(file);
  };

  const onCropped = async (image: Blob) => {
    setCropFile(null);
    setUploading(true);
    try {
      const result = await uploadAvatar(image);
      updateAccount(result.account);
      setAvatarUrl(result.avatarUrl ?? '');
      toast.success('Profile picture updated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const removeUploaded = async () => {
    setUploading(true);
    try {
      const result = await deleteAvatar();
      updateAccount(result.account);
      setAvatarUrl('');
      toast.success('Profile picture removed');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not remove the picture');
    } finally {
      setUploading(false);
    }
  };

  if (cropFile) {
    return (
      <Modal title="Crop your picture" subtitle="The round area is what others see." onClose={() => setCropFile(null)} size="sm">
        <AvatarCropper file={cropFile} onCancel={() => setCropFile(null)} onDone={(image) => void onCropped(image)} />
      </Modal>
    );
  }

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
        <Avatar seed={me.id} name={displayName || me.displayName} src={avatarUrl || null} size={64} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-text-bright">{me.displayName}</p>
          <p className="truncate text-sm text-text-muted">{me.username}</p>
          <RoleBadge roles={me.roles} hideMember={false} className="mt-1" />
        </div>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={onPicked} data-avatar-input />
        <Button size="sm" variant="secondary" loading={uploading} onClick={() => fileInput.current?.click()}>
          <ImageUp size={14} /> Upload picture
        </Button>
        {uploaded && (
          <Button size="sm" variant="ghost" disabled={uploading} onClick={() => void removeUploaded()}>
            <Trash2 size={14} /> Remove picture
          </Button>
        )}
        <span className="text-xs text-text-faint">PNG, JPEG or WebP; cropped to a square and resized to 256×256.</span>
      </div>
      <form id="profile-form" onSubmit={save}>
        <Field label="Display name">
          <TextInput value={displayName} maxLength={50} onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="About you" hint="Optional, up to 500 characters.">
          <TextArea value={bio} maxLength={500} onInput={(e) => setBio((e.target as HTMLTextAreaElement).value)} />
        </Field>
        <Field label="Avatar URL" hint={uploaded ? 'Your uploaded picture is in use. Paste a link here to use that instead.' : 'Alternative to uploading: link to an image. Leave empty for a generated avatar.'}>
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
