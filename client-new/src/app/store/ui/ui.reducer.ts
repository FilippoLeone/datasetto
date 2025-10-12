import { createReducer, on } from '@ngrx/store';
import { Notification } from '../../core/models';
import * as UIActions from './ui.actions';

export interface UIState {
  notifications: Notification[];
  openModals: Map<string, any>;
  sidebarOpen: boolean;
  loading: boolean;
}

export const initialState: UIState = {
  notifications: [],
  openModals: new Map(),
  sidebarOpen: true,
  loading: false,
};

export const uiReducer = createReducer(
  initialState,
  
  on(UIActions.showNotification, (state, { notification }) => ({
    ...state,
    notifications: [...state.notifications, notification],
  })),
  
  on(UIActions.hideNotification, (state, { notificationId }) => ({
    ...state,
    notifications: state.notifications.filter((n) => n.id !== notificationId),
  })),

  on(UIActions.openModal, (state, { modalId, data }) => {
    const newModals = new Map(state.openModals);
    newModals.set(modalId, data || null);
    return {
      ...state,
      openModals: newModals,
    };
  }),

  on(UIActions.closeModal, (state, { modalId }) => {
    const newModals = new Map(state.openModals);
    newModals.delete(modalId);
    return {
      ...state,
      openModals: newModals,
    };
  }),

  on(UIActions.toggleSidebar, (state) => ({
    ...state,
    sidebarOpen: !state.sidebarOpen,
  })),

  on(UIActions.setSidebarOpen, (state, { open }) => ({
    ...state,
    sidebarOpen: open,
  })),

  on(UIActions.setLoading, (state, { loading }) => ({
    ...state,
    loading,
  }))
);
