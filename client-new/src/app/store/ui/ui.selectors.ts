import { createFeatureSelector, createSelector } from '@ngrx/store';
import { UIState } from './ui.reducer';

export const selectUIState = createFeatureSelector<UIState>('ui');

export const selectNotifications = createSelector(
  selectUIState,
  (state) => state.notifications
);

export const selectOpenModals = createSelector(
  selectUIState,
  (state) => state.openModals
);

export const selectIsModalOpen = (modalId: string) =>
  createSelector(selectOpenModals, (modals) => modals.has(modalId));

export const selectModalData = (modalId: string) =>
  createSelector(selectOpenModals, (modals) => modals.get(modalId));

export const selectSidebarOpen = createSelector(
  selectUIState,
  (state) => state.sidebarOpen
);

export const selectUILoading = createSelector(
  selectUIState,
  (state) => state.loading
);
