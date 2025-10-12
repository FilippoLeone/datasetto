import { createReducer, on } from '@ngrx/store';
import { Account, SessionInfo, User } from '../../core/models';
import * as AuthActions from './auth.actions';

export interface AuthState {
  user: User | null;
  account: Account | null;
  session: SessionInfo | null;
  isAuthenticated: boolean;
  loading: boolean;
  error: string | null;
}

export const initialState: AuthState = {
  user: null,
  account: null,
  session: null,
  isAuthenticated: false,
  loading: true, // Start as true to wait for initial session check
  error: null,
};

export const authReducer = createReducer(
  initialState,
  
  // Login
  on(AuthActions.login, (state) => ({
    ...state,
    loading: true,
    error: null,
  })),
  
  on(AuthActions.loginSuccess, (state, { user, account, session }) => ({
    ...state,
    user,
    account,
    session,
    isAuthenticated: true,
    loading: false,
    error: null,
  })),
  
  on(AuthActions.loginFailure, (state, { error }) => ({
    ...state,
    loading: false,
    error,
  })),

  // Register
  on(AuthActions.register, (state) => ({
    ...state,
    loading: true,
    error: null,
  })),
  
  on(AuthActions.registerSuccess, (state, { user, account, session }) => ({
    ...state,
    user,
    account,
    session,
    isAuthenticated: true,
    loading: false,
    error: null,
  })),
  
  on(AuthActions.registerFailure, (state, { error }) => ({
    ...state,
    loading: false,
    error,
  })),

  // Logout
  on(AuthActions.logout, (state) => ({
    ...state,
    loading: true,
  })),
  
  on(AuthActions.logoutSuccess, () => initialState),

  // Session
  on(AuthActions.loadSession, (state) => ({
    ...state,
    loading: true,
  })),
  
  on(AuthActions.sessionLoaded, (state, { user, account, session }) => ({
    ...state,
    user,
    account,
    session,
    isAuthenticated: true,
    loading: false,
  })),
  
  on(AuthActions.sessionInvalid, () => ({
    ...initialState,
    loading: false, // Session check complete, no valid session found
  })),

  // Update Account
  on(AuthActions.updateAccount, (state) => ({
    ...state,
    loading: true,
    error: null,
  })),
  
  on(AuthActions.updateAccountSuccess, (state, { account, user }) => ({
    ...state,
    account,
    user: user || state.user,
    loading: false,
  })),
  
  on(AuthActions.updateAccountFailure, (state, { error }) => ({
    ...state,
    loading: false,
    error,
  }))
);
