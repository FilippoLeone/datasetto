import { createAction, props } from '@ngrx/store';
import { Notification } from '../../core/models';

export const showNotification = createAction(
  '[UI] Show Notification',
  props<{ notification: Notification }>()
);

export const hideNotification = createAction(
  '[UI] Hide Notification',
  props<{ notificationId: string }>()
);

export const openModal = createAction(
  '[UI] Open Modal',
  props<{ modalId: string; data?: any }>()
);

export const closeModal = createAction(
  '[UI] Close Modal',
  props<{ modalId: string }>()
);

export const toggleSidebar = createAction('[UI] Toggle Sidebar');

export const setSidebarOpen = createAction(
  '[UI] Set Sidebar Open',
  props<{ open: boolean }>()
);

export const setLoading = createAction(
  '[UI] Set Loading',
  props<{ loading: boolean }>()
);
