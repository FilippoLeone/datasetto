import { signal } from '@preact/signals';
import type { CreatableChannelType, NotificationType } from '@/types/protocol';

export type AdminSection = 'users' | 'invites' | 'channels' | 'bans' | 'usage' | 'server';

export type Modal =
  | { type: 'auth'; mode: 'login' | 'register' }
  | { type: 'profile' }
  | { type: 'createChannel'; channelType: CreatableChannelType }
  | { type: 'joinPrivateChannel' }
  | { type: 'streamKey'; channelId: string }
  | { type: 'audioSettings' }
  | { type: 'clips' }
  | { type: 'admin'; tab: AdminSection }
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

/** Below the lg breakpoint: the member list becomes a drawer. */
export const MOBILE_QUERY = '(max-width: 1023px)';
/**
 * Phones: below the md breakpoint, or a touch screen that is short enough to
 * be a phone held sideways (a landscape phone is wider than 767px but still
 * needs the drawer and the compact chrome; a desktop window of that height
 * has a fine pointer and keeps the tablet/desktop layout).
 */
export const PHONE_QUERY = '(max-width: 767px), ((max-height: 500px) and (pointer: coarse))';
/** A phone held sideways: the bottom toolbar goes, voice shows the video edge to edge. */
export const LANDSCAPE_PHONE_QUERY = '(max-height: 500px) and (pointer: coarse) and (orientation: landscape)';

const mobileQuery = window.matchMedia(MOBILE_QUERY);
export const isMobile = signal(mobileQuery.matches);
mobileQuery.addEventListener('change', (event) => {
  isMobile.value = event.matches;
  if (!event.matches) {
    sidebarOpen.value = false;
    membersOpen.value = false;
  }
});

// Phones also put the channel sidebar in a drawer and show the bottom toolbar;
// tablets keep the sidebar and only use the member drawer.
const phoneQuery = window.matchMedia(PHONE_QUERY);
export const isPhone = signal(phoneQuery.matches);
phoneQuery.addEventListener('change', (event) => {
  isPhone.value = event.matches;
  if (!event.matches) sidebarOpen.value = false;
});

const landscapePhoneQuery = window.matchMedia(LANDSCAPE_PHONE_QUERY);
export const isLandscapePhone = signal(landscapePhoneQuery.matches);
landscapePhoneQuery.addEventListener('change', (event) => {
  isLandscapePhone.value = event.matches;
});

/**
 * A text field has the focus on a touch screen, so the on-screen keyboard is
 * (most likely) up: the bottom toolbar hides to give the composer the room.
 * Maintained by lib/keyboard.ts.
 */
export const keyboardOpen = signal(false);

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
