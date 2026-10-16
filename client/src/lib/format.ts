import type { RoleName } from '@/types/protocol';

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fullFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const isSameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "14:05" for today, "Oct 3, 14:05" otherwise. */
export const formatMessageTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  const now = new Date();
  if (isSameDay(date, now)) return timeFormatter.format(date);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, yesterday)) return 'Yesterday ' + timeFormatter.format(date);
  return dateFormatter.format(date) + ', ' + timeFormatter.format(date);
};

export const formatFullDate = (timestamp: number): string => fullFormatter.format(new Date(timestamp));

/** "just now", "5 min ago", "3 h ago", "2 days ago", else a date; "never" for null. */
export const formatRelative = (timestamp: number | null | undefined, now = Date.now()): string => {
  if (!timestamp) return 'never';
  const diff = Math.max(0, now - timestamp);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' min ago';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' h ago';
  if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + ' days ago';
  return dateFormatter.format(new Date(timestamp));
};

/** "Today", "Yesterday" or a date, for day separators. */
export const formatDayLabel = (timestamp: number): string => {
  const date = new Date(timestamp);
  const now = new Date();
  if (isSameDay(date, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, yesterday)) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(date);
};

export const sameDay = (a: number, b: number): boolean => isSameDay(new Date(a), new Date(b));

/** "1:05:09" or "05:09". */
export const formatDuration = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? hours + ':' + mm + ':' + ss : mm + ':' + ss;
};

export const ROLE_LABELS: Record<RoleName, string> = {
  superuser: 'Superuser',
  admin: 'Admin',
  moderator: 'Mod',
  streamer: 'Streamer',
  user: 'Member',
};

export const ROLE_ORDER: RoleName[] = ['superuser', 'admin', 'moderator', 'streamer', 'user'];

/** The most important role a user holds. */
export const primaryRole = (roles: readonly string[] | undefined | null): RoleName =>
  ROLE_ORDER.find((role) => roles?.includes(role)) ?? 'user';

export const formatRole = (role: string): string => ROLE_LABELS[role as RoleName] ?? role;

export const initials = (name: string | null | undefined): string => {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/[\s_.-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return value.toFixed(1) + ' ' + units[unit];
};

export const pluralize = (count: number, singular: string, plural = singular + 's'): string =>
  count + ' ' + (count === 1 ? singular : plural);
