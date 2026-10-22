import { Film, Settings, Shield, Wifi, WifiOff } from 'lucide-preact';
import { Avatar, IconButton, Logo, RoleBadge } from '@/components';
import { ChannelList } from '@/features/channels/ChannelList';
import { InstallHint } from '@/features/settings/InstallHint';
import { VoiceDock } from '@/features/voice/VoiceDock';
import { supportsClipStorage } from '@/services/clips/clipStore';
import { account, canManage, connectionStatus } from '@/state/session';
import { openModal } from '@/state/ui';

const ConnectionIcon = () => {
  const status = connectionStatus.value;
  if (status === 'connected') return <Wifi size={14} className="text-success" aria-label="Connected" />;
  return <WifiOff size={14} className="text-warning animate-pulse" aria-label="Reconnecting" />;
};

const UserBar = () => {
  const me = account.value;
  if (!me) return null;
  return (
    <div className="flex items-center gap-2 bg-base/60 px-2 py-2">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1 py-1 text-left hover:bg-hover"
        onClick={() => openModal({ type: 'profile' })}
        title="Edit profile"
      >
        <Avatar seed={me.id} name={me.displayName} src={me.avatarUrl} size={32} status="online" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-text-bright">{me.displayName}</span>
          <span className="flex items-center gap-1 text-xs text-text-muted">
            <RoleBadge roles={me.roles} hideMember={false} />
          </span>
        </span>
      </button>
      {canManage.value && (
        <IconButton label="Server admin" size="sm" onClick={() => openModal({ type: 'admin', tab: 'users' })}>
          <Shield size={18} />
        </IconButton>
      )}
      {supportsClipStorage() && (
        <IconButton label="Clips" size="sm" onClick={() => openModal({ type: 'clips' })}>
          <Film size={18} />
        </IconButton>
      )}
      <IconButton label="Settings" size="sm" onClick={() => openModal({ type: 'audioSettings' })}>
        <Settings size={18} />
      </IconButton>
    </div>
  );
};

export const Sidebar = () => (
  <>
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4 shadow-sm">
      <h1 className="flex min-w-0 items-center gap-2 text-base font-bold text-text-bright">
        <Logo size={22} className="shrink-0" />
        <span className="truncate">Datasetto</span>
      </h1>
      <ConnectionIcon />
    </header>
    <div className="scrollbar-thin flex-1 overflow-y-auto px-2 py-3">
      <ChannelList />
    </div>
    <InstallHint />
    <VoiceDock />
    <UserBar />
  </>
);
