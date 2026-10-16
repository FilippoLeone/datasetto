import { signal } from '@preact/signals';
import type { ChannelType, NotificationType } from '@/types/protocol';

export type Modal =
  | { type: 'auth'; mode: 'login' | 'register' }
  | { type: 'profile' }
  | { type: 'createChannel'; channelType: ChannelType }
  | { type: 'streamKey'; channelId: string }
  | { type: 'audioSettings' }
  | { type: 'admin'; tab: 'users' | 'channels' | 'bans' }
  | { type: 'channelPermissions'; channelId: string }
  | { type: 'confirm'; title: string; message: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void };

export const modal = signal<Modal | null>(null);
export const openModal = (next: Modal): void => {
  modal.value = next;
};
export const closeModal = (): void => {
  modal.value = null;
};

export interface Toast {
  id: string;
  type: NotificationType;
  message: string;
  duration: number;
}

export const toasts = signal<Toast[]>([]);

let toastCounter = 0;

export const pushToast = (type: NotificationType, message: string, duration = type === 'error' ? 6000 : 3500): string => {
  const id = 'toast-' + Date.now() + '-' + (toastCounter += 1);
  toasts.value = [...toasts.value.slice(-4), { id, type, message, duration }];
  if (duration > 0) {
    window.setTimeout(() => dismissToast(id), duration);
  }
  return id;
};

export const dismissToast = (id: string): void => {
  if (!toasts.value.some((toast) => toast.id === id)) return;
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
};

export const toast = {
  info: (message: string, duration?: number) => pushToast('info', message, duration),
  success: (message: string, duration?: number) => pushToast('success', message, duration),
  warning: (message: string, duration?: number) => pushToast('warning', message, duration),
  error: (message: string, duration?: number) => pushToast('error', message, duration),
};

// Responsive layout -----------------------------------------------------------

const mobileQuery = window.matchMedia('(max-width: 1023px)');
export const isMobile = signal(mobileQuery.matches);
mobileQuery.addEventListener('change', (event) => {
  isMobile.value = event.matches;
  if (!event.matches) {
    sidebarOpen.value = false;
    membersOpen.value = false;
  }
});

/** Mobile drawers. */
export const sidebarOpen = signal(false);
export const membersOpen = signal(false);
/** Desktop member list visibility. */
export const showMembers = signal(true);
/** Stream page: hide chat dock. */
export const theaterMode = signal(false);

export const closeDrawers = (): void => {
  sidebarOpen.value = false;
  membersOpen.value = false;
};
