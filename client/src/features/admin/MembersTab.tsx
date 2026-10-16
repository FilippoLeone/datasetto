import { useEffect, useMemo, useState } from 'preact/hooks';
import { ArrowUpDown, KeyRound, LogOut, MonitorSmartphone, Pencil, Search, ShieldCheck, Trash2, UserCheck, UserX } from 'lucide-preact';
import { Avatar, Button, RoleBadge, Select, TextInput } from '@/components';
import { cn } from '@/lib/cn';
import { formatFullDate, formatRelative, ROLE_LABELS, ROLE_ORDER, primaryRole } from '@/lib/format';
import { api } from '@/services/socket/api';
import { adminAccounts, adminSessions } from '@/state/misc';
import { account, can, isSuperuser } from '@/state/session';
import { openModal } from '@/state/ui';
import type { Account, RoleName } from '@/types/protocol';

type SortKey = 'name' | 'created' | 'seen' | 'role' | 'status';
type Panel = 'roles' | 'rename' | 'password' | 'sessions' | null;

const ASSIGNABLE: RoleName[] = ['admin', 'moderator', 'streamer', 'user'];

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'seen', label: 'Last seen' },
  { value: 'name', label: 'Name' },
  { value: 'created', label: 'Joined' },
  { value: 'role', label: 'Role' },
  { value: 'status', label: 'Status' },
];

const STATUS_STYLES: Record<Account['status'], string> = {
  active: 'bg-success/20 text-[#7be39b]',
  disabled: 'bg-warning/20 text-[#ffd38a]',
  deleted: 'bg-active text-text-muted',
};

const sortAccounts = (list: Account[], key: SortKey): Account[] =>
  [...list].sort((a, b) => {
    switch (key) {
      case 'name':
        return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
      case 'created':
        return (b.createdAt ?? 0) - (a.createdAt ?? 0);
      case 'seen':
        return (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0);
      case 'role':
        return ROLE_ORDER.indexOf(primaryRole(a.roles)) - ROLE_ORDER.indexOf(primaryRole(b.roles));
      case 'status':
        return a.status.localeCompare(b.status);
      default:
        return 0;
    }
  });

/** May the signed-in admin act on this account (not self, not above them)? */
const outranks = (target: Account): boolean => {
  const me = account.value;
  if (!me || target.id === me.id) return false;
  if (isSuperuser.value) return true;
  return ROLE_ORDER.indexOf(primaryRole(me.roles)) < ROLE_ORDER.indexOf(primaryRole(target.roles));
};

const SessionsPanel = ({ user }: { user: Account }) => {
  const payload = adminSessions.value[user.id];
  useEffect(() => {
    api.listAccountSessions(user.id);
  }, [user.id]);
  const sessions = payload?.sessions ?? [];
  return (
    <div className="rounded-sm bg-sidebar p-2 text-sm">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium text-text-bright">Active sessions ({sessions.length})</span>
        {sessions.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => api.revokeAccountSessions(user.id)}>
            <LogOut size={14} /> Sign out everywhere
          </Button>
        )}
      </div>
      {!payload && <p className="text-xs text-text-muted">Loading…</p>}
      {payload && sessions.length === 0 && <p className="text-xs text-text-muted">No active sessions.</p>}
      <ul className="flex flex-col gap-1">
        {sessions.map((session) => (
          <li key={session.id} className="flex flex-wrap items-center gap-2 rounded-sm bg-base/60 px-2 py-1 text-xs">
            <span className={cn('h-2 w-2 rounded-full', session.online ? 'bg-online' : 'bg-text-faint')} title={session.online ? 'Connected now' : 'Not connected'} />
            <span className="min-w-0 flex-1 truncate text-text" title={session.userAgent ?? ''}>
              {(session.userAgent ?? 'Unknown client').slice(0, 60)}
              {session.current && <span className="ml-1 text-text-faint">(this session)</span>}
            </span>
            <span className="text-text-faint">{session.ip ?? '?'}</span>
            <span className="text-text-faint" title={'Signed in ' + formatFullDate(session.createdAt)}>
              seen {formatRelative(session.lastSeenAt)}
            </span>
            {!session.current && (
              <Button size="sm" variant="ghost" onClick={() => api.revokeAccountSessions(user.id, session.id)}>
                Revoke
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};

const MemberRow = ({ user }: { user: Account }) => {
  const [panel, setPanel] = useState<Panel>(null);
  const [roles, setRoles] = useState<RoleName[]>(user.roles);
  const [name, setName] = useState(user.displayName);
  const [temporary, setTemporary] = useState('');
  const me = account.value;
  const isMe = user.id === me?.id;
  const deleted = user.status === 'deleted';
  const disabled = user.status === 'disabled';
  const manageable = outranks(user);
  const assignable = isSuperuser.value ? ['superuser', ...ASSIGNABLE] : ASSIGNABLE;

  const toggle = (next: Panel) => setPanel((current) => (current === next ? null : next));
  const toggleRole = (role: RoleName) => setRoles((current) => (current.includes(role) ? current.filter((entry) => entry !== role) : [...current, role]));

  return (
    <li className={cn('rounded-md bg-base/60 p-3', (disabled || deleted) && 'opacity-70')} data-member={user.username}>
      <div className="flex items-center gap-3">
        <Avatar seed={user.id} name={user.displayName} src={user.avatarUrl} size={36} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-bright">
            <span className="truncate">{user.displayName}</span>
            {isMe && <span className="text-xs font-normal text-text-muted">(you)</span>}
            <span className={cn('rounded-sm px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase', STATUS_STYLES[user.status])}>{user.status}</span>
            {user.mustChangePassword && <span className="rounded-sm bg-warning/20 px-1.5 py-px text-[10px] font-semibold text-[#ffd38a] uppercase">temporary password</span>}
          </p>
          <p className="truncate text-xs text-text-muted">{user.username}</p>
          <p className="text-[11px] text-text-faint">
            Joined {user.createdAt ? formatFullDate(user.createdAt) : '?'} · last seen {formatRelative(user.lastSeenAt ?? null)}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {user.roles.map((role) => (
            <RoleBadge key={role} roles={[role]} hideMember={false} />
          ))}
        </div>
      </div>
      {!deleted && (
        <div className="mt-2 flex flex-wrap gap-2">
          {can('canAssignRoles') && !isMe && (
            <Button size="sm" variant={panel === 'roles' ? 'primary' : 'secondary'} onClick={() => toggle('roles')}>
              <ShieldCheck size={14} /> Roles
            </Button>
          )}
          {can('canManageUsers') && (
            <Button size="sm" variant={panel === 'rename' ? 'primary' : 'secondary'} onClick={() => toggle('rename')}>
              <Pencil size={14} /> Rename
            </Button>
          )}
          {can('canManageUsers') && manageable && (
            <Button size="sm" variant={panel === 'password' ? 'primary' : 'secondary'} onClick={() => toggle('password')}>
              <KeyRound size={14} /> Reset password
            </Button>
          )}
          {can('canManageUsers') && (
            <Button size="sm" variant={panel === 'sessions' ? 'primary' : 'secondary'} onClick={() => toggle('sessions')}>
              <MonitorSmartphone size={14} /> Sessions
            </Button>
          )}
          {can('canDisableAccounts') &&
            manageable &&
            (disabled ? (
              <Button size="sm" variant="secondary" onClick={() => api.enableAccount(user.id)}>
                <UserCheck size={14} /> Enable
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => api.disableAccount(user.id, 'Disabled by ' + (me?.displayName ?? 'admin'))}>
                <UserX size={14} /> Disable
              </Button>
            ))}
          {can('canDisableAccounts') && manageable && (
            <Button
              size="sm"
              variant="danger"
              onClick={() =>
                openModal({
                  type: 'confirm',
                  title: 'Delete ' + user.displayName + '?',
                  message:
                    'The account is signed out everywhere and can no longer sign in. Its messages stay, shown as "Deleted user", and the email address becomes free for a new account. This cannot be undone.',
                  confirmLabel: 'Delete account',
                  danger: true,
                  onConfirm: () => api.deleteAccount(user.id),
                })
              }
            >
              <Trash2 size={14} /> Delete
            </Button>
          )}
        </div>
      )}
      {panel === 'roles' && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-sm bg-sidebar p-2">
          {assignable.map((role) => (
            <label key={role} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={roles.includes(role as RoleName)} onChange={() => toggleRole(role as RoleName)} />
              {ROLE_LABELS[role as RoleName]}
            </label>
          ))}
          <span className="flex-1" />
          <Button
            size="sm"
            disabled={roles.length === 0}
            onClick={() => {
              api.updateRoles(user.id, ROLE_ORDER.filter((role) => roles.includes(role)));
              setPanel(null);
            }}
          >
            Save roles
          </Button>
        </div>
      )}
      {panel === 'rename' && (
        <form
          className="mt-2 flex items-center gap-2 rounded-sm bg-sidebar p-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) api.adminUpdateAccount(user.id, name.trim());
            setPanel(null);
          }}
        >
          <TextInput value={name} maxLength={50} autoFocus onInput={(e) => setName((e.target as HTMLInputElement).value)} aria-label="Display name" />
          <Button size="sm" type="submit" disabled={!name.trim() || name.trim() === user.displayName}>
            Save name
          </Button>
        </form>
      )}
      {panel === 'password' && (
        <form
          className="mt-2 rounded-sm bg-sidebar p-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (temporary.length >= 8) api.resetAccountPassword(user.id, temporary);
            setTemporary('');
            setPanel(null);
          }}
        >
          <p className="mb-1 text-xs text-text-muted">
            Set a temporary password and hand it over. {user.displayName} is signed out everywhere and must choose a new password on the next sign-in.
          </p>
          <div className="flex items-center gap-2">
            <TextInput type="text" autoComplete="off" spellcheck={false} value={temporary} minLength={8} maxLength={128} autoFocus onInput={(e) => setTemporary((e.target as HTMLInputElement).value)} placeholder="Temporary password (8+ characters)" aria-label="Temporary password" />
            <Button size="sm" type="submit" variant="danger" disabled={temporary.length < 8}>
              Reset
            </Button>
          </div>
        </form>
      )}
      {panel === 'sessions' && <div className="mt-2"><SessionsPanel user={user} /></div>}
    </li>
  );
};

/** All accounts with search, sort and the management actions. */
export const MembersTab = () => {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('seen');
  const [showDeleted, setShowDeleted] = useState(false);
  const accounts = adminAccounts.value;

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = accounts.filter((entry) => {
      if (!showDeleted && entry.status === 'deleted') return false;
      if (!needle) return true;
      return entry.displayName.toLowerCase().includes(needle) || entry.username.toLowerCase().includes(needle) || entry.roles.some((role) => role.includes(needle));
    });
    return sortAccounts(filtered, sort);
  }, [accounts, query, sort, showDeleted]);

  const deletedCount = accounts.filter((entry) => entry.status === 'deleted').length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative min-w-48 flex-1">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-faint" />
          <TextInput value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} placeholder="Search by name, email or role…" className="pl-8" aria-label="Search members" />
        </div>
        <div className="flex items-center gap-1">
          <ArrowUpDown size={14} className="text-text-faint" />
          <Select value={sort} options={SORT_OPTIONS} onChange={(value) => setSort(value as SortKey)} className="w-36 py-0" />
        </div>
        {deletedCount > 0 && (
          <label className="flex items-center gap-1.5 pb-2 text-xs text-text-muted">
            <input type="checkbox" checked={showDeleted} onChange={() => setShowDeleted((value) => !value)} /> Show deleted ({deletedCount})
          </label>
        )}
      </div>
      <p className="text-xs text-text-faint">
        {shown.length} of {accounts.length} accounts
      </p>
      <ul className="flex flex-col gap-2">
        {shown.map((user) => (
          <MemberRow key={user.id} user={user} />
        ))}
        {accounts.length === 0 && <p className="text-sm text-text-muted">Loading accounts…</p>}
        {accounts.length > 0 && shown.length === 0 && <p className="text-sm text-text-muted">No account matches.</p>}
      </ul>
    </div>
  );
};
