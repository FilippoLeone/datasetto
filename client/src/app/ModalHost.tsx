import { modal } from '@/state/ui';
import { AuthModal } from '@/features/auth/AuthModal';
import { ProfileModal } from '@/features/auth/ProfileModal';
import { CreateChannelModal } from '@/features/channels/CreateChannelModal';
import { JoinPrivateChannelModal } from '@/features/channels/JoinPrivateChannelModal';
import { StreamKeyModal } from '@/features/channels/StreamKeyModal';
import { ConfirmModal } from '@/features/channels/ConfirmModal';
import { AudioSettingsModal } from '@/features/voice/AudioSettingsModal';
import { AdminModal } from '@/features/admin/AdminModal';
import { ChannelPermissionsModal } from '@/features/admin/ChannelPermissionsModal';

/** Renders whichever dialog the UI store says is open. */
export const ModalHost = () => {
  const current = modal.value;
  if (!current) return null;
  switch (current.type) {
    case 'auth':
      return <AuthModal initialMode={current.mode} dismissable />;
    case 'profile':
      return <ProfileModal />;
    case 'createChannel':
      return <CreateChannelModal channelType={current.channelType} />;
    case 'joinPrivateChannel':
      return <JoinPrivateChannelModal />;
    case 'streamKey':
      return <StreamKeyModal channelId={current.channelId} />;
    case 'audioSettings':
      return <AudioSettingsModal />;
    case 'admin':
      return <AdminModal initialTab={current.tab} />;
    case 'channelPermissions':
      return <ChannelPermissionsModal channelId={current.channelId} />;
    case 'confirm':
      return (
        <ConfirmModal
          title={current.title}
          message={current.message}
          confirmLabel={current.confirmLabel}
          danger={current.danger}
          onConfirm={current.onConfirm}
        />
      );
    default:
      return null;
  }
};
