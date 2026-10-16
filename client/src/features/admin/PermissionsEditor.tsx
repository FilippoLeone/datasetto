import { useMemo, useState } from 'preact/hooks';
import { Eye, Search } from 'lucide-preact';
import { Avatar, TextInput } from '@/components';
import { accountsWithAccess, type AccessContext } from '@/lib/channelAccess';
import { cn } from '@/lib/cn';
import { ROLE_LABELS } from '@/lib/format';
import type { Account, ChannelPermissionAction, ChannelPermissions, ChannelType, ChannelVisibility, RoleName } from '@/types/protocol';

export const EMPTY_PERMISSIONS: ChannelPermissions = {
  view: { roles: ['*'], accounts: [] },
  chat: { roles: ['*'], accounts: [] },
  voice: { roles: ['*'], accounts: [] },
  stream: { roles: ['*'], accounts: [] },
  manage: { roles: ['admin'], accounts: [] },
};

interface ActionInfo {
  id: ChannelPermissionAction;
  label: string;
  hint: string;
}

const ACTIONS: ActionInfo[] = [
  { id: 'view', label: 'See', hint: 'See the channel in the list, open it and read its history. Everything else needs this too.' },
  { id: 'chat', label: 'Chat', hint: 'Send messages (text and stream channels).' },
  { id: 'voice', label: 'Voice', hint: 'Join the voice room.' },
  { id: 'stream', label: 'Stream / share', hint: 'Get the stream key and publish, or share a screen.' },
  { id: 'manage', label: 'Manage', hint: 'Edit the channel settings.' },
];

/** Which actions matter for a channel kind (the others are kept but hidden). */
const RELEVANT: Record<ChannelType, ChannelPermissionAction[]> = {
  text: ['view', 'chat', 'manage'],
  voice: ['view', 'voice', 'stream', 'manage'],
  stream: ['view', 'chat', 'stream', 'manage'],
  screenshare: ['view', 'chat', 'stream', 'manage'],
  dm: ['view', 'chat'],
};

const ROLE_COLUMNS: Array<{ id: string; label: string; hint: string }> = [
  { id: '*', label: 'Everyone', hint: 'All signed-in members, whatever their role.' },
  ...(['admin', 'moderator', 'streamer', 'user'] as RoleName[]).map((role) => ({
    id: role,
    label: ROLE_LABELS[role],
    hint: role === 'user' ? 'Members without a special role.' : 'Anyone holding the ' + ROLE_LABELS[role] + ' role.',
  })),
];

export interface PermissionsEditorProps {
  value: ChannelPermissions;
  onChange: (next: ChannelPermissions) => void;
  /** Channel kind, to show only the actions that matter. */
  channelType: ChannelType;
  /** All accounts, for overrides and the preview (admins have them loaded). */
  accounts: readonly Account[];
  /** Private channel context for the preview; omit for public channels and templates. */
  visibility?: ChannelVisibility;
  memberIds?: ReadonlySet<string>;
  /** Hide the preview (e.g. for templates where no concrete channel exists). */
  previewTitle?: string;
}

/**
 * Role matrix, per-member overrides with search, and a live preview of who
 * ends up with each right. Shared by the channel dialog and the "defaults for
 * new channels" editor in the admin panel.
 */
export const PermissionsEditor = ({ value, onChange, channelType, accounts, visibility = 'public', memberIds, previewTitle }: PermissionsEditorProps) => {
  const [query, setQuery] = useState('');
  const actions = ACTIONS.filter((action) => RELEVANT[channelType].includes(action.id));
  const members = memberIds ?? new Set<string>();
  const context: AccessContext = { permissions: value, visibility, memberIds: members };

  const toggleRole = (action: ChannelPermissionAction, role: string) => {
    const roles = value[action].roles;
    let next: string[];
    if (role === '*') next = roles.includes('*') ? [] : ['*'];
    else {
      const without = roles.filter((entry) => entry !== '*');
      next = without.includes(role) ? without.filter((entry) => entry !== role) : [...without, role];
    }
    onChange({ ...value, [action]: { ...value[action], roles: next } });
  };

  const toggleAccount = (action: ChannelPermissionAction, accountId: string) => {
    const list = value[action].accounts;
    const next = list.includes(accountId) ? list.filter((entry) => entry !== accountId) : [...list, accountId];
    onChange({ ...value, [action]: { ...value[action], accounts: next } });
  };

  const overridden = useMemo(() => {
    const ids = new Set<string>();
    for (const action of actions) for (const id of value[action.id].accounts) ids.add(id);
    return ids;
  }, [value, actions]);

  const needle = query.trim().toLowerCase();
  const shownAccounts = accounts.filter((account) => {
    if (needle) return account.displayName.toLowerCase().includes(needle) || account.username.toLowerCase().includes(needle);
    return overridden.has(account.id);
  });

  const preview = actions.map((action) => ({ action, allowed: accountsWithAccess(accounts, action.id, context) }));

  return (
    <div className="flex flex-col gap-4">
      {/* ------------------------------------------------------------ role matrix */}
      <section>
        <p className="text-sm font-semibold text-text-bright">Roles</p>
        <p className="mb-2 text-xs text-text-muted">
          Tick who may do what. "Everyone" covers all members; untick it to pick roles. Superusers always have every right.
          {visibility === 'private' && ' This channel is private: on top of these roles, people must be members (admins excepted).'}
        </p>
        <div className="overflow-x-auto rounded-md bg-base/60">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-text-muted">
                <th className="px-3 py-2 text-left font-medium">Action</th>
                {ROLE_COLUMNS.map((column) => (
                  <th key={column.id} className="px-2 py-2 text-center font-medium" title={column.hint}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {actions.map((action) => {
                const entry = value[action.id];
                const everyone = entry.roles.includes('*');
                return (
                  <tr key={action.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <span className="block font-medium text-text-bright">{action.label}</span>
                      <span className="block text-xs text-text-muted">{action.hint}</span>
                    </td>
                    {ROLE_COLUMNS.map((column) => {
                      const checked = column.id === '*' ? everyone : everyone || entry.roles.includes(column.id);
                      const implied = column.id !== '*' && everyone;
                      return (
                        <td key={column.id} className="px-2 py-2 text-center">
                          <input
                            type="checkbox"
                            aria-label={action.label + ': ' + column.label}
                            checked={checked}
                            disabled={implied}
                            title={implied ? 'Included in Everyone' : column.hint}
                            onChange={() => toggleRole(action.id, column.id)}
                            className={cn(implied && 'opacity-40')}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ------------------------------------------------------- member overrides */}
      <section>
        <p className="text-sm font-semibold text-text-bright">Member overrides</p>
        <p className="mb-2 text-xs text-text-muted">Grant single members a right their role does not give them. Search by name or email to add someone.</p>
        <div className="relative mb-2">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-faint" />
          <TextInput value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} placeholder="Search members…" className="pl-8" aria-label="Search members" />
        </div>
        {shownAccounts.length === 0 ? (
          <p className="px-1 text-xs text-text-faint">{needle ? 'No member matches.' : 'No overrides yet. Search for a member to add one.'}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {shownAccounts.slice(0, 25).map((account) => (
              <li key={account.id} className="flex flex-wrap items-center gap-2 rounded-sm bg-base/60 px-2 py-1.5 text-sm">
                <Avatar seed={account.id} name={account.displayName} src={account.avatarUrl} size={22} />
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-text-bright">{account.displayName}</span>
                  <span className="ml-1 text-xs text-text-faint">{account.username}</span>
                </span>
                <span className="flex flex-wrap gap-2">
                  {actions.map((action) => (
                    <label key={action.id} className="flex items-center gap-1 text-xs text-text-muted">
                      <input type="checkbox" checked={value[action.id].accounts.includes(account.id)} onChange={() => toggleAccount(action.id, account.id)} />
                      {action.label}
                    </label>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------------------------------------------------------------- preview */}
      <section className="rounded-md border border-border bg-base/40 p-3">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-text-bright">
          <Eye size={14} /> {previewTitle ?? 'Who can do what right now'}
        </p>
        <ul className="mt-2 flex flex-col gap-1.5 text-xs" data-permissions-preview>
          {preview.map(({ action, allowed }) => {
            const names = allowed.map((account) => account.displayName);
            const everyone = accounts.length > 0 && allowed.length === accounts.filter((a) => a.status !== 'disabled').length;
            return (
              <li key={action.id} className="flex gap-2">
                <span className="w-24 shrink-0 font-medium text-text">{action.label}</span>
                <span className="min-w-0 text-text-muted">
                  {allowed.length === 0 ? (
                    <span className="text-[#fa777c]">nobody (superusers excepted)</span>
                  ) : everyone ? (
                    'everyone (' + allowed.length + ')'
                  ) : (
                    (names.length > 8 ? names.slice(0, 8).join(', ') + ' and ' + (names.length - 8) + ' more' : names.join(', ')) + ' (' + allowed.length + ')'
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
};
