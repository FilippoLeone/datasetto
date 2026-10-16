import { useEffect, useState } from 'preact/hooks';
import { Activity, Ban, Copy, Hash, KeyRound, Link2, Server, Ticket, Trash2, Users, X, XCircle } from 'lucide-preact';
import { Button, Field, IconButton, Select, TextInput } from '@/components';
import { cn } from '@/lib/cn';
import { formatFullDate } from '@/lib/format';
import { inviteLinkFor } from '@/lib/inviteLink';
import { api } from '@/services/socket/api';
import { serverConfig } from '@/services/ServerConfigService';
import { channels } from '@/state/channels';
import { adminAccounts, adminBans, adminInvites, adminSettings, lastCreatedInvite } from '@/state/misc';
import { EMPTY_PERMISSIONS, PermissionsEditor } from './PermissionsEditor';
import { MembersTab } from './MembersTab';
import { UsageSection } from './UsageSection';
import { ServerSection } from './ServerSection';
import { can, isSuperuser } from '@/state/session';
import { closeModal, openModal, toast, type AdminSection } from '@/state/ui';
import { CHANNEL_ICONS } from '@/app/layout/MainArea';
import type { ChannelPermissions, CreatableChannelType, InviteToken } from '@/types/protocol';



const USES_OPTIONS = [
  { value: '1', label: 'Single use' },
  { value: '5', label: '5 uses' },
  { value: '10', label: '10 uses' },
  { value: '25', label: '25 uses' },
  { value: '100', label: '100 uses' },
];

const EXPIRY_OPTIONS = [
  { value: '0', label: 'Never expires' },
  { value: '1', label: 'Expires in 1 day' },
  { value: '7', label: 'Expires in 7 days' },
  { value: '30', label: 'Expires in 30 days' },
];

const copyText = async (value: string, label: string) => {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(label + ' copied');
  } catch {
    toast.error('Clipboard unavailable, copy it manually');
  }
};

const STATUS_STYLES: Record<InviteToken['status'], string> = {
  active: 'bg-success/20 text-[#7be39b]',
  revoked: 'bg-danger/20 text-[#fa777c]',
  expired: 'bg-active text-text-muted',
  exhausted: 'bg-warning/20 text-[#ffd38a]',
};

const InviteRow = ({ invite }: { invite: InviteToken }) => {
  const link = inviteLinkFor(invite.token);
  return (
    <li className={cn('rounded-md bg-base/60 p-3', invite.status !== 'active' && 'opacity-75')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('rounded-sm px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase', STATUS_STYLES[invite.status])}>{invite.status}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-bright">{invite.note ?? 'No note'}</span>
        <span className="text-xs text-text-muted tabular-nums" title="Uses">
          {invite.uses} / {invite.maxUses} used
        </span>
      </div>
      <p className="mt-1 truncate font-mono text-xs text-text-muted" title={link}>
        {link}
      </p>
      <p className="mt-1 text-xs text-text-faint">
        Created {formatFullDate(invite.createdAt)}
        {invite.createdByName ? ' by ' + invite.createdByName : ''}
        {invite.expiresAt ? ' · expires ' + formatFullDate(invite.expiresAt) : ' · never expires'}
        {invite.redeemedBy.length > 0 ? ' · joined: ' + invite.redeemedBy.map((entry) => entry.displayName).join(', ') : ''}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => void copyText(link, 'Invite link')}>
          <Copy size={14} /> Copy link
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void copyText(invite.token, 'Invite token')}>
          Copy token
        </Button>
        {invite.status === 'active' && (
          <Button size="sm" variant="ghost" onClick={() => api.revokeInvite(invite.id)}>
            <XCircle size={14} /> Revoke
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => api.deleteInvite(invite.id)}>
          <Trash2 size={14} /> Delete
        </Button>
      </div>
    </li>
  );
};

const InvitesTab = () => {
  const [maxUses, setMaxUses] = useState('1');
  const [expiry, setExpiry] = useState('0');
  const [note, setNote] = useState('');
  const mode = serverConfig.registrationMode();
  const created = lastCreatedInvite.value;

  useEffect(() => {
    api.listInvites();
    return () => {
      lastCreatedInvite.value = null;
    };
  }, []);

  const create = (event: Event) => {
    event.preventDefault();
    const days = Number(expiry);
    api.createInvite({
      maxUses: Number(maxUses),
      expiresAt: days > 0 ? Date.now() + days * 86_400_000 : null,
      note: note.trim() || null,
    });
    setNote('');
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-text-muted">
        {mode === 'closed'
          ? 'Registration is closed (REGISTRATION_MODE=closed), so invite links do not work until the mode is changed on the server.'
          : mode === 'invite'
            ? 'Registration needs the shared invite code or one of these links. Links work on their own and show who used them.'
            : 'Registration is open; invite links still record who joined through them.'}
      </p>
      <form onSubmit={create} className="rounded-md bg-base/60 p-3">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-text-bright">
          <Link2 size={14} /> New invite link
        </p>
        <div className="grid gap-x-3 sm:grid-cols-2">
          <Select label="Uses" value={maxUses} options={USES_OPTIONS} onChange={setMaxUses} />
          <Select label="Expiry" value={expiry} options={EXPIRY_OPTIONS} onChange={setExpiry} />
        </div>
        <Field label="Note" hint="Optional. Who it is for, so you recognise it later.">
          <TextInput value={note} maxLength={200} onInput={(e) => setNote((e.target as HTMLInputElement).value)} placeholder="For Sam" />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" size="sm">
            Create invite
          </Button>
        </div>
      </form>
      {created && (
        <div className="rounded-md border border-success/40 bg-success/10 p-3">
          <p className="text-sm font-semibold text-text-bright">Share this link</p>
          <p className="mt-1 break-all font-mono text-xs text-text">{inviteLinkFor(created.token)}</p>
          <Button size="sm" className="mt-2" onClick={() => void copyText(inviteLinkFor(created.token), 'Invite link')}>
            <Copy size={14} /> Copy link
          </Button>
        </div>
      )}
      <ul className="flex flex-col gap-2">
        {adminInvites.value.map((invite) => (
          <InviteRow key={invite.id} invite={invite} />
        ))}
        {adminInvites.value.length === 0 && <p className="text-sm text-text-muted">No invite links yet.</p>}
      </ul>
    </div>
  );
};

const TEMPLATE_KINDS: Array<{ value: CreatableChannelType; label: string }> = [
  { value: 'text', label: 'Text channels' },
  { value: 'voice', label: 'Voice channels' },
  { value: 'stream', label: 'Live streams' },
  { value: 'screenshare', label: 'Screenshare rooms' },
];

/** Permissions new channels of a kind start with; edited and saved per kind. */
const TemplatesSection = () => {
  const [kind, setKind] = useState<CreatableChannelType>('text');
  const [draft, setDraft] = useState<ChannelPermissions | null>(null);
  const settings = adminSettings.value;
  const stored = settings?.channelPermissionTemplates[kind] ?? null;
  const value = draft ?? stored ?? EMPTY_PERMISSIONS;

  useEffect(() => {
    api.getSettings();
  }, []);

  return (
    <section className="rounded-md bg-base/60 p-3">
      <p className="text-sm font-semibold text-text-bright">Defaults for new channels</p>
      <p className="mb-2 text-xs text-text-muted">
        New channels copy these permissions when they are created (the creator can still change them afterwards). Kinds without a template use the server default:
        everyone may see, chat, talk and stream; admins manage.
      </p>
      <Select
        label="Channel kind"
        value={kind}
        options={TEMPLATE_KINDS.map((entry) => ({ value: entry.value, label: entry.label + (settings?.channelPermissionTemplates[entry.value] ? ' (custom)' : ' (server default)') }))}
        onChange={(next) => {
          setKind(next as CreatableChannelType);
          setDraft(null);
        }}
      />
      {settings ? (
        <PermissionsEditor value={value} onChange={setDraft} channelType={kind} accounts={adminAccounts.value} previewTitle={'Who could do what in a new ' + kind + ' channel'} />
      ) : (
        <p className="text-sm text-text-muted">Loading settings…</p>
      )}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {stored && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              api.updateSettings({ channelPermissionTemplates: { [kind]: null } });
              setDraft(null);
            }}
          >
            Reset to server default
          </Button>
        )}
        <Button
          size="sm"
          disabled={!draft}
          onClick={() => {
            if (!draft) return;
            api.updateSettings({ channelPermissionTemplates: { [kind]: draft } });
            setDraft(null);
          }}
        >
          Save template
        </Button>
      </div>
    </section>
  );
};

const ChannelsTab = () => (
  <div className="flex flex-col gap-3">
    {can('canManageChannelPermissions') && <TemplatesSection />}
    <ChannelRows />
  </div>
);

const ChannelRows = () => (
  <ul className="flex flex-col gap-1">
    {channels.value.filter((channel) => channel.type !== 'dm').map((channel) => {
      const Icon = CHANNEL_ICONS[channel.type];
      return (
        <li key={channel.id} className="flex items-center gap-2 rounded-md bg-base/60 px-3 py-2">
          <Icon size={16} className="text-text-muted" />
          <span className="min-w-0 flex-1 truncate text-sm text-text-bright">{channel.name}</span>
          <span className="text-xs text-text-faint">{channel.type}</span>
          {can('canManageChannelPermissions') && (
            <Button size="sm" variant="secondary" onClick={() => openModal({ type: 'channelPermissions', channelId: channel.id })}>
              <KeyRound size={14} /> Permissions
            </Button>
          )}
          {can('canDeleteChannels') && (
            <Button
              size="sm"
              variant="danger"
              onClick={() =>
                openModal({
                  type: 'confirm',
                  title: 'Delete #' + channel.name + '?',
                  message: 'All messages in this channel are deleted. This cannot be undone.',
                  confirmLabel: 'Delete',
                  danger: true,
                  onConfirm: () => api.deleteChannel(channel.id),
                })
              }
            >
              <Trash2 size={14} />
            </Button>
          )}
        </li>
      );
    })}
  </ul>
);

const BansTab = () => {
  const accounts = adminAccounts.value;
  return (
    <ul className="flex flex-col gap-2">
      {adminBans.value.map((ban) => {
        const user = accounts.find((entry) => entry.id === ban.accountId);
        return (
          <li key={ban.accountId} className="flex items-center gap-3 rounded-md bg-base/60 px-3 py-2">
            <Ban size={16} className="text-live" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-text-bright">{user?.displayName ?? ban.accountId}</p>
              <p className="truncate text-xs text-text-muted">
                {ban.reason ?? 'No reason'} · by {ban.bannedBy ?? 'unknown'} · {formatFullDate(ban.bannedAt)}
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => api.unbanAccount(ban.accountId)}>
              Unban
            </Button>
          </li>
        );
      })}
      {adminBans.value.length === 0 && <p className="text-sm text-text-muted">No active bans.</p>}
    </ul>
  );
};

/** Where the panel lives in the address bar: /app/admin on the deployed site, /admin in dev. */
const adminPath = (): string => (window.location.pathname.startsWith('/app') ? '/app/admin' : '/admin');
const appPath = (): string => (window.location.pathname.startsWith('/app') ? '/app' : '/');

/** True when the page was opened on the admin deep link. */
export const openedOnAdminPath = (): boolean => /\/admin\/?$/.test(window.location.pathname);

interface SectionInfo {
  id: AdminSection;
  label: string;
  hint: string;
  icon: typeof Users;
  show: boolean;
}

/**
 * Full-screen admin area with a section list on the left. Opened from the
 * sidebar shield or by visiting /app/admin; closing returns to the app.
 */
export const AdminModal = ({ initialTab }: { initialTab: AdminSection }) => {
  const [tab, setTab] = useState<AdminSection>(initialTab);

  useEffect(() => {
    api.listAccounts();
    if (can('canBanUsers')) api.listBans();
    const previous = window.location.pathname + window.location.search + window.location.hash;
    try {
      window.history.replaceState(null, '', adminPath());
    } catch {
      /* file:// in the shells */
    }
    return () => {
      try {
        window.history.replaceState(null, '', openedOnAdminPath() ? appPath() : previous.replace(/\/admin\/?$/, '') || appPath());
      } catch {
        /* ignore */
      }
    };
  }, []);

  const sections: SectionInfo[] = (
    [
    { id: 'users', label: 'Members', hint: 'Accounts, roles, passwords, sessions', icon: Users, show: can('canManageUsers') },
    { id: 'invites', label: 'Invites', hint: 'Invite links and who used them', icon: Ticket, show: can('canManageUsers') },
    { id: 'channels', label: 'Channels', hint: 'Permissions and defaults for new channels', icon: Hash, show: can('canManageChannelPermissions') || can('canDeleteChannels') },
    { id: 'bans', label: 'Bans', hint: 'Banned accounts', icon: Ban, show: can('canBanUsers') },
    { id: 'usage', label: 'Usage', hint: 'Streaming traffic, live streams, viewers', icon: Activity, show: can('canManageUsers') },
    { id: 'server', label: 'Server', hint: 'Version, registration, limits (superusers)', icon: Server, show: isSuperuser.value },
    ] satisfies SectionInfo[]
  ).filter((entry) => entry.show);
  const current = sections.find((entry) => entry.id === tab) ?? sections[0];

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-main animate-fade-in safe-top safe-x safe-bottom" role="dialog" aria-modal="true" aria-label="Server admin">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4 shadow-sm">
        <Server size={18} className="text-text-muted" />
        <h2 className="text-base font-semibold text-text-bright">Server admin</h2>
        <span className="hidden text-xs text-text-faint sm:inline">{adminPath()}</span>
        <span className="flex-1" />
        <IconButton label="Close admin" size="sm" onClick={closeModal}>
          <X size={18} />
        </IconButton>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="scrollbar-thin flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-sidebar p-2 max-md:w-14" aria-label="Admin sections">
          {sections.map((entry) => {
            const Icon = entry.icon;
            const active = entry.id === current?.id;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => setTab(entry.id)}
                title={entry.hint}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-sm px-2 py-2 text-left text-sm transition-colors max-md:justify-center',
                  active ? 'bg-active text-text-bright' : 'text-text-muted hover:bg-hover hover:text-text',
                )}
              >
                <Icon size={16} className="shrink-0" />
                <span className="min-w-0 max-md:hidden">
                  <span className="block truncate font-medium">{entry.label}</span>
                  <span className="block truncate text-[11px] text-text-faint">{entry.hint}</span>
                </span>
              </button>
            );
          })}
        </nav>
        <main className="scrollbar-thin min-w-0 flex-1 overflow-y-auto p-4">
          <div className="mx-auto max-w-4xl">
            <h3 className="mb-3 text-lg font-semibold text-text-bright">{current?.label}</h3>
            {current?.id === 'users' && <MembersTab />}
            {current?.id === 'invites' && <InvitesTab />}
            {current?.id === 'channels' && <ChannelsTab />}
            {current?.id === 'bans' && <BansTab />}
            {current?.id === 'usage' && <UsageSection />}
            {current?.id === 'server' && <ServerSection />}
          </div>
        </main>
      </div>
    </div>
  );
};
