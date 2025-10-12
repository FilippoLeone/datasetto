import { createAction, props } from '@ngrx/store';
import { Account, SessionInfo, User } from '../../core/models';

// Login Actions
export const login = createAction(
  '[Auth] Login',
  props<{ username: string; password: string }>()
);

export const loginSuccess = createAction(
  '[Auth] Login Success',
  props<{ user: User; account: Account; session: SessionInfo }>()
);

export const loginFailure = createAction(
  '[Auth] Login Failure',
  props<{ error: string }>()
);

// Register Actions
export const register = createAction(
  '[Auth] Register',
  props<{ username: string; password: string; displayName?: string }>()
);

export const registerSuccess = createAction(
  '[Auth] Register Success',
  props<{ user: User; account: Account; session: SessionInfo }>()
);

export const registerFailure = createAction(
  '[Auth] Register Failure',
  props<{ error: string }>()
);

// Logout Actions
export const logout = createAction('[Auth] Logout');

export const logoutSuccess = createAction('[Auth] Logout Success');

// Token Actions
export const loadSession = createAction('[Auth] Load Session');

export const sessionLoaded = createAction(
  '[Auth] Session Loaded',
  props<{ user: User; account: Account; session: SessionInfo }>()
);

export const sessionInvalid = createAction('[Auth] Session Invalid');

// Update Account
export const updateAccount = createAction(
  '[Auth] Update Account',
  props<{ account: Partial<Account> }>()
);

export const updateAccountSuccess = createAction(
  '[Auth] Update Account Success',
  props<{ account: Account; user?: User }>()
);

export const updateAccountFailure = createAction(
  '[Auth] Update Account Failure',
  props<{ error: string }>()
);
