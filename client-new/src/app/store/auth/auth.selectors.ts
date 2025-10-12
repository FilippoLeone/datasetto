import { createFeatureSelector, createSelector } from '@ngrx/store';
import { AuthState } from './auth.reducer';

export const selectAuthState = createFeatureSelector<AuthState>('auth');

export const selectUser = createSelector(
  selectAuthState,
  (state) => state.user
);

export const selectAccount = createSelector(
  selectAuthState,
  (state) => state.account
);

export const selectSession = createSelector(
  selectAuthState,
  (state) => state.session
);

export const selectIsAuthenticated = createSelector(
  selectAuthState,
  (state) => state.isAuthenticated
);

export const selectAuthLoading = createSelector(
  selectAuthState,
  (state) => state.loading
);

export const selectAuthError = createSelector(
  selectAuthState,
  (state) => state.error
);

export const selectUserRoles = createSelector(
  selectUser,
  (user) => user?.roles || []
);

export const selectIsSuperuser = createSelector(
  selectUser,
  (user) => user?.isSuperuser || false
);
